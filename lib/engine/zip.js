/**
 * 最小 zip 解包：只取会话导出包里的会话文件。
 *
 * 为什么需要它：导入接口接受 `.zip` 导出包，但旧会话扫描（`legacy.js`
 * 的 `inspectLegacyFile`）只认 `.jsonl` / `.jsonl.zstd`——两者口径不一致时，
 * zip 会「导入成功但列表里看不见」，也就永远无法勾选转换。
 * 修法是在**导入时就把 zip 解开**成标准目录形式（`<目录>/session.jsonl`），
 * 使后续扫描 / 转换全走既有路径，无需改扫描逻辑。
 *
 * 零依赖：只用 node:zlib 的 inflateRawSync 解 deflate 数据。
 * 支持 store（0）与 deflate（8）两种压缩方式，覆盖常见导出包。
 *
 * 安全：不信任 zip 内的路径与声明大小——
 *  - 只取条目**基名**，拒绝任何含目录分隔或 `..` 的名称（防路径穿越）；
 *  - 解压后校验实际大小不超过上限（防 zip 炸弹）。
 *
 * 本模块不依赖 DSH 运行时，可独立单测。
 *
 * @module engine/zip
 */
import { inflateRawSync } from 'node:zlib';

/** 单个条目解压后的体积上限（会话导出包通常 < 100MB）。 */
export const MAX_ENTRY_BYTES = 512 * 1024 * 1024;

/** 中央目录条目签名。 */
const SIG_CENTRAL = 0x02014b50;
/** 中央目录结尾签名。 */
const SIG_EOCD = 0x06054b50;

/**
 * 从一个 zip Buffer 中解出所有条目。
 *
 * 走**中央目录**而不是逐个读本地头：不少导出工具在本地头里把
 * 压缩/原始长度写成 0，真实长度放在数据后的 data descriptor
 * （general purpose flag 的 bit 3），照着本地头解析会得到 0 长度而解不出内容。
 * 中央目录里的长度始终准确，因此以它为准定位数据。
 *
 * @param {Buffer} buf - 整个 zip 文件内容。
 * @returns {Array<{name: string, data: Buffer}>} 条目列表（name 已剥成基名）。
 * @throws {Error} 数据不是合法 zip，或条目超出大小上限。
 */
export function unzipEntries(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error('不是合法 zip：内容过短');
  const central = findCentralDirectory(buf);
  const out = [];
  for (const entry of central) {
    const { rawName, method, compSize, localOffset } = entry;
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > buf.length) {
      throw new Error(`zip 条目 ${rawName} 数据越界（声明 ${compSize} 字节）`);
    }
    const payload = buf.subarray(dataStart, dataStart + compSize);
    out.push({ name: safeBaseName(rawName), data: inflate(rawName, method, payload) });
  }
  if (!out.length) throw new Error('zip 内没有可读取的条目');
  return out;
}

/**
 * 读出中央目录里的全部条目描述。
 *
 * @param {Buffer} buf - 整个 zip 文件内容。
 * @returns {Array<{rawName: string, method: number, compSize: number, localOffset: number}>}
 * @throws {Error} 找不到中央目录或条目越界（截断/伪造的包）。
 */
function findCentralDirectory(buf) {
  // EOCD 之后可能跟注释，从尾部回扫定位签名。
  let eocd = -1;
  const start = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是合法 zip：找不到中央目录');
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > buf.length || buf.readUInt32LE(pos) !== SIG_CENTRAL) {
      throw new Error(`不是合法 zip：第 ${i + 1} 个中央目录条目损坏`);
    }
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const rawName = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    if (localOffset + 30 > buf.length) throw new Error(`不是合法 zip：条目 ${rawName} 偏移越界`);
    entries.push({ rawName, method, compSize, localOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/**
 * 按压缩方式解出一条数据。
 *
 * @param {string} rawName - 原始条目名（用于报错）。
 * @param {number} method - 压缩方式（0=store，8=deflate）。
 * @param {Buffer} payload - 压缩数据。
 * @returns {Buffer} 解出的数据。
 * @throws {Error} 压缩方式不支持，或解压后超出上限。
 */
function inflate(rawName, method, payload) {
  let data;
  if (method === 0) {
    data = Buffer.from(payload);
  } else if (method === 8) {
    data = inflateRawSync(payload);
  } else {
    throw new Error(`zip 条目 ${rawName} 使用了不支持的压缩方式 ${method}`);
  }
  if (data.length > MAX_ENTRY_BYTES) {
    throw new Error(`zip 条目 ${rawName} 解压后过大（${data.length} 字节，上限 ${MAX_ENTRY_BYTES}）`);
  }
  return data;
}

/**
 * 取出条目名的基名，挡掉路径穿越。
 *
 * zip 里的名称可能是 `a/b/session.jsonl` 或 `../evil.jsonl`；
 * 本模块只关心「叫什么」，落盘位置由调用方决定，因此统一剥成基名。
 *
 * @param {string} rawName - zip 内的原始条目名。
 * @returns {string} 安全的基名。
 */
export function safeBaseName(rawName) {
  const normalized = String(rawName).replace(/\\/g, '/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  // 去掉可能的盘符与残留的点号前缀，避免落成隐藏文件或越级名。
  return base.replace(/^[A-Za-z]:/, '').replace(/^\.+/, '') || 'entry';
}

/**
 * 从 zip 里挑出会话文件（优先 .jsonl.zstd，其次 .jsonl）。
 *
 * @param {Array<{name: string, data: Buffer}>} entries - unzipEntries 的结果。
 * @returns {{name: string, data: Buffer}|null} 会话条目；没有则 null。
 */
export function pickSessionEntry(entries) {
  const zstd = entries.find((e) => e.name.endsWith('.jsonl.zstd'));
  if (zstd) return zstd;
  const plain = entries.find((e) => e.name.endsWith('.jsonl'));
  return plain ?? null;
}
