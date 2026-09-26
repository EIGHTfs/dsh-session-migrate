# 文件树

<!-- dshgp-tree:start -->
```text
dsh-session-migrate/
├── lib/ — 插件核心实现（入口/路由/WebSocket/浏览器半侧/引擎）
│   ├── client.js — 设置侧边栏页面（浏览器半侧，四个分区，单文件入口）
│   ├── follow.js — WebSocket 触发迁移（Node 实现，无需 Python）
│   ├── index.js — 插件唯一入口（工具注册 + 系统提示词 + HTTP 接线）
│   ├── legacy.js — 旧会话扫描与索引
│   ├── routes.js — HTTP 接口编排（state/check/scan/repair/workspaces/import/convert/fix-layout）
│   ├── workspace.js — 工作区候选探测
│   ├── engine/ — 迁移引擎（帧/布局/版本/导入/体检/修复/验证）
│   │   ├── import.js — 投放（跨工作区去重 + 备份 + 转码 + 重建首帧 + 子会话）
│   │   ├── inspect.js — 体检与布局修复
│   │   ├── layout.js — cwd 编码、目标路径推导、布局校验
│   │   ├── repair.js — 内容缺陷扫描与修复（scanLog / repairLogText / planRepair）
│   │   ├── target.js — 版本探测与迁移边规划（不硬编码版本号）
│   │   ├── validate.js — 离线迁移链验证（catalogCandidates / loadCatalog / validateMigrationChain）
│   │   ├── zip.js — 最小 zip 解包（导入时把导出包解开成标准目录形式）
│   │   ├── zstd.js — 帧级读写、首帧契约、多帧全量解码（decodeFull）与内存重编码（textToZstd）
│   ├── i18n/ — 外置多语言字典
│   │   ├── en.json — 英文词条
│   │   ├── zh.json — 中文词条
├── assets/ — 界面预览相关（预览页生成器 + 假数据 + 静态服务器）
│   ├── preview-gen.mjs — 预览页生成器（跑真实 lib/client.js，垫片宿主环境；--serve 起静态服务器）
│   ├── preview.html — 生成物：单文件自包含预览页（内联 React/ReactDOM UMD + 假数据接口）
│   ├── lib/ — 预览辅助库
│   │   ├── fixture.mjs — 预览用假数据（/state 响应体，覆盖各状态分支）
│   │   ├── serve.mjs — 局域网静态服务器（只读托管 assets，拦截路径穿越）
├── test/ — 自测脚本
│   ├── .test — 审计豁免标记（测试目录 fixture 魔数不入审）
│   ├── test-client.mjs — client 契约自测（模块装配 / 槽注册 / 同步文案）
│   ├── test-repair.mjs — repair 引擎自测（内容缺陷扫描 / 修复 / zstd 往返）
├── docs/ — 分体式文档（文件树/函数列表/版本记录，README 链接引用）
│   ├── CHANGELOG.md — 版本记录明细（1.0.0~1.0.4 逐版本 changelog，README 链接引用）
│   ├── FUNCTIONS.md — 函数列表（doc-func 生成：各文件函数名/行号/行数/签名）
│   ├── TREE.md — 文件目录树（doc-tree 生成：tree-doc.json 注释映射）
├── .auditignore — 审计豁免清单（lib/client.js 单文件入口架构的固有行数/嵌套不入审）
├── .gitignore — 忽略规则（tgz 打包产物等不入库）
├── README.md — 项目 README（功能总览/用法/坑/预览/分体式文档入口）
├── cli.mjs — 命令行入口（零依赖可独立运行：list/check/scan/validate/fix/import/repair）
├── cordis.patch.yml — DSH 插件组合 patch（loader 注入定义）
├── package.json — npm 包元数据（version/exports/dsh.client 声明）
├── tree-doc.json — 文件树注释映射（{路径: 一句话介绍}，手动维护）
```
<!-- dshgp-tree:end -->
