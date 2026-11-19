# kohaku-roleplay

面向 KohakuTerrarium 桌面单用户的酒馆角色卡扩展，目标兼容 KT v2.2.2。已有 creature 的形象挂载、单 agent 酒馆和逐角色 agent 小说使用同一素材库；剧情与人物经历只属于当前会话。

## 使用

在插件仓库执行 `kt install .` 复制安装到 KT 2.2.2，再重新启动目标 Studio；已具备 `kohaku.yaml` 中的 Python 依赖时可用 `--no-deps` 离线安装。开发时可用 `kt install . -e --no-deps` 做 editable 安装；仅在工作区专属虚拟环境和 `KT_CONFIG_DIR` 下做开发验证，不要将测试卡装入日用 KT。

`0.5.0` 新增酒馆原生玩法 Tool、字面量 MVU 更新和多项世界书规则。升级时先停止目标 Studio，再在同一 KT 配置下按同名包更新，重启后从 History 恢复旧会话；不要清空 KT 配置目录或角色库。已保存的会话不会重放开场或改写原有世界书快照。

- 角色库：在 Studio 的「新建标签」菜单打开 **Roleplay Library**，也可从设置里的 **Roleplay Cards** 跳转到该标签页。导入并选中卡片后，使用顶部的开局按钮。
- 会话面板：展开聊天里的浮动工具栏，打开 `role` 面板，再用标题栏的固定按钮将它移到右侧。原版 KT 2.2.2 可能只在悬停时显示 `role`；支持扩展按钮文字的界面会直接显示它。未加载 `roleplay` 的 creature 不会应用角色卡。
- 酒馆摘要：在 `role` 面板的摘要设置里勾选本局公开条目并保存，最多八项。宿主支持 `sessionHeader` 时，桌面和窄屏会话标题区会实时显示只读摘要；不同会话不共享勾选。原版 KT 2.2.2 仍只有 `role` 侧栏入口，不显示标题摘要；仅更新本插件不会增加宿主能力。
- 人物形象：在已有 creature 的插件列表启用 `roleplay`，再在面板确认形象；移除仅影响之后的模型请求。
- 酒馆：从角色库一键开局，或自选玩家身份和开场；也可启动 `@kohaku-roleplay/creatures/rp_agent` 后在面板选卡。开场白只展示并保存为一条角色消息，不向模型发送请求。
- 小说（实验性）：从角色库用所选卡开局，或用演员列表组队，再在 root 聊天中输入行动。root 只在收齐必要回报后裁定；打开面板不会推进剧情，缺报时不会替角色作决定，新局也不读取旧局。

## 编辑、另存与导出

在角色库选中一张 PNG 或 JSON 卡后，可修改角色资料、主开场、备选开场和本卡状态定义。保存会生成一个新的库条目；原卡、已绑定的人物形象以及正在玩的会话不受影响。要使用修改后的设定，选新卡开局。导出按钮按原格式下载当前所选资料，可再次导入；导出原卡时不会重新编码原件。

另存沿用原来的格式和版本，不从界面字段重建整卡，未编辑的世界书和未知扩展予以保留。对同时携带 `ccv3` 与 `chara` 的 PNG，会分别修改两个文档，保留原始图像数据；遇到重复或无法编辑的文档时拒绝另存，不覆盖原件。

## CHARX 本地素材

角色库支持导入至多 32 MiB 的 CCv3 `.charx`，要求 ZIP 根目录有 `card.json`，读取以 Stored 或 Deflate 压缩方式保存的条目。已经声明的本地 PNG、JPEG 和 WebP 图片可在角色库及该卡的酒馆侧栏中预览，`icon` 可作为卡面。预览使用 KT 显示用 PNG，不发模型请求，不解析外部素材地址或执行脚本；无法读取的素材会单独报告。不支持音视频；可执行脚本及模块的范围见[酒馆卡片脚本](#酒馆卡片脚本实验性)。

酒馆卡可在 `data.extensions["kohaku-roleplay"].scene_images` 声明有序切图规则。每项用 `asset` 引用已导入的唯一 `assets.name`，用 `field` 和 `equals` 匹配已保存的公开文字、枚举或数值字段；例如 `{"asset":"Library at night","field":"location","equals":"library"}`。先取首条命中规则，再回退到无条件的 `{"asset":"Lobby"}`、本地 `icon`，最后不显示自动图片。无效规则单独提示，不阻止导入其他素材。点击其他图片可暂时手动预览，再按「跟随剧情」恢复自动；重新打开同一存档，以已保存状态自动选图，新局从初值开始。普通形象和小说不使用这组规则。

原始压缩包按字节导出为 `.charx`。此格式暂不支持修改资料或另存立绘；PNG / JSON 卡的编辑行为不变。从库中删除素材会影响依赖它的会话预览，不影响已保存的聊天正文。

## 本地立绘与表情

在角色库为同一张卡选择本地静态 PNG，指定一个可选的默认立绘，其余按**公开**文字、枚举或数值字段的值匹配。保存为新的卡后，图片及规则随卡导出，不依赖本机文件路径或外部图片服务。角色库和普通形象挂载使用默认图或原卡面，不加载剧情状态。

酒馆按已保存的状态、小说按 root 已裁定的状态选图。多条规则同时满足时取顺序靠前的；没有匹配时用默认图，再回到原卡面，没有图则显示占位。图片不会插入模型提示词，切图本身不触发新的模型请求。差分图片保存为去除元数据的显示用 PNG（最大 480×640）；整卡仍须满足原有 12 MiB 导入上限。

## 小说幕的恢复

裁定同时写入 root 的本局事实和每名收件 NPC 自己的私有记录，不用再唤醒 NPC。若中断在裁定前，恢复原会话后可以在小说侧栏重试当前幕：已有回报不重演，只给缺报且空闲的角色重发原视角；若回报已齐，只请 root 完成本幕。重试不是新的玩家输入，也不会补造缺失的回报。

成功裁定的工具结果回填后，插件直接把裁定原文写入聊天和会话记录，不额外请求模型复述；聊天和侧栏使用同一份正文。若进程在写入聊天前退出，仍可在原会话侧栏查看最后已保存的裁定正文。

## 卡作者：声明本局状态

在酒馆卡 `data.extensions["kohaku-roleplay"].state` 放字段数组；没有此扩展的卡无需改动。每个字段需要 `key`、`label`（显示名）、`type`、`initial`（初值）和 `visibility`（`public` 或 `private`）。`key` 在同一张卡中唯一，以 ASCII 字母开头，之后可用字母、数字、`_`、`-`，总长不超过 64 个字符。

| `type` | 值及约束 |
| --- | --- |
| `text` | 字符串 |
| `number` | 有限数值；可选 `min`、`max`，初值与更新均须在范围内 |
| `enum` | 字符串；`options` 是非空、不重复的候选列表，值须在列表内 |
| `list` | 字符串数组，可为空 |

酒馆由 `rp_agent` 在需要时更新本局字段值；小说由 root 在幕裁定时写入受影响角色的字段。错误或未声明的更新整批拒绝。侧栏只投影 `public` 字段，普通 creature 的形象挂载不加载这些定义。`private` 不意味着对宿主操作者加密，单用户仍可以检查原卡、工具调用和调试记录。开局后的变化不会改写卡库或串入新会话。

### 酒馆 MVU 初始变量

新开酒馆时，卡内世界书中名称或备注含 `[InitVar]` 的条目可作为静态 JSON／YAML 对象读取，无须启用其普通世界书触发。可识别的初值只进入当前存档；无效初始块单独提示。酒馆通过 KT 工具更新已声明路径，支持同类型赋值和有限数值加减；批次中任一项无效就整批拒绝。

变量值默认不出现在侧栏。可在「MVU 变量」面板选择要显示的路径并保存，重开同一存档可恢复数值和选择，新开局从卡片初值开始。此设置只控制侧栏，不隐藏该局酒馆模型需要的变量，也不加密会话。形象挂载、小说和普通无变量酒馆不使用此面板。MVU 的原宿主运行时、EJS 和第三方自定义界面不会原样加载。有限的卡片脚本见下节。

支持 MagVarUpdate 常见的字面量 `<UpdateVariable>` 子集：每行一条 `_.set('路径', 新值)`、`_.set('路径', 旧值, 新值)` 或 `_.add('路径', 数值差)`；路径是已有对象的点分路径，参数只允许字面量，可带行末注释。提供旧值时必须与当前状态一致。有效 `[InitVar]` 卡的开场尾部若有更新块，开局时只应用一次，不把控制块显示成剧情；无效整批跳过并提示。剧情中若卡有对应更新说明，由插件自带的 `rp_apply_mvu_update` 接收整块并复用同一状态校验，不自动扫描普通对话。同一更新块也可使用 `<JSONPatch>` 及其 JSON 数组：支持对已有值 `test` 和同类型 `replace`，以及通过 JSON Pointer 对数组插入（含 `/-` 追加）和删除。字面命令可用 `items[0]` 一类下标。操作顺序生效，任一操作失败时整批不写；对象增删、`move`／`copy`、表达式和未知命令不支持。

### 酒馆卡片脚本（实验性）

可识别 `TavernHelper_scripts` 与 `tavern_helper.scripts` 的本地脚本声明；导入不会执行脚本。新酒馆默认运行卡片已启用、具备可用 `[InitVar]` 的兼容脚本。在角色库可改全局默认，只影响此后新开的酒馆；开局时可跟随默认，也可为这一局明确开启或关闭。既有局通过 `role` 面板更改自己的开关，并可以点击当前脚本公开的按钮。宿主若没有可用的持久会话回合号，脚本不能启用，已有许可也不会开放按钮或 Tool。新局启用后可运行一次开场事件；在已经开局的会话中开启不重放开场。玩家输入及最终回复按 KT 对话回合去重；工具续轮不重跑同一阶段，历史改写或分叉不会回滚脚本已写入的变量。支持 `eventOn`、`getVariables`、`replaceVariables`、`updateVariablesWith` 及 `getButtonEvent` / `eventOnButton`；`rp_run_card_script` 只接收本局登记的 ID 和 JSON 参数。只把当前会话的 MVU 副本交给有时间和内存上限的独立 JS 进程，变量更新整批校验。不会给脚本提供文件、网络、浏览器 DOM、其他会话或宿主 Tool；完整 Tavern Helper、EJS 和斜杠命令链仍不支持。此模式适合确认来源的卡，不等同于操作系统级沙箱或原样运行所有卡。

`appendInexistentScriptButtons([{name, visible}])` 可把新按钮添加到当前脚本的本局列表；同名不重复，`getScriptButtons()` 只读返回副本（原卡静态隐藏按钮仍不导入）。同一个脚本最多八个。按[酒馆助手 4.12.1 的按钮分发规则](https://github.com/N0VI028/JS-Slash-Runner/blob/f9c95abbd74c728db0cfbca53f8ba217279e6f0b/src/store/iframe_runtimes/script.ts)，作者显式关闭 `button.enabled` 时脚本仍可运行，但本局不公布、也不接受这组按钮；单个隐藏或只注册但未发布的名称同样不能调用。新开局从卡片读取配置；旧库只缺按钮配置时，不会重新生成缩略图或读取媒体内容。已有会话保留原快照：在此规则交付前开过的局可能仍显示当时保存的按钮，要应用作者的开关请用同一张卡重新开局。普通事件与 MVU 结算中，新按钮与有效变量改动一起保存；失败都不写。关脚本不可调用，读档可恢复；不会改原卡、不需要模型、不操作宿主 DOM，也不提供任意脚本树修改。

旧卡常把值保存为 `[标量, 说明文字]`。字面量 `_.set('路径', 新标量)` 在同类型时只改第 0 项，说明不变；带旧值的写法也只比较该标量。监听器收到原路径和新旧标量，而不是 `路径.0`。根 `$meta.strictSet: true` 时不作这个解释。原生 typed 更新、JSON Pointer 和显式整数组替换仍按实际存储类型处理。

启用脚本时，一次 MVU 更新依次触发 `Mvu.events.VARIABLE_UPDATE_STARTED`、`COMMAND_PARSED`（如有监听）、每次写入的 `SINGLE_VARIABLE_UPDATED` 和 `VARIABLE_UPDATE_ENDED`。parsed 回调收到 `(当前帧, 命令列表, 更新块文本)`，支持筛除命令和 `_.remove(列表, 判断函数)`；不接受新增、改写或重排命令。typed 调用没有原文，有 parsed 监听时会提供由其参数生成的规范字面量文本；不能无损表示的路径会拒绝。有 parsed 监听的卡目前须使用 `_.set` / `_.add` 而非 JSON Patch，不会跳过监听器直接写入。

逐项回调收到 `(stat_data, 路径, 旧值, 新值)`，结束回调收到 `(当前帧, 更新前的帧)`。结束帧的 `display_data` 是本次更新的临时显示副本，可传给后面的结束监听器，但不写入 MVU 状态、不替代前端。已有路径的 `stat_data` 修改会参与下一步校验，不递归派发事件；失败不保存半成品。带尾部更新块的开场也按此规则结算一次，按钮及脚本自身写入不自动重放更新事件。`mag_variable_initialized`、`mag_before_message_update` 的注册不会挡住其他已支持回调，但当前不触发，会在本局 `cardScripts.inactiveEvents` 列明。这里不是完整的 MVU、Lodash 或 Zod。

若依赖预览注明 `external_mvu_zod_schema`，表示该段导入了 MVU Zod 的 `registerMvuSchema` 助手，而不是表示其约束已在 KT 生效。即使模块已缓存，也不自动注入全局 Zod、模拟楼层变量或翻译 `coerce`、`union`、`tuple` 等动态规则。KT 原生卡要表达初值、数值范围和有限选项，可用 `state` 的 `initial`、`min` / `max`、`enum` / `options`；原生状态在写入时校验，不需要脚本。没有此提示也不代表脚本的所有 API 都受支持。

在玩家输入或最终回复的脚本回调中，`getChatMessages(-1)`（也接受字符串 `'-1'`）可读取**当前这条事件消息**的正文片段，最多 900 个字符。返回副本仅含 `role`、`message`、`is_hidden: false`，可用 `{role: 'user' | 'assistant' | 'all'}` 过滤。开场、按钮和工具事件没有对应的当前消息，返回空数组；不提供楼层历史、隐藏消息、替代回复或系统／工具内容。

静态 ES 模块可使用卡包内的 `.js` / `.mjs`，或按卡保存的已确认 HTTPS 副本。角色库选文件后可先预览依赖，再确认下载所选的静态 HTTPS 来源，或不下载直接入库。若卡片已入库但下载失败，保留原卡，重试只下载模块，不会再导入一次；重开卡片可查看已保存的来源。导入和预览不会执行卡片代码；只有主动确认过的直接来源才下载，不跟重定向，也不递归下载其他来源。保存的依赖不改卡片原件；导出原件不会附带远程模块副本。启用时只从本地副本和受校验的 CHARX 归档链接，并把结果写入本局快照；关闭的酒馆不提前链接。补好缺失依赖或链接器后，可在本局重新启用，开场不会重放。模块缺失、未确认的间接公网依赖、模块不受支持和运行中调用不存在的接口分别诊断。动态 `import()`、任意下载器及依赖系统或浏览器权限的代码不支持。

仅有模块依赖的卡片需要链接器：确保运行 Studio 的系统可找到 Node.js 22.12+（或 20.19+ 的 20.x），在**已安装的插件目录**执行一次 `npm ci --ignore-scripts --omit=dev`。没有链接器时，普通卡和无模块的脚本不受影响；不会在开局时自行安装工具。

### 转发已运行的酒馆插件接口（后端）

KT 不安装或启动原版酒馆服务器插件。先在独立宿主上运行插件，再由 KT 操作者在 `<KT_CONFIG_DIR>/kohaku-roleplay/legacy-tavern-plugins.json` 配置插件 ID、其本机监听端口和允许使用的路由。例如：

```json
{
  "example": {
    "port": 8765,
    "endpoints": [
      {"method": "GET", "path": "status"},
      {"method": "POST", "path": "roll"}
    ]
  }
}
```

`example`、`status` 和 `roll` 都是示例名；配置要与提供方真实暴露的 ID、方法和路由完全相同。提供方须能从 Studio 进程访问 `127.0.0.1:8765`；配置中的 `path` 只写后缀，如 `status`，不写 `/api/plugins/example/status` 或查询参数。添加配置不会启动提供方，也不会授权已有或新会话。

在本局的 `roleplay` owner 调 `legacy_plugin_options` 查看 `available` 和 `enabled`，再通过 `set_legacy_plugins` 传 `{"pluginIds":["example"]}` 显式授权；传空数组撤销。许可随本局存档，不改变兼容脚本默认设置。`legacy_plugin_request` 的参数示例：

```json
{"pluginId":"example","method":"GET","path":"status","query":{"mode":"short"}}
```

```json
{"pluginId":"example","method":"POST","path":"roll","body":{"sides":6}}
```

`query` 是字符串到字符串的键值对象，GET 不带 `body`。后端只转发到已配置的本机 `/api/plugins/<id>/<path>`，把提供方的 HTTP 状态及 JSON 返回为 `{status, body}`（空响应体为 `null`）；例如，提供方的 JSON `422` 仍是 `422`，不是 KT 转发故障。不带宿主凭据，不跟重定向，不支持二进制响应。

受信任的网页宿主还可以通过 `card_web_plugin_request` 提交 `panelScope`、`method`、原相对地址 `url`（例如 `/api/plugins/example/status?mode=short`）及可选 POST JSON `body`。只处理页面已就绪且作用域匹配的本局请求，再按白名单和本局许可转发；旧开场页只允许 GET。只返回 `{status, body}`，不把插件配置或宿主凭据交给页面。绝对地址、任意宿主路径及重复查询键不支持。

排查失败时先区分哪一层拒绝：

- **不在 `available`**：检查配置是否放在运行 Studio 的 `KT_CONFIG_DIR` 下；文件缺失时列表为空，配置格式错误时会指出出错的字段。**在 `available` 但未启用**：检查该局的 `enabled`，别用另一局的许可。`available` 只表示有配置，不代表提供方已在线。
- **方法或路由未启用**：核对配置里的精确 `method` / `path`。**无法连接**：确认独立服务正在同一台机器上监听配置端口。**提供方没有返回 JSON**：检查是否打到了 HTML 登录页或代理错误页；非空响应需带 JSON 类型。不要把提供方本身返回的 JSON 错误当作连接失败。
- **网页作用域变化**：从当前会话重新打开网页，不沿用旧 `panelScope`。旧开场页拒绝 POST，即使本局和配置都允许该路由。

**原版服务的接入边界。** 未禁用 CSRF 时，[SillyTavern](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/server-main.js#L166-L202) 会在挂载 `/api/plugins/<id>` 路由前注册 CSRF 中间件；插件路由也在[登录中间件](https://github.com/SillyTavern/SillyTavern/blob/06bde939fb1e9c4c8d8641d810f0a916b5bce127/src/server-main.js#L244-L249)之后挂载。KT 不转发 Cookie、Authorization 或 CSRF token，因此不能把要求这些凭据的原版路由直接当作 KT 提供方。不要为了接入关闭原版保护；应由操作者另行配置独立的本机 JSON 提供方，且只白名单所需路由。

下表按上游源码核对接口形状，**不是已安装或联调通过的原版插件列表**：

| 原版提供方 | 源码所示接口 | KT 当前边界 |
| --- | --- | --- |
| [EdgeTTS](https://github.com/SillyTavern/SillyTavern-EdgeTTS-Plugin/blob/7feb160b5026b58ea4c540ac810ac2b81baddb4e/src/index.ts#L40-L66)（`edge-tts`） | `GET list` 无参数，成功返回语音列表 JSON；`POST generate` 接受 `{text, voice}`，返回 `audio/webm`。 | 独立提供方的 `GET list` 成功响应符合 JSON 协议；音频生成不支持。 |
| [Office Parser](https://github.com/SillyTavern/SillyTavern-Office-Parser/blob/44ce12e0f3cc9a290513aea5043a3eac6aebf6d6/src/index.ts#L25-L45)（`office`） | `POST parse` 接受 JSON `{data}`（文件 data URL），返回文本。 | 非 JSON 文本不支持；也没有文件解析或上传适配。 |
| [Discord Rich Presence](https://github.com/SillyTavern/SillyTavern-DiscordRichPresence-Server/blob/61a6c9f83cd6123f412394d3b5071db8c4707610/src/index.ts#L42-L54)（`discord`） | `POST update?name=…` 更新 Discord 状态并返回文本 `OK`，无 `name` 时重置并返回空 `204`。 | 不提供 Discord 集成；不要把空 `204` 可转发误认为整个接口兼容。 |

以上是会话后端接口，浏览器中的旧页面调用仍需接线。没有配置界面、原版插件加载器或任意外部服务转发。

### 会话内卡片网页（后端接口）

CHARX 作者可在 `data.extensions["kohaku-roleplay"].webPanel` 声明 `{"title": "商店", "entry": "panels/shop.html"}`，并在包内提供该 UTF-8 HTML 文件（最多 256 KiB）。首版使用自包含页面，不装载外部资源。导入只读取页面，开局把它保存为本局快照；卡库和会话普通视图只返回 `webPanel.title`。旧库中未缓存声明时，从原件识别后可新开一局，不修改已有会话。原卡删除不影响已有页面快照。

受信任的宿主组件可在本局开场完成、玩家打开面板时调用 `card_web_panel` 取 `{title, html, panelScope}`。组件在读 `card_web_state` 或向 `card_web_gameplay` 提交 `{"actions": [...]}` 时带上同一 `panelScope`，仍由本局 owner 处理；切局误转发或重新挂载前的迟到请求会被拒绝。作用域标记不写存档，恢复后要重新打开面板。背包和任务沿用原生校验，状态及结算回包是 `{fields, panels, mvu}`，不返回会话历史、笔记或未公开变量。原 HTML 不可直接插入 KT 主页面；前端隔离容器未完成。请求已启用的外部插件走上文单独接口；这些后端接口不是整套 Tavern Helper。

旧卡如果用仅显示、仅作用于助理文本的 `regex_scripts`，把开场中的一个字面标记替换为完整围栏 HTML，KT 可识别这类页面；不会运行脚本、通用正则替换或把 HTML 发给模型。显式 CHARX 网页优先。旧卡页面只读，`card_web_panel` 额外返回 `legacyMarker` 及 `legacyOpening`（开场消息编号 `0` 和发布当时的 `data.stat_data`）。若后续一条已完成的助理回复含同一标记，还返回最近一份 `legacyLatest`（编号是本面板内的会话回合号，不是酒馆的任意楼层索引）。对声明了可识别的 MagVarUpdate `beta` 模块与 `<StatusPlaceHolderImpl/>` 页面的新酒馆，若已开启兼容脚本且 MVU 已初始化，则参照[上游状态栏触发规则](https://github.com/MagicalAstrogy/MagVarUpdate/blob/d03b7dc8a6ebf9bd611c7e2dc91f3b35462deebc/src/function/update_variables.ts#L1672-L1768)，完整回复无需由模型输出该标记也可更新页面快照，即使变量未改变。KT 只保存快照和原回复，不把标记加进会话正文、不下载或执行上游模块；其他卡仍要求显式标记。两份快照都只含玩家当前选择公开的路径；继续对话的当前值不会冒充当时值。流式片段、模型工具调用和回放不产生快照。其他历史楼层、`display_data` / `delta_data`、整个酒馆页面或虚拟浏览器 API 不在这个后端切片。

对于用 `$('body').load(...)` 加载外部 HTTPS 网页的旧开场，KT 可识别这一类原作者声明。导入、预览和开局都不执行加载代码、不请求外部 HTML，也不把静态脚本模块的下载许可用于网页。

目录 owner 的 `preview_card_dependencies` 可列出一个符合条件的 `remoteOpeningPage`（`title`、`marker`、`url`），不会下载。只有单独明确确认，才可通过 `confirm_card_opening_page` 传入已入库的 `id` 和完全一致的 `url`，取得 `{openingPage: {url, size}}`。来源限公网 HTTPS 443，路径不得含 `.`／`..` 路径段，不跟重定向；响应限无压缩的 UTF-8 `text/html`，最多 256 KiB。副本按卡保存，详情的 `remoteOpeningPage.snapshot` 可检查是否保存；再次确认已保存的入口直接返回同一份副本。确认不改原卡，不下载页面引用的其他资源，也不会运行网页。此前已入库但缺这份元数据的原件需重新导入。

缓存入口后，目录 owner 的 `preview_card_opening_dependencies` 接受 `{"id":"入库卡片 ID"}`，只从已保存副本读取内联脚本的 `import`／`export from` 和 `import()` 引用（最多 32 项）；分别报告其他资源、不可解析入口及列表截断。这是诊断，不确认或下载任何依赖，也不把外部 `<script src>`、图片或样式当成可自动加载的模块。

仅新开局选到含该标记的开场、且没有适用的 CHARX 或卡内页面时，才从本地缓存快照自包含的外链入口。页面和开场照旧只读，随本局存档；后来缓存或删除库卡不改旧局。未确认、需要外部资源、或入口形式暂不支持时，酒馆正常开局，owner 分别报告 `entry_unconfirmed`、`entry_needs_resources` 或 `entry_unsupported`，不提供面板。这里检查的是页面声明的资源和脚本依赖，不替代浏览器隔离，也不保证任意旧网页可运行。此处还没有卡库确认控件或隔离网页实玩支持。

### 酒馆原生面板

在 `data.extensions["kohaku-roleplay"].panels` 声明一组面板；每项有唯一 `id`、显示用 `label` 和 `type`。状态由 KT 的本局字段更新，面板只负责呈现，不自行推进剧情。

| `type` | 附加字段 |
| --- | --- |
| `meter` | `field` 指向有 `min` 和 `max` 的公开数值字段。 |
| `inventory` | `field` 指向公开的字符串列表；相同物品名合并显示数量。 |
| `quest` | `status` 指向公开枚举，`completed` 是该枚举中的完成值；可用 `objectives: [{"label":"…","field":"…","equals":"…"}]` 显示单项目标。 |
| `choices` | `options: [{"label":"…","text":"…"}]`；面板明示实际要发送的内容，玩家点击后才作为一条普通输入提交。不支持宿主斜杠命令。 |

声明背包或任务面板后，酒馆会启用同包的 `rp_apply_gameplay`：`gain_item`、`consume_item` 更新指定背包的数量；`complete_objective` 按面板内从 0 开始的目标序号写入声明的完成值；`complete_quest` 要求所有目标先完成。每次工具调用只结算一件事，同一轮里互不依赖的行为分别调用。例如先拾取物品，再尝试交任务：拾取单独结算，交任务失败不撤销拾取；交付材料和完结任务必须同时成功，所以放在另一次调用里。一次调用里的步骤按顺序校验，失败则该调用一项都不写，只需修正失败的调用，不要重复已经成功的动作。KT 不会猜测并拆开已经打包的步骤。`rp_set_card_state` 可写普通字段、目标进度和任务的非完成阶段，但不能整表替换已声明的背包，也不能直接把任务状态设为完成；包含此类写入的混合批次同样整批拒绝。如果多个任务共用一个状态字段和值，影响它们的动作必须满足所有相关任务的完成条件。已有存档不改写，新规则在下次写入时生效。

引用私有字段、类型不匹配或未知面板声明会跳过并提示。读取已保存的公开字段，不把面板配置或伏笔写回卡片；不改变普通形象和小说的行为，也不替代聊天框的自由输入。现有正文中的原生选项组件继续可用。

### 给其他卡提供独立玩法包

[进度时钟包](examples/progress-clock/kohaku.yaml)是单独安装的 KT 原生包，不是卡片脚本。用普通 KT 安装流程安装 `examples/progress-clock/` 后，从角色库分别导入[档案室](examples/archive-survey.json)和[渡船](examples/ferry-crossing.json)即可开局；两张卡分别配置四格和三格时钟。它们使用同一个工具，但进度按会话保存。导卡不安装包，也不执行包代码；缺包或版本不匹配时仍可保留和导出卡，开局会解释缺什么。原生包拥有宿主插件权限，只安装你信任的包。

卡在 `data.extensions["kohaku-roleplay"].gameplayPack` 声明 `name`、准确 `version`（`x.y.z`）以及可选 JSON `settings`，不能指定模块或工具名。独立包在自己的 `kohaku.yaml` 将 `creatures/rp_tavern` 声明为 `{name: rp_tavern, roleplay_pack: true}`。该 creature 加载 tavern 模式的 `roleplay` 和与包同名的规则插件；规则插件通过 `validate_roleplay_settings(settings)` 检查设置，开局后从 `roleplay.gameplay_settings(包名)` 读取本局副本。工具沿用 KT `contribute_tools`；需要向此酒馆公开的工具名由插件的 `roleplay_tool_names` 给出，前缀为 `rp_pack_<包名，连字符改为下划线>_`。首次约定一张卡只选择一个玩法包，不动态加载代码或自动解决包依赖。

## 项目文件地图

- `kohaku.yaml`：KT 包清单；`creatures/rp_agent/`：单 agent 酒馆配置与角色行为。
- `kt_roleplay/`：后端，含卡片解析、素材库、人物形象/游玩投影和世界书筛选；`card_state.py` 定义卡片状态协议，`state_tool.py` 提供酒馆更新工具，`mvu.py` / `mvu_tool.py` 负责静态初值与本局原生更新工具，`panels.py` 投影酒馆原生面板，`novel.py` / `scene_tools.py` / `recovery.py` 处理小说裁定、分发回报与中断恢复。
- `kt_roleplay/card_editor.py`：在原格式上另存卡片；`charx.py`：读取归档及本地媒体；`portraits.py` / `portrait_library.py`：处理嵌入的本地图片、公开状态映射与立绘副本。
- `package.json` / `package-lock.json`：卡片模块离线链接器的一次性 Node.js 安装声明；`kt_roleplay/module_*.py`、`script_dependencies.py` 和 `link_card_module.mjs` 负责检查、保存与链接。
- [原生玩法最小示例：物资登记员](examples/native-ledger.json)：可直接在角色库导入并开酒馆。无需卡片 JS、MVU 或 Node。查看 `state` 如何声明库存、核对结果和任务状态，再看 `panels` 如何引用它们。点击「核对清单」只发送所示玩家输入；由玩法工具记录动作，面板读取结果，不靠按钮直接改存档。
- `ui/`：KT UI SDK 扩展，包含角色库、卡片编辑、会话侧栏、行动选项与语言资源。

## 兼容范围

角色卡优先使用 PNG / JSON V2；支持 V1 基础字段及 V3 的兼容子集。未知扩展保存在导入的原件中，不自动执行或下载外部资源。已有会话保留开局时的角色文字设定；删除库中卡片不会删除已发生的对话，但之后不能再从素材库读取该卡头像。

### 酒馆世界书

酒馆可读取卡内世界书，并独立绑定或解除一本 JSON 世界书，不影响其他会话。支持 Tavern 的 `entries` 列表或 ID 对象、四种次关键词组合、字面关键词、全词匹配、扫描深度与分书预算。明确启用 `recursive_scanning`（或 `recursiveScanning`）的世界书最多扫描八轮；只将已选且允许继续触发的条目用于递归，同一条在一次请求中不重复插入。卡内和附加世界书共享约 2,048 个正文 token 的预算（估算）。

支持角色定义前后、会话笔记前后和普通对话深度。笔记位置映射到 KT 会话笔记；深度位置始终作为参考资料插入，不按卡内角色配置提权为系统消息。支持 `probability`（0–100，`useProbability: false` 时忽略概率）和每本书独立的包含组。`group` 可用逗号列出多个名字；在同一轮中一个条目赢下组后，同属任一组的候选不会同时入选。可用 `useGroupScoring` 为全书或单条启用关键词评分；启用评分的条目若低于组内最高得分会被淘汰，对剩余条目先按顺序值从高到低处理 `groupOverride`，再对未占用的组按 `groupWeight` 抽选；调换逗号两侧的组名不会改变优先结果。先从组内选条目，再判断触发概率；未通过的条目不在该请求的后续递归中重抽。`delay` 以当前活动会话中非空玩家／角色消息数为门槛，不计纯工具反馈或系统提示。

不支持的示例位置、不兼容的正则关键词、脚本片段及其他未识别项会跳过，而不是阻止整本导入。已开局快照不自动补写之前被跳过的条目：酒馆附加书可重新绑定，旧卡内嵌书需以更新后的插件新开局。酒馆侧栏分开显示卡内和附加世界书各自的可解析条目数及跳过原因；原书明确禁用的条目仍不参与匹配。普通角色形象和小说 NPC 不加载此类世界书规则。

`sticky` 与 `cooldown` 从条目实际入选的消息开始计数，触发消息本身算首格。同一消息上的工具续轮不推进计时；黏滞期内不重查关键词或重掷概率，优先于普通竞争条目，但仍受预算和同组排他限制。随后冷却窗口内不重新触发。计时跟随存档，重新绑定附加书会清掉附加书计时，不影响卡内书。

命名 outlet 条目可用位置 `7` 与 `outletName`（或卡片扩展的 `outlet_name`）。在卡片系统提示或历史后指示中写 `{{outlet::名称}}`；只有存在引用且通过普通触发和预算的条目才会渲染。同名插槽只填充首处，不展开嵌套；玩家消息、会话笔记和其他字段不作为插槽位置。

酒馆世界书可用 `/模式/flags` 作为主关键词或次关键词；支持常用正则及 `i`、`m`、`s`、`u`，不保证与 JavaScript 引擎等价。正则仅扫描候选文本末尾的 8,192 个字符，单次匹配与整次请求都有时间上限；超时直接跳过该条，避免把未知结果当成「不匹配」。缺少 `regex` 依赖或导入语法不受支持时将报告，并继续处理字面关键词。

### 小说模式

小说模式允许玩家直接输入行动，由 root 判断哪些角色应当察觉，不必手动点名。多人一幕需要多次模型请求；参数重试以及 KT Studio 自动生成的会话摘要也可能产生调用。侧栏只展示公开状态，不保证模型生成的自由正文永不串视角。耗时、角色选择和长局一致性取决于所选模型与卡片。模型有时会收到视角却不回报：此时本幕会停住，而不是让 root 代演；待模型空闲后可尝试“恢复本幕”。侧栏的最新正文是已提交版本，不能把上一幕正文误当成新一幕。本版不保证连续六幕无需干预，小说模式仍为实验性。
