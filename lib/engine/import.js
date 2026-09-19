/**
 * 会话导入：把源（文件或导出包解出的目录）投放进目标 DSH_HOME。
 *
 * 源可以是：
 *   · session.jsonl / session.jsonl.zstd 单文件
 *   · 目录（含 session.jsonl[.zstd] + subagents/<sid>/session.jsonl[.zstd]）
 *
 * 流程：查重（同 id 已在其它工作区则旧份移出备份）→ 迁移前备份既有 generation
 *       → （必要时明文转 zstd）→ 重写首帧 cwd → 落盘 → 移走既有 v3
 *       （迫使 DSH 重新迁移）→ 逐个投放 subagents。
 *
 * 幂等：重复导入同一会话会先备份既有目录再覆盖。
 * 去重：同一会话 id 若已在其它工作区（不同 cwd 目录）存在，先把旧份整体移出到
 *       <home>/../session-backups/（可恢复，非物理删除），再转换到本次目标工作区——
 *       杜绝「一个会话两次恢复到不同工作区」的重复副本。
 * 不做的事：不启动/不停止 DSH —— 迁移应在 DSH 停止时执行。
 */
import { existsSync, mkdirSync, readdirSync, statSync, copyFileSync, rmSync, cpSync, renameSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { encodeCwd, deriveTargetCwd, listSessions } from './layout.js';
import { isPlaintext, plaintextToZstd, rewriteHeader, readHeaderAny } from './zstd.js';

/** 时间戳串（用于备份命名） */
function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 会话文件候选名（优先明文，其次 zstd） */
const SESSION_FILE_CANDS = ['session.jsonl', 'session.jsonl.zstd'];
/** 落盘的会话文件名（zstd 编码，目标实例默认 compression=zstd） */
const SESSION_FILE_ZSTD = 'session.jsonl.zstd';

/** 在一个目录里找会话文件（优先明文的 session.jsonl，其次 .zstd） */
function findSessionFile(dir) {
  for (const cand of SESSION_FILE_CANDS) {
    const p = join(dir, cand);
    if (existsSync(p)) return p;
  }
  return null;
}

/**
 * 跨工作区去重：同一会话 id 已存在于其它 cwd 目录（不同工作区）时，
 * 把旧份整体移出到 session-backups（可恢复，非物理删除），再转换到本次目标工作区。
 * 只对主会话做（into 为空 = 主会话层）；subagent 落在主会话目录内，不受影响。
 *
 * @param {object} o
 * @param {string} o.home        目标 DSH_HOME
 * @param {string} o.sessionId   会话 id
 * @param {string} o.targetDir   本次落盘目录（同目录不算重复）
 * @param {string} o.backupDir   session-backups 目录
 * @param {Function} o.log       日志函数
 * @returns {Array<{from:string,backup:string,projectDir:string}>}
 */
function removeDuplicateCopies({ home, sessionId, targetDir, backupDir, log }) {
  const removed = [];
  try {
    const { projects } = listSessions(home);
    let idx = 0;
    for (const p of projects) {
      const hits = removeInProject({ project: p, sessionId, targetDir, backupDir, log, idx });
      idx = hits.nextIdx;
      removed.push(...hits.removed);
    }
  } catch (err) {
    log(`  ⚠ 去重扫描失败（继续转换，未清理旧份）: ${String(err?.message ?? err)}`);
  }
  return removed;
}

/**
 * 在一个项目目录里找并移出重复会话。
 *
 * @param {object} o - { project, sessionId, targetDir, backupDir, log, idx }。
 * @returns {{removed: Array<{from:string,backup:string,projectDir:string}>, nextIdx: number}}
 */
function removeInProject({ project, sessionId, targetDir, backupDir, log, idx }) {
  const removed = [];
  for (const s of project.sessions) {
    if (s.id !== sessionId || s.dir === targetDir) continue;
    const backupPath = moveDuplicate(s, backupDir, sessionId, ++idx);
    removed.push({ from: s.dir, backup: backupPath, projectDir: project.dir });
    log(`  ⚠ 会话 ${sessionId} 已存在于其它工作区（${project.dir}），旧份移出备份 → ${backupPath}`);
  }
  return { removed, nextIdx: idx };
}

/**
 * 把一个重复会话移出到备份目录（备份名带序号，冲突时继续递增，
 * 避免同秒多次去重撞名——rename 到非空目录会 ENOTEMPTY）。
 *
 * @param {{dir: string}} session - 重复会话信息。
 * @param {string} backupDir - session-backups 目录。
 * @param {string} sessionId - 会话 id。
 * @param {number} seq - 序号（用于备份名）。
 * @returns {string} 备份路径。
 */
function moveDuplicate(session, backupDir, sessionId, seq) {
  mkdirSync(backupDir, { recursive: true });
  let backupPath;
  do {
    backupPath = join(backupDir, `${sessionId}.dup-${stamp()}-${seq}`);
  } while (existsSync(backupPath));
  renameSync(session.dir, backupPath);
  return backupPath;
}

/**
 * 解析源：返回主会话文件与子会话文件列表。
 * @param {string} src 文件或目录
 */
export function resolveSource(src) {
  if (!existsSync(src)) throw new Error(`源不存在: ${src}`);
  const st = statSync(src);

  if (st.isFile()) return { main: src, subs: [] };

  const main = findSessionFile(src);
  if (!main) throw new Error(`目录中未找到 session.jsonl[.zstd]: ${src}`);

  const subs = [];
  const subRoot = join(src, 'subagents');
  if (existsSync(subRoot)) {
    for (const name of readdirSync(subRoot)) {
      const sdir = join(subRoot, name);
      if (!statSync(sdir).isDirectory()) continue;
      const f = findSessionFile(sdir);
      if (f) subs.push({ id: name, file: f });
    }
  }
  return { main, subs };
}

/**
 * 投放单个会话到 <home>/sessions/<enc>/<sid>/session.jsonl.zstd
 * @param {object} o
 * @param {string} o.home 目标 DSH_HOME
 * @param {string} o.srcFile 源会话文件（明文或 zstd）
 * @param {string} [o.sid] 会话 id（缺省从 header 推导）
 * @param {string} o.targetCwd 写入 header 的 cwd
 * @param {string} [o.into] 目标会话目录（用于 subagent 落进主会话目录）
 * @param {boolean} [o.quiet]
 * @returns {{ sid:string, dir:string, action:string, header:object, frames:number, removedDuplicates:Array<{from:string,backup:string,projectDir:string}> }}
 */
export function installSession({ home, srcFile, sid, targetCwd, into, quiet = false }) {
  const log = (...a) => { if (!quiet) console.log(...a); };
  const sroot = join(home, 'sessions');
  const backupDir = join(dirname(home), 'session-backups');

  // 读 header 以确定 id
  const { head, plaintext } = readHeaderAny(srcFile);
  const sessionId = sid || head.id;
  if (!sessionId) throw new Error('无法确定会话 id（header 缺少 id）');

  const dir = into || join(sroot, encodeCwd(targetCwd), sessionId);
  mkdirSync(dir, { recursive: true });

  // 跨工作区去重（见 removeDuplicateCopies 的说明）
  const removedDuplicates = into
    ? []
    : removeDuplicateCopies({ home, sessionId, targetDir: dir, backupDir, log });

  // 覆盖前备份（仅当目录已有内容）
  let backupPath = null;
  const before = readdirSync(dir).filter((f) => f !== '.session.incoming.zstd');
  if (before.length) {
    mkdirSync(backupDir, { recursive: true });
    backupPath = join(backupDir, `${sessionId}.before-import-${stamp()}`);
    cpSync(dir, backupPath, { recursive: true });
    log(`  覆盖前已备份 → ${backupPath}`);
  }

  // 明文 → zstd（目标实例 compression=zstd 时必需）
  let workFile = srcFile;
  let tempConverted = null;
  if (plaintext) {
    tempConverted = join(dir, '.session.converted.zstd');
    const r = plaintextToZstd(srcFile, tempConverted);
    log(`  ✓ 明文转 zstd: ${r.lines} 行 → ${r.frames} 帧`);
    workFile = tempConverted;
  }

  // 只重建首帧（其余 frame 原样保留）
  const incomingPath = join(dir, '.session.incoming.zstd');
  const rw = rewriteHeader(workFile, incomingPath, { cwd: targetCwd });
  renameSync(incomingPath, join(dir, SESSION_FILE_ZSTD));
  if (tempConverted) rmSync(tempConverted, { force: true });
  log(`  首帧 ${rw.firstFrameBytes[0]}B → ${rw.firstFrameBytes[1]}B；其余 ${rw.restBytes}B 原样保留`);

  // 移走既有 v3：否则 DSH 认为已迁移，不会重跑
  const v3 = join(dir, 'session.v3.jsonl.zstd');
  if (existsSync(v3)) {
    mkdirSync(backupDir, { recursive: true });
    renameSync(v3, join(backupDir, `${sessionId}.v3-prev-${stamp()}`));
    log('  既有 v3 已移出（将重新迁移）');
  }
  const lock = join(dir, 'session.lock');
  if (existsSync(lock)) rmSync(lock, { force: true });

  const check = readHeaderAny(join(dir, SESSION_FILE_ZSTD));
  return {
    sid: sessionId, dir, action: backupPath ? 'replaced' : 'created',
    header: check.head, frames: check.frameCount, backupPath,
    removedDuplicates,
  };
}

/**
 * 双路径导入：源 → 目标 home（含 subagents）。
 * @param {object} o
 * @param {string} o.src  源文件/目录
 * @param {string} o.home 目标 DSH_HOME
 * @param {string} [o.targetCwd] 覆盖目标 cwd（缺省自动映射）
 */
export function importAuto({ src, home, targetCwd }) {
  if (!existsSync(home)) throw new Error(`目标 DSH_HOME 不存在: ${home}`);
  const { main, subs } = resolveSource(src);
  const { head } = readHeaderAny(main);
  const cwd = targetCwd || deriveTargetCwd(head.cwd, home);

  const out = {
    source: src, home, sid: head.id, srcCwd: head.cwd, targetCwd: cwd,
    main: null, subagents: [], results: [],
    removedDuplicates: [],
  };

  console.log(`源主会话 : ${main}`);
  console.log(`子会话数 : ${subs.length}`);
  console.log(`目标 home: ${home}`);
  console.log(`会话 id  : ${head.id}`);
  console.log(`源 cwd   : ${head.cwd}`);
  console.log(`目标 cwd : ${cwd}`);
  console.log('');

  console.log('── 主会话 ──');
  const mainRes = installSession({ home, srcFile: main, sid: head.id, targetCwd: cwd });
  out.main = mainRes;
  out.removedDuplicates = mainRes.removedDuplicates ?? [];
  console.log(`  落盘: ${mainRes.dir}  (${mainRes.action})`);
  if (out.removedDuplicates.length) {
    console.log('');
    console.log('── 去重 ──');
    for (const dup of out.removedDuplicates) {
      console.log(`  ⚠ 已存在其它工作区副本（${dup.projectDir}）→ 旧份移出备份: ${dup.backup}`);
    }
  }

  if (subs.length) {
    console.log('');
    console.log('── 子会话（subagents）──');
    for (const s of subs) {
      const subRes = installSubagent({ home, srcFile: s.file, sid: s.id, targetCwd: cwd, mainDir: mainRes.dir });
      out.subagents.push(subRes);
      console.log(subRes.ok ? `  ✓ ${s.id}` : `  ✗ ${s.id}: ${subRes.error}`);
    }
  }

  console.log('');
  console.log(`完成。落盘目录: ${mainRes.dir}`);
  console.log('提醒：需 DSH 启动后打开会话以触发 v0→v1→v2→v3 迁移。');
  out.results = [mainRes, ...out.subagents];
  return out;
}

/**
 * 安装一个子会话（落进主会话目录的 subagents/ 下）。
 *
 * @param {object} o - { home, srcFile, sid, targetCwd, mainDir }。
 * @returns {{id: string, ok: boolean, dir?: string, error?: string}}
 */
function installSubagent({ home, srcFile, sid, targetCwd, mainDir }) {
  const subDir = join(mainDir, 'subagents', sid);
  try {
    const r = installSession({ home, srcFile, sid, targetCwd, into: subDir, quiet: true });
    return { id: sid, ok: true, dir: r.dir };
  } catch (err) {
    return { id: sid, ok: false, error: String(err?.message ?? err) };
  }
}
