# dsh-session-migrate

DSH 会话日志跨版本迁移——把低版本 generation（v0 等）投放到当前实例可识别的位置，
由 DSH 在打开该日志时沿迁移边自动还原到当前格式版本。

## 为什么需要它

DSH 会话日志格式是**预发布格式**，随 harness 版本演进（v0 → v1 → v2 → v3）。
官方不提供迁移命令，但持久化层在**打开日志**时会沿迁移边串行还原。
本插件负责「安全投放」，迁移本身交给 DSH——这样格式再演进也不会过期。

## 核心机制

转换一条会话需要**两步**，缺一不可：

| 步骤 | 动作 | 说明 |
|---|---|---|
| ① 投放 | 写入 `sessions/--<cwd编码>--/<id>/session.jsonl.zstd` | 改写 `header.cwd`，只重建首帧 |
| ② 触发 | WebSocket `session/follow` | **只有这步才会真的产出 vN 文件** |

实测对照（决定了为什么必须有 ②）：

| 动作 | 是否触发迁移 |
|---|---|
| `session/list`（HTTP） | ✗ |
| `session/page`（HTTP 冷读，能读出内容） | ✗ |
| `session/follow`（WebSocket 流式） | ✓ lock 与 vN 立刻落盘 |

## 功能

| 能力 | 入口 | 说明 |
|---|---|---|
| 旧会话扫描 | `legacy.js` | 扫描 `session.old/`，读出 id / 版本 / cwd / 帧结构 |
| 体检与迁移路径 | `GET /check` | 首帧契约、帧数、目标版本能力、`v0→v1→v2→v3` 规划 |
| 工作区探测 | `GET /workspaces` | 候选工作区列表 |
| 导入 | `POST /import` | multipart 上传或 JSON `{paths}`；支持 `.jsonl` / `.jsonl.zstd` / `.zip` |
| 转换 | `POST /convert` | 投放 + 触发迁移，可传 `trigger:false` 只投放 |
| 布局修复 | `POST /fix-layout` | 移出 `sessions/` 下非法裸目录（否则工作区列表全空） |
| CLI | `node cli.mjs` | `list` / `check` / `fix` / `import`，可脱离 DSH 独立运行 |

## 用法

### CLI

```bash
node cli.mjs list   <DSH_HOME>                     # 列会话与布局问题
node cli.mjs check  <文件> [--home <DSH_HOME>]     # 单文件体检（含目标版本与迁移路径）
node cli.mjs fix    <DSH_HOME>                     # 移出 sessions/ 下非法裸目录
node cli.mjs import <源文件|源目录> <DSH_HOME>     # 双路径导入（含 subagents）
node cli.mjs import <源> <DSH_HOME> --cwd <cwd>    # 指定目标 cwd
```

### HTTP

```bash
curl -s localhost:30801/api/session-migrate/state
curl -s 'localhost:30801/api/session-migrate/check?file=<会话文件绝对路径>'
curl -s -X POST localhost:30801/api/session-migrate/convert \
  -H 'content-type: application/json' \
  -d '{"ids":["session-xxx"],"cwd":"/path/工作区/测试","trigger":true}'
```

## 两个必须避开的坑

**坑 1｜备份放错位置 → 工作区列表全空**

`sessions/` 根下**只允许** `--<cwd编码>--` 形式的目录。放任何裸目录会让 DSH 报
`uses the unsupported flat-file layout`，表现为工作区列表为空。
所有备份一律放 `<home>/../session-backups/`（home 之外）。

**坑 2｜zstd 整体重压缩 → 会话读取失败**

v0 布局是**每行一个独立 zstd frame**，且首帧必须正好是 header 那一行。
「解压→改→重压」会合并成 1 帧，DSH 报
`corrupt Zstandard session log: first frame is not exactly one header line`。
正确做法：**只重建首帧，其余字节原样拼接**。

## 目录结构

```
cli.mjs              命令行入口（零依赖，可独立运行）
assets/
  preview-gen.mjs    预览页生成器（跑真实 lib/client.js，垫片宿主环境；--serve 起局域网静态服务器）
  preview.html       生成物：单文件自包含预览页（内联 React/ReactDOM UMD + 假数据接口）
  lib/fixture.mjs    预览用假数据（/state 响应体，覆盖各状态分支）
  lib/serve.mjs      局域网静态服务器（只读托管 assets，拦截路径穿越）
lib/
  index.js           插件唯一入口（工具注册 + 系统提示词 + HTTP 接线）
  client.js          设置侧边栏页面（浏览器半侧，四个分区）
  routes.js          HTTP 接口编排
  follow.js          WebSocket 触发迁移（Node 实现，无需 Python）
  legacy.js          旧会话扫描与索引
  workspace.js       工作区候选探测
  i18n/{zh,en}.json  外置多语言字典
  engine/            迁移引擎（帧 / 布局 / 版本 / 导入 / 体检）
    zstd.js          帧级读写与首帧契约
    layout.js        cwd 编码、目标路径推导、布局校验
    target.js        版本探测与迁移边规划（不硬编码版本号）
    import.js        投放（备份 + 转码 + 重建首帧 + 子会话）
    inspect.js       体检与布局修复
test/
  test-client.mjs    client 契约自测（模块装配 / 槽注册 / 同步文案）
```

浏览器半侧与官方约定一致：入口声明在 `package.json` 的 `exports["./client"]`
（值为 `./lib/client.js`），与 `@deepseek-ai/dsh-client-*` 系列插件同构——DSH 客户端
模块系统按该子路径解析并聚合，不走顶层散落文件。


每项能力只有一份实现：版本探测统一走 `engine/target.js`，帧读写统一走
`engine/zstd.js`，触发迁移统一走 `follow.js`（Node）。

## 界面预览

`assets/preview-gen.mjs` 生成一个**单文件自包含**的界面预览页：它加载仓库里真实的
`lib/client.js`（不是另写的 mockup），只垫片宿主环境（`__ModuleLoader__` / `require` /
`locale` / `slots` / `fetch`），因此界面与真实插件一致，也能暴露真实渲染与交互缺陷。

```sh
node assets/preview-gen.mjs            # 生成 assets/preview.html
node assets/preview-gen.mjs --serve    # 生成并用局域网静态服务器托管（默认端口 8099）
PORT=8080 node assets/preview-gen.mjs --serve
```

生成物内联 React 与 ReactDOM 的 UMD 构建，双击即开、离线可用，不需要 DSH 在运行。
预览页里的数据是假的（覆盖待转换 / 已转换 / 不可迁移 / 不可读 / cwd 越界各分支），
勾选、选工作区、导入、转换都可点，改动只留在页面内，不写任何文件。

React 的 UMD 从 DSH 安装根的 pnpm store 取；ReactDOM 常未随 DSH 安装，生成器会依次
查 DSH 数据目录下的 `cache/react-umd/` 与 `/tmp/rd/`，都没有时按提示下载即可：

```sh
mkdir -p /tmp/rd/umd && curl -sSL -o /tmp/rd/umd/react-dom.development.js \
  https://unpkg.com/react-dom@18.3.1/umd/react-dom.development.js
```

`DSH_ROOT` / `REACT_UMD_DIR` / `REACT_DOM_UMD_DIR` 可显式覆盖查找结果。

## 设置侧边栏

`lib/client.js` 挂载「设置 → 侧边栏 → 会话迁移」，四个分区：

| 分区 | 作用 |
|---|---|
| 环境 | 目标版本 / 旧会话目录 / 工作区根 / 待转换计数，含布局异常告警 |
| 导入 | 选择 `.zip` / `.jsonl` / `.jsonl.zstd` 上传到 `session.old/` |
| 列表 | 扫描 `session.old/`，显示 cwd / 版本 / 已转换版本 / 大小，可勾选 |
| 转换 | 选目标工作区 → 投放选中项（改写 cwd），随后由 DSH 读取该条记录时迁移 |

注册方式：客户端 `inject` 声明 `slots`，在 `settings.section` 槽注册条目
（`{ name, id, order, label }` + 页面组件）。词条经宿主
`GET /api/session-migrate/i18n` 拉取，源码只保留首屏所需的同步兜底。

## 版本记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 1.0.1 | 2026-09-19 | 浏览器半侧 `lib/client.js` 内部整理（不拆文件、不引入构建链——DSH 只读 `exports["./client"]` 的单文件，官方插件同样是「源码分多文件 + 打包成单文件」，行数由段落注释与小函数承担）。消除两份事实来源：源码内联的 14 个词条兜底删去，只保留首屏同步渲染必需的 `settings.title` / `common.loading`，权威字典统一为 `lib/i18n/{zh,en}.json`（各 62 键，实测覆盖代码用到的全部 45 键）；`renderStatus` 拆为 `renderStatusHeader` / `renderStatusGrid` / `renderStatusBadges`；`createModule` 里的槽注册抽成 `registerDictionary` / `registerSettingsSection`，`apply` 从 5 层嵌套降为平铺；ID 截断长度 20 / 12 提为 `ID_DISPLAY_LEN` / `ID_NOTICE_LEN` 命名常量。修 TDZ 隐患：`window.__ModuleLoader__.load(...)` 从文件中部移到末尾，原先依赖函数提升、若 factory 被同步调用会命中常量 TDZ。 |
| 1.0.0 | 2026-09-19 | 首个正式版。设置侧边栏页面（环境 / 导入 / 列表 / 转换四分区）与迁移引擎（`lib/engine/*`）合并为单一实现：插件入口 `lib/index.js`，浏览器半侧入口 `lib/client.js`（经 `exports["./client"]` 声明，与官方 `@deepseek-ai/dsh-client-*` 同构）；含 WebSocket 触发迁移、HTTP 接口与工作区探测。新增界面预览生成器 `assets/preview-gen.mjs` + `assets/lib/{fixture,serve}.mjs`（跑真实 `lib/client.js` + 垫片宿主，内联 React/ReactDOM UMD 输出单文件 `preview.html`，`--serve` 起局域网静态服务器并拦截路径穿越）。修复：导入选文件后误报「未选择任何文件」（`onPick` 先取 `Array.from` 快照再清空 `input.value`，避免拿到被清空的活视图 FileList）；两处占位符未替换（`import.desc` 的 `{dir}`、作为标签使用的 `status.badgeTotal` 改为独立词条 `status.total`）；浏览器半侧整体包 IIFE，避免与同为手写插件的 `dsh-skill-scoreboard` 在 client 聚合中顶层声明重名（10 个）导致 `Failed to load plugins` |


## 许可

MIT
