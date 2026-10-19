/**
 * 预览描述（由 `dsh-useful-tools` 插件的 `preview` 工具消费）。
 *
 * 本仓库不再自持预览生成器/静态服务器/假数据：模块装载、`__ModuleLoader__`、`require`、
 * `locale`、`slots` 与 `fetch` 垫片全部由 useful-tools 的自动挂载 harness 提供，
 * 这里只声明标题（设置页组件由 harness 按「设置页 > 插件配置卡 > 侧边栏」自动挂载）。
 *
 * 数据来自后端：`preview serve --backend <地址>` 反代真实实例；离线时先用
 * `minihost` 起最小宿主跑本插件的服务端代码，再把 backend 指向它。
 */
export default {
  title: 'dsh-session-migrate 设置页预览',
};
