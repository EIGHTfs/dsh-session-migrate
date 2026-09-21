/**
 * dsh-session-migrate — HTTP 接口（供设置页调用）
 *
 * 全部接口挂 `/api/session-migrate/*`：只读查询 + 显式动作两类。
 *   GET  /api/session-migrate/state       环境快照（版本能力 / 目录 / 工作区 / 列表 / 摘要）
 *   GET  /api/session-migrate/list        仅列表
 *   GET  /api/session-migrate/workspaces  仅工作区候选
 *   GET  /api/session-migrate/i18n        外置多语言字典
 *   GET  /api/session-migrate/check?file= 单文件体检（含迁移路径规划）
 *   POST /api/session-migrate/import      导入旧会话（multipart 上传，或 JSON {paths}）
 *   POST /api/session-migrate/convert     转换选中项（投放 → 触发迁移）
 *   POST /api/session-migrate/fix-layout  修复 sessions/ 下非法裸目录
 *
 * 业务实现全部走 `lib/engine/*`（成熟引擎，已实测验证）与 `lib/follow.js`，
 * 本模块只做 HTTP 编解码与编排，不重复实现帧 / 布局 / 版本逻辑。
 *
 * @module routes
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, renameSync, copyFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

import { detectTarget, detectInstallRoot, planMigration } from './engine/target.js';
import { checkArtifact, fixLayout } from './engine/inspect.js';
import { listSessions } from './engine/layout.js';
import { installSession } from './engine/import.js';
import { unzipEntries, pickSessionEntry } from './engine/zip.js';
import { buildList, markConverted, legacyDir } from './legacy.js';
import { detectWorkspaces } from './workspace.js';
import { triggerMigration } from './follow.js';
import { scanLog, repairLogText, parseLog } from './engine/repair.js';
import { validateMigrationChain } from './engine/validate.js';
import { decodeFull, isPlaintext, textToZstd } from './engine/zstd.js';

/** 接口前缀。 */
export const API_PREFIX = '/api/session-migrate';

/** 单次导入的请求体上限（256MB，覆盖大会话导出包）。 */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

/** 触发迁移的默认等待上限（毫秒）。 */
const FOLLOW_WAIT_MS = 45000;

/** multipart 分隔符的 CR / LF（避免裸魔数）。 */
const CR = 0x0d;
const LF = 0x0a;
/** JSON 对象的起始字节 `{`。 */
const BYTE_JSON_OPEN = 0x7b;

/**
 * 发 JSON 响应。
 *
 * @param {object} res - HTTP 响应。
 * @param {number} code - 状态码。
 * @param {object} body - 响应体。
 */
function sendJson(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

/**
 * 读请求体（带上限，避免大文件把内存打满）。
 *
 * IncomingMessage 本身是异步可迭代流，用 for await 收块，
 * 出错/超限走 throw 而不是手动 reject，扁平且不会漏 error 事件。
 *
 * @param {object} req - HTTP 请求。
 * @returns {Promise<Buffer>}
 */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      req.destroy();
      throw new Error(`请求体超过上限 ${Math.floor(MAX_BODY_BYTES / 1024 / 1024)}MB`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 解析 JSON 请求体。
 *
 * @param {object} req - HTTP 请求。
 * @returns {Promise<object>} 解析结果；失败返回空对象。
 */
async function readJsonBody(req) {
  try {
    const buf = await readBody(req);
    if (!buf.length) return {};
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * 解析 multipart/form-data（只取文件字段，零依赖）。
 *
 * @param {Buffer} buf - 请求体。
 * @param {string} contentType - Content-Type 头。
 * @returns {{files: Array<{name: string, data: Buffer}>}}
 */
export function parseMultipart(buf, contentType) {
  const boundary = extractBoundary(contentType);
  if (!boundary) return { files: [] };
  const delim = Buffer.from(`--${boundary}`);
  const files = [];
  let pos = buf.indexOf(delim);

  while (pos !== -1) {
    const next = buf.indexOf(delim, pos + delim.length);
    if (next === -1) break;
    const part = parsePart(buf.subarray(pos + delim.length, next));
    if (part) files.push(part);
    pos = next;
  }
  return { files };
}

/**
 * 从 Content-Type 里取 boundary（引号可带可不带）。
 *
 * @param {string} contentType - Content-Type 头。
 * @returns {string|null}
 */
function extractBoundary(contentType) {
  const matched = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  return matched ? (matched[1] || matched[2]).trim() : null;
}

/**
 * 解析单个 multipart part：取文件名与数据（剥掉尾部 CRLF）。
 *
 * @param {Buffer} part - 一个 part 的内容（不含前后分隔符）。
 * @returns {{name: string, data: Buffer}|null} 非文件字段或无名文件返回 null。
 */
function parsePart(part) {
  const headerEnd = part.indexOf('\r\n\r\n');
  if (headerEnd === -1) return null;
  const headers = part.subarray(0, headerEnd).toString('utf8');
  const nameMatched = /filename="([^"]*)"/i.exec(headers);
  if (!nameMatched || !nameMatched[1]) return null;
  let payload = part.subarray(headerEnd + 4);
  // 尾部 CRLF 属于分隔符，需剥掉
  const tail = payload.length;
  if (tail >= 2 && payload[tail - 2] === CR && payload[tail - 1] === LF) {
    payload = payload.subarray(0, tail - 2);
  }
  return { name: nameMatched[1], data: payload };
}

/**
 * 读取外置 i18n 字典（zh + en）。
 *
 * @returns {{zh: object, en: object}}
 */
export function loadI18n() {
  const here = dirname(fileURLToPath(import.meta.url));
  const out = { zh: {}, en: {} };
  for (const lang of ['zh', 'en']) {
    try {
      const p = join(here, 'i18n', `${lang}.json`);
      if (existsSync(p)) out[lang] = JSON.parse(readFileSync(p, 'utf8'));
    } catch { /* 单个语言失败不影响另一个 */ }
  }
  return out;
}

/**
 * 目标版本能力（引擎探测，不硬编码版本号）。
 *
 * @param {object} deps - { dshHome, installRoot }。
 * @returns {{ok: boolean, version: number|null, migrations: object[], readable: number[], source: string, installRoot: string|null, note: string}}
 */
export function targetInfo(deps) {
  const root = deps.installRoot || detectInstallRoot(deps.dshHome);
  const target = detectTarget(root);
  return {
    ok: target.ok,
    version: target.currentVersion,
    migrations: target.migrations,
    readable: target.readable,
    source: target.source,
    installRoot: root,
    note: target.note,
  };
}

/**
 * 列表摘要：区分「待转换 / 已转换 / 不可读 / 不可迁移」。
 *
 * @param {object[]} sessions - 旧会话列表。
 * @param {number|null} targetVersion - 目标版本。
 * @param {object[]} migrations - 迁移边。
 * @returns {object}
 */
export function summarize(sessions, targetVersion, migrations = []) {
  let pending = 0;
  let converted = 0;
  let unreadable = 0;
  let unmigratable = 0;
  for (const s of sessions) {
    if (s.error) { unreadable += 1; continue; }
    if (Array.isArray(s.convertedVersions) && targetVersion !== null
      && s.convertedVersions.includes(targetVersion)) {
      converted += 1;
      continue;
    }
    const plan = planMigration(s.version, { currentVersion: targetVersion, migrations });
    if (!plan.possible && !plan.alreadyCurrent) unmigratable += 1;
    pending += 1;
  }
  return {
    total: sessions.length, pending, converted, unreadable, unmigratable,
  };
}

/**
 * 环境快照（UI 首屏用这一个接口）。
 *
 * @param {object} deps - { dshHome, installRoot }。
 * @returns {object} 快照。
 */
export function buildState(deps) {
  const { dshHome } = deps;
  const target = targetInfo(deps);
  const list = buildList(dshHome);
  const ws = detectWorkspaces(dshHome);
  const layout = listSessions(dshHome);
  return {
    ok: true,
    targetVersion: target.version,
    targetVersionSource: target.source,
    targetInstallRoot: target.installRoot,
    migrations: target.migrations,
    readable: target.readable,
    legacyDir: legacyDir(dshHome),
    dshHome,
    workspaces: ws.workspaces,
    defaultCwd: ws.defaultCwd,
    wsRoot: ws.wsRoot,
    sessionsLayoutOk: layout.illegal.length === 0,
    offenders: layout.illegal,
    sessions: list.sessions,
    summary: summarize(list.sessions, target.version, target.migrations),
  };
}

/**
 * 导入：把上传文件写进 `session.old/`。
 *
 * 两种落盘形态，取决于上传的是什么：
 *
 *  - `.jsonl` / `.jsonl.zstd` —— 直接落成同名文件；
 *  - `.zip` 导出包 —— **解包后落成标准目录形式** `<目录>/session.jsonl`。
 *
 * 为什么 zip 必须解开：旧会话扫描（`legacy.js` 的 `inspectLegacyFile`）
 * 只认 `.jsonl` / `.jsonl.zstd` 两种文件名。若把 zip 原样落盘，
 * 它会「导入成功但列表里看不见」，也就永远无法勾选转换
 * （`/convert` 会以「会话不在列表里」失败）。解包成目录形式后，
 * 后续列表 / 转换全部走既有路径，无需改动扫描逻辑。
 *
 * @param {object} deps - { dshHome }。
 * @param {Array<{name: string, data: Buffer}>} files - 上传文件。
 * @returns {object} 导入结果。
 */
export function doImport(deps, files) {
  const dir = legacyDir(deps.dshHome);
  mkdirSync(dir, { recursive: true });
  const imported = [];
  const failed = [];
  const used = new Set();

  for (const f of files) {
    const raw = basename(f.name || '');
    if (!raw || raw.startsWith('.')) {
      failed.push({ name: f.name, err: '非法文件名' });
      continue;
    }
    if (!/\.(jsonl|jsonl\.zstd|zstd|zip)$/i.test(raw)) {
      failed.push({ name: raw, err: '不支持的类型（仅 .jsonl / .jsonl.zstd / .zip）' });
      continue;
    }
    try {
      const written = raw.toLowerCase().endsWith('.zip')
        ? importZip(dir, raw, f.data, used)
        : importPlainFile(dir, raw, f.data, used);
      imported.push(...written);
    } catch (err) {
      failed.push({ name: raw, err: String(err?.message ?? err) });
    }
  }
  return { ok: failed.length === 0, imported, failed };
}

/**
 * 落盘单个明文 / zstd 会话文件。
 *
 * 同名文件重复导入走**覆盖**（旧文件改名归档），不另起新名字——
 * 与 zip 分支同一语义，避免同一会话在列表里出现多条。
 *
 * @param {string} dir - `session.old/` 目录。
 * @param {string} raw - 原始文件名。
 * @param {Buffer} data - 文件内容。
 * @param {Set<string>} used - 本轮已占用的名字。
 * @returns {Array<{name: string, bytes: number, replaced?: string}>} 导入条目。
 */
function importPlainFile(dir, raw, data, used) {
  const targetName = used.has(raw) ? uniqueName(raw, used, () => true) : raw;
  used.add(targetName);
  const target = join(dir, targetName);
  const replaced = backUpFileIfExists(target);
  writeFileSync(target, data);
  return [{ name: targetName, bytes: data.length, ...(replaced ? { replaced } : {}) }];
}

/**
 * 解开 zip 导出包，落成 `<目录>/session.<ext>` 标准目录形式。
 *
 * 目录名取 zip 内会话文件名去掉扩展名（`session.jsonl` → `session`），
 * 与 `legacy.js` 的 `findSessionFileInDir` 约定一致；同名目录先备份再覆盖。
 *
 * @param {string} dir - `session.old/` 目录。
 * @param {string} raw - zip 文件名。
 * @param {Buffer} data - zip 内容。
 * @param {Set<string>} used - 本轮已占用的名字。
 * @returns {Array<{name: string, bytes: number, unzippedFrom: string}>} 导入条目。
 * @throws {Error} zip 非法，或包内没有会话文件。
 */
function importZip(dir, raw, data, used) {
  const session = pickSessionEntry(unzipEntries(data));
  if (!session) throw new Error('zip 内没有会话文件（需包含 .jsonl 或 .jsonl.zstd）');

  // 目录名以会话 id 优先（header.id 更稳定），退化为文件名去扩展名。
  // 同名会话重复导入要**覆盖原目录并先备份**，而不是另起一个带时间戳的目录——
  // 后者会让同一个会话在列表里出现多条，转换时也分不清哪条是新的。
  const base = zipDirName(session);
  const dirName = used.has(base) ? uniqueName(base, used, () => true) : base;
  used.add(dirName);
  const target = join(dir, dirName);
  // 覆盖前留底：同名会话重复导入时可回退（既有内容改名归档）。
  backUpIfNotEmpty(target);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, session.name), session.data);
  return [{
    name: dirName,
    bytes: session.data.length,
    unzippedFrom: raw,
  }];
}

/**
 * 由 zip 内的会话文件推目录名。
 *
 * @param {{name: string, data: Buffer}} session - 包内会话文件。
 * @returns {string} 目录名（不含路径分隔符，已过滤非法字符）。
 */
function zipDirName(session) {
  const head = firstJsonObject(session.data);
  const fromId = head && typeof head.id === 'string' ? head.id : '';
  const base = fromId || session.name.replace(/\.jsonl(\.zstd)?$/, '');
  // 目录名要经得起落盘：去掉路径分隔与控制字符。
  return base.replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_') || 'session';
}

/**
 * 读首帧并解析为对象（明文直接读首行；zstd 解首帧）。
 *
 * 解析失败返回 null——目录名退化为文件名，不影响导入本身。
 *
 * @param {Buffer} data - 会话文件内容。
 * @returns {object|null} header 对象。
 */
function firstJsonObject(data) {
  try {
    if (data.length > 0 && data[0] === BYTE_JSON_OPEN) {
      const end = data.indexOf(LF);
      const line = data.toString('utf8', 0, end < 0 ? data.length : end);
      return JSON.parse(line);
    }
    // zstd 日志首个 frame 恰好是一行 header（见 engine/zstd.js 的格式契约），
    // 因此只需解开头这段，不必整体解压数万帧。
    const head = zstdDecompressSync(data.subarray(0, firstFrameEnd(data)));
    const end = head.indexOf(LF);
    return JSON.parse(head.toString('utf8', 0, end < 0 ? head.length : end));
  } catch {
    return null;
  }
}

/**
 * 找第一个 zstd frame 的结束偏移（用于只解 header 那一帧）。
 *
 * frame 头里带 content size 时用它推算，否则退回在长度上限内尝试。
 *
 * @param {Buffer} data - zstd 文件内容。
 * @returns {number} 猜测的帧结束偏移（上限为文件长度）。
 */
function firstFrameEnd(data) {
  // 保守上限：header 行不会超过 64KB，压缩后更小。
  const CAP = 64 * 1024;
  return Math.min(data.length, CAP);
}

/**
 * 目录已有内容时先改名留底（与 engine/import.js 的备份约定一致）。
 *
 * @param {string} target - 目标目录。
 * @returns {void}
 */
function backUpIfNotEmpty(target) {
  let entries;
  try {
    entries = readdirSync(target);
  } catch {
    return;
  }
  if (!entries.length) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  renameSync(target, `${target}.before-import-${stamp}`);
  mkdirSync(target, { recursive: true });
}

/**
 * 单个文件已存在时改名留底。
 *
 * @param {string} target - 目标文件路径。
 * @returns {string|null} 归档后的路径；无既有文件时返回 null。
 */
function backUpFileIfExists(target) {
  if (!existsSync(target)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archived = `${target}.before-import-${stamp}`;
  renameSync(target, archived);
  return basename(archived);
}

/**
 * 取一个未被占用的名字；冲突时追加时间戳。
 *
 * @param {string} name - 期望名字。
 * @param {Set<string>} used - 本轮已占用集合。
 * @param {Function} exists - (name) => boolean，判断磁盘上是否已存在。
 * @returns {string} 可用的名字。
 */
function uniqueName(name, used, exists) {
  if (!used.has(name) && !exists(name)) return name;
  return `${name}.${new Date().toISOString().replace(/[:.]/g, '-')}`;
}

/**
 * 转换单个旧会话：投放 → （可选）触发迁移。
 *
 * 两步缺一不可：
 *   ① 投放 `installSession` —— 改写 header.cwd、只重建首帧、留底既有目录
 *   ② 触发 `triggerMigration` —— WebSocket session/follow，DSH 才会真的产出 vN
 *
 * @param {object} opts - { dshHome, session, targetCwd, targetVersion, trigger, waitMs }。
 * @returns {Promise<object>} 单会话结果。
 */
async function convertOne(opts) {
  const {
    dshHome, session, targetCwd, targetVersion, trigger, waitMs,
  } = opts;

  let placed;
  try {
    placed = installSession({
      home: dshHome,
      srcFile: session.file,
      sid: session.id,
      targetCwd,
      quiet: true,
    });
  } catch (err) {
    return { id: session.id, ok: false, error: `投放失败: ${String(err?.message ?? err)}` };
  }

  const out = {
    id: session.id,
    ok: true,
    targetCwd,
    targetDir: placed.dir,
    targetFile: join(placed.dir, 'session.jsonl.zstd'),
    sourceVersion: session.version,
    targetVersion,
    action: placed.action,
    backupPath: placed.backupPath,
    frames: placed.frames,
    removedDuplicates: placed.removedDuplicates ?? [],
    triggered: false,
  };

  if (trigger) {
    const r = await triggerMigration({
      dshHome, sessionId: session.id, targetDir: placed.dir, targetVersion, waitMs,
    });
    out.triggered = r.ok;
    if (r.ok) {
      out.migratedFile = r.migratedFile;
      out.migratedVersion = `v${targetVersion}`;
    } else {
      out.triggerError = r.error;
    }
  }
  return out;
}

/**
 * 批量转换选中的旧会话。
 *
 * @param {object} deps - { dshHome, installRoot }。
 * @param {object} payload - { ids, cwd, trigger, waitMs }。
 * @returns {Promise<object>} 转换结果。
 */
export async function doConvert(deps, payload) {
  const { dshHome } = deps;
  const ids = Array.isArray(payload.ids) ? payload.ids : [];
  if (!ids.length) return { ok: false, error: '未选择要转换的会话' };

  const target = targetInfo(deps);
  if (target.version === null) {
    return { ok: false, error: '未能探测到目标会话格式版本（请检查 DSH 安装目录）' };
  }

  const list = buildList(dshHome);
  const byId = new Map(list.sessions.map((s) => [s.id, s]));
  const ws = detectWorkspaces(dshHome);
  const targetCwd = payload.cwd || ws.defaultCwd;
  if (!targetCwd) return { ok: false, error: '未指定目标工作区' };

  const trigger = payload.trigger !== false;
  const waitMs = Number(payload.waitMs) > 0 ? Number(payload.waitMs) : FOLLOW_WAIT_MS;

  const results = [];
  for (const id of ids) {
    const session = byId.get(id);
    if (!session) {
      results.push({ id, ok: false, error: '会话不在列表里（可能已被移走）' });
      continue;
    }
    const r = await convertOne({
      dshHome, session, targetCwd, targetVersion: target.version, trigger, waitMs,
    });
    if (r.ok) markConverted(dshHome, id, target.version);
    results.push(r);
  }

  const okCount = results.filter((r) => r.ok).length;
  return {
    ok: okCount > 0,
    targetVersion: target.version,
    targetVersionSource: target.source,
    results,
    summary: {
      ok: okCount,
      fail: results.length - okCount,
      triggered: results.filter((r) => r.triggered).length,
    },
  };
}

/**
 * 修复 sessions/ 根下的非法裸目录（会导致工作区列表全空）。
 *
 * @param {object} deps - { dshHome }。
 * @returns {object} 修复结果。
 */
export function doFixLayout(deps) {
  const before = listSessions(deps.dshHome);
  if (!before.illegal.length) return { ok: true, moved: [], message: '布局正常' };
  const r = fixLayout(deps.dshHome);
  return { ok: true, moved: r.moved };
}

/**
 * 单文件体检（转发引擎能力，附迁移路径规划）。
 *
 * @param {object} deps - { dshHome, installRoot }。
 * @param {string} file - 会话文件路径。
 * @returns {object} 体检结果。
 */
export function doCheck(deps, file) {
  if (!file || !existsSync(file)) return { ok: false, error: `文件不存在: ${file || '(空)'}` };
  try {
    return {
      ok: true,
      ...checkArtifact(file, { home: deps.dshHome, installRoot: deps.installRoot || detectInstallRoot(deps.dshHome) }),
    };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/**
 * 注册所有 HTTP 路由。
 *
 * @param {object} webServer - 宿主 webServer 服务。
 * @param {object} deps - { dshHome, installRoot }。
 */
export function registerWebRoutes(webServer, deps) {
  /** 统一的异常兜底：任何 handler 抛错都回 500 JSON。 */
  const guard = (fn) => async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  };
  /** 只接受 POST 的 handler 包装。 */
  const post = (fn) => guard(async (req, res) => {
    if ((req.method ?? 'GET') !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    await fn(req, res);
  });
  /** 注册一个 exact 路由。 */
  const on = (path, handler) => webServer.register({
    kind: 'exact', path: `${API_PREFIX}${path}`, handler,
  });

  on('/state', guard(async (req, res) => sendJson(res, 200, buildState(deps))));
  on('/list', guard((req, res) => handleList(req, res, deps)));
  on('/workspaces', guard(async (req, res) => sendJson(res, 200, detectWorkspaces(deps.dshHome))));
  on('/i18n', guard(async (req, res) => sendJson(res, 200, loadI18n())));
  on('/check', guard((req, res) => handleCheck(req, res, deps)));
  on('/scan', guard((req, res) => handleScan(req, res, deps)));
  on('/repair', post((req, res) => handleRepair(req, res, deps)));
  on('/import', post((req, res) => handleImport(req, res, deps)));
  on('/convert', post((req, res) => handleConvert(req, res, deps)));
  on('/fix-layout', post(async (req, res) => sendJson(res, 200, doFixLayout(deps))));
}

/**
 * GET /list：会话列表 + 目标版本 + 摘要。
 *
 * @param {object} req - HTTP 请求。
 * @param {object} res - HTTP 响应。
 * @param {object} deps - { dshHome, installRoot }。
 */
async function handleList(req, res, deps) {
  const list = buildList(deps.dshHome);
  const target = targetInfo(deps);
  sendJson(res, 200, {
    ok: list.ok,
    sessions: list.sessions,
    targetVersion: target.version,
    summary: summarize(list.sessions, target.version, target.migrations),
  });
}

/**
 * GET /check：单文件体检。
 *
 * @param {object} req - HTTP 请求。
 * @param {object} res - HTTP 响应。
 * @param {object} deps - { dshHome, installRoot }。
 */
async function handleCheck(req, res, deps) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  sendJson(res, 200, doCheck(deps, url.searchParams.get('file') ?? ''));
}

/**
 * GET /scan?file=<路径>：内容缺陷扫描（只读）。
 *
 * @param {object} req - HTTP 请求。
 * @param {object} res - HTTP 响应。
 * @param {object} deps - { dshHome, installRoot }。
 */
async function handleScan(req, res, deps) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const file = url.searchParams.get('file') ?? '';
  if (!file || !existsSync(file)) {
    sendJson(res, 400, { ok: false, error: '需要 file 参数且文件必须存在' });
    return;
  }
  const { text } = readSessionText(file);
  const { rows, invalid } = parseLog(text);
  const scan = scanLog(rows, { text });
  sendJson(res, 200, { ok: true, file, rows: scan.rows, invalidLines: invalid, scan });
}

/** 读取会话文件全文（明文原样，zstd 自动全量解码）。 */
function readSessionText(file) {
  if (isPlaintext(file)) return { text: readFileSync(file, 'utf8'), plaintext: true };
  return { text: decodeFull(readFileSync(file)), plaintext: false };
}

/**
 * POST /repair：备份 → 内容修复 → 离线迁移链校验 → 落盘。
 *
 * 请求体 JSON：{ file: string, dryRun?: boolean }
 *
 * @param {object} req - HTTP 请求。
 * @param {object} res - HTTP 响应。
 * @param {object} deps - { dshHome, installRoot }。
 */
async function handleRepair(req, res, deps) {
  const body = await readJsonBody(req);
  const file = typeof body?.file === 'string' ? body.file : '';
  if (!file || !existsSync(file)) {
    sendJson(res, 400, { ok: false, error: '需要 file 且文件必须存在' });
    return;
  }
  const dryRun = body?.dryRun === true;
  const { text } = readSessionText(file);
  const before = scanLog(parseLog(text).rows, { text });
  const repaired = repairLogText(text);

  if (repaired.changedLines.length === 0) {
    sendJson(res, 200, { ok: true, file, dryRun, changed: 0, before: before.counts, message: '无需修复：未发现本工具可处理的缺陷' });
    return;
  }

  const validation = await runChainValidate(repaired.text, deps);
  const response = buildRepairResponse(file, dryRun, repaired, validation);

  if (dryRun) {
    sendJson(res, 200, response);
    return;
  }

  // 校验失败（且 catalog 可用）→ 拒绝写入
  if (validation && validation.ok === false && validation.skipped === undefined) {
    response.ok = false;
    response.message = '拒绝写入：修复后仍无法通过迁移链校验';
    sendJson(res, 400, response);
    return;
  }

  // 备份 → 落盘（原子写）
  response.backup = writeRepairedFile(file, repaired);
  response.encodedBytes = textToZstd(repaired.text).length;
  sendJson(res, 200, response);
}

/** 离线迁移链校验（目标实例自带 catalog；找不到则 skipped，异常归一为失败）。 */
async function runChainValidate(text, deps) {
  try {
    return await validateMigrationChain(text, { dshHome: deps.dshHome, installRoot: deps.installRoot });
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  }
}

/** 组装 repair 响应体（除落盘字段外全部字段）。 */
function buildRepairResponse(file, dryRun, repaired, validation) {
  return {
    ok: true, file, dryRun,
    changed: repaired.changedLines.length,
    changedLines: repaired.changedLines,
    stats: repaired.stats,
    skipped: repaired.skipped,
    before: repaired.before.counts,
    after: repaired.after.counts,
    validation,
  };
}

/** 备份原文件 → textToZstd 落盘（临时文件 + rename 原子写），返回备份目录。 */
function writeRepairedFile(file, repaired) {
  const backupDir = join(dirname(file), `${basename(file)}.repair-bak-${Date.now()}`);
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(file, join(backupDir, basename(file)));
  const encoded = textToZstd(repaired.text);
  const temp = file + '.tmp-' + process.pid;
  writeFileSync(temp, encoded);
  renameSync(temp, file);
  return backupDir;
}

/**
 * POST /import：multipart 上传，或 JSON {paths} 从磁盘读。
 *
 * @param {object} req - HTTP 请求。
 * @param {object} res - HTTP 响应。
 * @param {object} deps - { dshHome, installRoot }。
 */
async function handleImport(req, res, deps) {
  const ctype = req.headers?.['content-type'] ?? '';
  if (/multipart\/form-data/i.test(ctype)) {
    const buf = await readBody(req);
    const { files } = parseMultipart(buf, ctype);
    if (!files.length) {
      sendJson(res, 400, { ok: false, error: '没有解析到文件字段' });
      return;
    }
    sendJson(res, 200, doImport(deps, files));
    return;
  }
  const body = await readJsonBody(req);
  const paths = Array.isArray(body.paths) ? body.paths : [];
  const files = [];
  const failed = [];
  for (const p of paths) {
    try {
      files.push({ name: basename(p), data: await readFile(p) });
    } catch (err) {
      failed.push({ name: p, err: String(err?.message ?? err) });
    }
  }
  const r = doImport(deps, files);
  sendJson(res, 200, { ...r, failed: [...failed, ...r.failed] });
}

/**
 * POST /convert：转换选中项（投放 → 触发迁移）。
 *
 * @param {object} req - HTTP 请求。
 * @param {object} res - HTTP 响应。
 * @param {object} deps - { dshHome, installRoot }。
 */
async function handleConvert(req, res, deps) {
  const body = await readJsonBody(req);
  const r = await doConvert(deps, body);
  sendJson(res, r.ok ? 200 : 400, r);
}
