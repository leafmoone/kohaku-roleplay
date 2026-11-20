import {
  computed,
  onBeforeUnmount,
  ref,
  watch,
} from "vue";
import {
  ActionButton,
  useCreature,
  useMessage,
  useOwner,
  useSession,
} from "@kohakuterrarium/ui-sdk";

import { useRoleplayText } from "./strings.js";

function encodeJsonForInlineScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function isValidLocator(loc) {
  return (
    Boolean(loc) &&
    typeof loc === "object" &&
    !Array.isArray(loc) &&
    Number.isSafeInteger(loc.turn) &&
    loc.turn > 0 &&
    Number.isSafeInteger(loc.branchId) &&
    loc.branchId > 0 &&
    Number.isSafeInteger(loc.eventId) &&
    loc.eventId > 0 &&
    Number.isSafeInteger(loc.roundStartEventId) &&
    loc.roundStartEventId > 0 &&
    loc.roundStartEventId < loc.eventId
  );
}

function hasRoleplayOptionsTags(text) {
  if (typeof text !== "string" || !text) return false;
  return text.includes("<roleplay_options>") && text.includes("</roleplay_options>");
}

function buildMessageSlotPreheatScript(bootData) {
  const singleMessage =
    bootData.message && typeof bootData.message === "object" && !Array.isArray(bootData.message)
      ? bootData.message
      : null;
  const payloadJson = encodeJsonForInlineScript({
    message: singleMessage,
  });
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

const _jsonParse = JSON.parse;
const _jsonStringify = JSON.stringify;
const _structuredClone =
  typeof window.structuredClone === "function"
    ? window.structuredClone.bind(window)
    : null;

function cloneValue(val) {
  try {
    return _structuredClone ? _structuredClone(val) : _jsonParse(_jsonStringify(val));
  } catch (_e) {
    return _jsonParse(_jsonStringify(val));
  }
}

function ensureLocalMesTextElement() {
  let el = document.querySelector(".mes_text");
  if (el instanceof HTMLElement) return el;
  el = document.createElement("div");
  el.className = "mes_text";
  el.setAttribute("data-testid", "kt-rp-local-mes-text");
  if (document.body) {
    document.body.appendChild(el);
  } else if (document.documentElement) {
    document.documentElement.appendChild(el);
  }
  return el;
}

if (typeof window.$ !== "function") {
  const dollarReady = function $(fn) {
    if (typeof fn !== "function") {
      throw new Error("Only $(fn) DOM-ready callbacks are supported in KT isolated message slot");
    }
    const invoke = function() {
      ensureLocalMesTextElement();
      fn.call(document, dollarReady);
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function() {
        setTimeout(invoke, 0);
      }, { once: true });
    } else {
      setTimeout(invoke, 0);
    }
    return undefined;
  };
  window.$ = dollarReady;
  if (typeof window.jQuery !== "function") {
    window.jQuery = dollarReady;
  }
}

if (typeof window.errorCatched !== "function") {
  window.errorCatched = function errorCatched(fn) {
    if (typeof fn !== "function") {
      throw new Error("errorCatched requires a function");
    }
    return function wrappedErrorCatched() {
      try {
        const out = fn.apply(this, arguments);
        if (out && (typeof out === "object" || typeof out === "function") && typeof out.then === "function") {
          return out.then(undefined, function(err) {
            console.error(err);
            throw err;
          });
        }
        return out;
      } catch (err) {
        console.error(err);
        throw err;
      }
    };
  };
}

const singleMsg = BOOT.message;
const activeId = singleMsg && Number.isInteger(singleMsg.message_id) ? singleMsg.message_id : 0;

function matchesActiveMessageId(idOrRange) {
  if (idOrRange === undefined || idOrRange === null || idOrRange === "") return true;
  if (typeof idOrRange === "number" && Number.isInteger(idOrRange)) {
    return idOrRange === activeId;
  }
  const raw = String(idOrRange).trim();
  if (!/^-?\\d+$/.test(raw)) return false;
  return Number(raw) === activeId;
}

window.getCurrentMessageId = function getCurrentMessageId() {
  return activeId;
};

window.getChatMessages = function getChatMessages(idOrRange) {
  if (!singleMsg || !matchesActiveMessageId(idOrRange)) {
    return [];
  }
  return [cloneValue(singleMsg)];
};

window.retrieveDisplayedMessage = function retrieveDisplayedMessage(messageId) {
  if (!singleMsg || !matchesActiveMessageId(messageId)) {
    return [];
  }
  const mesText = ensureLocalMesTextElement();
  const wrapper = [mesText];
  wrapper.find = function find(selector) {
    if (selector === ".mes_text" && mesText.matches(".mes_text")) {
      return [mesText];
    }
    return Array.from(mesText.querySelectorAll(String(selector || "")));
  };
  return wrapper;
};

const statData = singleMsg && singleMsg.data && singleMsg.data.stat_data;
const hasNonEmptyStatData =
  Boolean(statData) &&
  typeof statData === "object" &&
  !Array.isArray(statData) &&
  Object.keys(statData).length > 0;

if (hasNonEmptyStatData) {
  const _ReflectOwnKeys = Reflect.ownKeys;
  const _getOwnPropDesc = Object.getOwnPropertyDescriptor;
  const _getProtoOf = Object.getPrototypeOf;
  const _ObjectProto = Object.prototype;
  const _ArrayIsArray = Array.isArray;
  const _hasOwn =
    typeof Object.hasOwn === "function"
      ? Object.hasOwn
      : Function.prototype.call.bind(_ObjectProto.hasOwnProperty);
  const _statDataJson = _jsonStringify(statData);
  const _statDataFrozen = _structuredClone ? _jsonParse(_statDataJson) : null;

  const cloneStatDataStrict = function cloneStatDataStrict() {
    return _structuredClone
      ? _structuredClone(_statDataFrozen)
      : _jsonParse(_statDataJson);
  };

  window.getVariables = function getVariables(option) {
    if (!option || typeof option !== "object" || _ArrayIsArray(option)) {
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
      throw new Error("Only the current message snapshot is accessible");
    }
    return { stat_data: cloneStatDataStrict() };
  };

  const mvuSubset = Object.freeze({
    mode: "kt-message-stat-data-v1",
    readOnly: true
  });
  window.Mvu = mvuSubset;
  window.waitGlobalInitialized = function waitGlobalInitialized(name) {
    if (name === "Mvu") return Promise.resolve(mvuSubset);
    return Promise.reject(new Error("Global is not available in KT read-only message slot: " + String(name)));
  };
}

let reqSeq = 0;
const pending = new Map();

window.addEventListener("message", function(ev) {
  if (ev.source !== window.parent) return;
  const d = ev.data;
  if (!d || typeof d !== "object" || d.__ktrpSlotBridge !== "outer-to-inner") return;
  if (d.type === "rpc-reply" && typeof d.reqId === "number") {
    const entry = pending.get(d.reqId);
    if (!entry) return;
    pending.delete(d.reqId);
    if (d.ok) {
      entry.resolve(d.result);
    } else {
      entry.reject(new Error(typeof d.error === "string" ? d.error : "Message option preview failed"));
    }
  }
});

function callSlotBridge(action, payload) {
  return new Promise(function(resolve, reject) {
    const reqId = ++reqSeq;
    pending.set(reqId, { resolve: resolve, reject: reject });
    window.parent.postMessage({
      __ktrpSlotBridge: "inner-to-outer",
      reqId: reqId,
      action: action,
      payload: payload || {}
    }, "*");
  });
}

const ktrpSlotApi = Object.freeze({
  mode: "mes-text-v1",
  readOnly: true,
  previewMessageOption: function previewMessageOption(optionIndex) {
    if (
      typeof optionIndex !== "number" ||
      !Number.isSafeInteger(optionIndex) ||
      optionIndex < 0
    ) {
      return Promise.reject(new Error("previewMessageOption requires a non-negative integer index"));
    }
    return callSlotBridge("card_web_message_option", { optionIndex: optionIndex });
  }
});

try {
  Object.defineProperty(window, "ktRoleplay", {
    value: ktrpSlotApi,
    configurable: false,
    enumerable: true,
    writable: false
  });
} catch (_e) {
  window.ktRoleplay = ktrpSlotApi;
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", ensureLocalMesTextElement, { once: true });
} else {
  ensureLocalMesTextElement();
}
})();</script>`;
}

function prependPreheatBeforeAuthorMarkup(rawHtml, preheatTag) {
  const html = String(rawHtml || "");
  const doctypeMatch = /^\s*<!doctype\s+html\s*>/i.exec(html);
  if (doctypeMatch) {
    const endIdx = doctypeMatch[0].length;
    return html.slice(0, endIdx) + preheatTag + html.slice(endIdx);
  }
  return preheatTag + html;
}

export function buildMessageSlotOuterSrcdoc(authorHtml, bootData) {
  const preheat = buildMessageSlotPreheatScript(bootData);
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
#ktrp-slot-inner-sandbox {
  border: 0;
  width: 100%;
  height: 100%;
  display: block;
}
</style>
</head>
<body>
<iframe id="ktrp-slot-inner-sandbox" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
<script>(function(){
"use strict";
const MOUNT_TOKEN = ${mountTokenJson};
const INNER_HTML = ${innerHtmlJson};
const ALLOWED_ACTIONS = new Set([
  "card_web_message_option"
]);
const innerFrame = document.getElementById("ktrp-slot-inner-sandbox");
innerFrame.srcdoc = INNER_HTML;

window.addEventListener("message", function(ev) {
  const d = ev.data;
  if (!d || typeof d !== "object") return;
  if (ev.source === innerFrame.contentWindow && d.__ktrpSlotBridge === "inner-to-outer") {
    const action = typeof d.action === "string" ? d.action : "";
    const reqId = typeof d.reqId === "number" ? d.reqId : -1;
    if (!ALLOWED_ACTIONS.has(action) || reqId <= 0) {
      if (reqId > 0 && innerFrame.contentWindow) {
        innerFrame.contentWindow.postMessage({
          __ktrpSlotBridge: "outer-to-inner",
          type: "rpc-reply",
          reqId: reqId,
          ok: false,
          error: "Unsupported message slot bridge action"
        }, "*");
      }
      return;
    }
    window.parent.postMessage({
      __ktrpSlotHostBridge: "outer-to-host",
      mountToken: MOUNT_TOKEN,
      reqId: reqId,
      action: action,
      payload: d.payload && typeof d.payload === "object" ? d.payload : {}
    }, "*");
    return;
  }
  if (
    ev.source === window.parent &&
    d.__ktrpSlotHostBridge === "host-to-outer" &&
    d.mountToken === MOUNT_TOKEN
  ) {
    if (innerFrame.contentWindow) {
      innerFrame.contentWindow.postMessage({
        __ktrpSlotBridge: "outer-to-inner",
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

let slotInstanceCounter = 0;

/**
 * Isolated per-message body slot component for `plugin:roleplay` (`kt.registerMessageBody("mes-text", ...)`).
 * Uses call-only `useOwner({ subscribe: false })` so mounted rows never open WebSocket subscriptions.
 * Only when `message.isLastAssistant === true`, `assistantLocator` is valid, and `message.text` contains
 * `<roleplay_options>...</roleplay_options>` does it probe `card_web_message_offer({ locator })` once and
 * automatically mount the isolated `.mes_text` author iframe on a valid offer.
 * Clicking an author option calls `window.ktRoleplay.previewMessageOption(index)` which resolves the
 * trusted option draft via `card_web_message_option` and renders a local read-only preview without
 * touching the host composer or auto-sending a turn.
 */
export const MessageBodySlot = {
  name: "MessageBodySlot",
  components: { ActionButton },
  setup() {
    const owner = useOwner({ subscribe: false });
    const message = useMessage();
    const session = useSession();
    const creature = useCreature();
    const t = useRoleplayText();

    const instanceId = ++slotInstanceCounter;
    const outerIframeRef = ref(null);
    const loading = ref(false);
    const errorMessage = ref("");
    const activePanelScope = ref("");
    const activeLocator = ref(null);
    const slotTitle = ref("");
    const outerSrcdoc = ref("");
    const currentMountToken = ref("");
    const optionDraft = ref(null);
    const optionBusy = ref(false);
    const optionError = ref("");

    let loadSeq = 0;
    let optionSeq = 0;

    const locatorKey = computed(() => {
      const msg = message.value;
      const loc = msg?.assistantLocator;
      if (!isValidLocator(loc)) return "";
      return `${loc.turn}:${loc.branchId}:${loc.eventId}:${loc.roundStartEventId}`;
    });

    const rowContextKey = computed(() => {
      const msg = message.value;
      const sessId = session.value?.id || "";
      const tabId = typeof msg?.tab === "string" ? msg.tab : "";
      const isLast = msg?.isLastAssistant === true ? "1" : "0";
      const hasTags = hasRoleplayOptionsTags(msg?.text) ? "1" : "0";
      return `${sessId}|${tabId}|${isLast}|${hasTags}|${locatorKey.value}`;
    });

    function hardDestroySlot() {
      loadSeq += 1;
      optionSeq += 1;
      const frameEl = outerIframeRef.value;
      if (frameEl) {
        try {
          frameEl.srcdoc = "";
          frameEl.removeAttribute("srcdoc");
        } catch {
          // Ignore DOM cleanup errors during unmount
        }
      }
      loading.value = false;
      errorMessage.value = "";
      activePanelScope.value = "";
      activeLocator.value = null;
      slotTitle.value = "";
      outerSrcdoc.value = "";
      currentMountToken.value = "";
      optionDraft.value = null;
      optionBusy.value = false;
      optionError.value = "";
    }

    async function discoverAndMountSlot() {
      hardDestroySlot();
      const msg = message.value;
      if (!msg || msg.role !== "assistant" || msg.isLastAssistant !== true) {
        return;
      }
      const loc = msg.assistantLocator;
      if (!isValidLocator(loc) || !hasRoleplayOptionsTags(msg.text)) {
        return;
      }
      const snapLocator = {
        turn: loc.turn,
        branchId: loc.branchId,
        eventId: loc.eventId,
        roundStartEventId: loc.roundStartEventId,
      };
      const snapContextKey = rowContextKey.value;
      const seq = ++loadSeq;
      loading.value = true;
      try {
        const offerRes = await owner.call("card_web_message_offer", {
          locator: snapLocator,
        });
        if (seq !== loadSeq || rowContextKey.value !== snapContextKey) return;
        const offer = offerRes?.offer;
        if (
          !offer ||
          typeof offer !== "object" ||
          offer.mode !== "mes-text-v1" ||
          typeof offer.panelScope !== "string" ||
          !offer.panelScope
        ) {
          return;
        }
        const panelScope = offer.panelScope;
        const slotRes = await owner.call("card_web_message_slot", {
          panelScope,
          locator: snapLocator,
        });
        if (seq !== loadSeq || rowContextKey.value !== snapContextKey) return;
        if (
          !slotRes ||
          typeof slotRes !== "object" ||
          slotRes.slot !== "mes-text-v1" ||
          typeof slotRes.html !== "string" ||
          !slotRes.html ||
          !slotRes.message ||
          typeof slotRes.message !== "object"
        ) {
          return;
        }
        const token = `ktrp_slot_${instanceId}_${seq}`;
        activePanelScope.value = panelScope;
        activeLocator.value = snapLocator;
        slotTitle.value =
          typeof slotRes.title === "string" && slotRes.title.trim()
            ? slotRes.title.trim()
            : t("cardWebPanelDefaultTitle");
        currentMountToken.value = token;
        outerSrcdoc.value = buildMessageSlotOuterSrcdoc(slotRes.html, {
          mountToken: token,
          message: slotRes.message,
        });
      } catch {
        // Silent no-op when session is not a tavern with an active message slot
      } finally {
        if (seq === loadSeq) {
          loading.value = false;
        }
      }
    }

    function sendBridgeReply(targetWin, token, reqId, ok, resultOrError) {
      if (!targetWin || token !== currentMountToken.value) return;
      try {
        targetWin.postMessage(
          {
            __ktrpSlotHostBridge: "host-to-outer",
            mountToken: token,
            reqId,
            ok,
            ...(ok ? { result: resultOrError } : { error: String(resultOrError) }),
          },
          "*",
        );
      } catch {
        // Frame may have been torn down
      }
    }

    async function handleWindowMessage(ev) {
      const frameEl = outerIframeRef.value;
      if (!frameEl || ev.source !== frameEl.contentWindow) return;
      const d = ev.data;
      if (!d || typeof d !== "object" || d.__ktrpSlotHostBridge !== "outer-to-host") return;
      if (!currentMountToken.value || d.mountToken !== currentMountToken.value) return;
      const reqId = typeof d.reqId === "number" ? d.reqId : -1;
      if (reqId <= 0) return;

      const tokenSnap = currentMountToken.value;
      const scopeSnap = activePanelScope.value;
      const locSnap = activeLocator.value;
      const contextSnap = rowContextKey.value;
      if (!scopeSnap || !isValidLocator(locSnap)) {
        sendBridgeReply(
          frameEl.contentWindow,
          tokenSnap,
          reqId,
          false,
          "Message slot is no longer active",
        );
        return;
      }

      if (d.action !== "card_web_message_option") {
        sendBridgeReply(
          frameEl.contentWindow,
          tokenSnap,
          reqId,
          false,
          "Unsupported message slot action",
        );
        return;
      }

      const rawIndex = d.payload?.optionIndex;
      if (typeof rawIndex !== "number" || !Number.isSafeInteger(rawIndex) || rawIndex < 0) {
        sendBridgeReply(
          frameEl.contentWindow,
          tokenSnap,
          reqId,
          false,
          "Invalid option index",
        );
        return;
      }

      if (optionBusy.value) {
        sendBridgeReply(
          frameEl.contentWindow,
          tokenSnap,
          reqId,
          false,
          "A message option preview is in progress",
        );
        return;
      }

      const seq = ++optionSeq;
      optionBusy.value = true;
      optionError.value = "";
      try {
        const res = await owner.call("card_web_message_option", {
          panelScope: scopeSnap,
          locator: locSnap,
          optionIndex: rawIndex,
        });
        if (
          seq !== optionSeq ||
          tokenSnap !== currentMountToken.value ||
          rowContextKey.value !== contextSnap ||
          outerIframeRef.value !== frameEl
        ) {
          return;
        }
        const draft = res?.draft;
        if (!draft || typeof draft !== "object" || typeof draft.text !== "string") {
          optionDraft.value = null;
          activePanelScope.value = "";
          activeLocator.value = null;
          sendBridgeReply(
            frameEl.contentWindow,
            tokenSnap,
            reqId,
            false,
            "Message slot is no longer active",
          );
          return;
        }
        const plainDraft = {
          index: rawIndex,
          label: typeof draft.label === "string" ? draft.label : "",
          text: draft.text,
        };
        optionDraft.value = plainDraft;
        sendBridgeReply(frameEl.contentWindow, tokenSnap, reqId, true, {
          draft: { ...plainDraft },
        });
      } catch (err) {
        if (
          seq === optionSeq &&
          tokenSnap === currentMountToken.value &&
          rowContextKey.value === contextSnap &&
          outerIframeRef.value === frameEl
        ) {
          const msg =
            err?.details?.message || err?.message || String(err || "Option preview failed");
          optionError.value = msg;
          sendBridgeReply(frameEl.contentWindow, tokenSnap, reqId, false, msg);
        }
      } finally {
        if (seq === optionSeq) {
          optionBusy.value = false;
        }
      }
    }

    if (typeof window !== "undefined") {
      window.addEventListener("message", handleWindowMessage);
    }

    watch(
      rowContextKey,
      () => {
        void discoverAndMountSlot();
      },
      { immediate: true },
    );

    onBeforeUnmount(() => {
      if (typeof window !== "undefined") {
        window.removeEventListener("message", handleWindowMessage);
      }
      hardDestroySlot();
    });

    return {
      t,
      creature,
      outerIframeRef,
      loading,
      errorMessage,
      slotTitle,
      outerSrcdoc,
      optionDraft,
      optionBusy,
      optionError,
    };
  },
  template: `
    <div
      v-if="outerSrcdoc || optionDraft || optionError"
      class="ktrp-card-box ktrp-message-slot-box"
      data-testid="kt-rp-message-slot"
    >
      <div
        v-if="outerSrcdoc"
        class="ktrp-message-slot-stage"
        data-testid="kt-rp-message-slot-stage"
      >
        <iframe
          ref="outerIframeRef"
          class="ktrp-web-panel-iframe ktrp-message-slot-iframe"
          sandbox="allow-scripts"
          referrerpolicy="no-referrer"
          :title="slotTitle"
          :srcdoc="outerSrcdoc"
          data-testid="kt-rp-message-slot-frame"
        />
      </div>

      <div
        v-if="optionError"
        class="ktrp-banner ktrp-banner--error"
        role="alert"
        data-testid="kt-rp-message-option-error"
      >
        <span>{{ optionError }}</span>
      </div>

      <div
        v-if="optionDraft"
        class="ktrp-sub-card ktrp-message-option-preview"
        role="status"
        data-testid="kt-rp-message-option-preview"
        :data-option-index="String(optionDraft.index)"
      >
        <div class="ktrp-row-between">
          <strong data-testid="kt-rp-message-option-preview-label">
            {{ optionDraft.label }}
          </strong>
          <span class="ktrp-chip" data-testid="kt-rp-message-option-preview-badge">
            {{ t('messageSlotPreviewBadge') }}
          </span>
        </div>
        <p
          class="ktrp-quote-box ktrp-pre"
          data-testid="kt-rp-message-option-preview-text"
        >{{ optionDraft.text }}</p>
      </div>
    </div>
  `,
};
