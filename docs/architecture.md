# 插件架构

KohakuTerrarium（KT）负责会话、聊天、模型调用、工具执行和历史。本插件使用 **原版 KT 2.2.2** 的包和 UI 接口；不分发或要求宿主源码补丁。旧卡兼容是酒馆的一层适配，不是另一个 SillyTavern 宿主。

## 入口与权属

| 部分 | 入口 | 职责 |
| --- | --- | --- |
| 素材库 | [`catalog.py`](../kt_roleplay/catalog.py)、[`library.py`](../kt_roleplay/library.py) | 导入、编辑副本、导出卡片及管理世界书。目录在 [`paths.py`](../kt_roleplay/paths.py) 统一解析，素材库不需要加载会话插件。 |
| 开局 | [`launch.py`](../kt_roleplay/launch.py) | 通过 KT 创建会话。酒馆是一个 `rp_agent`；小说由导演 root 和各自独立的 NPC 组成。 |
| 会话 | [`runtime.py`](../kt_roleplay/runtime.py) | `RoleplayPlugin` 接收 KT 生命周期和 owner 调用。形象模式只注入形象提示；酒馆结算本局状态；小说由 root 裁定、NPC 只接收自己的线索。 |
| 酒馆快照 | [`tavern_state.py`](../kt_roleplay/tavern_state.py)、[`tavern_opening.py`](../kt_roleplay/tavern_opening.py) | 校验开局参数，准备开场、世界书快照、原生字段、MVU 和可用的作者网页。准备阶段不写会话或发布聊天；运行时负责保存、开场事件和聊天发布。 |
| 独立作者网页 | [`tavern_web.py`](../kt_roleplay/tavern_web.py)、[`CardWebPanel.js`](../ui/src/CardWebPanel.js) | 在 `role`／`Play` 内隔离展示。owner 校验本局作用域，并转交原生玩法或开场计数器的结算，不由网页直接写会话。 |
| 会话剧情图 | [`tavern_media.py`](../kt_roleplay/tavern_media.py) | 复用本地选图规则，将图保留为会话附件。`role` 继续跟随当前状态；开场和助理终稿各自持有发布时的图片引用。 |

素材可以跨局复用；剧情、人物经历、变量与世界书快照按局保存。面板只显示本局的公开投影，不另外保存一份游戏状态。原生声明字段和旧卡 MVU 是不同的接口，不自动互相转换。

## 宿主升级时要复验的地方

- [包清单](../kohaku.yaml)和 [UI 入口](../ui/index.js)注册角色库、世界书库、`role`／`Play` 和原生 `kt_roleplay.choices`。聊天选项使用 KT 的标准消息渲染器；作者网页不再挂进回复正文。
- [`playWindow.js`](../ui/src/playWindow.js) 和对应样式会使用 KT 2.2.2 的 Dock 窗口及窄屏抽屉结构。升级宿主时检查拖动、缩放、关闭以及作者网页有没有重载。
- [`runtime.py`](../kt_roleplay/runtime.py) 的回合钩子读取 KT 的持久回合和已完成回复，并用宿主的输出／工具反馈流程发布开场与小说裁定。升级宿主时复验开场只发布一次、旧档能恢复、继续工具回合不会重复结算；SDK 能加载包不代表这些行为已验证。
- 剧情图使用原生 `assistant_image` 显示事件和同一条助理消息的图片内容，分别承载 KT 2.2.2 的实时显示与持久回放。剧情图不参与酒馆的叙事模型请求。复验时检查首显、回复重生成与历史，不能只看 `role` 里的当前场景。
