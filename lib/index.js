/**
 * dsh-session-migrate — 插件入口（Host 侧）
 *
 * 把 `<DSH_HOME>/session.old/` 下的低版本日志（v0 等）投放到当前实例需要的格式契约上，
 * 由 DSH 在打开该条记录时自动完成版本迁移。
 *
 * ## 接线的三件事
 *
 *   ① 工具注册    ctx.inject(['tools'])        → 模型可调用 4 个工具
 *   ② 系统提示词  ctx.inject(['systemPrompt']) → 一段会话迁移约定
 *   ③ HTTP API    ctx.inject(['webServer'])    → /api/session-migrate/*
 *
 * 业务实现全在 `lib/engine/*`（帧契约 / 目录布局 / 版本探测 / 导入 / 体检）与
 * `lib/routes.js`，本模块只做接线。引擎可脱离 DSH 独立运行：`node cli.mjs <子命令>`。
 *
 * ## 为什么是「投放」而不是「插件自己转」
 *
 * DSH 的持久化格式是预发布格式，随 harness 版本演进（v0 → v1 → v2 → v3…）。
 * 官方没有迁移命令，但持久化层在**打开记录**时会沿迁移边串行还原。
 * 所以插件只负责「正确投放」，迁移交给 DSH——这样格式再演进也不会过期，
 * 插件不需要跟着改（复刻一份迁移实现等于维护第二套格式契约）。
 *
 * ## 落脚点
 *
 * 旧会话固定放 `<DSH_HOME>/session.old/`（**与 sessions/ 同层级**）。
 * 绝不能放 `sessions/` 里面：该目录根下只允许 `--<cwd编码>--` 形式的目录，
 * 放裸目录会让 DSH 报 unsupported flat-file layout，后果是工作区列表全空。
 *
 * ## 接线约定（实测经验，勿改）
 *
 *   · 工具返回的 block.content 必须是数组，返回裸字符串会损坏会话日志
 *   · systemPrompt.section 的 text() 必须**同步**返回（async 会让模型看到 [object Promise]）
 *   · ctx.log / ctx.workspaceRoot 是 cordis 服务属性，未 inject 时直读会抛
 *     "cannot get property ... without inject" 导致插件树加载失败；一律用 ctx.get() 防御式读取
 *
 * @module dsh-session-migrate
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { checkArtifact, fixLayout } from './engine/inspect.js';
import { importAuto } from './engine/import.js';
import { listSessions } from './engine/layout.js';
import { detectTarget, detectInstallRoot } from './engine/target.js';
import { registerWebRoutes, buildState } from './routes.js';
import { legacyDir } from './legacy.js';

/** 插件名（须与 package.json name 一致）。 */
export const name = 'dsh-session-migrate';

/** 插件版本。 */
export const version = '1.0.2';

/** 系统提示词段落的排序权重（越大越靠后）。 */
const PROMPT_ORDER = 900;

// ───────────────────────── 路径探测 ─────────────────────────

/**
 * 解析 DSH 主目录与安装根。
 *
 * 优先级：
 *   ① 显式配置（config.dshHome）
 *   ② 环境变量 DSH_HOME
 *   ③ 从当前目录向上找 `.dsh`（`<实例根>/…` → 逐级向上）
 *
 * @param {object} config - 插件配置。
 * @returns {{dshHome: string|null, installRoot: string|null, source: string}}
 */
export function resolvePaths(config = {}) {
  const explicit = config.dshHome || process.env.DSH_HOME || '';
  if (explicit && existsSync(explicit)) {
    return {
      dshHome: explicit,
      installRoot: config.installRoot || detectInstallRoot(explicit),
      source: 'env-or-config',
    };
  }

  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, '.dsh');
    if (existsSync(cand)) {
      return { dshHome: cand, installRoot: config.installRoot || dir, source: 'walk-up' };
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return { dshHome: explicit || null, installRoot: config.installRoot || null, source: 'not-found' };
}

// ───────────────────────── 工具定义 ─────────────────────────

/**
 * 动态加载 @deepseek-ai/dsh-tools 的 defineTool。
 *
 * 工作区自测环境没有 DSH 依赖，加载失败返回 null（工具不注册，其它接线照常）。
 *
 * @param {Function} log - 日志函数。
 * @returns {Promise<Function|null>}
 */
async function loadDefineTool(log) {
  try {
    const mod = await import('@deepseek-ai/dsh-tools');
    return typeof mod?.defineTool === 'function' ? mod.defineTool : null;
  } catch (err) {
    log(`加载 @deepseek-ai/dsh-tools 失败（自测环境属正常）: ${err?.message || err}`);
    return null;
  }
}

/**
 * 工具结果渲染器：必须返回块数组（裸字符串会损坏会话日志）。
 *
 * @param {object} _args - 调用参数（未使用）。
 * @param {*} value - 工具返回值。
 * @returns {Array<{type: string, text: string}>}
 */
function textRender(_args, value) {
  return [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }];
}

/**
 * 把简写参数 spec 规范成 DSH 参数形状。
 *
 * @param {object} parameters - 形如 `{ path: 'string', home: 'string?' }`。
 * @returns {object} DSH 参数对象。
 */
function normalizeParameters(parameters = {}) {
  const out = {};
  for (const [key, spec] of Object.entries(parameters || {})) {
    if (spec && typeof spec === 'object') {
      out[key] = { type: String(spec.type || 'string'), description: String(spec.description || '') };
    } else {
      const raw = String(spec || 'string');
      out[key] = { type: raw.replace(/\?$/, '') || 'string', description: '' };
    }
  }
  return out;
}

/**
 * 取目标 home（工具参数优先，其次显式配置 / 环境变量）。
 *
 * @param {object} config - 插件配置。
 * @param {string} [home] - 工具调用传入的 home。
 * @returns {string|null}
 */
function pickHome(config, home) {
  if (home && existsSync(home)) return home;
  return resolvePaths(config).dshHome;
}

/** 工具参数缺 home 时的统一报错（提示可在环境变量 DSH_HOME 提供）。 */
const ERR_NEED_HOME = '需要 home 或设置 DSH_HOME';

/**
 * 把体检结果整理成多行文本（供 session_migrate_check 输出）。
 *
 * @param {string} path - 文件路径。
 * @param {object} r - checkArtifact 的结果。
 * @returns {string}
 */
function formatCheckResult(path, r) {
  const lines = [
    `文件: ${path}`,
    `编码: ${r.plaintext ? '明文 jsonl' : 'zstd'}`,
    '首帧契约: 满足（恰好一行 header）',
    r.plaintext ? `行数: ${r.lines}` : `frame 数: ${r.frameCount}`,
    `会话 id: ${r.id}`,
    `格式版本: v${r.version}`,
    `cwd: ${r.cwd || '(无)'}`,
  ];
  if (!r.plan) return lines.join('\n');
  lines.push(r.plan.steps.length
    ? `迁移路径: ${r.plan.steps.map((s) => `v${s.from}→v${s.to}`).join(' , ')}`
    : (r.plan.alreadyCurrent ? '迁移路径: 已是当前版本' : `迁移路径: 不可迁移（${r.plan.reason}）`));
  return lines.join('\n');
}

/**
 * 把会话列表整理成多行文本（供 session_migrate_list 输出）。
 *
 * @param {string} target - DSH_HOME。
 * @returns {string}
 */
function formatSessionList(target) {
  const { projects, illegal } = listSessions(target);
  const lines = [`DSH_HOME: ${target}`, ''];
  for (const p of projects) {
    lines.push(`── ${p.dir}`);
    for (const s of p.sessions) {
      lines.push(`   ${s.id}`);
      const gens = s.generations.map((g) => `${g.file}(v${g.version},${g.size}B)`).join('  ') || '(无 generation)';
      lines.push(`      ${gens}`);
    }
  }
  if (illegal.length) {
    lines.push('', '⚠ 非法目录（会导致激活失败）:');
    for (const n of illegal) lines.push(`   ${n}`);
    lines.push('   → 运行 session_migrate_fix 移出');
  }
  return lines.join('\n');
}

/**
 * 工具清单（纯函数，便于单测）。
 *
 * @param {object} config - 插件配置。
 * @returns {object[]} 工具定义数组。
 */
export function listTools(config = {}) {
  return [
    {
      name: 'session_migrate_check',
      description:
        '体检一个 DSH 会话文件（.jsonl.zstd 或明文 .jsonl）：校验 zstd 首帧契约（首帧必须恰好一行 header）、'
        + '统计帧数/行数、读取 id/版本/cwd，并给出到当前目标版本的迁移路径。导入前必跑。'
        + '若报「首帧不是恰好一行 header」，说明文件被 zstd 整体重压缩过，需要按帧重建。',
      parameters: normalizeParameters({ path: 'string' }),
      render: textRender,
      execute: async ({ path }) => {
        if (!path) throw new Error('需要 path');
        const paths = resolvePaths(config);
        const r = checkArtifact(path, { home: paths.dshHome, installRoot: paths.installRoot });
        return formatCheckResult(path, r);
      },
    },
    {
      name: 'session_migrate_list',
      description:
        '列出目标 DSH_HOME 下的全部会话（按 cwd 目录分组，显示各 generation 与磁盘版本），并暴露布局问题：'
        + 'sessions/ 根下的非法裸目录会导致 DSH 报 unsupported flat-file layout、workspaceRegistry 激活失败，'
        + '表现为「工作区列表为空 + directoryPickerController is unavailable」。',
      parameters: normalizeParameters({ home: 'string?' }),
      render: textRender,
      execute: async ({ home }) => {
        const target = pickHome(config, home);
        if (!target) throw new Error(ERR_NEED_HOME);
        return formatSessionList(target);
      },
    },
    {
      name: 'session_migrate_fix',
      description:
        '修复布局：把 sessions/ 根下的非法裸目录移出到 <home>/../session-backups/（改名保留，可恢复）。'
        + '用于修复因备份放错位置而导致的 workspaceRegistry 激活失败。',
      parameters: normalizeParameters({ home: 'string?' }),
      render: textRender,
      execute: async ({ home }) => {
        const target = pickHome(config, home);
        if (!target) throw new Error(ERR_NEED_HOME);
        const { moved } = fixLayout(target);
        return moved.length ? `已移出 ${moved.length} 项至 session-backups/` : '布局正常，无需修复';
      },
    },
    {
      name: 'session_migrate_import',
      description:
        '把会话导入目标 DSH_HOME（双路径：源 + 目标 home）。源可以是单个会话文件（zstd 或明文 jsonl），'
        + '也可以是导出包解出的目录（自动带上 subagents/*）。'
        + '明文会在导入时转成 zstd；header 的 cwd 会被改写成目标实例路径（否则 DSH 按 cwd 算目录名会找不到会话）；'
        + '导入后需启动 DSH 打开会话，由持久化层自动完成 v0→v1→v2→v3 迁移。'
        + '注意：本工具不启动/不停止 DSH，迁移应在 DSH 停止时执行。',
      parameters: normalizeParameters({ source: 'string', home: 'string?', cwd: 'string?' }),
      render: textRender,
      execute: async ({ source, home, cwd }) => {
        if (!source) throw new Error('需要 source');
        const target = pickHome(config, home);
        if (!target) throw new Error(ERR_NEED_HOME);
        const r = importAuto({ src: source, home: target, targetCwd: cwd || null });
        return [
          `会话 id: ${r.sid}`,
          `源 cwd: ${r.srcCwd}`,
          `目标 cwd: ${r.targetCwd}`,
          `落盘: ${r.main.dir}  (${r.main.action})`,
          `子会话: ${r.subagents.filter((s) => s.ok).length}/${r.subagents.length} 成功`,
          '',
          '下一步：启动 DSH 并打开该会话，持久化层会自动跑版本迁移。',
        ].join('\n');
      },
    },
  ];
}

// ───────────────────────── 系统提示词 ─────────────────────────

/** 系统提示词：会话迁移的关键约定（text 必须同步返回）。 */
export const promptSection = {
  name: 'session-migrate',
  order: PROMPT_ORDER,
  text: () =>
    '【DSH 会话迁移约定】\n'
    + '· DSH 会话格式随版本演进（0.1.2 写 v0，0.1.5+ 为 v3）；官方无迁移命令，打开会话时持久化层自动沿 v0→v1→v2→v3 还原。\n'
    + '· 投放会话必须满足两项格式契约：\n'
    + '  1) sessions/ 根下只允许 --<cwd编码>-- 目录，裸目录会导致 workspaceRegistry 激活失败（工作区列表为空）。\n'
    + '  2) session.jsonl.zstd 首帧必须恰好一行 header；用 zstd 整体重压缩会合并帧并导致读取失败。\n'
    + '· 会话 header 的 cwd 必须指向目标实例的实际路径，否则按 cwd 推导的目录名对不上。\n'
    + '· 导入后需重新启动 DSH 并打开会话，迁移才发生；迁移产物是新的 session.v<N>.jsonl.zstd，源文件保留。',
};

// ───────────────────────── 插件入口 ─────────────────────────

/**
 * 插件入口（DSH 调用）。
 *
 * @param {object} ctx - cordis 上下文。
 * @param {object} [config] - 插件配置。
 */
export async function apply(ctx, config = {}) {
  const serviceLog = ctx?.get?.('log');
  const log = serviceLog?.info?.bind(serviceLog)
    || ((...args) => console.log('[session-migrate]', ...args));

  const paths = resolvePaths(config);
  if (!paths.dshHome) {
    log('[dsh-session-migrate] 未能定位 DSH 主目录，插件不注册任何能力');
    return;
  }
  const deps = { dshHome: paths.dshHome, installRoot: paths.installRoot };

  const tools = listTools(config);
  log(`[session-migrate] v${version} 接线开始（${tools.length} 个工具）`);

  // 启动时探测一次，把关键信息写进日志（便于排查「版本没探到」这类问题）
  try {
    const target = detectTarget(paths.installRoot);
    log(
      `[session-migrate] DSH_HOME=${paths.dshHome} 旧会话目录=${legacyDir(paths.dshHome)} `
      + `目标版本=${target.currentVersion ?? '未探测到'}（来源: ${target.source}）`,
    );
  } catch (err) {
    log(`[session-migrate] 环境探测失败: ${String(err?.message ?? err)}`);
  }

  if (typeof ctx?.inject !== 'function') {
    log('[session-migrate] ctx.inject 不可用，跳过全部注册');
    return;
  }

  // ① 工具注册：ctx.inject(['tools']) → get('tools').register(defineTool(spec))
  const defineTool = await loadDefineTool(log);
  if (typeof defineTool !== 'function') {
    log('[session-migrate] defineTool 不可用，工具未注册（CLI 仍可用：node cli.mjs）');
  } else {
    ctx.inject(['tools'], (tctx) => registerTools({ log, registry: tctx?.get?.('tools'), tools, defineTool }));
  }

  // ② 系统提示词（text 必须是同步函数，否则模型看到 [object Promise]）
  ctx.inject(['systemPrompt'], (sctx) => {
    const prompt = sctx?.get?.('systemPrompt');
    if (!prompt?.section) { log('[session-migrate] systemPrompt 服务不可用，跳过注入'); return; }
    try {
      prompt.section(promptSection);
      log('[session-migrate] 已注入会话迁移约定');
    } catch (err) {
      log(`[session-migrate] 提示词注入失败: ${err?.message || err}`);
    }
  });

  // ③ HTTP API
  ctx.inject(['webServer'], (wctx) => {
    const webServer = wctx?.get?.('webServer');
    if (!webServer?.register) { log('[session-migrate] webServer 服务不可用，跳过 HTTP 注册'); return; }
    try {
      registerWebRoutes(webServer, deps);
      log('[session-migrate] 已注册 /api/session-migrate/* 接口');
    } catch (err) {
      log(`[session-migrate] HTTP 注册失败: ${err?.message || err}`);
    }
  });
}

/**
 * 把工具清单注册进宿主 tools 服务（逐个 try，单个失败不中断）。
 *
 * @param {object} o - { log, registry, tools, defineTool }。
 */
function registerTools({ log, registry, tools, defineTool }) {
  if (!registry?.register) { log('[session-migrate] tools 服务不可用，工具未注册'); return; }
  let registered = 0;
  for (const tool of tools) {
    try {
      registry.register(defineTool(tool));
      registered += 1;
    } catch (err) {
      log(`[session-migrate] 工具 ${tool.name} 注册失败: ${err?.message || err}`);
    }
  }
  log(`[session-migrate] 已注册 ${registered}/${tools.length} 个工具`);
}

export { buildState };
