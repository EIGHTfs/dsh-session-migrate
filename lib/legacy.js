/**
 * dsh-session-migrate — 旧会话扫描与登记
 *
 * 旧会话存放位置：`<dshHome>/session.old/`（**与 sessions/ 同层级**）。
 *
 * ⚠️ 为什么不能放 `sessions/` 里面（session-cross-machine-migrate 坑 1）：
 * `sessions/` 根下只允许 `--<cwd编码>--` 形式的目录，放任何裸目录会让 DSH 报
 * `uses the unsupported flat-file layout`，后果是**工作区列表全空**、
 * directoryPickerController unavailable。所以导入一律落 `session.old/`。
 *
 * 登记文件：`<dshHome>/session.old/session.old.json`
 *   { version: 1, sessions: { [legacyId]: { id, cwd, version, convertedVersions, ... } } }
 *
 * @module legacy
 */

import { existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { readHeaderAny } from './engine/zstd.js';

/** 旧会话目录名（与 sessions/ 同层级）。 */
export const LEGACY_DIR_NAME = 'session.old';

/** 会话文件名正则：v0 无版本后缀，vN 带 `.v<N>`。 */
export const SESSION_FILE_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;

/**
 * 从会话文件名推断格式版本（v0 无后缀 → 0）。
 *
 * 放在这里而不是引擎里：引擎按 header 内容判断版本，只有「扫描旧目录、
 * 文件名带 vN」这一侧需要用文件名兜底，属于本模块的独有职责。
 *
 * @param {string} fileName - 文件名。
 * @returns {number|null} 版本号；不匹配返回 null。
 */
export function versionFromFileName(fileName) {
  const matched = SESSION_FILE_RE.exec(basename(fileName));
  if (!matched) return null;
  return matched[1] === undefined ? 0 : Number(matched[1]);
}

/** 登记文件名。 */
export const LEGACY_INDEX_NAME = 'session.old.json';

/** 登记文件结构版本（结构变更时递增，便于将来迁移）。 */
export const LEGACY_INDEX_VERSION = 1;

/**
 * 旧会话目录绝对路径。
 *
 * @param {string} dshHome - DSH 主目录。
 * @returns {string}
 */
export function legacyDir(dshHome) {
  return join(dshHome, LEGACY_DIR_NAME);
}

/**
 * 登记文件绝对路径。
 *
 * @param {string} dshHome - DSH 主目录。
 * @returns {string}
 */
export function legacyIndexPath(dshHome) {
  return join(legacyDir(dshHome), LEGACY_INDEX_NAME);
}

/**
 * 确保旧会话目录存在。
 *
 * @param {string} dshHome - DSH 主目录。
 * @returns {string} 目录路径。
 */
export function ensureLegacyDir(dshHome) {
  const dir = legacyDir(dshHome);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 读登记文件（不存在或损坏时返回空结构，不抛错）。
 *
 * @param {string} dshHome - DSH 主目录。
 * @returns {{version: number, sessions: Record<string, object>}}
 */
export function loadIndex(dshHome) {
  const file = legacyIndexPath(dshHome);
  try {
    const obj = JSON.parse(readFileSync(file, 'utf8'));
    if (obj && typeof obj === 'object' && obj.sessions && typeof obj.sessions === 'object') {
      return { version: obj.version ?? LEGACY_INDEX_VERSION, sessions: obj.sessions };
    }
  } catch { /* 文件不存在或损坏 → 空索引 */ }
  return { version: LEGACY_INDEX_VERSION, sessions: {} };
}

/**
 * 写登记文件（原子写：先写临时文件再改名，避免半截文件）。
 *
 * @param {string} dshHome - DSH 主目录。
 * @param {{version: number, sessions: Record<string, object>}} index - 索引内容。
 * @returns {string} 写入路径。
 */
export function saveIndex(dshHome, index) {
  const dir = ensureLegacyDir(dshHome);
  const file = join(dir, LEGACY_INDEX_NAME);
  const tmp = `${file}.tmp-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf8');
  renameSync(tmp, file);
  return file;
}

/**
 * 扫旧会话目录，读出每个会话的真实信息。
 *
 * 识别对象：目录下的**文件**，扩展名为 .jsonl / .jsonl.zstd / .zstd；
 * 每个子目录也当作一个会话（导出包解出来的结构可能是目录形式）。
 *
 * @param {string} dshHome - DSH 主目录。
 * @returns {{ok: boolean, sessions: object[], error?: string}}
 */
export function scanLegacy(dshHome) {
  const dir = legacyDir(dshHome);
  if (!existsSync(dir)) return { ok: true, sessions: [] };
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch (err) {
    return { ok: false, sessions: [], error: String(err?.message ?? err) };
  }
  const out = [];
  const seen = new Set();
  for (const en of entries) {
    if (en.name === LEGACY_INDEX_NAME || en.name.startsWith('.')) continue;
    if (en.name.endsWith('.tmp')) continue;
    // 导入时的留底目录（`<id>.before-import-<时间戳>`）与文件同 id，
    // 扫进来会让同一会话在列表里重复出现。
    if (en.name.includes('.before-import-')) continue;
    const p = join(dir, en.name);
    const info = en.isFile()
      ? inspectLegacyFile(p)
      : en.isDirectory() ? inspectDirEntry(p, en.name) : null;
    if (!info || seen.has(info.id)) continue;
    seen.add(info.id);
    out.push(info);
  }
  return { ok: true, sessions: out };
}

/**
 * 读目录形式的旧会话（目录内找会话文件）。
 *
 * @param {string} dirPath - 候选目录。
 * @param {string} dirName - 目录名（用于 id 兜底）。
 * @returns {object|null} 会话信息；目录内无会话文件时 null。
 */
function inspectDirEntry(dirPath, dirName) {
  const inner = findSessionFileInDir(dirPath);
  return inner ? inspectLegacyFile(inner, dirName) : null;
}

/**
 * 在目录里找一个会话文件（优先 .jsonl.zstd，其次 .jsonl）。
 *
 * @param {string} dir - 目录。
 * @returns {string|null}
 */
function findSessionFileInDir(dir) {
  let files;
  try { files = readdirSync(dir); } catch { return null; }
  const zst = files.find((f) => f.endsWith('.jsonl.zstd'));
  if (zst) return join(dir, zst);
  const plain = files.find((f) => f.endsWith('.jsonl'));
  if (plain) return join(dir, plain);
  return null;
}

/**
 * 读取单个旧会话文件的信息（id / cwd / version / 首帧契约）。
 *
 * 明文 .jsonl 与压缩 .jsonl.zstd 都支持：前者直接读首行当 header。
 *
 * @param {string} file - 文件路径。
 * @param {string} [dirName] - 所在目录名（用于 id 兜底）。
 * @returns {object|null} 不是会话文件时返回 null。
 */
export function inspectLegacyFile(file, dirName) {
  const name = basename(file);
  const isPlain = name.endsWith('.jsonl') && !name.endsWith('.jsonl.zstd');
  const isZstd = name.endsWith('.jsonl.zstd');
  if (!isPlain && !isZstd) return null;

  let head = null;
  let headerOk = { ok: true, reason: 'ok' };
  let frameCount = 0;
  try {
    // 引擎统一入口：自动分流 zstd / 明文。
    // zstd 分支内部会校验「首帧恰好一行 header」，不合契约直接抛错，
    // 等价于旧的 checkHeaderFrame（不抛错即契约满足）。
    const r = readHeaderAny(file);
    head = r.head;
    frameCount = r.frameCount;
    if (!r.plaintext) headerOk = { ok: true, reason: 'ok' };
  } catch (err) {
    return {
      file, name, dirName: dirName ?? null,
      id: dirName ?? name,
      cwd: null, version: null,
      size: safeSize(file),
      readable: false,
      error: String(err?.message ?? err),
      headerOk: false, frameCount: 0,
    };
  }

  const idFromHead = head && typeof head.id === 'string' ? head.id : null;
  const versionFromHead = head && typeof head.version === 'number' ? head.version : null;
  const versionFromName = versionFromFileName(name);

  return {
    file,
    name,
    dirName: dirName ?? null,
    id: idFromHead ?? dirName ?? name,
    cwd: head && typeof head.cwd === 'string' ? head.cwd : null,
    // 版本以 header 内的为准；header 没写则按文件名推断（v0 无后缀）
    version: versionFromHead ?? versionFromName,
    size: safeSize(file),
    readable: true,
    frameCount,
    headerOk: headerOk.ok,
    headerNote: headerOk.reason,
    createdAt: head && typeof head.createdAt === 'number' ? head.createdAt : null,
  };
}

/**
 * 取文件大小，失败返回 0。
 *
 * @param {string} file - 文件路径。
 * @returns {number}
 */
function safeSize(file) {
  try { return statSync(file).size; } catch { return 0; }
}

/**
 * 把磁盘扫描结果与登记文件合并，得到 UI 用的列表。
 *
 * 合并规则：
 *   · 以**磁盘实际存在的会话**为准（文件被删掉就不该再列出来）
 *   · `convertedVersions` 从登记文件继承；**默认空数组**
 *   · 磁盘上新发现的会话补进登记（convertedVersions: []）
 *
 * @param {string} dshHome - DSH 主目录。
 * @returns {{ok: boolean, sessions: object[], changed: boolean, error?: string}}
 */
export function buildList(dshHome) {
  const scan = scanLegacy(dshHome);
  if (!scan.ok) return { ok: false, sessions: [], changed: false, error: scan.error };
  const index = loadIndex(dshHome);
  let changed = false;
  const seen = new Set();
  const sessions = [];

  for (const s of scan.sessions) {
    seen.add(s.id);
    const prev = index.sessions[s.id];
    if (!prev) {
      index.sessions[s.id] = {
        id: s.id,
        cwd: s.cwd,
        version: s.version,
        file: s.name,
        dirName: s.dirName,
        convertedVersions: [], // 默认空数组；转换成功后追加目标版本
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
      };
      changed = true;
    } else {
      prev.cwd = s.cwd;
      prev.version = s.version;
      prev.file = s.name;
      prev.dirName = s.dirName;
      prev.lastSeenAt = Date.now();
      if (!Array.isArray(prev.convertedVersions)) prev.convertedVersions = [];
    }
    sessions.push({ ...s, convertedVersions: index.sessions[s.id].convertedVersions });
  }

  // 磁盘上已消失的条目：保留登记（可能只是暂时移走），但不列进 UI
  for (const id of Object.keys(index.sessions)) {
    if (!seen.has(id)) {
      index.sessions[id].missing = true;
      changed = true;
    } else if (index.sessions[id].missing) {
      delete index.sessions[id].missing;
      changed = true;
    }
  }

  if (changed) saveIndex(dshHome, index);
  return { ok: true, sessions, changed };
}

/**
 * 标记某会话成功转换到目标版本（追加进 convertedVersions）。
 *
 * 语义：记录**产出过的目标版本列表**——转成 v3 记 [3]，
 * 之后若还能转成 v4 则为 [3, 4]。重复转换同一版本不重复追加。
 *
 * @param {string} dshHome - DSH 主目录。
 * @param {string} id - 会话 id。
 * @param {number} version - 成功产出的目标版本。
 * @returns {{ok: boolean, convertedVersions: number[]}}
 */
export function markConverted(dshHome, id, version) {
  const index = loadIndex(dshHome);
  const rec = index.sessions[id];
  if (!rec) return { ok: false, convertedVersions: [] };
  if (!Array.isArray(rec.convertedVersions)) rec.convertedVersions = [];
  if (!rec.convertedVersions.includes(version)) rec.convertedVersions.push(version);
  rec.convertedVersions.sort((a, b) => a - b);
  rec.lastConvertedAt = Date.now();
  delete rec.missing;
  saveIndex(dshHome, index);
  return { ok: true, convertedVersions: rec.convertedVersions };
}

/**
 * 判断文件名是否是受支持的会话文件。
 *
 * @param {string} name - 文件名。
 * @returns {boolean}
 */
export function isSessionFileName(name) {
  return name.endsWith('.jsonl.zstd') || (name.endsWith('.jsonl') && !name.endsWith('.jsonl.zstd'));
}

/**
 * 生成一个不会撞名的目标文件名。
 *
 * @param {string} dir - 目标目录。
 * @param {string} base - 期望的文件名。
 * @returns {string} 可用文件名。
 */
export function uniqueName(dir, base) {
  if (!existsSync(join(dir, base))) return base;
  const ext = base.endsWith('.jsonl.zstd') ? '.jsonl.zstd' : extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let i = 1; i < 1000; i++) {
    const cand = `${stem}-${i}${ext}`;
    if (!existsSync(join(dir, cand))) return cand;
  }
  return `${stem}-${Date.now()}${ext}`;
}
