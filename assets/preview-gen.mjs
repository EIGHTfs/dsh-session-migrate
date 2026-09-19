/**
 * 生成 assets/preview.html —— 会话迁移设置页模拟预览（假数据、界面全部可交互）。
 *
 * 跑的是仓库里真实的 client.js（不是手抄 mockup），只垫片宿主环境，所以界面与真实插件一致，
 * 且能发现真实渲染/交互缺陷。生成物单文件自包含（内联 React / ReactDOM UMD），离线可用。
 *
 * 垫片的宿主面（与真实宿主同名同形）：
 *   window.__ModuleLoader__.load  客户端模块装载（client.js 是 classic script，只入队不建模块）
 *   require                       react
 *   ctx.locale                    getLocale / register（字典命名空间）
 *   ctx.get('slots')              slots.inject + slots.register（settings.section 列表槽）
 *   ctx.effect                    生命周期登记（预览里为空实现）
 *   fetch                         /api/session-migrate/{state,i18n,import,convert}
 *
 * 用法：
 *   node assets/preview-gen.mjs            生成 assets/preview.html
 *   node assets/preview-gen.mjs --serve    生成后用局域网可访问的静态服务器托管
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAKE } from './lib/fixture.mjs';
import { lanAddresses, serve } from './lib/serve.mjs';

// 项目根 = 本文件所在目录的上一级（换机/换工作区即用，不写死本机路径）
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 定位 DSH 安装根。
 *
 * 为什么不能只靠相对推导：DSH 的**数据目录与安装目录不同源**——数据在
 * `<前缀>/@appdata/<包名>/<版本>/`，程序却装在 `<前缀>/@appstore/<包名>/`，
 * 两者不在同一棵树下，从项目根上溯任意级都到不了（实测上溯 8 级全部落空）。
 * 故除显式指定外，额外按 appdata↔appstore 的对应关系探测：既看 DSH_HOME，
 * 也看项目自身所在的 appdata 路径（工作区就在 appdata 侧，无需任何环境变量）。
 *
 * 顺序：DSH_ROOT → DSH_HOME 的上级链 → appdata/appstore 对应位 → 从项目根上溯。
 * 判据：安装根同时存在 node_modules/ 与 package.json。
 *
 * @returns {string} 安装根绝对路径，找不到返回空串。
 */
function findDshRoot() {
  if (process.env.DSH_ROOT) return process.env.DSH_ROOT;
  const isRoot = (d) => Boolean(d) && existsSync(join(d, 'package.json')) && existsSync(join(d, 'node_modules'));

  /**
   * 把 appdata 侧路径映射到 appstore 侧的安装根。
   *
   * 用分段重组而非正则：正则里 .*? 与 [^/]+ 相邻时会回溯错位，把包名段吞掉。
   *
   * @param {string} p - 形如 <前缀>/@appdata/<包名>/<版本>/… 的路径。
   * @returns {string} 安装根候选，不适用时返回空串。
   */
  const appstoreTwin = (p) => {
    if (!p) return '';
    const parts = p.split('/').filter(Boolean);
    const at = parts.indexOf('@appdata');
    if (at < 0 || parts.length <= at + 1) return '';
    const head = parts.slice(0, at).join('/');
    return `${head ? '/' + head : ''}/@appstore/${parts[at + 1]}/`;
  };

  const home = process.env.DSH_HOME;
  if (home) {
    for (const candidate of [home, resolve(home, '..'), resolve(home, '..', '..')]) {
      if (isRoot(candidate)) return candidate;
    }
  }
  // 项目自身就在 appdata 侧，据此找 appstore 孪生目录（免环境变量）
  for (const twin of [appstoreTwin(home), appstoreTwin(PROJECT_ROOT)]) {
    if (twin && isRoot(twin)) return twin;
  }
  let cur = PROJECT_ROOT;
  for (let i = 0; i < 8; i++) {
    const up = resolve(cur, '..');
    if (up === cur) break;
    cur = up;
    if (isRoot(cur)) return cur;
  }
  return '';
}

const DSH = findDshRoot();

/**
 * 定位 React / ReactDOM 的 UMD 构建。
 *
 * React 走 DSH 的 pnpm store；ReactDOM 常未随 DSH 安装，故依次查 DSH 数据目录下的缓存
 * （`.dsh/cache/react-umd`）与 /tmp 下的临时目录，都没有时提示下载方式。
 *
 * @returns {{react: string, dom: string}} 两份 UMD 的绝对路径（可能不存在，由调用方报错）。
 */
function findUmd() {
  const store = DSH ? join(DSH, 'node_modules', '.pnpm') : '';
  const react = process.env.REACT_UMD_DIR
    ? join(process.env.REACT_UMD_DIR, 'umd', 'react.development.js')
    : (store ? join(store, 'react@18.3.1', 'node_modules', 'react', 'umd', 'react.development.js') : '');

  const domCandidates = [
    process.env.REACT_DOM_UMD_DIR ? join(process.env.REACT_DOM_UMD_DIR, 'umd', 'react-dom.development.js') : '',
    process.env.DSH_HOME ? join(process.env.DSH_HOME, 'cache', 'react-umd', 'umd', 'react-dom.development.js') : '',
    '/tmp/rd/umd/react-dom.development.js',
    '/tmp/rd/react-dom.development.js',
  ].filter(Boolean);
  const dom = domCandidates.find((f) => existsSync(f)) ?? domCandidates[0];
  return { react, dom };
}

const { react: REACT_UMD, dom: DOM_UMD } = findUmd();

for (const [label, file, hint] of [
  ['React UMD', REACT_UMD, 'DSH 安装根推导为：' + (DSH || '(未找到)') + '\n  用 REACT_UMD_DIR 指向含 umd/react.development.js 的目录'],
  ['ReactDOM UMD', DOM_UMD, 'ReactDOM 常未随 DSH 安装，可下载后指向其父目录：\n'
    + '    mkdir -p /tmp/rd/umd && curl -sSL -o /tmp/rd/umd/react-dom.development.js \\\n'
    + '      https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js\n'
    + '    REACT_DOM_UMD_DIR=/tmp/rd node assets/preview-gen.mjs'],
]) {
  if (!file || !existsSync(file)) {
    console.error(`找不到 ${label}。\n  ${hint}`);
    process.exit(1);
  }
}

const clientSrc = readFileSync(join(PROJECT_ROOT, 'lib', 'client.js'), 'utf8');
const reactUmd = readFileSync(REACT_UMD, 'utf8');
const domUmd = readFileSync(DOM_UMD, 'utf8');
const zhDict = readFileSync(join(PROJECT_ROOT, 'lib', 'i18n', 'zh.json'), 'utf8');
const enDict = readFileSync(join(PROJECT_ROOT, 'lib', 'i18n', 'en.json'), 'utf8');


const harness = `
window.__ERRORS__ = [];
function __err(kind, msg) {
  window.__ERRORS__.push(kind + ': ' + msg);
  var d = document.getElementById('__err');
  if (!d) { d = document.createElement('pre'); d.id = '__err'; d.style.cssText = 'color:#f87171;white-space:pre-wrap;font-size:12px;border:1px solid #f87171;padding:8px;margin:0 0 12px'; document.body.insertBefore(d, document.body.firstChild); }
  d.textContent += kind + ': ' + msg + String.fromCharCode(10);
}
window.addEventListener('error', function (e) { __err('error', e.message); });
window.addEventListener('unhandledrejection', function (e) { __err('reject', String((e.reason && e.reason.stack) || e.reason)); });
var __oerr = console.error;
console.error = function () { __err('console', Array.prototype.map.call(arguments, function (x) { return String((x && x.stack) || x); }).join(' ')); __oerr.apply(console, arguments); };

window.__FAKE__ = ${JSON.stringify(FAKE)};
window.__QUEUE__ = [];
window.__ModuleLoader__ = { load: function (m) { window.__QUEUE__.push(m); } };

// 宿主 require：client.js 只用 react（字典走 fetch /i18n，不经 require）
window.__requireShim = function (name) {
  if (name === 'react') return React;
  throw new Error('未垫片的 require: ' + name);
};

window.__localeMock = {
  getLocale: function () { return window.__LOCALE__ || { id: 'zh' }; },
  register: function () { return function () {}; },
};

// 宿主 slots：settings.section 列表槽。
// 关键：真实宿主把 register 的第二个参数当 **React 组件**交给 reconciler 渲染，
// 而不是当普通函数直接调用——本垫片必须照此模拟。
window.__slotsMock = {
  inject: function (name, fn) { window.__INJECTED_NAME__ = name; fn(); },
  register: function (spec, component) {
    if (spec && spec.name === 'settings.section') window.__PAGE_COMPONENT__ = component;
    return spec;
  },
};

window.__ctxMock = {
  effect: function () { return function () {}; },
  get: function (name) { return name === 'slots' ? window.__slotsMock : undefined; },
  locale: window.__localeMock,
};

// 假接口。顺序要紧：/i18n 与 /state 都以 /api/session-migrate 开头，
// 若把通用分支放前面，字典请求会拿到 state 快照，界面到处显示原始键名。
//
// 响应形状必须与真实 Response 对齐：client.js 的 apiFetch 走 res.text() + JSON.parse
// （不是 res.json()）；只给 json() 时页面停在「加载失败: res.text is not a function」。
window.fetch = function (url, init) {
  var u = String(url);
  var json = function (body) {
    var text = JSON.stringify(body);
    return Promise.resolve({
      ok: true,
      status: 200,
      text: function () { return Promise.resolve(text); },
      json: function () { return Promise.resolve(body); },
    });
  };
  if (u.indexOf('/api/session-migrate/i18n') >= 0) {
    return json({ ok: true, zh: ${zhDict}, en: ${enDict} });
  }
  if (u.indexOf('/api/session-migrate/convert') >= 0) {
    var body = {};
    try { body = JSON.parse((init && init.body) || '{}'); } catch (e) { body = {}; }
    var ids = body.ids || [];
    window.__CONVERTED__ = { ids: ids, cwd: body.cwd };
    return json({
      ok: true,
      results: ids.map(function (id, i) {
        return i === ids.length - 1 && ids.length > 1
          ? { id: id, ok: false, error: '目标目录不可写：EACCES' }
          : { id: id, ok: true };
      }),
    });
  }
  if (u.indexOf('/api/session-migrate/import') >= 0) {
    window.__IMPORTED__ = true;
    return json({
      ok: true,
      imported: ['session-aaaa.jsonl.zstd', 'session-bbbb.jsonl.zstd'],
      failed: [{ name: 'not-a-session.txt', err: '扩展名不受支持' }],
    });
  }
  if (u.indexOf('/api/session-migrate/state') >= 0) return json(window.__FAKE__);
  return json({ ok: true });
};
`;

const post = `
try {
  var reg = window.__QUEUE__[0];
  if (!reg) throw new Error('client.js 未向 __ModuleLoader__ 注册');
  var mod = reg.factory(window.__requireShim);
  mod.apply(window.__ctxMock);
  var Page = window.__PAGE_COMPONENT__;
  if (!Page) throw new Error('settings.section 未注册渲染组件');
  // 错误边界必须是 **类组件**（componentDidCatch / getDerivedStateFromError）——
  // 函数组件里的 try/catch 只能拦住自身返回表达式，拦不住子组件的 effect 抛错，
  // 而「有入口、点进去空白」正是 effect 抛错后 React 卸载整棵树造成的。
  function Boundary() { React.Component.call(this); this.state = { err: null }; }
  Boundary.prototype = Object.create(React.Component.prototype);
  Boundary.prototype.constructor = Boundary;
  Boundary.getDerivedStateFromError = function (e) { return { err: e }; };
  Boundary.prototype.componentDidCatch = function (e) {
    __err('render(componentDidCatch)', (e && e.stack) || e.message);
  };
  Boundary.prototype.render = function () {
    if (this.state.err) {
      return React.createElement('div', { style: { color: '#f87171' } }, '渲染失败：' + this.state.err.message);
    }
    return React.createElement(Page, null);
  };
  ReactDOM.flushSync(function () {
    ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Boundary, null));
  });
  // effect 是异步提交的：稍后检查容器是否真的产出了内容
  setTimeout(function () {
    var host = document.getElementById('root');
    var txt = (host && host.textContent) || '';
    if (txt.replace(/\\s/g, '') === '') {
      __err('mount', '渲染后容器为空或仅占位（组件未产出内容；多为 effect 内抛错导致整棵树被卸载）');
    } else {
      window.__ready = true;
    }
  }, 400);
} catch (e) {
  __err('harness', (e && e.stack) || String(e));
}
`;

const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-session-migrate 界面模拟预览</title>
<style>
body{margin:0;padding:20px;background:#0f1117;color:#e8eaf0;
  font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.banner{max-width:900px;margin:0 0 14px;padding:10px 12px;border:1px dashed rgba(255,255,255,.18);
  border-radius:10px;color:#a0a6b4;font-size:12px}
.banner b{color:#e8eaf0}
#root{max-width:900px}
#__err{max-width:900px}
</style></head><body>
<div class="banner">这是<b>模拟预览</b>（假数据）：跑的是仓库里真实的 <b>client.js</b>，只垫片了宿主环境
（ModuleLoader / require / locale / slots / fetch）。刷新、勾选、选工作区、导入、转换都可点，
改动只留在页面内，不写任何文件。</div>
<div id="root"></div>
<script>${reactUmd}</script>
<script>${domUmd}</script>
<script>${harness}</script>
<script>${clientSrc}</script>
<script>${post}</script>
</body></html>`;

const out = join(PROJECT_ROOT, 'assets', 'preview.html');
writeFileSync(out, html);
console.log(`生成 ${out}（${(html.length / 1048576).toFixed(2)} MB）`);

/* ───────────────────────── --serve：局域网托管 ───────────────────────── */

if (process.argv.includes('--serve')) {
  const want = Number(process.env.PORT || 8099);
  const { port } = await serve(PROJECT_ROOT, want);
  console.log('\n局域网可访问：');
  console.log(`  本机     http://127.0.0.1:${port}/preview.html`);
  for (const ip of lanAddresses()) console.log(`  局域网   http://${ip}:${port}/preview.html`);
  console.log('\nCtrl+C 停止。');
}

