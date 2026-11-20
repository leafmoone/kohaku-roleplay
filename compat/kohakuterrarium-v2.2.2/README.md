# Kohaku Roleplay：KohakuTerrarium v2.2.2 宿主适配

以下可选源码补丁适用于 [KohakuTerrarium](https://github.com/Kohaku-Lab/KohakuTerrarium) 的 `v2.2.2`（`4df7c6afacac02abe8e1548f838558550561f711`）。只在干净、独立的该版上游源码副本应用；不要在运行中的服务目录使用。

Roleplay 的独立 `role` 面板不需要这些补丁；这些补丁只用于消息定位和受支持的消息正文选项，不改会话标题栏。

## 已完成消息的只读定位

`message-history.patch` 只补宿主 Python：成功提交的回合具有明确完成标记，可信 Roleplay owner 可以在同一 agent 的有限事件窗口内验证消息身份。失败或缺标记的旧档不会被补写，也不会猜测消息身份。补丁不修改前端，不增加正文挂载、作者脚本权或聊天写入权限。

把 `message-history.patch` 复制到上游源码根目录；确认 `git rev-parse HEAD` 等于上面的提交后，执行：

```sh
git apply --check message-history.patch
git apply message-history.patch
```

按上游说明从已应用的 Python 源码启动独立宿主。只应用这一项不需要重新构建前端。装原版宿主时，旧快照和 Dock 仍可用，只是可信消息定位返回空。

## 可信扩展的消息行定位

`message-locator.patch` 是前端配套补丁。与上面的 `message-history.patch` 一起使用后，可信包组件可从 `useMessage()` 读到可空的 `assistantLocator`（`turn`、`branchId`、`eventId`、`roundStartEventId`）。只有能定位到明确成功、完整持久事件链的实际助理消息行才有值。开场、失败、旧存档缺证据或分页信息不完整时为 `null`；不会用正文相同或行顺序猜身份。失败行仍可保留原回合用于原有导航，不获得成功回复权限。

请先确认干净上游的提交，再将两个补丁复制到源码根目录并应用。如果已应用 `message-history.patch`，不用应用第二次。须重新构建前端（Node.js 24 和随附 npm），并运行已应用这两个补丁的宿主源码：

```sh
git apply --check message-locator.patch
git apply message-locator.patch
cd src/kohakuterrarium-frontend
npm ci
npm run build
```

单独应用消息行定位补丁不会挂载作者页面，也不增加发送、草稿或历史写入权限。

## 助理回复正文的作者选项

`message-body.patch` 在前两项之上添加独立的可选 `ui.messageBodies` 声明和消息正文容器。只在同一局、当前已成功完成的助理回复且卡片有可用的作者选项时展示；开场、过期分支和失败回复不显示。作者页使用隔离容器，点击只查看这条选项的预览，不会自动发出消息。原版 KT 可以继续使用角色库、世界书库与独立小面板，不出现正文控件。未修改的《日记络络》只做了源码核对；正文点击验收使用同样位置映射的合成作者页，不代表该卡全部脚本原样可运行。

从干净的上游 `v2.2.2` 开始，将三个补丁复制到源码根目录，依顺序应用。使用 Node.js 24，只在最后构建一次前端：

```sh
for patch in message-history.patch message-locator.patch message-body.patch; do
  git apply --check "$patch" && git apply "$patch" || exit 1
done
cd src/kohakuterrarium-frontend
npm ci
npm run build
```

若前两项已应用，只对 `message-body.patch` 执行 `git apply --check` 与 `git apply`，然后重新构建。启动同一份已打补丁的 Python 源码及其 `src/kohakuterrarium/web_dist`，不要混用旧构建或另一套 KT 安装。

补丁中的上游代码保留原署名，各变更文件带有修改声明。随附的 [KohakuTerrarium License v1.0](LICENSE) 适用于这些宿主源码补丁；它们不是上游官方发行物。
