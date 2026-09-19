(() => {
// dsh-session-migrate — 浏览器半侧
// 设置 → 侧边栏 →「会话迁移」独立页面，四个分区：
//   环境   目标版本 / 旧会话目录 / 版本来源 / 工作区根（只读状态，含待转换计数）
//   导入   选择旧会话导出文件（.zip / .jsonl / .jsonl.zstd）上传到 session.old/
//   列表   扫描 session.old/ 的旧会话，勾选后可转换；显示 cwd / 版本 / 大小 / 已转换版本
//   转换   选目标工作区 → 投放选中项（改写 cwd），随后由 DSH 读取该条记录时自动迁移
// 数据来自宿主端接口 /api/session-migrate/*（lib/routes.js 注册）。
//
// Client entries must be classic scripts registered via window.__ModuleLoader__.load
// ({ id, factory }); the factory receives a synchronous `require`.
//
// 宿主 require 只认模块表词（seed / 已注册工厂），不支持相对路径 JSON——
// 因此 i18n 字典经宿主 GET /api/session-migrate/i18n 拉取，不 require('./i18n/zh.json')。
//
// 为什么是单文件：DSH 客户端模块系统只读 exports["./client"] 指向的**单个**文件
// （packages/client/modules 里 readFileSync(clientPath)），官方插件同样是「源码分多文件
// + tsdown 打成单文件产物」。本插件刻意零依赖，不引入构建链，因此源码即产物：
// 用内部分区注释 + 小函数替代目录拆分，行数由清晰的段落组织承担可读性。
//
// dsh-skip-size —— 单文件是宿主契约要求的形态，无法靠拆文件降行数；
// 本文件 481 行代码 + 239 行注释，段落以 ─── 分隔，单函数均短小。

/**
 * 宿主注入的 React（createModule 时赋值）。
 *
 * 顶层组件函数共用此引用，因此不能做成模块局部变量：factory 只在
 * ModuleLoader 消费队列时被调用一次，而组件渲染发生在之后。
 */
let smReactRef = null

/** 字典命名空间。 */
const NS_ID = 'dsh-session-migrate'

/** 侧边栏排序（与其它插件的 settings.section 条目错开）。 */
const SETTINGS_SECTION_ORDER = 60

/** 接口请求超时（毫秒）。 */
const FETCH_TIMEOUT_MS = 15000

/** 列表里会话 id 的展示长度（完整 id 过长会撑破列宽）。 */
const ID_DISPLAY_LEN = 20

/** 提示文案里会话 id 的展示长度（比列表更短，避免提示被 id 挤占）。 */
const ID_NOTICE_LEN = 12

/**
 * 外置字典：只保留**首屏同步渲染必需**的词条。
 *
 * `slots.register` 的 `label()` 会被宿主**同步**调用，此时 `/i18n` 尚未返回，
 * 因此导航标签必须在源码内可同步取到。其余词条（各分区标题/按钮/提示等）
 * 都在首次渲染前后由 `loadDict()` 补齐，无需在此重复——
 * 权威字典在 `lib/i18n/{zh,en}.json`（各 62 键），此处重复会形成两份事实来源。
 */
const dict = {
  zh: {
    'settings.title': '会话迁移',
    'common.loading': '加载中…',
  },
  en: {
    'settings.title': 'Session migrate',
    'common.loading': 'Loading…',
  },
}


/**
 * 取 API 前缀下的完整地址。
 *
 * @param {string} path - 以 / 开头的子路径（如 '/state'）。
 * @returns {string} 完整 URL。
 */
function apiUrl(path) {
  return `/api/session-migrate${path}`
}

/**
 * 发一次 JSON 请求。
 *
 * @param {string} path - API 子路径。
 * @param {object} [opts] - { method, body }。
 * @returns {Promise<object>} 解析后的 JSON。
 * @throws 网络错误、非 2xx、JSON 解析失败时抛错。
 */
async function apiFetch(path, opts = {}) {
  const init = {
    method: opts.method ?? 'GET',
    credentials: 'same-origin',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  };
  if (opts.body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(opts.body);
  }
  const response = await fetch(apiUrl(path), init);
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`响应不是 JSON（HTTP ${response.status}）`);
  }
  if (!response.ok && json?.ok !== true) {
    throw new Error(json?.error ? String(json.error) : `HTTP ${response.status}`);
  }
  return json;
}

// ───────────────────────── i18n ─────────────────────────

/** 当前 locale ctx（apply 时挂上）。 */
let localeCtx = null
/** 已拉取的外置字典（按语言）。 */
const remoteDict = { zh: {}, en: {} }
/** 字典变更订阅者。 */
const dictListeners = new Set()

/**
 * 取当前语言 id。
 *
 * @returns {string} 'zh' 或 'en'。
 */
function activeLocaleId() {
  try {
    const snap = localeCtx && typeof localeCtx.getLocale === 'function' ? localeCtx.getLocale() : null
    if (snap && typeof snap.id === 'string') return snap.id
    if (snap && typeof snap.locale === 'string') return snap.locale
  } catch { /* locale 读取失败，降级中文 */ }
  return 'zh'
}

/**
 * 取词条，支持 {name} 占位。
 *
 * @param {string} key - 词条键。
 * @param {object} [vars] - 占位变量。
 * @returns {string} 词条文本（缺失时回退键名）。
 */
function tr(key, vars) {
  const lang = activeLocaleId()
  const text = lookup(key, lang)
  return vars ? fill(text, vars) : text
}

/**
 * 查词：当前语言 → 中文 → 键名。
 *
 * @param {string} key - 词条键。
 * @param {string} lang - 语言 id。
 * @returns {string} 词条文本。
 */
function lookup(key, lang) {
  const hit = (remoteDict[lang] ?? {})[key] ?? (dict[lang] ?? {})[key]
  if (hit !== undefined) return hit
  const fallback = (remoteDict.zh ?? {})[key] ?? (dict.zh ?? {})[key]
  return fallback !== undefined ? fallback : key
}

/**
 * 替换 {name} 占位。
 *
 * @param {string} text - 含占位的文本。
 * @param {object} vars - 占位变量。
 * @returns {string} 替换后的文本。
 */
function fill(text, vars) {
  let out = text
  for (const [k, v] of Object.entries(vars)) out = out.split(`{${k}}`).join(String(v))
  return out
}

/**
 * 订阅字典变更（拉取完成后通知重渲染）。
 *
 * @param {Function} listener - 变更回调。
 * @returns {Function} 取消订阅。
 */
function subscribeDict(listener) {
  dictListeners.add(listener)
  return () => dictListeners.delete(listener)
}

/** 拉取外置字典（fire-and-forget，失败静默保留同步兜底）。 */
function loadDict() {
  fetch(apiUrl('/i18n'), { credentials: 'same-origin', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
    .then((res) => (res.ok ? res.json() : null))
    .then((payload) => {
      if (!payload || typeof payload !== 'object') return
      for (const lang of ['zh', 'en']) {
        if (payload[lang] && typeof payload[lang] === 'object') remoteDict[lang] = payload[lang]
      }
      for (const listener of dictListeners) {
        try { listener() } catch { /* 单个订阅者异常不影响其它 */ }
      }
    })
    .catch(() => { /* 字典拉取失败：保留同步兜底 */ })
}

// ───────────────────────── 样式 ─────────────────────────

/** 页面样式（前缀 dshsm_ 避免与其它插件冲突）。 */
const cssText = `
.dshsm_root{display:flex;flex-direction:column;gap:14px;font-size:13px;line-height:1.5}
.dshsm_lead{color:var(--dsw-alias-label-secondary);font-size:12px;margin:0}
.dshsm_card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px}
.dshsm_cardTitle{font-size:13px;font-weight:600;margin:0 0 8px}
.dshsm_grid{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;font-size:12px}
.dshsm_key{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshsm_val{font-family:var(--dsw-font-mono);word-break:break-all}
.dshsm_badges{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}
.dshsm_badge{border-radius:6px;padding:2px 8px;font-size:11px;background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-secondary)}
.dshsm_badgeWarn{background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-warning,#c60)}
.dshsm_row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dshsm_btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-fill-l2);color:var(--dsw-alias-label-primary);border-radius:7px;padding:5px 12px;font-size:12px;cursor:pointer}
.dshsm_btn:hover:not(:disabled){background:var(--dsw-alias-fill-l3,var(--dsw-alias-fill-l2))}
.dshsm_btn:disabled{opacity:.5;cursor:not-allowed}
.dshsm_btnPrimary{background:var(--dsw-alias-brand-primary,#3b6cf5);color:#fff;border-color:transparent}
.dshsm_select{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-fill-l1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:5px 8px;font-size:12px;max-width:100%}
.dshsm_table{width:100%;border-collapse:collapse;font-size:12px}
.dshsm_table th{text-align:left;color:var(--dsw-alias-label-tertiary);font-weight:500;padding:5px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}
.dshsm_table td{padding:5px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:middle}
.dshsm_mono{font-family:var(--dsw-font-mono);font-size:11px}
.dshsm_empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:8px 0}
.dshsm_hint{color:var(--dsw-alias-label-tertiary);font-size:11px;margin:6px 0 0}
.dshsm_err{color:var(--dsw-alias-label-error,#d33);font-size:12px}
.dshsm_ok{color:var(--dsw-alias-label-success,#2a2);font-size:12px}
`

/** 挂载样式表（幂等）。 */
function ensureCss() {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css="${NS_ID}"]`)) return
  const tag = document.createElement('style')
  tag.dataset.plugin = NS_ID
  tag.dataset.pluginCss = NS_ID
  tag.textContent = cssText
  document.head.appendChild(tag)
}

// ───────────────────────── 小工具 ─────────────────────────

/**
 * 人类可读字节数。
 *
 * @param {number} n - 字节数。
 * @returns {string} 形如 "12.3 KB"。
 */
function fmtSize(n) {
  const num = Number(n)
  if (!Number.isFinite(num) || num < 0) return '-'
  if (num < 1024) return `${num} B`
  const units = ['KB', 'MB', 'GB']
  let scaled = num / 1024
  let idx = 0
  while (scaled >= 1024 && idx < units.length - 1) { scaled /= 1024; idx += 1 }
  return `${scaled.toFixed(1)} ${units[idx]}`
}

/**
 * 格式化版本号。
 *
 * @param {number|null|undefined} v - 版本号。
 * @returns {string} 形如 "v3"，未知返回 "-"。
 */
function fmtVersion(v) {
  return (v === null || v === undefined) ? '-' : `v${v}`
}

/**
 * 「已转换版本」列文案。
 *
 * host 返回的 `convertedVersions` 是**已产出的版本数组**（可能多个，如 [1,2,3]）；
 * 是否已转换到目标版本由数组是否包含 targetVersion 决定（与 host 的 summary 口径一致）。
 *
 * @param {object} session - 会话条目。
 * @param {number|null} targetVersion - 目标版本。
 * @returns {string} 形如 "v3" / "v1, v2" / "未转换"。
 */
function fmtConverted(session, targetVersion) {
  const versions = Array.isArray(session?.convertedVersions) ? session.convertedVersions : []
  if (!versions.length) return tr('list.notConverted')
  const text = versions.map((v) => fmtVersion(v)).join(', ')
  // 已产出目标版本时加个对勾，避免与「产出的是中间版本」混淆
  return (targetVersion !== null && targetVersion !== undefined && versions.includes(targetVersion))
    ? `${text} ✓`
    : text
}

// ───────────────────────── 页面组件 ─────────────────────────

/**
 * 页面状态与动作（hooks 组装，与视图分开以便各自保持短小）。
 *
 * @returns {object} { state, actions, selection, workspace, busy, notice, fileRef }。
 */
function usePageState() {
  const [, forceRender] = smReactRef.useReducer((x) => x + 1, 0)
  const [state, setState] = smReactRef.useState({ loading: true, error: null, data: null })
  const [selected, setSelected] = smReactRef.useState(() => new Set())
  const [workspace, setWorkspace] = smReactRef.useState('')
  const [busy, setBusy] = smReactRef.useState(null)
  const [notice, setNotice] = smReactRef.useState(null)
  const fileRef = smReactRef.useRef(null)

  const load = smReactRef.useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }))
    try {
      const next = await apiFetch('/state')
      setState({ loading: false, error: null, data: next })
      setWorkspace((cur) => cur || next.defaultCwd || next.workspaces?.[0]?.cwd || '')
    } catch (err) {
      setState({ loading: false, error: String(err?.message ?? err), data: null })
    }
  }, [])

  smReactRef.useEffect(() => { load() }, [load])
  // 字典拉取完成后重渲染（词条从外置 JSON 补齐）
  smReactRef.useEffect(() => subscribeDict(forceRender), [])

  const sessions = state.data?.sessions ?? []
  const selection = {
    selected,
    toggle: (id) => setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    }),
    toggleAll: (on) => setSelected(on ? new Set(sessions.map((s) => s.id)) : new Set()),
  }
  return {
    state,
    sessions,
    selection,
    workspace,
    setWorkspace,
    busy,
    setBusy,
    notice,
    setNotice,
    fileRef,
    load,
  }
}

/**
 * 会话迁移设置页。
 *
 * @returns {object} React 元素。
 */
function MigratePage() {
  const p = usePageState()
  ensureCss()

  return smReactRef.createElement('div', { className: 'dshsm_root' },
    smReactRef.createElement('p', { className: 'dshsm_lead' }, tr('settings.desc')),
    p.state.error
      ? smReactRef.createElement('p', { className: 'dshsm_err' }, tr('common.error', { err: p.state.error }))
      : null,
    renderStatus(p.state.data, p.state.loading, p.load),
    p.notice
      ? smReactRef.createElement('p', { className: p.notice.ok ? 'dshsm_ok' : 'dshsm_err' }, p.notice.text)
      : null,
    renderImport({
      busy: p.busy,
      setBusy: p.setBusy,
      setNotice: p.setNotice,
      load: p.load,
      fileRef: p.fileRef,
      legacyDir: p.state.data?.legacyDir ?? null,
    }),
    renderList({
      sessions: p.sessions,
      selection: p.selection,
      loading: p.state.loading,
      targetVersion: p.state.data?.targetVersion ?? null,
    }),
    renderConvert({
      data: p.state.data,
      selection: p.selection,
      workspace: p.workspace,
      setWorkspace: p.setWorkspace,
      busy: p.busy,
      setBusy: p.setBusy,
      setNotice: p.setNotice,
      load: p.load,
    }),
  )
}

/**
 * 环境分区的键值行（无数据时为空数组）。
 *
 * 标签一律用**独立词条**：像 status.badgeTotal（「共 {n}」）那种整短语不能当标签，
 * 否则标签位置会原样露出 {n}。
 *
 * @param {object|null} data - /state 返回。
 * @returns {Array<[string, string]>} [词条键, 值] 列表。
 */
function statusRows(data) {
  if (!data) return []
  const source = data.targetVersionSource ? `（${data.targetVersionSource}）` : ''
  return [
    ['status.targetVersion', fmtVersion(data.targetVersion) + source],
    ['status.legacyDir', data.legacyDir ?? '-'],
    ['status.workspace', data.wsRoot ?? '-'],
    ['status.total', String(data.summary?.total ?? 0)],
  ]
}

/**
 * 渲染「环境」分区。
 *
 * @param {object|null} data - /state 返回。
 * @param {boolean} loading - 是否加载中。
 * @param {Function} load - 重新加载。
 * @returns {object} React 元素。
 */
function renderStatus(data, loading, load) {
  const rows = statusRows(data)
  return smReactRef.createElement('div', { className: 'dshsm_card' },
    renderStatusHeader(loading, load),
    renderStatusGrid(rows),
    renderStatusBadges(data),
  )
}

/**
 * 「环境」分区标题行（标题 + 刷新按钮）。
 *
 * @param {boolean} loading - 是否加载中。
 * @param {Function} load - 重新加载。
 * @returns {object} React 元素。
 */
function renderStatusHeader(loading, load) {
  return smReactRef.createElement('div', { className: 'dshsm_row' },
    smReactRef.createElement('h3', { className: 'dshsm_cardTitle' }, tr('status.title')),
    smReactRef.createElement('button', {
      className: 'dshsm_btn', onClick: load, disabled: loading,
    }, loading ? tr('common.loading') : tr('common.refresh')),
  )
}

/**
 * 「环境」键值网格（无数据时显示加载占位）。
 *
 * @param {Array<[string,string]>} rows - [词条键, 展示值] 列表。
 * @returns {object} React 元素。
 */
function renderStatusGrid(rows) {
  if (!rows.length) {
    return smReactRef.createElement('div', { className: 'dshsm_empty' }, tr('common.loading'))
  }
  return smReactRef.createElement('div', { className: 'dshsm_grid' },
    rows.flatMap(([key, value]) => [
      smReactRef.createElement('div', { className: 'dshsm_key', key: `${key}-k` }, tr(key)),
      smReactRef.createElement('div', { className: 'dshsm_val', key: `${key}-v` }, String(value)),
    ]))
}

/**
 * 「环境」计数徽标（待转换 / 已转换 / 布局告警）。
 *
 * @param {object|null} data - /state 返回。
 * @returns {object|null} React 元素；无数据时为 null。
 */
function renderStatusBadges(data) {
  if (!data) return null
  const badges = [
    smReactRef.createElement('span', { className: 'dshsm_badge', key: 'pending' },
      tr('status.badgePending', { n: data.summary?.pending ?? 0 })),
    smReactRef.createElement('span', { className: 'dshsm_badge', key: 'converted' },
      tr('status.badgeConverted', { n: data.summary?.converted ?? 0 })),
  ]
  if (data.sessionsLayoutOk === false) {
    badges.push(smReactRef.createElement('span', {
      className: 'dshsm_badge dshsm_badgeWarn', key: 'layout',
    }, tr('status.layoutWarn', { dirs: (data.offenders ?? []).join(', ') })))
  }
  return smReactRef.createElement('div', { className: 'dshsm_badges' }, badges)
}

/**
 * 上传选中的旧会话文件（multipart），并把结果写进 notice。
 *
 * @param {FileList|Array} picked - 选中的文件。
 * @param {object} ctx - { setBusy, setNotice, load }。
 * @returns {Promise<void>} 完成后 resolve。
 */
async function uploadLegacyFiles(picked, ctx) {
  const { setBusy, setNotice, load } = ctx
  const files = Array.from(picked ?? [])
  if (!files.length) { setNotice({ ok: false, text: tr('import.noFile') }); return }
  setBusy('import')
  setNotice(null)
  try {
    const form = new FormData()
    for (const f of files) form.append('files', f, f.name)
    const response = await fetch(apiUrl('/import'), {
      method: 'POST',
      credentials: 'same-origin',
      body: form,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 4),
    })
    const payload = await response.json()
    const ok = payload?.imported?.length ?? 0
    const failed = payload?.failed ?? []
    const detail = failed.map((f) => tr('import.failItem', { name: f.name, err: f.err })).join(' ; ')
    setNotice({
      ok: failed.length === 0,
      text: tr('import.result', { ok, fail: failed.length }) + (detail ? ' · ' + detail : ''),
    })
    await load()
  } catch (err) {
    setNotice({ ok: false, text: String(err?.message ?? err) })
  } finally {
    setBusy(null)
  }
}

/**
 * 渲染「导入」分区。
 *
 * @param {object} ctx - { busy, setBusy, setNotice, load, fileRef, legacyDir }。
 * @returns {object} React 元素。
 */
function renderImport(ctx) {
  const { busy, setBusy, setNotice, load, fileRef, legacyDir } = ctx
  /**
   * 文件选择回调：先取文件快照，再清空 input 值。
   *
   * 顺序不能颠倒：`input.value = ''` 会清空该 input 的 selected files list，
   * 而 `ev.target.files` 返回的 FileList 在部分浏览器（WebKit/Chromium）是
   * 绑定到 input 的**活视图**，清空后旧引用长度变 0——若先清空再传引用，
   * uploadLegacyFiles 会拿到空数组，用户看到「未选择任何文件」。
   * 因此必须 `Array.from` 快照在前、`value = ''` 在后。
   *
   * @param {object} ev - change 事件。
   */
  const onPick = (ev) => {
    const files = Array.from(ev.target.files ?? [])
    ev.target.value = ''
    return uploadLegacyFiles(files, { setBusy, setNotice, load })
  }
  return smReactRef.createElement('div', { className: 'dshsm_card' },
    smReactRef.createElement('h3', { className: 'dshsm_cardTitle' }, tr('import.title')),
    smReactRef.createElement('p', { className: 'dshsm_hint' }, tr('import.desc', { dir: legacyDir ?? '-' })),
    smReactRef.createElement('div', { className: 'dshsm_row' },
      smReactRef.createElement('input', {
        ref: fileRef, type: 'file', multiple: true, style: { display: 'none' },
        accept: '.zip,.jsonl,.jsonl.zstd,.zstd,application/zip',
        onChange: onPick,
      }),
      smReactRef.createElement('button', {
        className: 'dshsm_btn dshsm_btnPrimary',
        disabled: busy === 'import',
        onClick: () => fileRef.current?.click(),
      }, busy === 'import' ? tr('import.importing') : tr('import.button')),
    ),
  )
}

/**
 * 渲染「列表」分区。
 *
 * @param {object} ctx - { sessions, selected, toggle, toggleAll, loading }。
 * @returns {object} React 元素。
 */
function renderList(ctx) {
  const { sessions, selection, loading, targetVersion } = ctx
  const { selected, toggle, toggleAll } = selection
  if (loading && !sessions.length) {
    return smReactRef.createElement('div', { className: 'dshsm_card' },
      smReactRef.createElement('h3', { className: 'dshsm_cardTitle' }, tr('list.title')),
      smReactRef.createElement('div', { className: 'dshsm_empty' }, tr('common.loading')))
  }
  if (!sessions.length) {
    return smReactRef.createElement('div', { className: 'dshsm_card' },
      smReactRef.createElement('h3', { className: 'dshsm_cardTitle' }, tr('list.title')),
      smReactRef.createElement('div', { className: 'dshsm_empty' }, tr('list.empty')))
  }
  const header = smReactRef.createElement('tr', null,
    smReactRef.createElement('th', null, tr('list.colSelect')),
    smReactRef.createElement('th', null, tr('list.colId')),
    smReactRef.createElement('th', null, tr('list.colCwd')),
    smReactRef.createElement('th', null, tr('list.colVersion')),
    smReactRef.createElement('th', null, tr('list.colConverted')),
    smReactRef.createElement('th', null, tr('list.colSize')),
  )
  const body = sessions.map((s) => smReactRef.createElement('tr', { key: s.id },
    smReactRef.createElement('td', null,
      smReactRef.createElement('input', {
        type: 'checkbox', checked: selected.has(s.id), onChange: () => toggle(s.id),
      })),
    smReactRef.createElement('td', { className: 'dshsm_mono' }, String(s.id).slice(0, ID_DISPLAY_LEN)),
    smReactRef.createElement('td', { className: 'dshsm_mono' }, s.cwd ?? tr('common.none')),
    smReactRef.createElement('td', null, fmtVersion(s.version)),
    smReactRef.createElement('td', null, fmtConverted(s, targetVersion)),
    smReactRef.createElement('td', null, fmtSize(s.size)),
  ))
  return smReactRef.createElement('div', { className: 'dshsm_card' },
    smReactRef.createElement('div', { className: 'dshsm_row' },
      smReactRef.createElement('h3', { className: 'dshsm_cardTitle' }, tr('list.title')),
      smReactRef.createElement('button', { className: 'dshsm_btn', onClick: () => toggleAll(true) }, tr('list.selectAll')),
      smReactRef.createElement('button', { className: 'dshsm_btn', onClick: () => toggleAll(false) }, tr('list.selectNone')),
      smReactRef.createElement('span', { className: 'dshsm_hint' }, tr('list.selectedCount', { n: selected.size })),
    ),
    smReactRef.createElement('table', { className: 'dshsm_table' },
      smReactRef.createElement('thead', null, header),
      smReactRef.createElement('tbody', null, body)),
  )
}

/**
 * 渲染「转换」分区。
 *
 * @param {object} ctx - { data, selection, workspace, setWorkspace, busy, setBusy, setNotice, load }。
 * @returns {object} React 元素。
 */
function renderConvert(ctx) {
  const { data, selection, workspace, setWorkspace, busy, setBusy, setNotice, load } = ctx
  const { selected } = selection
  const workspaces = data?.workspaces ?? []
  const onConvert = () => convertSelected(selected, workspace, { setBusy, setNotice, load })
  return smReactRef.createElement('div', { className: 'dshsm_card' },
    smReactRef.createElement('h3', { className: 'dshsm_cardTitle' }, tr('convert.title')),
    smReactRef.createElement('p', { className: 'dshsm_hint' }, tr('convert.desc')),
    smReactRef.createElement('div', { className: 'dshsm_row' },
      smReactRef.createElement('span', { className: 'dshsm_key' }, tr('convert.workspaceLabel')),
      smReactRef.createElement('select', {
        className: 'dshsm_select', value: workspace, onChange: (e) => setWorkspace(e.target.value),
      },
        smReactRef.createElement('option', { value: '' }, tr('workspace.empty')),
        workspaces.map((w) => smReactRef.createElement('option', { key: w.cwd, value: w.cwd },
          `${w.name} — ${w.cwd}`)),
      ),
      smReactRef.createElement('button', {
        className: 'dshsm_btn dshsm_btnPrimary',
        disabled: busy === 'convert',
        onClick: onConvert,
      }, busy === 'convert' ? tr('convert.converting') : tr('convert.button')),
    ),
    smReactRef.createElement('p', { className: 'dshsm_hint' }, tr('convert.workspaceHint')),
  )
}

/**
 * 把选中的旧会话投放到目标工作区。
 *
 * @param {Set<string>} selected - 选中的会话 id。
 * @param {string} workspace - 目标工作区 cwd。
 * @param {object} ctx - { setBusy, setNotice, load }。
 * @returns {Promise<void>} 完成后 resolve。
 */
async function convertSelected(selected, workspace, ctx) {
  const { setBusy, setNotice, load } = ctx
  if (!selected.size) { setNotice({ ok: false, text: tr('convert.noSelection') }); return }
  if (!workspace) { setNotice({ ok: false, text: tr('convert.noWorkspace') }); return }
  setBusy('convert')
  setNotice(null)
  try {
    const r = await apiFetch('/convert', {
      method: 'POST',
      body: { ids: Array.from(selected), cwd: workspace, trigger: true },
    })
    setNotice(convertNotice(r.results ?? []))
    await load()
  } catch (err) {
    setNotice({ ok: false, text: String(err?.message ?? err) })
  } finally {
    setBusy(null)
  }
}

/**
 * 把转换结果整理成提示文案。
 *
 * @param {Array<object>} results - 每条 { id, ok, error }。
 * @returns {{ok: boolean, text: string}} 提示对象。
 */
function convertNotice(results) {
  const succeeded = results.filter((x) => x.ok).length
  const failure = results.filter((x) => !x.ok)
  const removed = results.reduce((n, x) => n + (Array.isArray(x.removedDuplicates) ? x.removedDuplicates.length : 0), 0)
  const detail = failure
    .map((x) => tr('convert.failItem', { id: String(x.id).slice(0, ID_NOTICE_LEN), err: x.error }))
    .join(' ; ')
  return {
    ok: failure.length === 0,
    text: tr('convert.result', { ok: succeeded, fail: failure.length })
      + (succeeded ? ` · ${tr('convert.done')}` : '')
      + (removed > 0 ? ` · ${tr('convert.deduped', { n: removed })}` : '')
      + (detail ? ' · ' + detail : ''),
  }
}

// ───────────────────────── 模块装配 ─────────────────────────

/**
 * 模块装配：由 ModuleLoader 的 factory 调用，返回插件 exports。
 *
 * @param {Function} require - 宿主注入的同步 require（仅 react）。
 * @returns {object} 插件模块导出对象（name/inject/apply）。
 */
function createModule(require) {
  const module = { exports: {} }
  const exports = module.exports
  Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

  const React = require('react')
  smReactRef = React

  const name = 'dsh-session-migrate'
  const inject = ['slots', 'locale']

  /**
   * 插件客户端入口。
   *
   * @param {object} ctx - 客户端 cordis 上下文。
   */
  function apply(ctx) {
    localeCtx = ctx.locale ?? null
    const disposeDict = registerDictionary(ctx)
    registerSettingsSection(ctx, React)
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => disposeDict, 'dsh-session-migrate: dictionaries')
    }
    loadDict()
  }

  exports.NS = NS_ID
  exports.name = name
  exports.apply = apply
  exports.inject = inject
  return module.exports
}

/**
 * 向宿主 locale 注册字典，返回注销函数。
 *
 * 注册失败不致命：`tr` 会用源码内的同步兜底继续工作。
 *
 * @param {object} ctx - 客户端 cordis 上下文。
 * @returns {Function} 注销函数（无注册时为空操作）。
 */
function registerDictionary(ctx) {
  try {
    if (ctx.locale?.register) return ctx.locale.register(NS_ID, dict)
  } catch { /* locale 注册失败：tr 仍可用同步兜底 */ }
  return () => {}
}

/**
 * 在「设置 → 侧边栏」注入本插件分区。
 *
 * 宿主未提供 slots 服务时静默跳过（插件其余能力不受影响）。
 *
 * @param {object} ctx - 客户端 cordis 上下文。
 * @param {Function} React - 宿主注入的 React。
 * @returns {void}
 */
function registerSettingsSection(ctx, React) {
  const slots = ctx.get ? ctx.get('slots') : undefined
  if (slots === undefined || typeof slots.inject !== 'function') return
  const section = {
    name: 'settings.section',
    id: 'session-migrate',
    order: SETTINGS_SECTION_ORDER,
    label: () => tr('settings.title'),
  }
  slots.inject('settings.section', () => slots.register(
    section,
    () => React.createElement(MigratePage, null),
  ))
}

// ───────────────────────── 注册 ─────────────────────────
// 必须位于文件末尾：factory 引用上方全部 const/function，
// 提前调用会在 TDZ 内命中 "Cannot access 'X' before initialization"。

window.__ModuleLoader__.load({
  id: NS_ID,
  factory: (require) => createModule(require),
})

})();
