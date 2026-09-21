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
| 内容缺陷扫描 | `GET /scan` / `CLI scan` | 只读诊断内容级缺陷（见「内容缺陷修复」） |
| 内容缺陷修复 | `POST /repair` / `CLI repair` | 备份 → 修复 → 离线迁移链校验 → 落盘（见「内容缺陷修复」） |
| 迁移链实跑验证 | `CLI validate` | 用目标实例自带格式目录离线跑完整 `v0→v1→v2→v3`，验证日志能否被真实迁移链接受 |
| 工作区探测 | `GET /workspaces` | 候选工作区列表 |
| 导入 | `POST /import` | multipart 上传或 JSON `{paths}`；支持 `.jsonl` / `.jsonl.zstd` / `.zip` |
| 转换 | `POST /convert` | 投放 + 触发迁移，可传 `trigger:false` 只投放 |
| 布局修复 | `POST /fix-layout` | 移出 `sessions/` 下非法裸目录（否则工作区列表全空） |
| 转换去重 | `POST /convert` 内置 | 转换时按会话 id 全工作区查重：同 id 已存在于其它工作区则**提示并移出旧份备份（可恢复），重新转换**到本次目标工作区，杜绝「一个会话两次恢复到不同工作区」 |
| CLI | `node cli.mjs` | `list` / `check` / `scan` / `validate` / `fix` / `import` / `repair`，可脱离 DSH 独立运行 |

## 内容缺陷修复

旧版写入器（或第三方工具改写）可能在 v0 日志里留下**内容级缺陷**——结构上仍是合法
JSON 行、首帧契约也满足，但缺关键的关联字段，DSH 打开时迁移链拒绝、报
`history unavailable`。这类缺陷只有读内容才能发现，`check` 的帧级体检看不到。

已识别的可修复缺陷（`lib/engine/repair.js`）：

| 缺陷 | 表现 | 修复方式 |
|---|---|---|
| `packedChunkMissingId/Name` | `tool-call-chunks` 分片行 id/name 为空 | 从同 turn/step/index 的 `tool-call-delta` 流取回 |
| `blockEndMissingId/Name` | `assistant/chunk` 的 block-end 块 id/name 为空 | 同上取回 |
| `messageToolCallMissingName` | `assistant/message` 里 tool-call 块 name 为空 | 从广播/结果侧补回 |
| `toolCallMissingName` | `tool/call` 的 name 为空 | 同上 |
| `toolCallArgumentMismatch` | `tool/call` 的 arguments 与消息声明不一致 | 以**不含 U+FFFD 替换字符**的一侧为准对齐（canonical 与证明同源于写入链路的 U+FFFD 一侧） |

修复的安全链：**备份**到 `<文件同目录><basename>.repair-bak-<时间戳>/` → 只重写变化行
（最小差异，缺 delta 参考的行进 `skipped` 不硬改）→ 用目标实例自带的格式目录**离线跑
完整迁移链**预校验 → 校验通过才 `textToZstd` 原子写（temp + rename）落盘；校验失败
拒绝写入、catalog 不可用时仅警告。全程零依赖、只读扫描不改动输入。

## 用法

### CLI

```bash
node cli.mjs list     <DSH_HOME>                     # 列会话与布局问题
node cli.mjs check    <文件> [--home <DSH_HOME>]     # 单文件体检（含目标版本与迁移路径）
node cli.mjs scan     <文件>                         # 内容缺陷扫描（只读；阻塞>0 退出码 3）
node cli.mjs validate <文件> [--home <DSH_HOME>]     # 离线跑完整 v0→v1→v2→v3 迁移链（只读）
node cli.mjs fix      <DSH_HOME>                     # 移出 sessions/ 下非法裸目录
node cli.mjs import   <源文件|源目录> <DSH_HOME>     # 双路径导入（含 subagents）
node cli.mjs import   <源> <DSH_HOME> --cwd <cwd>    # 指定目标 cwd
node cli.mjs repair   <文件> [--home <DSH_HOME>]     # 备份 → 内容修复 → 迁移链校验 → 落盘
                      [--dry-run] [--yes] [--no-validate] [--no-fix-arguments]
```

### HTTP

```bash
curl -s localhost:30801/api/session-migrate/state
curl -s 'localhost:30801/api/session-migrate/check?file=<会话文件绝对路径>'
curl -s 'localhost:30801/api/session-migrate/scan?file=<会话文件绝对路径>'
curl -s -X POST localhost:30801/api/session-migrate/repair \
  -H 'content-type: application/json' \
  -d '{"file":"<会话文件绝对路径>","dryRun":true}'
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
  engine/            迁移引擎（帧 / 布局 / 版本 / 导入 / 体检 / 修复）
    zstd.js          帧级读写、首帧契约、多帧全量解码（decodeFull）与内存重编码（textToZstd）
    zip.js           最小 zip 解包（导入时把导出包解开成标准目录形式）
    layout.js        cwd 编码、目标路径推导、布局校验
    target.js        版本探测与迁移边规划（不硬编码版本号）
    import.js        投放（跨工作区去重 + 备份 + 转码 + 重建首帧 + 子会话）
    inspect.js       体检与布局修复
    repair.js        内容缺陷扫描与修复（scanLog / repairLogText / planRepair）
    validate.js      离线迁移链验证（catalogCandidates / loadCatalog / validateMigrationChain）
test/
  test-client.mjs    client 契约自测（模块装配 / 槽注册 / 同步文案）
  test-repair.mjs    repair 引擎自测（内容缺陷扫描 / 修复 / zstd 往返）
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
| 1.0.3 | 2026-09-20 | 全量审计清理（独立 CLI git-sluice 口径：warning 121 → 19，评分 77.5 → 83.5）。引擎与 HTTP 侧 I/O 隐患清除：`follow.js` token 探测改「`readdirSync` 一次性收进内存集合、循环内零 I/O」，WebSocket 连接拆 `bindSocketLifecycle` / `attachSocketEvents` / `withHandshakeContext`，快照等待拆 `waitForSnapshot`，静默收尾统一 `endQuietly` / `destroyQuietly` / `closeQuietly`；`routes.js` 请求体读取改 `for await` 异步迭代（IncomingMessage 原生可迭代，消 Promise 手动嵌套）；预览静态服务器 `serve.mjs` 改 `fs/promises`（stat + readFile），请求处理拆 `handleRequest`；`client.js` 设置分区注册拆 `injectSection`、CSS 行高 / 字重提为 `CSS_LINE_HEIGHT` / `CSS_TITLE_WEIGHT` 常量；`index.js` 工具注册拆 `registerTools`、列表格式化拆 `formatSessionList`；预览生成器 CSS 字号 / 白色通道提 `PREVIEW_LINE_HEIGHT` / `CSS_WHITE_CHANNEL` 常量。`lib/client.js` 加入 `.auditignore`（单文件入口架构的固有行数 / 嵌套不入审）。 |
| 1.0.2 | 2026-09-19 | 修复 `.zip` 导出包**导得进、列不出、转不了**：导入接口接受 `.zip`，但旧会话扫描只认 `.jsonl` / `.jsonl.zstd`，两者口径不一致，zip 落盘后扫描不到，`/convert` 会以「会话不在列表里」失败。改为**导入时即解包**成标准目录形式 `<会话id>/session.jsonl`，后续列表 / 转换全走既有路径。新增 `lib/engine/zip.js`：零依赖最小解包（只用 `node:zlib`），**走中央目录**定位数据——导出工具常在本地头把长度写 0 并改用 data descriptor，照本地头解析会得到 0 长度而解不出内容；条目名统一剥成基名挡路径穿越，解压后校验体积上限挡 zip 炸弹。导入语义统一为「同名覆盖 + 覆盖前留底」（原先会另起带时间戳的新目录，导致同一会话在列表里出现多条）；扫描跳过 `*.before-import-*` 留底目录并按会话 id 去重。**另：转换内置全工作区去重**——同一会话 id 已存在于其它工作区（不同 cwd 目录）时，提示并把旧份整体移出到 `session-backups/`（可恢复，非物理删除），再转换到本次目标工作区，杜绝「一个会话两次恢复到不同工作区」的重复副本；CLI `import` 与 `/convert` 均生效。 |
| 1.0.1 | 2026-09-19 | 浏览器半侧 `lib/client.js` 内部整理（不拆文件、不引入构建链——DSH 只读 `exports["./client"]` 的单文件，官方插件同样是「源码分多文件 + 打包成单文件」，行数由段落注释与小函数承担）。消除两份事实来源：源码内联的 14 个词条兜底删去，只保留首屏同步渲染必需的 `settings.title` / `common.loading`，权威字典统一为 `lib/i18n/{zh,en}.json`（各 62 键，实测覆盖代码用到的全部 45 键）；`renderStatus` 拆为 `renderStatusHeader` / `renderStatusGrid` / `renderStatusBadges`；`createModule` 里的槽注册抽成 `registerDictionary` / `registerSettingsSection`，`apply` 从 5 层嵌套降为平铺；ID 截断长度 20 / 12 提为 `ID_DISPLAY_LEN` / `ID_NOTICE_LEN` 命名常量。修 TDZ 隐患：`window.__ModuleLoader__.load(...)` 从文件中部移到末尾，原先依赖函数提升、若 factory 被同步调用会命中常量 TDZ。 |
| 1.0.0 | 2026-09-19 | 首个正式版。设置侧边栏页面（环境 / 导入 / 列表 / 转换四分区）与迁移引擎（`lib/engine/*`）合并为单一实现：插件入口 `lib/index.js`，浏览器半侧入口 `lib/client.js`（经 `exports["./client"]` 声明，与官方 `@deepseek-ai/dsh-client-*` 同构）；含 WebSocket 触发迁移、HTTP 接口与工作区探测。新增界面预览生成器 `assets/preview-gen.mjs` + `assets/lib/{fixture,serve}.mjs`（跑真实 `lib/client.js` + 垫片宿主，内联 React/ReactDOM UMD 输出单文件 `preview.html`，`--serve` 起局域网静态服务器并拦截路径穿越）。修复：导入选文件后误报「未选择任何文件」（`onPick` 先取 `Array.from` 快照再清空 `input.value`，避免拿到被清空的活视图 FileList）；两处占位符未替换（`import.desc` 的 `{dir}`、作为标签使用的 `status.badgeTotal` 改为独立词条 `status.total`）；浏览器半侧整体包 IIFE，避免与同为手写插件的 `dsh-skill-scoreboard` 在 client 聚合中顶层声明重名（10 个）导致 `Failed to load plugins` |


## 许可

MIT
