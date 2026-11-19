# 实测旧卡：StageDog《呕吐内心的少女》开场

已在隔离 KT 与真实 Chrome 中，使用作者 [固定版本 `78eb7a3` 的原始 PNG 和编译资源](https://github.com/StageDog/tavern_helper_template/tree/78eb7a3ba462a0fa917dd6ac64129b4b43acd14c/示例/角色卡示例)，完成原界面 `+` 按钮 **35% → 40%**，作者结构脚本把阶段从「渴求注视」结算为「暗中靠近」。从同一 SQLite 恢复后仍为 40% 和该阶段，再点原按钮到 41%。另一个会话仍从 35% 开始，导出 PNG 与原件一致。

## 适用条件

- 实测固定作者编译 HTML、13 个静态网页模块以及原「变量结构」编译模块；这些原字节预先放入隔离测试缓存。**没有验证原卡浮动地址的当前响应或逐项下载批准。** 浮动链接若换版本，不能沿用本页结论。插件不随附、重写或自动下载这张卡。
- 安装 [Roleplay 的 Node.js 离线链接依赖](../README.md#酒馆卡片脚本实验性)。在角色库逐项确认所选开场的 HTML 和静态依赖；网页许可和卡片兼容脚本的缓存独立。另只确认「变量结构」脚本声明的一个编译模块。用目录 owner `preview_card_dependencies({data})` 传原 PNG 的 Base64，可从 `scripts` 中找到该脚本实际 `scriptId` 和 `references`；确认前先核对地址及版本。不可为通过而确认无关自动更新脚本。
- 此配置目前由可信 Studio 开局接口 `POST /api/ext/kohaku-roleplay/taverns` 选择，普通卡库开局未提供结构脚本选择器。选主开场；把两个占位 ID 换成本机目录和原卡预览返回的值：

```json
{
  "cardId": "<已入库卡片 ID>",
  "player": {"name": "玩家"},
  "greetingIndex": 0,
  "enableOpeningModules": true,
  "openingPageRuntime": "tavern-page-callbacks-v1",
  "enableOpeningMvuRead": true,
  "enableCardScripts": false,
  "openingMvuCounter": {"path": ["白娅", "依存度"], "minimum": 0, "maximum": 100},
  "openingMvuSchema": {
    "profile": "mvu-zod-derived-v1",
    "scriptId": "<变量结构的 scriptId>",
    "outputPath": ["白娅", "$依存度阶段"]
  }
}
```

在本局 `role` 面板明确公开这份结构脚本的全部输入（该固定样本 20 项）。若不愿公开某项，不要启用此玩法；只公开计数器时可读计数，不允许网页写回或读取依赖私有输入的派生。随后在 Dock 打开作者开场网页，使用作者「角色情报」及 `+`／`−`。首个正常聊天回合开始后，开场计数器不再可写。

只有单个获准整数和单个派生字符串同笔保存；会改变其它规范字段的写入拒绝，例如某些低值触发作者称号删减。没有运行上游完整 MVU、即时事件提示或卡自动更新；不据此承诺所有数值或卡片版本。此结果是原卡实玩，**不是**助理消息正文插槽验收，也不是对原版外部服务插件的联调证明。
