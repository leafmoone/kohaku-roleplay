# 插件架构与前缀缓存设计

KohakuTerrarium（KT）负责会话、聊天、模型调用、工具执行和历史存储。本插件基于 **原版 KT 2.2.2+** 的公开包与 UI SDK 接口构建，不要求修改或重编译宿主源码。旧卡兼容是酒馆模式的一层受限适配，并非完整的 SillyTavern 运行时。

## 核心模块与职责边界

| 部分 | 入口 | 职责 |
| --- | --- | --- |
| 素材库与路由 | [`catalog.py`](../kt_roleplay/catalog.py)、[`library.py`](../kt_roleplay/library.py)、[`worldbook_library.py`](../kt_roleplay/worldbook_library.py) | 导入、编辑另存、原格式导出角色卡（PNG / JSON / CHARX）与世界书；目录在 [`paths.py`](../kt_roleplay/paths.py) 统一解析。 |
| 开局编排 | [`launch.py`](../kt_roleplay/launch.py) | 创建持久会话。单卡酒馆启动 `rp_agent`；多卡小说以实名特权主节点（主角名或 `旁白视角`）搭配按角色真名创建的独立 NPC 节点组图。 |
| 会话运行时 | [`runtime.py`](../kt_roleplay/runtime.py)、[`projections.py`](../kt_roleplay/projections.py) | `RoleplayPlugin` 处理 KT 生命周期、工具可见性与 owner RPC，并按「静态队头 + 瞬态队尾」组装模型请求。 |
| 小说与书页工作台 | [`novel.py`](../kt_roleplay/novel.py)、[`cast.py`](../kt_roleplay/cast.py)、[`cast_tools.py`](../kt_roleplay/cast_tools.py)、[`scene_tools.py`](../kt_roleplay/scene_tools.py)、[`default_narrator.py`](../kt_roleplay/default_narrator.py)、[`novel_lore.py`](../kt_roleplay/novel_lore.py)、[`novel_media.py`](../kt_roleplay/novel_media.py)、[`novel_reader.py`](../kt_roleplay/novel_reader.py)、[`novel_revision.py`](../kt_roleplay/novel_revision.py)、[`recovery.py`](../kt_roleplay/recovery.py) | 维护章节账本、动态属性表（`CharacterSheet`）、三层角色记忆（`ActorMemory`）、默认旁白与文风双卡槽、动态角色扩编、结构化剧情走向 `choices`、局部 `fork_llm` 精修、双模式整幕平行版本重写及缺报恢复。 |
| 酒馆状态与玩法 | [`tavern_state.py`](../kt_roleplay/tavern_state.py)、[`tavern_opening.py`](../kt_roleplay/tavern_opening.py)、[`card_state.py`](../kt_roleplay/card_state.py)、[`panels.py`](../kt_roleplay/panels.py)、[`gameplay.py`](../kt_roleplay/gameplay.py)、[`mvu.py`](../kt_roleplay/mvu.py) | 校验开局参数，准备开场、世界书快照、原生声明字段、背包／任务面板与受限 MVU 状态。 |
| 媒体与卡片网页 | [`charx.py`](../kt_roleplay/charx.py)、[`portraits.py`](../kt_roleplay/portraits.py)、[`tavern_media.py`](../kt_roleplay/tavern_media.py)、[`tavern_web.py`](../kt_roleplay/tavern_web.py)、[`opening_page_library.py`](../kt_roleplay/opening_page_library.py) | 读取归档与立绘映射，发布会话剧情图附件，并在隔离沙箱内挂载经确认的卡片网页与受限脚本。 |
| 前端扩展 (`ui/`) | [`ui/index.js`](../ui/index.js)、[`CardLibraryView.js`](../ui/src/CardLibraryView.js)、[`WorldbookLibraryView.js`](../ui/src/WorldbookLibraryView.js)、[`NovelReaderView.js`](../ui/src/NovelReaderView.js)、[`NovelBookPanel.js`](../ui/src/NovelBookPanel.js)、[`SelectionStudioPanel.js`](../ui/src/SelectionStudioPanel.js)、[`RoleplayMiniPanel.js`](../ui/src/RoleplayMiniPanel.js)、[`RoleplayDockPanel.js`](../ui/src/RoleplayDockPanel.js)、[`ChoiceBlock.js`](../ui/src/ChoiceBlock.js) | 注册角色库、世界书库、书页标签与全屏沉浸层（`NovelReaderModalHost.js`）、会话悬浮面板（`novel-book`、`Play`、`role`）及剧情走向卡片渲染器。 |

素材跨局复用；剧情、人物经历、变量与世界书快照严格按会话隔离保存。前端面板仅投影当前会话的公开状态，不另存独立游戏账本。

## 上下文组装与 KV 缓存前缀稳定设计

大模型服务商的自动 Prompt Cache 依赖请求前部的精确字节匹配。为避免世界书关键词触发、状态面板／MVU 更新或小说幕数推进导致整段历史对话缓存失效，`pre_llm_call` 将上下文拆分为两部分：

1. **静态锁死队头（`insert_roleplay_context`）**：插入在系统提示词之后、首条对话消息之前，仅包含整局恒定的静态资料——角色卡基础人设、玩家设定、会话固定备注、小说前提、旁白／文风卡、初始演员档案（`initialActors`），以及不可被高优动态条目或黏滞计时挤占的无条件常驻世界书。
2. **瞬态实时队尾（`insert_tail_context`）**：始终追加到请求末尾（不写入持久对话历史，不移动既有 `user`、`assistant(tool_calls)` 或 `tool` 消息），承载每轮变化的数据——关键词／计时／模板触发的动态世界书、按深度排序的 `@Depth` 资料、当前属性面板／记忆／MVU 数值、小说中途动态加入的角色（`joinedCast`）及最近定稿章节尾部（`canonical_chapters`）。

对于在 `system_prompt` 中引用了动态 `{{outlet::…}}` 插槽的酒馆卡，相关指令段会自动分流至队尾展开，确保旧卡插槽与 EJS 变量模板实时生效且不影响常规卡片的静态前缀。普通会话的人物形象挂载（`persona`）仅在原有系统提示词末尾追加固定展示策略，并将角色资料作为参考 JSON 注入，不覆盖原任务与工具契约。

## 小说裁定发布与中断恢复

- **无复述裁定发布**：主节点调用 `rp_commit_scene` 时，章节正文（`Chapter.prose`）保持纯文学无代码块，后续走向存入结构化 `Chapter.choices`；运行时在工具结算边界直接向会话写入正文（并在聊天视图启用选项时仅对聊天消息附加 `kt_roleplay.choices` 围栏），不再额外调用模型复述一遍正文。
- **缺报恢复**：裁定原子写入主节点账本和受影响 NPC 的私有记录，无需再次唤醒 NPC。若在收齐回报或成文前中断，恢复原会话后点击「恢复本幕」：已有回报不重演，仅向缺报且空闲的角色补发原感官线索；若回报已齐，则仅唤醒主节点完成本幕裁定。

## 宿主升级复验清单

- [包清单](../kohaku.yaml)与 [`ui/index.js`](../ui/index.js) 同时声明 `owner: package` 的工作区标签页与 `owner: plugin:roleplay` 的会话悬浮面板（`novel-book`、`role`、`Play`）。跨标签发现实名主节点会话时，须通过 `GET /api/sessions/active/{session_id}` 取 `is_privileged: true` 节点的真实 `creature_id` 调用 owner 接口。
- 升级宿主后应复验：酒馆静态开场只发布一次且不误触发生成态、小说工具结算边界发布顺序完整、切图 `assistant_image` 首显与历史回放一致，以及多轮推进时出网请求的历史前缀字节保持稳定。
