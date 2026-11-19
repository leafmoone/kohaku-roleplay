import { computed, onBeforeUnmount, ref, watch } from "vue";
import { ActionButton } from "@kohakuterrarium/ui-sdk";

import { useRoleplayText } from "./strings.js";

function encodeJsonForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function isNonEmptyPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value).length > 0;
}

function buildAuthorPreheatScript(bootData) {
  // Never serialize both legacyOpening and legacyLatest into the author frame:
  // only serialize the single selected message snapshot (or null for CHARX native web panels).
  const singleMessage = bootData.isLegacyOpening
    ? bootData.selectedLegacyMessage || null
    : null;
  const hasSelectedStatData = isNonEmptyPlainObject(singleMessage?.data?.stat_data);
  const mvuReadCap =
    bootData.isLegacyOpening &&
    hasSelectedStatData &&
    bootData.legacyMvuRead &&
    typeof bootData.legacyMvuRead === "object" &&
    bootData.legacyMvuRead.mode === "kt-message-stat-data-v1"
      ? { mode: "kt-message-stat-data-v1" }
      : null;
  const sanitizedBoot = {
    isLegacyOpening: Boolean(bootData.isLegacyOpening),
    playerName: typeof bootData.playerName === "string" ? bootData.playerName : "Player",
    characterName: typeof bootData.characterName === "string" ? bootData.characterName : "",
    selectedLegacyMessage: singleMessage,
    ...(mvuReadCap ? { legacyMvuRead: mvuReadCap } : {}),
  };
  const payloadJson = encodeJsonForInlineScript(sanitizedBoot);
  return `<script>(function(){
"use strict";
const BOOT = ${payloadJson};
const store = new Map();
const MAX_KEYS = 32;
const MAX_VAL_LEN = 4096;
const storageFacade = {
  get length() { return store.size; },
  key(idx) {
    const n = Number(idx);
    if (!Number.isInteger(n) || n < 0 || n >= store.size) return null;
    return Array.from(store.keys())[n] ?? null;
  },
  getItem(k) {
    const key = String(k);
    return store.has(key) ? store.get(key) : null;
  },
  setItem(k, v) {
    const key = String(k);
    const val = String(v);
    if (key.length > 128 || val.length > MAX_VAL_LEN) return;
    if (!store.has(key) && store.size >= MAX_KEYS) return;
    store.set(key, val);
  },
  removeItem(k) {
    store.delete(String(k));
  },
  clear() {
    store.clear();
  }
};
try {
  Object.defineProperty(window, "localStorage", {
    value: storageFacade,
    configurable: false,
    enumerable: true,
    writable: false
  });
} catch (_e) {}
try {
  Object.defineProperty(window, "sessionStorage", {
    value: storageFacade,
    configurable: false,
    enumerable: true,
    writable: false
  });
} catch (_e) {}

function cloneValue(val) {
  try {
    return JSON.parse(JSON.stringify(val));
  } catch (_e) {
    return val;
  }
}

if (BOOT.isLegacyOpening && BOOT.selectedLegacyMessage) {
  const singleMsg = BOOT.selectedLegacyMessage;
  const activeId = Number.isInteger(singleMsg.message_id) ? singleMsg.message_id : 0;

  window.getCurrentMessageId = function getCurrentMessageId() {
    return activeId;
  };

  window.getChatMessages = function getChatMessages(idOrRange) {
    let targetNum = activeId;
    if (idOrRange !== undefined && idOrRange !== null && idOrRange !== "") {
      const raw = String(idOrRange).trim();
      if (!/^-?\\d+$/.test(raw)) {
        return [];
      }
      targetNum = Number(raw);
    }
    if (targetNum === activeId) {
      return [cloneValue(singleMsg)];
    }
    return [];
  };

  const statData = singleMsg.data && singleMsg.data.stat_data;
  const hasNonEmptyStatData =
    Boolean(statData) &&
    typeof statData === "object" &&
    !Array.isArray(statData) &&
    Object.keys(statData).length > 0;

  if (
    BOOT.legacyMvuRead &&
    BOOT.legacyMvuRead.mode === "kt-message-stat-data-v1" &&
    hasNonEmptyStatData
  ) {
    const _ReflectOwnKeys = Reflect.ownKeys;
    const _getOwnPropDesc = Object.getOwnPropertyDescriptor;
    const _getProtoOf = Object.getPrototypeOf;
    const _ObjectProto = Object.prototype;
    const _hasOwn =
      typeof Object.hasOwn === "function"
        ? Object.hasOwn
        : Function.prototype.call.bind(_ObjectProto.hasOwnProperty);
    const _jsonParse = JSON.parse;
    const _jsonStringify = JSON.stringify;
    const _structuredClone =
      typeof window.structuredClone === "function"
        ? window.structuredClone.bind(window)
        : null;
    const _statDataJson = _jsonStringify(statData);
    if (typeof _statDataJson !== "string") {
      throw new Error("Failed to serialize read-only MVU snapshot");
    }
    const _statDataFrozenSource = _structuredClone ? _jsonParse(_statDataJson) : null;

    const cloneStatDataStrict = function cloneStatDataStrict() {
      const cloned = _structuredClone
        ? _structuredClone(_statDataFrozenSource)
        : _jsonParse(_statDataJson);
      if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
        throw new Error("Failed to clone read-only MVU snapshot");
      }
      return cloned;
    };

    const getVariablesFacade = function getVariables(option) {
      if (!option || typeof option !== "object" || Array.isArray(option)) {
        throw new Error("getVariables requires an explicit { type: 'message' } option");
      }
      const proto = _getProtoOf(option);
      if (proto !== _ObjectProto && proto !== null) {
        throw new Error("getVariables option must be a plain object");
      }
      const ownKeys = _ReflectOwnKeys(option);
      let hasOwnType = false;
      let typeVal = undefined;
      let hasOwnMessageId = false;
      let rawId = undefined;
      for (let i = 0; i < ownKeys.length; i += 1) {
        const k = ownKeys[i];
        if (typeof k !== "string" || (k !== "type" && k !== "message_id")) {
          throw new Error("Unsupported getVariables option key: " + String(k));
        }
        const desc = _getOwnPropDesc(option, k);
        if (!desc || !desc.enumerable || !_hasOwn(desc, "value")) {
          throw new Error("getVariables option properties must be own enumerable data properties");
        }
        if (k === "type") {
          hasOwnType = true;
          typeVal = desc.value;
        } else {
          hasOwnMessageId = true;
          rawId = desc.value;
        }
      }
      if (!hasOwnType || typeVal !== "message") {
        throw new Error("Only message-scoped getVariables({ type: 'message' }) is supported");
      }
      const matchesSelected =
        !hasOwnMessageId ||
        rawId === undefined ||
        rawId === "latest" ||
        rawId === -1 ||
        rawId === activeId;
      if (!matchesSelected) {
        throw new Error("Only the currently selected message snapshot is readable");
      }
      return { stat_data: cloneStatDataStrict() };
    };

    const mvuSubset = Object.freeze({
      mode: "kt-message-stat-data-v1",
      readOnly: true
    });

    const waitGlobalInitializedFacade = function waitGlobalInitialized(name) {
      if (name === "Mvu") {
        return Promise.resolve(mvuSubset);
      }
      return Promise.reject(
        new Error("Global is not available in KT read-only sandbox: " + String(name))
      );
    };

    try {
      Object.defineProperty(window, "Mvu", {
        value: mvuSubset,
        configurable: false,
        enumerable: true,
        writable: false
      });
    } catch (_e) {
      window.Mvu = mvuSubset;
    }
    try {
      Object.defineProperty(window, "getVariables", {
        value: getVariablesFacade,
        configurable: false,
        enumerable: true,
        writable: false
      });
    } catch (_e) {
      window.getVariables = getVariablesFacade;
    }
    try {
      Object.defineProperty(window, "waitGlobalInitialized", {
        value: waitGlobalInitializedFacade,
        configurable: false,
        enumerable: true,
        writable: false
      });
    } catch (_e) {
      window.waitGlobalInitialized = waitGlobalInitializedFacade;
    }
  }
}

window.substitudeMacros = function substitudeMacros(text) {
  if (typeof text !== "string") return String(text ?? "");
  const user = typeof BOOT.playerName === "string" && BOOT.playerName ? BOOT.playerName : "Player";
  const chr = typeof BOOT.characterName === "string" && BOOT.characterName ? BOOT.characterName : "";
  return text
    .replace(/<user>/gi, function() { return user; })
    .replace(/\\{\\{\\s*user\\s*\\}\\}/gi, function() { return user; })
    .replace(/<char>/gi, function() { return chr; })
    .replace(/\\{\\{\\s*char\\s*\\}\\}/gi, function() { return chr; });
};
window.substituteMacros = window.substitudeMacros;

let reqSeq = 0;
const pending = new Map();

window.addEventListener("message", function(ev) {
  if (ev.source !== window.parent) return;
  const d = ev.data;
  if (!d || typeof d !== "object" || d.__ktrpBridge !== "outer-to-inner") return;
  if (d.type === "rpc-reply" && typeof d.reqId === "number") {
    const entry = pending.get(d.reqId);
    if (!entry) return;
    pending.delete(d.reqId);
    if (d.ok) {
      entry.resolve(d.result);
    } else {
      entry.reject(new Error(typeof d.error === "string" ? d.error : "Card web request failed"));
    }
  }
});

function callBridge(action, payload) {
  return new Promise(function(resolve, reject) {
    const reqId = ++reqSeq;
    pending.set(reqId, { resolve: resolve, reject: reject });
    window.parent.postMessage({
      __ktrpBridge: "inner-to-outer",
      reqId: reqId,
      action: action,
      payload: payload || {}
    }, "*");
  });
}

const ktrpApi = Object.freeze({
  mode: BOOT.isLegacyOpening ? "legacy-opening-readonly" : "charx-web-panel",
  readOnly: Boolean(BOOT.isLegacyOpening),
  getState: function() {
    return callBridge("card_web_state", {});
  },
  applyGameplay: function(actions) {
    const list = Array.isArray(actions) ? actions : (actions && Array.isArray(actions.actions) ? actions.actions : []);
    return callBridge("card_web_gameplay", { actions: list });
  },
  requestPlugin: function(method, url, body) {
    const payload = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
    if (body !== undefined) payload.body = body;
    return callBridge("card_web_plugin_request", payload);
  }
});

try {
  Object.defineProperty(window, "ktRoleplay", {
    value: ktrpApi,
    configurable: false,
    enumerable: true,
    writable: false
  });
} catch (_e) {
  window.ktRoleplay = ktrpApi;
}
})();</script>`;
}

/**
 * Places the trusted bootstrap `<script>` strictly before any author markup or comments,
 * preserving only a known leading `<!DOCTYPE html>` at the very start of the string
 * so standards mode is retained without scanning or parsing inside author HTML.
 */
function prependPreheatBeforeAuthorMarkup(rawHtml, preheatTag) {
  const html = String(rawHtml || "");
  const doctypeMatch = /^\s*<!doctype\s+html\s*>/i.exec(html);
  if (doctypeMatch) {
    const endIdx = doctypeMatch[0].length;
    return html.slice(0, endIdx) + preheatTag + html.slice(endIdx);
  }
  return preheatTag + html;
}

export function buildOuterSandboxSrcdoc(authorHtml, bootData) {
  const preheat = buildAuthorPreheatScript(bootData);
  const fullInnerHtml = prependPreheatBeforeAuthorMarkup(authorHtml, preheat);
  const innerHtmlJson = encodeJsonForInlineScript(fullInnerHtml);
  const mountTokenJson = encodeJsonForInlineScript(String(bootData.mountToken || ""));
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'none'; connect-src 'none'; img-src 'none'; media-src 'none'; font-src 'none'; object-src 'none'; form-action 'none'">
<style>
html, body {
  margin: 0;
  padding: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: transparent;
}
#ktrp-inner-sandbox {
  border: 0;
  width: 100%;
  height: 100%;
  display: block;
}
</style>
</head>
<body>
<iframe id="ktrp-inner-sandbox" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
<script>(function(){
"use strict";
const MOUNT_TOKEN = ${mountTokenJson};
const INNER_HTML = ${innerHtmlJson};
const ALLOWED_ACTIONS = new Set(["card_web_state", "card_web_gameplay", "card_web_plugin_request"]);
const innerFrame = document.getElementById("ktrp-inner-sandbox");
innerFrame.srcdoc = INNER_HTML;

window.addEventListener("message", function(ev) {
  const d = ev.data;
  if (!d || typeof d !== "object") return;
  if (ev.source === innerFrame.contentWindow && d.__ktrpBridge === "inner-to-outer") {
    const action = typeof d.action === "string" ? d.action : "";
    const reqId = typeof d.reqId === "number" ? d.reqId : -1;
    if (!ALLOWED_ACTIONS.has(action) || reqId <= 0) {
      if (reqId > 0 && innerFrame.contentWindow) {
        innerFrame.contentWindow.postMessage({
          __ktrpBridge: "outer-to-inner",
          type: "rpc-reply",
          reqId: reqId,
          ok: false,
          error: "Unsupported card web bridge action"
        }, "*");
      }
      return;
    }
    window.parent.postMessage({
      __ktrpHostBridge: "outer-to-host",
      mountToken: MOUNT_TOKEN,
      reqId: reqId,
      action: action,
      payload: d.payload && typeof d.payload === "object" ? d.payload : {}
    }, "*");
    return;
  }
  if (ev.source === window.parent && d.__ktrpHostBridge === "host-to-outer") {
    if (d.mountToken !== MOUNT_TOKEN) return;
    if (innerFrame.contentWindow) {
      innerFrame.contentWindow.postMessage({
        __ktrpBridge: "outer-to-inner",
        type: "rpc-reply",
        reqId: d.reqId,
        ok: Boolean(d.ok),
        result: d.result,
        error: d.error
      }, "*");
    }
  }
});
})();</script>
</body>
</html>`;
}

/**
 * Isolated Card Web Panel & Explicit Control Bar for `plugin:roleplay`.
 * Renders an explicit open/reload/expand/close control bar when `state.webPanel` is present,
 * or an explicit non-blocking issue banner when `state.webPanelIssue` is reported.
 * Opening the panel fetches `card_web_panel` and mounts a nested double-srcdoc sandbox:
 * - Outer iframe: `sandbox="allow-scripts"` + strict CSP (`default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'none'`)
 * - Inner iframe: `sandbox="allow-scripts"` (opaque origin, never `allow-same-origin`)
 */
export const CardWebPanel = {
  name: "RoleplayCardWebPanel",
  components: { ActionButton },
  props: {
    owner: { type: Object, required: true },
    scopeKey: { type: String, required: true },
    mvuPublicSignature: { type: String, default: "[]" },
    webPanelMeta: { type: Object, default: null },
    webPanelIssue: { type: String, default: "" },
    playerName: { type: String, default: "Player" },
    characterName: { type: String, default: "" },
  },
  setup(props) {
    const t = useRoleplayText();

    const isOpen = ref(false);
    const isExpanded = ref(false);
    const loading = ref(false);
    const error = ref("");
    const activeMountToken = ref("");
    const activePanelScope = ref("");
    const activeTitle = ref("");
    const activeSource = ref("");
    const activeSnapshotTarget = ref("latest");
    const userPinnedOpening = ref(false);
    const activeSelectedMessageId = ref(null);
    const hasLegacyLatest = ref(false);
    const latestTurnNumber = ref(null);
    const cachedPanelPayload = ref(null);
    const outerSrcdoc = ref("");
    const outerFrameRef = ref(null);

    let mountSeq = 0;

    const isLegacyOpening = computed(
      () =>
        activeSource.value === "legacyOpening" ||
        props.webPanelMeta?.source === "legacyOpening",
    );

    const displayedLatestTurnNumber = computed(() => {
      if (Number.isInteger(latestTurnNumber.value)) {
        return latestTurnNumber.value;
      }
      const fromMeta = props.webPanelMeta?.latestMessageId;
      if (Number.isInteger(fromMeta)) return fromMeta;
      return null;
    });

    const canSwitchLegacySnapshot = computed(
      () =>
        isOpen.value &&
        !loading.value &&
        Boolean(cachedPanelPayload.value) &&
        isLegacyOpening.value &&
        Boolean(
          hasLegacyLatest.value ||
            Number.isInteger(props.webPanelMeta?.latestMessageId),
        ),
    );

    function issueMessage(code) {
      if (code === "entry_unconfirmed") {
        return t("cardWebIssueEntryUnconfirmed");
      }
      if (code === "entry_needs_resources") {
        return t("cardWebIssueEntryNeedsResources");
      }
      if (code === "entry_unsupported") {
        return t("cardWebIssueEntryUnsupported");
      }
      return code;
    }

    function clearLoadedPayloadAndSnapshotState() {
      activeMountToken.value = "";
      activePanelScope.value = "";
      cachedPanelPayload.value = null;
      activeSelectedMessageId.value = null;
      hasLegacyLatest.value = false;
      latestTurnNumber.value = null;
      outerSrcdoc.value = "";
    }

    function destroyActiveFrame() {
      mountSeq += 1;
      clearLoadedPayloadAndSnapshotState();
      loading.value = false;
    }

    function closePanel() {
      destroyActiveFrame();
      isOpen.value = false;
      isExpanded.value = false;
      userPinnedOpening.value = false;
      error.value = "";
    }

    function mountFromPayload(payload, preferredTarget) {
      const seq = ++mountSeq;
      const token = `${props.scopeKey}::${props.mvuPublicSignature}::mount::${seq}::${Date.now()}`;
      const isLegacy =
        Boolean(payload.legacyOpening) || props.webPanelMeta?.source === "legacyOpening";
      const latestMsg =
        payload.legacyLatest && typeof payload.legacyLatest === "object"
          ? payload.legacyLatest
          : null;
      const openingMsg =
        payload.legacyOpening && typeof payload.legacyOpening === "object"
          ? payload.legacyOpening
          : null;

      hasLegacyLatest.value = Boolean(latestMsg);
      latestTurnNumber.value =
        latestMsg && Number.isInteger(latestMsg.message_id)
          ? latestMsg.message_id
          : null;

      const resolvedTarget =
        preferredTarget === "opening" || !latestMsg ? "opening" : "latest";
      activeSnapshotTarget.value = resolvedTarget;

      // Strictly choose a single snapshot for the author frame: never pass both!
      const singleSelectedMessage = isLegacy
        ? resolvedTarget === "latest" && latestMsg
          ? latestMsg
          : openingMsg
        : null;
      const selectedHasStatData = isNonEmptyPlainObject(
        singleSelectedMessage?.data?.stat_data,
      );
      const legacyMvuRead =
        isLegacy &&
        selectedHasStatData &&
        payload.legacyMvuRead &&
        typeof payload.legacyMvuRead === "object" &&
        payload.legacyMvuRead.mode === "kt-message-stat-data-v1"
          ? { mode: "kt-message-stat-data-v1" }
          : null;

      activeSelectedMessageId.value =
        singleSelectedMessage && Number.isInteger(singleSelectedMessage.message_id)
          ? singleSelectedMessage.message_id
          : null;
      activePanelScope.value = String(payload.panelScope);
      activeMountToken.value = token;
      activeTitle.value = String(payload.title || props.webPanelMeta?.title || "");
      activeSource.value = isLegacy ? "legacyOpening" : "charx";

      outerSrcdoc.value = buildOuterSandboxSrcdoc(payload.html, {
        mountToken: token,
        isLegacyOpening: isLegacy,
        playerName: props.playerName || "Player",
        characterName: props.characterName || "",
        selectedLegacyMessage: singleSelectedMessage,
        legacyMvuRead,
      });
    }

    function selectLegacySnapshot(target) {
      if (target !== "opening" && target !== "latest") return;
      if (!isOpen.value || loading.value) return;
      userPinnedOpening.value = target === "opening";
      const metaLatestId = props.webPanelMeta?.latestMessageId;
      const needsFetchForLatest =
        target === "latest" &&
        (!cachedPanelPayload.value?.legacyLatest ||
          (Number.isInteger(metaLatestId) &&
            cachedPanelPayload.value.legacyLatest.message_id !== metaLatestId));
      if (cachedPanelPayload.value && !needsFetchForLatest) {
        mountFromPayload(cachedPanelPayload.value, target);
      } else {
        openOrReloadPanel(target);
      }
    }

    async function openOrReloadPanel(preferredTarget = "latest") {
      if (!props.webPanelMeta || !props.owner) return;
      const scopeSnap = props.scopeKey;
      const mvuSigSnap = props.mvuPublicSignature;
      const seq = ++mountSeq;

      // Immediately invalidate any previous frame, cached payload, snapshot controls, and in-flight requests
      clearLoadedPayloadAndSnapshotState();
      isOpen.value = true;
      loading.value = true;
      error.value = "";

      try {
        const res = await props.owner.call("card_web_panel", {});
        if (
          seq !== mountSeq ||
          props.scopeKey !== scopeSnap ||
          props.mvuPublicSignature !== mvuSigSnap ||
          !isOpen.value
        ) {
          return;
        }
        if (!res || typeof res !== "object" || typeof res.html !== "string" || !res.panelScope) {
          throw new Error("Invalid card web panel payload");
        }
        cachedPanelPayload.value = res;
        const target =
          preferredTarget === "opening" || preferredTarget === "latest"
            ? preferredTarget
            : "latest";
        mountFromPayload(res, target);
      } catch (err) {
        if (
          seq === mountSeq &&
          props.scopeKey === scopeSnap &&
          props.mvuPublicSignature === mvuSigSnap
        ) {
          clearLoadedPayloadAndSnapshotState();
          error.value = err?.message || String(err);
        }
      } finally {
        if (seq === mountSeq || cachedPanelPayload.value) {
          loading.value = false;
        }
      }
    }

    async function handleWindowMessage(ev) {
      const frameWin = outerFrameRef.value?.contentWindow;
      if (!frameWin || ev.source !== frameWin) return;
      const d = ev.data;
      if (!d || typeof d !== "object" || d.__ktrpHostBridge !== "outer-to-host") return;

      const tokenSnap = activeMountToken.value;
      const panelScopeSnap = activePanelScope.value;
      const scopeSnap = props.scopeKey;
      const mvuSigSnap = props.mvuPublicSignature;
      if (!isOpen.value || !tokenSnap || d.mountToken !== tokenSnap || !panelScopeSnap) {
        return;
      }

      const reqId = typeof d.reqId === "number" ? d.reqId : -1;
      const action = typeof d.action === "string" ? d.action : "";
      const payload = d.payload && typeof d.payload === "object" ? d.payload : {};
      if (reqId <= 0) return;

      function replyToOuter(ok, result, errText) {
        const currentWin = outerFrameRef.value?.contentWindow;
        if (
          !isOpen.value ||
          !currentWin ||
          currentWin !== frameWin ||
          activeMountToken.value !== tokenSnap ||
          props.scopeKey !== scopeSnap ||
          props.mvuPublicSignature !== mvuSigSnap
        ) {
          return;
        }
        currentWin.postMessage(
          {
            __ktrpHostBridge: "host-to-outer",
            mountToken: tokenSnap,
            reqId,
            ok,
            result: ok ? result : undefined,
            error: ok ? undefined : errText,
          },
          "*",
        );
      }

      if (
        action !== "card_web_state" &&
        action !== "card_web_gameplay" &&
        action !== "card_web_plugin_request"
      ) {
        replyToOuter(false, null, "Unsupported card web action");
        return;
      }

      try {
        let rpcArgs = { panelScope: panelScopeSnap };
        if (action === "card_web_gameplay") {
          rpcArgs = {
            panelScope: panelScopeSnap,
            actions: Array.isArray(payload.actions) ? payload.actions : [],
          };
        } else if (action === "card_web_plugin_request") {
          rpcArgs = {
            panelScope: panelScopeSnap,
            method: payload.method,
            url: payload.url,
            ...(payload.body !== undefined ? { body: payload.body } : {}),
          };
        }
        // Note: backend `apply_gameplay_actions` already calls `self.ui_emit("state", self.ui_state())`.
        // We reply directly with the settled result so a secondary refresh failure can never turn a
        // committed gameplay action into an error receipt on the author page.
        const result = await props.owner.call(action, rpcArgs);
        if (
          !isOpen.value ||
          activeMountToken.value !== tokenSnap ||
          activePanelScope.value !== panelScopeSnap ||
          props.scopeKey !== scopeSnap ||
          props.mvuPublicSignature !== mvuSigSnap
        ) {
          return;
        }
        error.value = "";
        replyToOuter(true, result, "");
      } catch (err) {
        const msg = err?.message || String(err);
        if (
          isOpen.value &&
          activeMountToken.value === tokenSnap &&
          props.scopeKey === scopeSnap &&
          props.mvuPublicSignature === mvuSigSnap
        ) {
          error.value = msg;
        }
        replyToOuter(false, null, msg);
      }
    }

    if (typeof window !== "undefined") {
      window.addEventListener("message", handleWindowMessage);
    }

    onBeforeUnmount(() => {
      if (typeof window !== "undefined") {
        window.removeEventListener("message", handleWindowMessage);
      }
      destroyActiveFrame();
    });

    // Tear down immediately when session/creature/card scope changes, MVU public selection changes, or webPanel disappears
    watch(
      () => [props.scopeKey, props.mvuPublicSignature, Boolean(props.webPanelMeta)],
      ([nextScope, nextMvuSig, hasPanel], [prevScope, prevMvuSig]) => {
        if (nextScope !== prevScope || nextMvuSig !== prevMvuSig || !hasPanel) {
          closePanel();
        }
      },
    );

    // When legacyLatest updates while the panel is open:
    // - If the user explicitly pinned Opening (#0), keep showing Opening (#0) and just mark Latest available;
    // - Otherwise, follow the new Latest turn snapshot automatically.
    watch(
      () => props.webPanelMeta?.latestMessageId,
      (nextId, prevId) => {
        if (!Number.isInteger(nextId) || nextId === prevId) return;
        if (
          isOpen.value &&
          !loading.value &&
          isLegacyOpening.value &&
          !userPinnedOpening.value &&
          nextId !== latestTurnNumber.value
        ) {
          openOrReloadPanel("latest");
        }
      },
    );

    return {
      t,
      isOpen,
      isExpanded,
      loading,
      error,
      activeMountToken,
      activeTitle,
      activeSnapshotTarget,
      activeSelectedMessageId,
      hasLegacyLatest,
      latestTurnNumber,
      displayedLatestTurnNumber,
      canSwitchLegacySnapshot,
      outerSrcdoc,
      outerFrameRef,
      isLegacyOpening,
      issueMessage,
      selectLegacySnapshot,
      openOrReloadPanel,
      closePanel,
    };
  },
  template: `
    <div
      v-if="webPanelMeta || webPanelIssue"
      class="ktrp-card-box ktrp-web-panel-box"
      data-testid="kt-rp-web-panel-section"
    >
      <div class="ktrp-row-between ktrp-web-panel-toolbar" data-testid="kt-rp-web-panel-toolbar">
        <div class="ktrp-inline-actions">
          <strong class="ktrp-box-head" data-testid="kt-rp-web-panel-title">
            {{ webPanelMeta?.title || activeTitle || t('cardWebPanelDefaultTitle') }}
          </strong>
          <span
            v-if="webPanelMeta"
            class="ktrp-chip"
            :class="{ 'ktrp-chip--accent': !isLegacyOpening }"
            data-testid="kt-rp-web-panel-mode-badge"
          >
            {{ isLegacyOpening ? t('cardWebPanelLegacyReadonlyBadge') : t('cardWebPanelInteractiveBadge') }}
          </span>
          <span
            v-if="isOpen && isLegacyOpening && activeSelectedMessageId !== null"
            class="ktrp-chip"
            data-testid="kt-rp-web-panel-turn-badge"
          >
            #{{ activeSelectedMessageId }}
          </span>
        </div>

        <div v-if="webPanelMeta" class="ktrp-inline-actions">
          <ActionButton
            v-if="!isOpen"
            size="sm"
            variant="primary"
            :disabled="loading"
            data-testid="kt-rp-web-panel-open-btn"
            @click="openOrReloadPanel('latest')"
          >
            {{ t('cardWebPanelOpenBtn') }}
          </ActionButton>
          <template v-else>
            <template v-if="canSwitchLegacySnapshot">
              <ActionButton
                size="sm"
                :variant="activeSnapshotTarget === 'opening' ? 'primary' : 'default'"
                :disabled="loading"
                data-testid="kt-rp-web-panel-snapshot-opening-btn"
                @click="selectLegacySnapshot('opening')"
              >
                {{ t('cardWebPanelSnapshotOpeningBtn') }}
              </ActionButton>
              <ActionButton
                size="sm"
                :variant="activeSnapshotTarget === 'latest' ? 'primary' : 'default'"
                :disabled="loading || !canSwitchLegacySnapshot"
                data-testid="kt-rp-web-panel-snapshot-latest-btn"
                @click="selectLegacySnapshot('latest')"
              >
                {{
                  displayedLatestTurnNumber !== null
                    ? t('cardWebPanelSnapshotLatestTurnBtn', { turn: displayedLatestTurnNumber })
                    : t('cardWebPanelSnapshotLatestBtn')
                }}
              </ActionButton>
            </template>
            <ActionButton
              size="sm"
              :disabled="loading"
              data-testid="kt-rp-web-panel-reload-btn"
              @click="openOrReloadPanel(activeSnapshotTarget)"
            >
              {{ loading ? t('cardWebPanelLoadingBtn') : t('cardWebPanelReloadBtn') }}
            </ActionButton>
            <ActionButton
              size="sm"
              data-testid="kt-rp-web-panel-expand-btn"
              @click="isExpanded = !isExpanded"
            >
              {{ isExpanded ? t('cardWebPanelCollapseBtn') : t('cardWebPanelExpandBtn') }}
            </ActionButton>
            <ActionButton
              size="sm"
              data-testid="kt-rp-web-panel-close-btn"
              @click="closePanel"
            >
              {{ t('cardWebPanelCloseBtn') }}
            </ActionButton>
          </template>
        </div>
      </div>

      <p v-if="webPanelMeta" class="ktrp-muted" data-testid="kt-rp-web-panel-hint">
        {{ isLegacyOpening ? t('cardWebPanelLegacyHint') : t('cardWebPanelInteractiveHint') }}
      </p>

      <div
        v-if="webPanelIssue && !webPanelMeta"
        class="ktrp-banner ktrp-banner--info"
        role="status"
        data-testid="kt-rp-web-panel-issue"
      >
        <span>{{ issueMessage(webPanelIssue) }}</span>
      </div>

      <div
        v-if="error"
        class="ktrp-banner ktrp-banner--error"
        role="alert"
        data-testid="kt-rp-web-panel-error"
      >
        <span>{{ error }}</span>
      </div>

      <div
        v-if="isOpen"
        class="ktrp-web-panel-stage"
        :class="{ 'is-expanded': isExpanded }"
        data-testid="kt-rp-web-panel-stage"
      >
        <div
          v-if="loading && !outerSrcdoc"
          class="ktrp-empty"
          data-testid="kt-rp-web-panel-loading"
        >
          {{ t('cardWebPanelLoadingBtn') }}
        </div>
        <iframe
          v-if="outerSrcdoc"
          :key="activeMountToken"
          ref="outerFrameRef"
          class="ktrp-web-panel-iframe"
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          :srcdoc="outerSrcdoc"
          :title="webPanelMeta?.title || activeTitle || t('cardWebPanelDefaultTitle')"
          data-testid="kt-rp-web-panel-outer-frame"
        />
      </div>
    </div>
  `,
};
