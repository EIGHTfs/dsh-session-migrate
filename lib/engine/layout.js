/**
 * 会话目录布局：cwd → 目录名编码、目标路径推导、布局校验。
 *
 * 编码规则（实测自 DSH 生成的目录名）：
 *   路径开头 '/'  → 由 "‑‑" 前缀代表（不单独输出）
 *   其余 '/'      → '-'
 *   空格          → '~0020'
 *   安全字符       → 原样（字母/数字/'.'/'_'/'~'/'-'）
 *   其余           → '~XXXX'（Unicode 码点大写十六进制，如 工 U+5DE5 → ~5DE5）
 *
 * 例：/volume1/@appdata/X/0.1.6-alpha.1/工作区
 *     → --volume1-~0040appdata-X-0.1.6-alpha.1-~5DE5~4F5C~533A--
 *
 * 布局契约（踩过的坑）：
 *   sessions/ 根下**只允许** --<编码cwd>-- 形式的目录；任何裸目录（如把备份
 *   放在 sessions/backup-xxx）会让 DSH 报
 *   `uses the unsupported flat-file layout`，进而 workspaceRegistry 激活失败，
 *   表现为「工作区列表为空 + directoryPickerController is unavailable」。
 *   备份一律放 <home>/../session-backups/。
 */
import { readdirSync, statSync, existsSync, renameSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { readHeaderAny } from './zstd.js';

/** cwd 绝对路径 → 会话目录名 */
export function encodeCwd(cwd) {
  let out = '';
  const s = String(cwd);
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const cp = s.codePointAt(i);
    if (ch === '/') {
      if (i === 0) continue;             // 开头的斜杠由 '--' 前缀代表
      out += '-';
    } else if (ch === ' ') {
      out += '~0020';
    } else if (/[A-Za-z0-9._~-]/.test(ch)) {
      out += ch;
    } else {
      out += '~' + cp.toString(16).toUpperCase().padStart(4, '0');
    }
  }
  return `--${out}--`;
}

/** 会话目录名 → 是否合法（--...-- 形式） */
export function isLegalProjectDir(name) {
  return /^--.*--$/.test(name);
}

/** 一个 generation 文件名 → 版本号（session.jsonl → 0，session.v3.jsonl.zstd → 3） */
export function generationVersion(filename) {
  const matched = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/.exec(filename);
  if (!matched) return null;
  return matched[1] ? Number(matched[1]) : 0;
}

/**
 * 由 header.version 推出**正确的会话日志文件名**。
 *
 * 为什么必须一致：宿主按文件名里的版本段判断 generation，文件名与 header 不符时
 * （例如 v4 内容却叫 session.jsonl.zstd）会让 workspace 服务解析失败，
 * 表现为**整实例所有会话在前端不可见**——不是只坏一条。
 * v0 才用无版本段的历史命名。
 * @param {number} version header.version
 * @returns {string}
 */
export function expectedLogName(version) {
  const n = Number(version);
  const v = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
  return v === 0 ? 'session.jsonl.zstd' : `session.v${v}.jsonl.zstd`;
}

/**
 * 遍历 sessions/**，把「文件名版本段 ≠ header.version」的日志改成正确名字。
 *
 * 不传 apply 时只**报告**（默认预览），符合「破坏性操作先 dry-run」的约定。
 * 只改名、不碰内容；同名已存在时跳过并记入 skipped（不覆盖）。
 * @param {string} home DSH_HOME
 * @param {{apply?: boolean, log?: Function, maxDepth?: number}} [opts]
 * @returns {{checked:number, mismatched:Array<{file:string,version:number,expected:string}>, renamed:Array<{from:string,to:string}>, skipped:Array<{file:string,reason:string}>}}
 */
export function fixSessionNames(home, opts = {}) {
  const apply = opts.apply === true;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const sroot = join(home, 'sessions');
  const out = { checked: 0, mismatched: [], renamed: [], skipped: [] };
  if (!existsSync(sroot)) return out;

  /** 逐个看一个「会话目录」里的日志文件（含 subagents/<sid>/）。 */
  const visitSessionDir = (dir) => {
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const version = generationVersion(name);
      if (version === null) continue;
      const file = join(dir, name);
      out.checked += 1;
      let headVersion;
      try {
        headVersion = readHeaderAny(file).head?.version;
      } catch (error) {
        out.skipped.push({ file, reason: `读 header 失败: ${String(error?.message ?? error)}` });
        continue;
      }
      const expected = expectedLogName(headVersion);
      if (name === expected) continue;
      out.mismatched.push({ file, version: headVersion, expected });
      const target = join(dir, expected);
      if (!apply) continue;
      if (existsSync(target)) {
        out.skipped.push({ file, reason: `目标已存在: ${expected}` });
        continue;
      }
      try {
        renameSync(file, target);
        out.renamed.push({ from: file, to: target });
        log(`  ✓ 改名 ${basename(dir)}/${name} → ${expected}（header.version=${headVersion}）`);
      } catch (error) {
        out.skipped.push({ file, reason: `改名失败: ${String(error?.message ?? error)}` });
      }
    }
  };

  for (const project of readdirSync(sroot)) {
    const projectDir = join(sroot, project);
    try {
      if (!statSync(projectDir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const sessionId of readdirSync(projectDir)) {
      const sessionDir = join(projectDir, sessionId);
      try {
        if (!statSync(sessionDir).isDirectory()) continue;
      } catch {
        continue;
      }
      visitSessionDir(sessionDir);
      const subRoot = join(sessionDir, 'subagents');
      if (!existsSync(subRoot)) continue;
      let subs = [];
      try {
        subs = readdirSync(subRoot);
      } catch {
        subs = [];
      }
      for (const sub of subs) {
        const subDir = join(subRoot, sub);
        try {
          if (!statSync(subDir).isDirectory()) continue;
        } catch {
          continue;
        }
        visitSessionDir(subDir);
      }
    }
  }
  return out;
}

/**
 * 列出 DSH_HOME 下的全部会话，并暴露布局问题。
 * @returns {{ projects: Array<{dir:string,cwdTail:string,sessions:Array<{id:string,dir:string,generations:Array<{file:string,version:number,size:number}>}>}>, illegal: string[] }}
 */
export function listSessions(home) {
  const sroot = join(home, 'sessions');
  const projects = [], illegal = [];
  if (!existsSync(sroot)) return { projects, illegal, sroot };

  for (const name of readdirSync(sroot)) {
    const pdir = join(sroot, name);
    if (!statSync(pdir).isDirectory()) continue;
    if (!isLegalProjectDir(name)) { illegal.push(name); continue; }
    projects.push({ dir: name, sessions: listProjectSessions(pdir) });
  }
  return { projects, illegal, sroot };
}

/** 列一个 cwd 项目目录下的全部会话（含各 generation 文件与版本）。 */
function listProjectSessions(pdir) {
  const sessions = [];
  for (const sidName of readdirSync(pdir)) {
    const sdir = join(pdir, sidName);
    if (!statSync(sdir).isDirectory()) continue;
    const generations = [];
    for (const f of readdirSync(sdir)) {
      const v = generationVersion(f);
      if (v === null) continue;
      generations.push({ file: f, version: v, size: statSync(join(sdir, f)).size });
    }
    generations.sort((a, b) => a.version - b.version);
    sessions.push({ id: sidName, dir: sdir, generations });
  }
  return sessions;
}

/**
 * 把源 cwd 映射到目标实例的实际路径。
 *
 * 源实例与目标实例结构都是：<实例根>/工作区[/<子项目>]，因此要**保留「工作区」
 * 之后的相对结构**，而不是只看最后一段：
 *   源 .../工作区              → <目标根>/工作区
 *   源 .../工作区/dsh-git-push → <目标根>/工作区/dsh-git-push
 *
 * 退化策略：目标根下无「工作区」时用目标根；对应子项目不存在时回落到工作区根
 * （宁可落到工作区根，也不写一个不存在的路径 —— DSH 按 cwd 推导会话目录名，
 *  不存在的路径会让会话挂在一个没有实际目录的工作区下）。
 *
 * @param {string} srcCwd 源会话 header.cwd
 * @param {string} home 目标 DSH_HOME（<实例根>/.dsh）
 * @returns {string} 目标 cwd 绝对路径
 */
export function deriveTargetCwd(srcCwd, home) {
  const homeRoot = join(home, '..');               // <实例根>
  const wsRoot = join(homeRoot, '工作区');
  const base = existsSync(wsRoot) ? wsRoot : homeRoot;

  const parts = String(srcCwd || '').split('/').filter(Boolean);
  const wsIdx = parts.lastIndexOf('工作区');

  if (wsIdx < 0) return base;                      // 源路径不含「工作区」→ 落工作区根

  const sub = parts.slice(wsIdx + 1);              // 工作区之后的相对段
  if (!sub.length) return base;

  const cand = join(base, ...sub);
  return existsSync(cand) ? cand : base;
}
