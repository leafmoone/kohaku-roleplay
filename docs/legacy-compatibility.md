# 旧版酒馆卡兼容手册

本文档说明 `kohaku-roleplay` 对存量 SillyTavern / MagVarUpdate / TavernHelper 角色卡的受限兼容范围、资源准备流程与安全边界。实测旧卡开场案例另见 [`compat/stagedog-opening.md`](../compat/stagedog-opening.md)。

> **边界说明**：本扩展并非完整的 SillyTavern、EJS 或 Tavern Helper 浏览器运行时；所有脚本求值、模块链接与网页展示均在受限沙箱或独立子进程中按白名单协议运行。

## 酒馆 MVU 初始变量与更新结算

- **静态初值（`[InitVar]`）**：新开酒馆时自动识别卡内世界书名称或备注含 `[InitVar]` 的 JSON / YAML 条目写入本局存档，无需启用该条目的普通触发。可在侧栏「MVU 变量」面板勾选需要公开显示的路径（仅控制界面投影，不影响模型可见性）。
- **只读世界书模板**：支持世界书中的 `<% … %>`、`<%= … %>` / `<%- … %>`、`@@if` 与沙箱内 `await`，在独立 QuickJS 进程中通过 `getvar('stat_data.路径')`、`_.has` 与 `<user>` 只读求值后参与提示词筛选；不执行模型回复中的脚本，也不提供文件或网络访问。
- **变量更新（`rp_update_mvu` / `rp_apply_mvu_update`）**：支持原生工具更新，以及字面量 `<UpdateVariable>` 子集（`_.set`、`_.add` 与 `<JSONPatch>` 的 `test` / `replace` / 数组增删；兼容旧卡 `[标量, 说明文字]` 数组的第 0 项标量更新，`$meta.strictSet: true` 时禁用）。任一操作校验失败则整批拒绝，不保存半成品；是否结算成功以工具调用回执为准。

## 固定版 MagVarUpdate Zod（实验性）

当卡片同时声明受支持的 MagVarUpdate 入口与 StageDog `mvu_zod` schema、要求 JSONPatch 且无其他伴随脚本时，点击角色库「准备卡片资源」可使用经核对的固定版运行时在隔离进程中校验 `<JSONPatch>`（支持 `add`、`replace`、`remove`）：

- 若卡片含受支持的 `<GameStartMenu/>`，可在首轮对话前于 `role` 面板打开一次建角菜单，变更经作者 schema 整批校验写入本局；
- 若卡片含受支持的 `<StatusPlaceHolderImpl/>`（及可选 `Mainchar.Image` 缓存头像），可在 `role` 面板打开只读状态栏查看概览与物品列表；
- 已在原版 KT 2.2.2 验证未改动的 ArtificRealm v1.0.1（建角、结算、状态栏与读档恢复）及《平然世界》公开版 `0ce1aa2`（文字开局与场景变量结算）。

## 酒馆卡片脚本与离线模块链接（实验性）

可识别 `TavernHelper_scripts` 与 `tavern_helper.scripts` 声明（导入时不执行）：

- **受限事件与 API**：在独立受限 JS 进程中按会话回合去重运行，支持 `eventOn`、`getVariables`、`replaceVariables`、`updateVariablesWith`、`getButtonEvent` / `eventOnButton`、`appendInexistentScriptButtons`（单脚本最多 8 个公开按钮）及当前事件消息只读片段 `getChatMessages(-1)`（最长 900 字符），并依次触发 `Mvu.events` 相关回调。不提供 DOM、网络、文件系统或其他楼层历史。
- **静态 ES 模块准备**：在系统装有 Node.js 22.12+（或 20.19+）并在插件安装目录执行过 `npm ci --ignore-scripts --omit=dev` 时，可通过角色库「准备卡片资源」缓存卡片声明的静态 HTTPS 模块并离线链接至本局快照（不跟随重定向，不支持动态 `import()`）。

## 会话内卡片网页与外链开场页

- **CHARX 与内嵌网页**：CHARX 可在 `data.extensions["kohaku-roleplay"].webPanel` 声明包内自包含 HTML（最大 256 KiB）；旧卡仅显示于助理开场的围栏 HTML 正则替换也可被识别为只读面板。页面在 `role` / `Play` 的独立沙箱中按需打开，通过 `panelScope` 校验本局权限，可调用 `window.ktRoleplay.getState()` 与 `applyGameplay(actions)`。
- **外部 HTTPS 开场页审批与固定运行时**：对使用 `$('body').load(...)` 的旧开场，支持通过「准备卡片资源」（底层对应 `preview_card_dependencies`、`confirm_card_opening_page`、`preview_card_opening_module_plan`、`confirm_card_opening_module`）逐级确认静态 HTTPS 入口与模块缓存，离线打包为本局只读网页快照。
- **可选开场运行时参数**：针对特定旧卡结构，开局接口支持显式传入 `openingPageRuntime`（`vue-3.5.22`、`vue-3.5.22-lodash-4.18.1`、`vue-3.5.22-lodash-4.18.1-zod-4.6.7` 或 `tavern-page-callbacks-v1`，全部使用包内锁定的本地依赖离线链接，不联网加载），以及受控的只读快照读取 `enableOpeningMvuRead`、单步整数计数器 `openingMvuCounter`（或卡面 `openingGameplay` 声明）与派生字符串 `openingMvuSchema`。具体参数组合见 [`compat/stagedog-opening.md`](../compat/stagedog-opening.md)。
- **制品与扩展只读诊断**：`tavernArtifacts` 可静态识别内嵌 GameLogic / StatusMenu Pack 版本与缺失宿主适配器提示；`preview_tavern_extension` 可只读检查 SillyTavern UI 扩展清单与入口语法，不安装或执行代码。

## 本机旧酒馆插件接口白名单转发

KT 不运行原版 SillyTavern 后端插件。如需对接独立运行在本机的 JSON 服务，可由操作者在 `<KT_CONFIG_DIR>/kohaku-roleplay/legacy-tavern-plugins.json` 显式配置端口与白名单路由：

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

在会话中通过 `set_legacy_plugins` 显式授权本局可用的 `pluginIds` 后，方可通过 `legacy_plugin_request` 或受信任网页内的 `window.ktRoleplay.requestPlugin(method, url, body?)` 转发请求至 `127.0.0.1:<port>/api/plugins/<id>/<path>`。转发器不携带宿主 Cookie / CSRF / Authorization 凭据，不跟随重定向，仅支持 JSON 或空响应（不支持音频流等二进制返回）。
