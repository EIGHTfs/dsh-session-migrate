// dsh-session-migrate 客户端半侧契约自测
//
// 为什么不能同步调 factory：DSH 的 window.__ModuleLoader__.load 只是**入队**
// （见 packages/client/modules/src/index.ts bootInjections 的 pendingQueue.push），
// factory 在整个模块系统启动后才被异步消费调用。同步调用会命中 TDZ，
// 那是测试方法错误，不是 client.js 的缺陷。本文件据此复现真实语义。
//
// 运行：node test/test-client.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

/** 极简 React 替身：只需支撑模块装配与一次渲染。 */
function makeFakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useReducer: (_reducer, init) => [init, () => {}],
    useCallback: (fn) => fn,
    useEffect: () => {},
    useRef: () => ({ current: null }),
  };
}

/**
 * 在 VM 中加载 client.js，复现 DSH 的「先入队、后建模块」语义。
 *
 * @returns {{module: object, ctx: object, calls: object}}
 */
function loadClient() {
  const calls = { registered: null, dict: null, injected: [] };
  let requireFn;
  let queue = [];

  const ctxObj = {
    locale: {
      register: (ns, d) => { calls.dict = { ns, d }; return () => {}; },
      getLocale: () => ({ id: 'zh' }),
    },
    get: (name) => (name === 'slots'
      ? {
        inject: (slot, fn) => { calls.injected.push(slot); fn(); },
        register: (opt, comp) => { calls.registered = { opt, comp }; return () => {}; },
      }
      : undefined),
    effect: () => {},
  };

  const sandbox = {
    window: { __ModuleLoader__: { load: (reg) => queue.push(reg) } },
    document: undefined,
    fetch: async () => ({ ok: false }),
    AbortSignal: { timeout: () => undefined },
    console,
  };
  requireFn = (spec) => {
    if (spec === 'react') return makeFakeReact();
    throw new Error(`missed-the-module-table: ${spec}`);
  };

  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);

  // 脚本求值只入队，不建模块（真实语义）
  const queued = queue.slice();
  queue = [];
  const reg = queued.find((r) => r.id === 'dsh-session-migrate');
  if (!reg) throw new Error('未入队 dsh-session-migrate 注册项');
  const module = reg.factory(requireFn);
  module.apply(ctxObj);
  return { module, ctx: ctxObj, calls, queued };
}

let failed = 0;
/**
 * 断言。
 *
 * @param {string} label - 断言名。
 * @param {boolean} ok - 是否通过。
 */
function check(label, ok) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? '✓' : '✗'} ${label}`);
}

console.log('── dsh-session-migrate client 契约 ──');

const { module: mod, calls, queued } = loadClient();

check('load() 只入队，不在求值期调 factory', queued.length === 1);
check('导出 name', mod.name === 'dsh-session-migrate');
check('导出 inject 含 slots/locale', Array.isArray(mod.inject)
  && mod.inject.includes('slots') && mod.inject.includes('locale'));
check('导出 apply 是函数', typeof mod.apply === 'function');

const opt = calls.registered?.opt;
check('注册到 settings.section 槽', calls.injected.includes('settings.section'));
check('槽条目 name 正确', opt?.name === 'settings.section');
check('槽条目有 id（SlotCore 必填）', typeof opt?.id === 'string' && opt.id.length > 0);
check('槽条目 order 是数字', typeof opt?.order === 'number');
const label = opt?.label?.();
check('label() 同步返回字符串', typeof label === 'string' && label.length > 0);
check('页面组件是函数', typeof calls.registered?.comp === 'function');
check('locale 注册了字典', calls.dict?.ns === 'dsh-session-migrate');

const dictZh = calls.dict?.d?.zh ?? {};
check('同步兜底字典含导航标签', typeof dictZh['settings.title'] === 'string');

console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
