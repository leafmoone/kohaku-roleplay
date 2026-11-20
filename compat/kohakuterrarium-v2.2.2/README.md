# Kohaku Roleplay：KohakuTerrarium v2.2.2 宿主适配

以下可选源码补丁适用于 [KohakuTerrarium](https://github.com/Kohaku-Lab/KohakuTerrarium) 的 `v2.2.2`（`4df7c6afacac02abe8e1548f838558550561f711`）。只在干净、独立的该版上游源码副本应用；不要在运行中的服务目录使用。

Roleplay 的独立 `role` 面板不需要这些补丁；此处的补丁只服务于可信扩展的消息定位。

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

消息行定位不是正文插槽：此补丁不嵌入或运行作者页面、也不增加发送、草稿或历史写入权限。

补丁中的上游代码保留原署名，各变更文件带有修改声明。随附的 [KohakuTerrarium License v1.0](LICENSE) 适用于这些宿主源码补丁；它们不是上游官方发行物。
