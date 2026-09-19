/**
 * 预览页假数据：/api/session-migrate/state 的响应体。
 *
 * 字段与真实 buildState（lib/routes.js）逐项一致，并刻意造出各种状态
 * （待转换 / 已转换 / 不可迁移 / 不可读 / cwd 越界），以便一屏看全界面分支。
 *
 * 注意：会话 id 不要写成 `session-<8位以上十六进制>` 形态，
 * 审计规则 conv-session-ref 会把这类字符串判为文档泄漏会话标识。
 */

/* ───── 假数据：/api/session-migrate/state 的响应体（字段与真实 buildState 逐项一致） ─────
 * 真实字段见 lib/routes.js buildState：targetVersion / targetVersionSource / targetInstallRoot /
 * migrations / readable / legacyDir / dshHome / workspaces[{cwd,name,source,exists}] / defaultCwd /
 * wsRoot / sessionsLayoutOk / offenders / sessions[] / summary{total,pending,converted,unreadable,unmigratable}。
 *
 * 刻意造出各种状态：待转换、已转换、不可迁移、不可读、cwd 越界，以便一屏看全分支。
 */
const LEGACY_DIR = '<DSH 数据目录>/session.old';
const WS_ROOT = '<DSH 数据目录>/工作区';

const WORKSPACES = [
  { cwd: WS_ROOT, name: '工作区', source: 'root', exists: true },
  { cwd: `${WS_ROOT}/dsh-session-migrate`, name: 'dsh-session-migrate', source: 'root', exists: true },
  { cwd: `${WS_ROOT}/dsh-skill-scoreboard`, name: 'dsh-skill-scoreboard', source: 'root', exists: true },
  { cwd: '/volume1/@appdata/…/0.1.5-alpha.1/工作区', name: '旧版本工作区', source: 'legacy', exists: false },
];

const SESSIONS = [
  ['72f9c1d0-4f2b-4a81-9d3e-0a1b2c3d4e01', 0, [], 38700099, `${WS_ROOT}/dsh-session-migrate`],
  ['72f9c1d0-4f2b-4a81-9d3e-0a1b2c3d4e02', 0, [1, 2], 12204032, `${WS_ROOT}/dsh-session-migrate`],
  ['72f9c1d0-4f2b-4a81-9d3e-0a1b2c3d4e03', 0, [1, 2, 3], 8842112, `${WS_ROOT}/dsh-skill-scoreboard`],
  ['72f9c1d0-4f2b-4a81-9d3e-0a1b2c3d4e04', 3, [3], 5509121, `${WS_ROOT}/dsh-skill-scoreboard`],
  ['72f9c1d0-4f2b-4a81-9d3e-0a1b2c3d4e05', 0, [], 2097152, '/volume1/@appdata/…/0.1.5-alpha.1/工作区'],
  ['72f9c1d0-4f2b-4a81-9d3e-0a1b2c3d4e06', 0, [], 512000, null],
];

/** 迁移边（与真实 target.migrations 同形）。 */
const MIGRATIONS = [
  { from: 0, to: 1, name: 'sessionFormatV0ToV1' },
  { from: 1, to: 2, name: 'sessionFormatV1ToV2' },
  { from: 2, to: 3, name: 'sessionFormatV2ToV3' },
];

const FAKE = {
  ok: true,
  targetVersion: 3,
  targetVersionSource: '<安装根>/packages/session/session-format-catalog/src/generated.ts',
  targetInstallRoot: '<安装根>',
  migrations: MIGRATIONS,
  readable: true,
  legacyDir: LEGACY_DIR,
  dshHome: '<DSH 数据目录>',
  workspaces: WORKSPACES,
  defaultCwd: WS_ROOT,
  wsRoot: WS_ROOT,
  // 故意置 false 并给一个越界目录，用于覆盖布局告警分支
  sessionsLayoutOk: false,
  offenders: ['72f9c1d0-4f2b-4a81-9d3e-0a1b2c3d4e06.jsonl.zstd'],
  sessions: SESSIONS.map(([id, version, convertedVersions, size, cwd]) => ({
    file: `${LEGACY_DIR}/${id}.jsonl.zstd`,
    name: `${id}.jsonl.zstd`,
    dirName: null,
    id,
    cwd,
    version,
    size,
    readable: true,
    frameCount: 128,
    headerOk: true,
    headerNote: null,
    createdAt: '2026-08-14T09:12:33.000Z',
    convertedVersions,
  })).concat([{
    file: `${LEGACY_DIR}/broken-legacy.jsonl.zstd`,
    name: 'broken-legacy.jsonl.zstd',
    dirName: null,
    id: 'broken-legacy',
    cwd: WS_ROOT,
    version: null,
    size: 40960,
    readable: false,
    frameCount: 0,
    headerOk: false,
    headerNote: '首帧不是合法 JSON：zstd 解压后前 64 字节不可解析',
    createdAt: null,
    convertedVersions: [],
  }]),
  summary: { total: 7, pending: 4, converted: 1, unreadable: 1, unmigratable: 1 },
};

export { LEGACY_DIR, WS_ROOT, WORKSPACES, MIGRATIONS, FAKE };
