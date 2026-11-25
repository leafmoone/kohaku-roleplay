# 卡作者指南与原生扩展规范

本文档汇总面向角色卡作者与原生玩法包开发者的字段规范、素材规则与世界书行为。日常安装与游玩流程见仓库根目录 [README](../README.md)。

## 编辑、另存与原格式导出

在角色库选中 PNG 或 JSON 卡后，可编辑角色资料、主开场、备选开场与本卡状态定义。保存会生成新的库条目，不影响原卡、已绑定形象或进行中的会话。导出按钮按原格式下载；导出未修改原卡时直接输出原始字节，不重编码图像。

另存沿用原格式与版本，保留未编辑的世界书和未知扩展。对同时携带 `ccv3` 与 `chara` 块的 PNG，会同步更新两个文档并保留原始图像数据；遇到重复或损坏块时拒绝另存以保护原件。

## 本地立绘差分与 CHARX 剧情切图

### 立绘与表情映射

可在角色库为 PNG / JSON 卡上传多张本地静态 PNG（去除元数据、最大 480×640，整卡不超过 12 MiB），指定默认立绘及按**公开**文字、枚举或数值字段匹配的切换规则，另存后随卡导出。酒馆按本局已保存状态选图，小说按主节点已裁定状态选图；图片不进入模型提示词，切图不额外发起模型请求。

### CHARX 归档与 `scene_images`

支持导入至多 32 MiB 的 CCv3 `.charx`（ZIP 根目录含 `card.json`，Stored 或 Deflate 压缩），本地 PNG / JPEG / WebP 素材可在卡库与 `role` 侧栏预览，导出时保留原始 `.charx` 字节（不支持音视频）。

酒馆卡可在 `data.extensions["kohaku-roleplay"].scene_images` 声明有序剧情切图规则：

```json
[
  {"asset": "Library at night", "field": "location", "equals": "library"},
  {"asset": "Lobby"}
]
```

每项用 `asset` 引用唯一 `assets.name`，优先取首条命中的公开字段规则，再回退至无条件默认项。开场和已完成回复发布时自动将命中图片存为该条消息的会话附件（历史消息配图不随之后状态改变）；`role` 侧栏实时跟随最新状态并支持临时手动预览。

## 声明本局状态（`state`）

在 `data.extensions["kohaku-roleplay"].state` 声明字段数组（无此扩展的普通卡无需改动）。每项包含 `key`（ASCII 字母开头，仅含字母、数字、`_`、`-`，最长 64 字符）、`label`、`type`、`initial` 与 `visibility`（`public` 或 `private`）：

| `type` | 值及约束 |
| --- | --- |
| `text` | 字符串 |
| `number` | 有限数值；可选 `min`、`max`，初值与更新均须在范围内 |
| `enum` | 字符串；`options` 为非空、不重复候选列表 |
| `list` | 字符串数组，可为空 |

酒馆通过 `rp_set_card_state` 更新本局字段，小说由主节点在 `rp_commit_scene` 的 `card_updates` 中写入并自动同步至角色动态属性表。非法或越界更新整批拒绝；侧栏仅投影 `public` 字段。

## 酒馆原生面板（`panels`）

在 `data.extensions["kohaku-roleplay"].panels` 声明 UI 面板（每项含唯一 `id`、`label`、`type`），可查看示例卡 [物资登记员](../examples/native-ledger.json)：

| `type` | 附加字段 |
| --- | --- |
| `meter` | `field` 指向带 `min` 和 `max` 的公开数值字段 |
| `inventory` | `field` 指向公开字符串列表；同名物品自动合并计数 |
| `quest` | `status` 指向公开枚举，`completed` 为完成态枚举值；可选 `objectives: [{"label":"…","field":"…","equals":"…"}]` |
| `choices` | `options: [{"label":"…","text":"…"}]`；点击后作为普通玩家输入发送（禁止 `/` 斜杠命令） |

声明 `inventory` 或 `quest` 后自动启用 `rp_apply_gameplay`（`gain_item`、`consume_item`、`complete_objective`、`complete_quest`）。互不依赖的动作应分多次工具调用结算；同一调用内任一步骤校验失败则整批回滚。`rp_set_card_state` 不可整表覆盖已声明背包或直接将任务设为完成值。

## 剧情走向选项格式（`kt_roleplay.choices`）

新局默认开启 `enableStoryChoices` 自动引导模型生成后续走向，卡作者也可在卡面自定义输出风格。单卡酒馆在回复末尾使用 `kt_roleplay.choices` 围栏，小说模式在 `rp_commit_scene` 的 `outcome.choices` 中使用相同 JSON 结构：

```kt_roleplay.choices
{
  "prompt": "接下来打算如何推动局势？",
  "options": [
    {
      "tag": "顺势试探",
      "label": "追问火漆印来历",
      "summary": "借端茶靠近书案，不动声色试探对方反应",
      "text": "我端起茶盏缓步走到书案旁，目光掠过那枚残破的火漆印，轻声问道：「这印记倒是少见，不知是从哪位故人手中辗转而来的？」"
    },
    "留在原地静观其变"
  ]
}
```

- `tag`（可选）：简短路线倾向标签；`summary`（可选）：一句话走向预览；
- `label`：卡片标题；`text`：点击直发或填入输入框微调的实际内容（以 `/` 开头的斜杠命令会被过滤）；
- 兼容纯字符串选项与仅含 `{label, text}` 的旧格式。

## 世界书（Worldbook / Lorebook）规则

支持导入预览、兼容诊断、默认关联角色卡及会话内动态换绑：

- **匹配与递归**：支持 `entries` 数组或对象、四种次关键词逻辑（`and_any`、`and_all`、`not_any`、`not_all`）、全词匹配、大小写敏感、`/正则/flags`（`i/m/s/u`，扫描末尾 8,192 字符并带共享超时预算）及最多 8 轮 `recursive_scanning`。卡内与附加世界书默认共享约 2,048 估算 token 预算（含模板书默认 4,096）。
- **分组、概率与计时**：支持逗号多组排他、`groupOverride`、`useGroupScoring` 关键词得分筛选、`groupWeight` 权重抽选与 `probability` 触发率。`delay`、`sticky` 与 `cooldown` 按会话内非空玩家／角色消息数推进（工具续轮不重复计数），状态随档保存。
- **位置与插槽**：支持角色前后、会话笔记前后、对话深度（`@Depth`）以及位置 `7` 的命名插槽（在 `system_prompt` 或 `post_history_instructions` 中写 `{{outlet::名称}}`，同名插槽仅在首处展开一次且不嵌套）。小说模式下世界书仅向主节点注入，不广播给 NPC。

## 独立原生玩法包（`gameplayPack`）

角色卡可在 `data.extensions["kohaku-roleplay"].gameplayPack` 声明外部原生玩法包（如示例 [进度时钟包](../examples/progress-clock/kohaku.yaml) 与配套卡 [档案室](../examples/archive-survey.json)、[渡船](../examples/ferry-crossing.json)）：

- 卡片仅声明 `name`、精确版本 `x.y.z` 与可选 JSON `settings`，导入卡片不会自动安装或执行代码；
- 独立包在自身 `kohaku.yaml` 中将 `creatures/rp_tavern` 标记为 `roleplay_pack: true`，加载 `tavern` 模式 `roleplay` 与同名规则插件；
- 规则插件通过 `validate_roleplay_settings(settings)` 校验配置，并通过 `roleplay_tool_names` 暴露前缀为 `rp_pack_<包名下划线>_` 的原生工具。
