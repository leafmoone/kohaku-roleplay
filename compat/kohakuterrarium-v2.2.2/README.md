# Kohaku Roleplay：KohakuTerrarium v2.2.2 宿主适配

以下独立源码补丁适用于 [KohakuTerrarium](https://github.com/Kohaku-Lab/KohakuTerrarium) 的 `v2.2.2`（`4df7c6afacac02abe8e1548f838558550561f711`）。只在干净、独立的该版上游源码副本应用；不要在运行中的服务目录使用。

## 本局标题栏摘要

`session-header.patch` 增加可选 `panel.sessionHeader`。Roleplay 仍用同一个 `role` 面板；桌面和窄屏标题区可额外显示本局的只读摘要。不应用补丁也可使用原版 Dock；此补丁不提供助理消息正文插槽。

准备 **Node.js 24 和随附的 npm**，与上游构建一致。把本目录中的 `session-header.patch` 复制到该源码根目录，然后在根目录执行：

```sh
git rev-parse HEAD
git apply --check session-header.patch
git apply session-header.patch
cd src/kohakuterrarium-frontend
npm ci
npm run build
```

第一条命令输出必须等于上面的完整提交。请按上游文档启动或打包该源码及其新构建的前端；只重装 Roleplay 插件或只替换前端不能启用标题栏能力。启动后，在 `role` 面板的摘要设置中勾选本局公开条目并保存。

## 已完成消息的只读定位

`message-history.patch` 只补宿主 Python：成功提交的回合具有明确完成标记，可信 Roleplay owner 可以在同一 agent 的有限事件窗口内验证消息身份。失败或缺标记的旧档不会被补写，也不会猜测消息身份。补丁不修改前端，不增加正文挂载、作者脚本权或聊天写入权限。

把 `message-history.patch` 复制到上游源码根目录；确认 `git rev-parse HEAD` 等于上面的提交后，执行：

```sh
git apply --check message-history.patch
git apply message-history.patch
```

按上游说明从已应用的 Python 源码启动独立宿主。只应用这一项不需要重新构建前端；可独立使用，也可与标题栏补丁按任意顺序应用。装原版宿主时，旧快照和 Dock 仍可用，只是可信消息定位返回空。

补丁中的上游代码保留原署名，各变更文件带有修改声明。随附的 [KohakuTerrarium License v1.0](LICENSE) 适用于这些宿主源码补丁；它们不是上游官方发行物。
