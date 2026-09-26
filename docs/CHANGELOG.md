# 版本记录

<!-- dshgp-version:start -->
## 版本列表

| 版本 | 内容 |
|------|------|
| 1.0.4 | 代码质量优化（审计评分 77.2→81、warning 66→35）+ 升版三处同步；README 分体式文档重构——文件树/函数列表/版本记录移出 README，独立 md + 链接引用（git-push doc- 三脚本生成）；doc-tree sync 清理 _meta.worktree 变动记录（提交后重新 sync，清掉 tree-doc.json 中的未提交变动元数据）；doc-version 脚本修复后重新生成版本表——五个版本独立成行，接入 dshgp-version 自动维护 |
| 1.0.3 | 升版并同步发版三件套——版本号三处（lib/index.js、package.json、README 版本记录表）升至 1.0.3，新增 .auditignore 豁免单文件入口 lib/client.js（不拆文件、不引入构建链的架构固有行数/嵌套不入审，与 dsh-git-push 对同路径文件的豁免理由一致） |
| 1.0.2 | zip 导出包导入后不可列/不可转——导入时即解包成标准目录形式；转换内置全工作区去重——同 id 会话已存在于其它工作区时提示并移出旧份备份（session-backups，可恢复）后重新转换，杜绝「一个会话两次恢复到不同工作区」的重复副本；CLI import 与 /convert 均生效，前端提示同步 |
| 1.0.1 | 整理浏览器半侧 lib/client.js——消除重复字典、拆长函数、修 TDZ 隐患 |
| 1.0.0 | 首个正式版——浏览器半侧迁至 lib/client.js，修复导入误报未选择文件 |

<!-- dshgp-version:end -->
