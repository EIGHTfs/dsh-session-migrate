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

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectTarget, detectInstallRoot, planMigration } from './engine/target.js';
import { checkArtifact, fixLayout } from './engine/inspect.js';
import { listSessions } from './engine/layout.js';
import { installSession } from './engine/import.js';
import { buildList, markConverted, legacyDir } from './legacy.js';
import { detectWorkspaces } from './workspace.js';
import { triggerMigration } from './follow.js';

/** 接口前缀。 */
export const API_PREFIX = '/api/session-migrate';

/** 单次导入的请求体上限（256MB，覆盖大会话导出包）。 */
const MAX_BODY_BYTES = 256 * 1024 * 1024;

/** 触发迁移的默认等待上限（毫秒）。 */
const FOLLOW_WAIT_MS = 45000;

/** multipart 分隔符的 CR / LF（避免裸魔数）。 */
const CR = 0x0d;
const LF = 0x0a;

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
 * @param {object} req - HTTP 请求。
 * @returns {Promise<Buffer>}
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过上限 ${Math.floor(MAX_BODY_BYTES / 1024 / 1024)}MB`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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
  const matched = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  const boundary = matched ? (matched[1] || matched[2]).trim() : null;
  if (!boundary) return { files: [] };
  const delim = Buffer.from(`--${boundary}`);
  const files = [];
  let pos = buf.indexOf(delim);

  while (pos !== -1) {
    const next = buf.indexOf(delim, pos + delim.length);
    if (next === -1) break;
    const part = buf.subarray(pos + delim.length, next);
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = part.subarray(0, headerEnd).toString('utf8');
      const fm = /filename="([^"]*)"/i.exec(headers);
      if (fm) {
        let payload = part.subarray(headerEnd + 4);
        // 尾部 CRLF 属于分隔符，需剥掉
        const tail = payload.length;
        if (tail >= 2 && payload[tail - 2] === CR && payload[tail - 1] === LF) {
          payload = payload.subarray(0, tail - 2);
        }
        if (fm[1]) files.push({ name: fm[1], data: payload });
      }
    }
    pos = next;
  }
  return { files };
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
    let targetName = raw;
    if (used.has(targetName) || existsSync(join(dir, targetName))) {
      targetName = `${raw}.${new Date().toISOString().replace(/[:.]/g, '-')}`;
    }
    used.add(targetName);
    try {
      writeFileSync(join(dir, targetName), f.data);
      imported.push({ name: targetName, bytes: f.data.length });
    } catch (err) {
      failed.push({ name: raw, err: String(err?.message ?? err) });
    }
  }
  return { ok: failed.length === 0, imported, failed };
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

  on('/list', guard(async (req, res) => {
    const list = buildList(deps.dshHome);
    const target = targetInfo(deps);
    sendJson(res, 200, {
      ok: list.ok,
      sessions: list.sessions,
      targetVersion: target.version,
      summary: summarize(list.sessions, target.version, target.migrations),
    });
  }));

  on('/workspaces', guard(async (req, res) => sendJson(res, 200, detectWorkspaces(deps.dshHome))));

  on('/i18n', guard(async (req, res) => sendJson(res, 200, loadI18n())));

  on('/check', guard(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    sendJson(res, 200, doCheck(deps, url.searchParams.get('file') ?? ''));
  }));

  on('/import', post(async (req, res) => {
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
        files.push({ name: basename(p), data: readFileSync(p) });
      } catch (err) {
        failed.push({ name: p, err: String(err?.message ?? err) });
      }
    }
    const r = doImport(deps, files);
    sendJson(res, 200, { ...r, failed: [...failed, ...r.failed] });
  }));

  on('/convert', post(async (req, res) => {
    const body = await readJsonBody(req);
    const r = await doConvert(deps, body);
    sendJson(res, r.ok ? 200 : 400, r);
  }));

  on('/fix-layout', post(async (req, res) => sendJson(res, 200, doFixLayout(deps))));
}
