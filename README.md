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

文件目录树由 `doc-tree` 脚本生成（注释映射维护在 `tree-doc.json`），独立成文，README 只做入口引用：

[查看完整文件树 → docs/TREE.md](docs/TREE.md)

```text
dsh-session-migrate/
├── lib/           插件核心实现（入口/路由/WebSocket/浏览器半侧/引擎）
├── assets/        界面预览（preview-gen.mjs 生成器 + preview.html + 假数据 + 静态服务器）
├── docs/          分体式文档（文件树 / 函数列表 / 版本记录，README 链接引用）
├── test/          自测脚本（test-client / test-repair）
├── cli.mjs        命令行入口（零依赖可独立运行）
├── tree-doc.json  文件树注释映射（手动维护）
└── package.json   npm 包元数据
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

## 分体式文档

长文档不直接内嵌 README，各自存独立 md（README 仅链接引用），由 git-push 的 doc- 前缀脚本自动维护：

| 文档 | 位置 | 维护脚本 | 说明 |
|---|---|---|---|
| 版本记录 | [docs/CHANGELOG.md](docs/CHANGELOG.md) | `doc-version.mjs` | 逐版本 changelog（1.0.0~1.0.4） |
| 函数列表 | [docs/FUNCTIONS.md](docs/FUNCTIONS.md) | `doc-func.mjs` | 全量函数表（16 文件 · 214 函数：文件名/行号/行数/签名） |
| 文件目录树 | [docs/TREE.md](docs/TREE.md) | `doc-tree.mjs` | 目录树（注释映射维护在 `tree-doc.json`） |


## 许可

MIT

MIT
