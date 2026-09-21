/**
 * 离线迁移链实测（engine/validate）。
 *
 * 目的：等价于「打开会话」但不影响正在运行的服务——用目标实例自带的
 * sessionFormatCatalog 把一份日志从 header 沿 v0→v1→v2→v3 完整还原一遍，
 * 通不过就是迁移链会拒绝（DSH 打开时同样会失败），修完（engine/repair）再实测，
 * 不用重启服务反复试。
 *
 * 依赖探测：clone 的 chain-validate 只找 npm 安装形态
 * （<root>/node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js）；
 * 本机 DSH 是 monorepo 源码形态，catalog 在
 *   <installRoot>/packages/session/session-format-catalog/lib/index.js
 * 因此本模块优先用 detectInstallRoot() 探测到的安装根拼源码路径，
 * 再回退到 node_modules 形态做兜底。
 *
 * 实现借鉴：createRestore 驱动方式改编自 zzdhsxk 的
 * dsh-session-migration-repair（MIT License, Copyright (c) 2026 zzdhsxk，
 * https://github.com/zzdhsxk/dsh-session-migration-repair），
 * 路径探测按本项目形态重写。
 *
 * @module dsh-session-migrate/lib/engine/validate
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectInstallRoot } from './target.js';
import { parseLog } from './repair.js';

/** monorepo 源码形态：<root>/packages/session/session-format-catalog/lib/index.js */
const CATALOG_SOURCE = 'packages/session/session-format-catalog/lib/index.js';
/** npm 安装形态（兜底）：<root>/node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js */
const CATALOG_NPM = 'node_modules/@deepseek-ai/dsh-session-format-catalog/lib/index.js';

/**
 * 候选 catalog 文件路径列表（按优先级）。
 *
 * @param {string|null} [dshHome] DSH_HOME（用于反推安装根）
 * @param {string|null} [installRoot] 显式安装根（最高优先级）
 * @returns {string[]}
 */
export function catalogCandidates(dshHome, installRoot) {
  const cands = [];
  if (installRoot && existsSync(join(installRoot, CATALOG_SOURCE))) {
    cands.push(join(installRoot, CATALOG_SOURCE));
  }
  if (installRoot && existsSync(join(installRoot, CATALOG_NPM))) {
    cands.push(join(installRoot, CATALOG_NPM));
  }
  const root = detectInstallRoot(dshHome);
  if (root && root !== installRoot) {
    if (existsSync(join(root, CATALOG_SOURCE))) cands.push(join(root, CATALOG_SOURCE));
    if (existsSync(join(root, CATALOG_NPM))) cands.push(join(root, CATALOG_NPM));
  }
  return [...new Set(cands)];
}

/**
 * 加载 sessionFormatCatalog。
 *
 * @param {string|null} [dshHome]
 * @param {string|null} [installRoot]
 * @returns {Promise<{catalog: object, catalogPath: string}|undefined>}
 */
export async function loadCatalog(dshHome, installRoot) {
  for (const path of catalogCandidates(dshHome, installRoot)) {
    try {
      const module = await import(path);
      if (module?.sessionFormatCatalog === undefined) continue;
      return { catalog: module.sessionFormatCatalog, catalogPath: path };
    } catch {
      // 候选文件 import 失败（版本过旧/损坏/非 ESM）——静默跳过，继续试下一个候选；
      // 全部失败时 loadCatalog 返回 undefined，由调用方决定降级策略。
    }
  }
  return undefined;
}

/**
 * 跑完整迁移链：createRestore(header) → 逐行 decodeRow → finish → restoreArtifact。
 *
 * @param {string} text 明文日志（多行 JSONL）
 * @param {{catalog?: object|false, dshHome?: string|null, installRoot?: string|null}} [options]
 * @returns {Promise<{ok:boolean, events?:number, error?:string, skipped?:string, catalogPath?:string}>}
 */
export async function validateMigrationChain(text, options = {}) {
  if (options.catalog === false) return { ok: false, skipped: 'format catalog explicitly disabled' };
  const loaded = options.catalog !== undefined
    ? { catalog: options.catalog, catalogPath: '(provided)' }
    : await loadCatalog(options.dshHome, options.installRoot);
  if (loaded === undefined) {
    return { ok: false, skipped: 'no session format catalog found (pass installRoot or --dsh-root)' };
  }
  const { catalog, catalogPath } = loaded;
  try {
    const { rows } = parseLog(text);
    const header = rows[0];
    if (header === undefined || header === null) return { ok: false, error: 'log has no parsable header line', catalogPath };
    const restore = catalog.createRestore(header, { validation: 'current' });
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index];
      if (row === undefined) continue;
      restore.decoder.decodeRow(row, restore.migration);
    }
    restore.migration.finish();
    const artifact = restore.restoreArtifact({
      header: restore.header,
      events: restore.collector.values,
      inheritedEventCount: restore.sourceInheritedEventCount,
    });
    const events = Array.isArray(artifact?.events) ? artifact.events.length : restore.collector.values.length;
    return { ok: true, events, catalogPath };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), catalogPath };
  }
}