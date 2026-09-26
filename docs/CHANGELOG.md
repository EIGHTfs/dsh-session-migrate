# 版本记录

<!-- dshgp-version:start -->
## 版本列表

| 版本 | 内容 |
|------|------|
| 1.0.4 | 代码质量优化（审计评分 77.2→81、warning 66→35）+ 升版三处同步；README 分体式文档重构——文件树/函数列表/版本记录移出 README，独立 md + 链接引用（git-push doc- 三；doc-tree sync 清理 _meta.worktree 变动记录（提交后重新 sync，清掉 tree-doc.json 中 |
| 1.0.3 | 升版并同步发版三件套——版本号三处（lib/index.js、package.json、README 版本记录表）升至 1.0.3， |
| 1.0.2 | zip 导出包导入后不可列/不可转——导入时即解包成标准目录形式；转换内置全工作区去重——同 id 会话已存在于其它工作区时提示并移出旧份备份（session-backups，可恢复）后重新转换，杜绝 |
| 1.0.1 | 整理浏览器半侧 lib/client.js——消除重复字典、拆长函数、修 TDZ 隐患 |
| 1.0.0 | 首个正式版——浏览器半侧迁至 lib/client.js，修复导入误报未选择文件 |

<!-- dshgp-version:end -->
