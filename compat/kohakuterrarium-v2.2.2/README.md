# Kohaku Roleplay：KohakuTerrarium v2.2.2 标题栏适配

此源码补丁为 [KohakuTerrarium](https://github.com/Kohaku-Lab/KohakuTerrarium) 的 `v2.2.2`（`4df7c6afacac02abe8e1548f838558550561f711`）增加可选 `panel.sessionHeader`。Roleplay 仍用同一个 `role` 面板；桌面和窄屏标题区可额外显示本局的只读摘要。不应用补丁也可使用原版 Dock；此补丁不提供助理消息正文插槽。

只在独立、干净的上游源码副本使用，不要在运行中的服务目录应用。准备 **Node.js 24 和随附的 npm**，与上游构建一致。把本目录中的 `session-header.patch` 复制到该源码根目录，然后在根目录执行：

```sh
git rev-parse HEAD
git apply --check session-header.patch
git apply session-header.patch
cd src/kohakuterrarium-frontend
npm ci
npm run build
```

第一条命令输出必须等于上面的完整提交。请按上游文档启动或打包该源码及其新构建的前端；只重装 Roleplay 插件或只替换前端不能启用标题栏能力。启动后，在 `role` 面板的摘要设置中勾选本局公开条目并保存。

补丁中的上游代码保留原署名，各变更文件带有修改声明。随附的 [KohakuTerrarium License v1.0](LICENSE) 适用于此宿主源码补丁；它不是上游官方发行物。
