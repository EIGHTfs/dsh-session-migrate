/**
 * dsh-session-migrate — 工作区探测
 *
 * ## 为什么不能纯字符串反解目录名
 *
 * `sessions/` 下的目录名是 `--<编码cwd>--`，编码把 `/` 写成 `-`。反过来解码时
 * `-` **既可能是路径分隔符、也可能是原路径里的连字符**（如 `dsh-git-push`），
 * 纯字符串还原必然出错：
 *   `--volume1-~0040appdata-DeepSeekHarness-NAS-...-dsh-git-push--`
 *   会被还原成 `/volume1/@appdata/DeepSeekHarness/NAS/.../dsh/git/push`（错）
 *
 * 所以反解只能用来**生成候选**，必须再用「磁盘上真实存在的路径」验证：
 *   · 工作区根 `工作区/` 的直接子目录是**权威候选**（真实存在，不需要解码）
 *   · 目录名反解出的候选，只有 `existsSync` 为真才采信
 *   · 两者都匹配不上时，退化为「工作区根」这一个安全选项
 *
 * 另外：**只有 `工作区` 之后那一层的名字需要猜**，`工作区` 之前的实例根能从
 * `dshHome` 直接算出来（`dshHome` 的父目录），不需要解码。
 *
 * @module workspace
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename, sep } from 'node:path';

/**
 * 目录名解码：`--volume1-~0040appdata-X--` → `/volume1/@appdata/X`。
 *
 * ⚠️ 结果**仅供参考/生成候选**：`-` 到 `/` 的还原有歧义（见模块头注释）。
 * 调用方必须用 existsSync 验证后再采信。
 *
 * @param {string} dirName - 形如 `--xxx--` 的目录名。
 * @returns {string|null} 解码出的路径；格式不符时 null。
 */
export function decodeCwdDirName(dirName) {
  if (!dirName.startsWith('--') || !dirName.endsWith('--') || dirName.length <= 4) return null;
  const body = dirName.slice(2, -2);
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '~' && i + 4 < body.length) {
      const hex = body.slice(i + 1, i + 5);
      if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 4;
        continue;
      }
    }
    out += ch === '-' ? '/' : ch;
  }
  return `/${out}`;
}

/**
 * 实例根目录（`dshHome` 的父目录，如 `.../0.1.6-alpha.1`）。
 *
 * @param {string} dshHome - DSH 主目录。
 * @returns {string}
 */
export function instanceRoot(dshHome) {
  return join(dshHome, '..');
}

/**
 * 工作区根目录（`<实例根>/工作区`）。
 *
 * @param {string} dshHome - DSH 主目录。
 * @returns {string}
 */
export function workspaceRoot(dshHome) {
  return join(instanceRoot(dshHome), '工作区');
}

/**
 * 从 `sessions/` 目录名生成候选 cwd（**已用 existsSync 过滤**）。
 *
 * 关键技巧：解码前先把「实例根 + /工作区」这段**已知前缀**换成占位符，
 * 只对「工作区之后的相对部分」做有歧义的还原——但即便如此，相对部分自己
 * 也可能含连字符，所以最终仍以磁盘存在性为准。
 *
 * @param {string} dshHome - DSH 主目录。
 * @returns {string[]} 真实存在的工作区路径。
 */
export function workspacesFromSessions(dshHome) {
  const root = join(dshHome, 'sessions');
  if (!existsSync(root)) return [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const wsRoot = workspaceRoot(dshHome);
  const out = [];
  for (const en of entries) {
    if (!en.isDirectory()) continue;
    const decoded = decodeCwdDirName(en.name);
    if (!decoded || !existsSync(decoded)) continue; // 只采信真实存在的
    out.push(decoded);
  }
  // 工作区根本身单独由调用方补上
  return dedupe(out.filter((p) => p !== wsRoot));
}

/**
 * 工作区根下的一级子目录（**权威候选**：真实存在，无需解码）。
 *
 * @param {string} dshHome - DSH 主目录。
 * @returns {{root: string|null, dirs: string[]}}
 */
export function workspacesFromDisk(dshHome) {
  const root = workspaceRoot(dshHome);
  let dirs = [];
  try {
    if (statSync(root).isDirectory()) {
      dirs = readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => join(root, e.name));
    }
  } catch { /* 工作区根不存在 */ }
  return { root: existsSync(root) ? root : null, dirs: dedupe(dirs) };
}

/**
 * 数组去重（保持顺序）。
 *
 * @param {string[]} list - 原始数组。
 * @returns {string[]} 去重结果。
 */
function dedupe(list) {
  return [...new Set(list.filter(Boolean))];
}

/**
 * 汇总可用工作区：以「工作区根的直接子目录」为权威，
 * 再用 sessions 目录名反解出的**已存在**路径补充（补充项可能来自更早的实例根）。
 *
 * @param {string} dshHome - DSH 主目录。
 * @returns {{ok: boolean, workspaces: object[], wsRoot: string|null, defaultCwd: string|null}}
 *   workspaces 每项：{ cwd, name, source, exists }
 */
export function detectWorkspaces(dshHome) {
  const wsRoot = workspaceRoot(dshHome);
  const disk = workspacesFromDisk(dshHome);
  const fromSessions = workspacesFromSessions(dshHome);
  const map = new Map();

  // 工作区根自身永远是第一个选项（最安全的落点）
  if (disk.root) {
    map.set(disk.root, { cwd: disk.root, name: '工作区', source: 'root', exists: true });
  }

  for (const cwd of disk.dirs) {
    map.set(cwd, { cwd, name: basename(cwd), source: 'disk', exists: true });
  }

  for (const cwd of fromSessions) {
    const prev = map.get(cwd);
    if (prev) {
      prev.source = 'both';
      continue;
    }
    // sessions 反解出来的历史工作区：只有真实存在才加进来
    map.set(cwd, { cwd, name: basename(cwd), source: 'sessions', exists: true });
  }

  const workspaces = [...map.values()].sort((a, b) => {
    // 工作区根排最前，其余按名称排序
    if (a.source === 'root') return -1;
    if (b.source === 'root') return 1;
    return a.name.localeCompare(b.name);
  });

  return {
    ok: true,
    workspaces,
    wsRoot: disk.root ?? wsRoot,
    defaultCwd: disk.root ?? workspaces[0]?.cwd ?? null,
  };
}
