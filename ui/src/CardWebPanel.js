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

function normalizeCounterGrant(rawGrant, selectedMessage) {
  if (!rawGrant || typeof rawGrant !== "object" || Array.isArray(rawGrant)) return null;
  if (!selectedMessage || selectedMessage.message_id !== 0) return null;
  if (rawGrant.messageId !== 0) return null;
  if (
    !Array.isArray(rawGrant.path) ||
    rawGrant.path.length < 1 ||
    rawGrant.path.length > 16 ||
    !rawGrant.path.every((p) => typeof p === "string" && p.length > 0 && p.length <= 160)
  ) {
    return null;
  }
  if (
    typeof rawGrant.minimum !== "number" ||
    !Number.isSafeInteger(rawGrant.minimum) ||
    typeof rawGrant.maximum !== "number" ||
    !Number.isSafeInteger(rawGrant.maximum) ||
    rawGrant.minimum >= rawGrant.maximum
  ) {
    return null;
  }
  if (
    typeof rawGrant.revision !== "number" ||
    !Number.isSafeInteger(rawGrant.revision) ||
    rawGrant.revision < 0
  ) {
    return null;
  }
  return {
    messageId: 0,
    path: [...rawGrant.path],
    minimum: rawGrant.minimum,
    maximum: rawGrant.maximum,
    revision: rawGrant.revision,
  };
}

function normalizePinnedMvuSetup(rawSetup) {
  if (!rawSetup || typeof rawSetup !== "object" || Array.isArray(rawSetup)) return null;
  if (rawSetup.mode !== "mvu-setup-v1") return null;
  const statData = rawSetup.data?.stat_data;
  if (!isNonEmptyPlainObject(statData)) return null;
  if (!isNonEmptyPlainObject(statData.Mainchar) || typeof statData.GameStarted !== "boolean") {
    return null;
  }
  return {
    mode: "mvu-setup-v1",
    writable: Boolean(rawSetup.writable),
    data: { stat_data: statData },
  };
}

const PINNED_STATUS_PORTRAIT_DATA_URI_RE =
  /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/;

function normalizePinnedMvuStatus(rawStatus) {
  if (!rawStatus || typeof rawStatus !== "object" || Array.isArray(rawStatus)) return null;
  const statData = rawStatus.data?.stat_data;
  if (!isNonEmptyPlainObject(statData)) return null;
  const portrait =
    typeof rawStatus.portrait === "string" &&
    PINNED_STATUS_PORTRAIT_DATA_URI_RE.test(rawStatus.portrait)
      ? rawStatus.portrait
      : null;
  return {
    data: { stat_data: statData },
    ...(portrait ? { portrait } : {}),
  };
}

function buildAuthorPreheatScript(bootData) {
  // Never serialize both legacyOpening and legacyLatest into the author frame:
  // only serialize the single selected message snapshot (or null for CHARX native web panels).
  const pinnedMvuStatusCap = normalizePinnedMvuStatus(bootData.pinnedMvuStatus);
  const singleMessage =
    !pinnedMvuStatusCap && bootData.isLegacyOpening
      ? bootData.selectedLegacyMessage || null
      : null;
  const pinnedMvuSetupCap =
    !pinnedMvuStatusCap && bootData.isLegacyOpening
      ? normalizePinnedMvuSetup(bootData.pinnedMvuSetup)
      : null;
  const hasSelectedStatData = isNonEmptyPlainObject(singleMessage?.data?.stat_data);
  const mvuReadCap =
    !pinnedMvuStatusCap &&
    !pinnedMvuSetupCap &&
    bootData.isLegacyOpening &&
    hasSelectedStatData &&
    bootData.legacyMvuRead &&
    typeof bootData.legacyMvuRead === "object" &&
    bootData.legacyMvuRead.mode === "kt-message-stat-data-v1"
      ? { mode: "kt-message-stat-data-v1" }
      : null;
  const mvuCounterCap = mvuReadCap
    ? normalizeCounterGrant(bootData.legacyMvuCounter, singleMessage)
    : null;
  const sanitizedBoot = {
    isLegacyOpening: Boolean(bootData.isLegacyOpening),
    playerName: typeof bootData.playerName === "string" ? bootData.playerName : "Player",
    characterName: typeof bootData.characterName === "string" ? bootData.characterName : "",
    selectedLegacyMessage: singleMessage,
    ...(pinnedMvuStatusCap ? { pinnedMvuStatus: pinnedMvuStatusCap } : {}),
    ...(pinnedMvuSetupCap ? { pinnedMvuSetup: pinnedMvuSetupCap } : {}),
    ...(mvuReadCap ? { legacyMvuRead: mvuReadCap } : {}),
    ...(mvuCounterCap ? { legacyMvuCounter: mvuCounterCap } : {}),
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
    const _ArrayIsArray = Array.isArray;
    const _isSafeInteger = Number.isSafeInteger;
    const _mathAbs = Math.abs;
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
    let _statDataJson = _jsonStringify(statData);
    if (typeof _statDataJson !== "string") {
      throw new Error("Failed to serialize read-only MVU snapshot");
    }
    let _statDataFrozenSource = _structuredClone ? _jsonParse(_statDataJson) : null;

    const replaceCanonicalStatData = function replaceCanonicalStatData(nextStatData) {
      if (!nextStatData || typeof nextStatData !== "object" || _ArrayIsArray(nextStatData)) {
        throw new Error("Invalid canonical MVU snapshot");
      }
      const nextJson = _jsonStringify(nextStatData);
      if (typeof nextJson !== "string") {
        throw new Error("Failed to serialize canonical MVU snapshot");
      }
      const parsed = _jsonParse(nextJson);
      if (!parsed || typeof parsed !== "object" || _ArrayIsArray(parsed)) {
        throw new Error("Failed to parse canonical MVU snapshot");
      }
      _statDataJson = nextJson;
      _statDataFrozenSource = _structuredClone ? parsed : null;
      if (singleMsg.data && typeof singleMsg.data === "object") {
        singleMsg.data.stat_data = _jsonParse(nextJson);
      }
    };

    const cloneStatDataStrict = function cloneStatDataStrict() {
      const cloned = _structuredClone
        ? _structuredClone(_statDataFrozenSource)
        : _jsonParse(_statDataJson);
      if (!cloned || typeof cloned !== "object" || _ArrayIsArray(cloned)) {
        throw new Error("Failed to clone read-only MVU snapshot");
      }
      return cloned;
    };

    const validateMessageOption = function validateMessageOption(option, fnName) {
      if (!option || typeof option !== "object" || _ArrayIsArray(option)) {
        throw new Error(fnName + " requires an explicit { type: 'message' } option");
      }
      const proto = _getProtoOf(option);
      if (proto !== _ObjectProto && proto !== null) {
        throw new Error(fnName + " option must be a plain object");
      }
      const ownKeys = _ReflectOwnKeys(option);
      let hasOwnType = false;
      let typeVal = undefined;
      let hasOwnMessageId = false;
      let rawId = undefined;
      for (let i = 0; i < ownKeys.length; i += 1) {
        const k = ownKeys[i];
        if (typeof k !== "string" || (k !== "type" && k !== "message_id")) {
          throw new Error("Unsupported " + fnName + " option key: " + String(k));
        }
        const desc = _getOwnPropDesc(option, k);
        if (!desc || !desc.enumerable || !_hasOwn(desc, "value")) {
          throw new Error(fnName + " option properties must be own enumerable data properties");
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
        throw new Error("Only message-scoped " + fnName + "({ type: 'message' }) is supported");
      }
      const matchesSelected =
        !hasOwnMessageId ||
        rawId === undefined ||
        rawId === "latest" ||
        rawId === -1 ||
        rawId === activeId;
      if (!matchesSelected) {
        throw new Error("Only the currently selected message snapshot is accessible");
      }
    };

    const getVariablesFacade = function getVariables(option) {
      validateMessageOption(option, "getVariables");
      return { stat_data: cloneStatDataStrict() };
    };

    const readOwnGrantInteger = function readOwnGrantInteger(rootStatData, pathParts) {
      let cur = rootStatData;
      for (let i = 0; i < pathParts.length; i += 1) {
        if (!cur || typeof cur !== "object" || _ArrayIsArray(cur)) {
          throw new Error("Granted counter path container is not a plain object");
        }
        const proto = _getProtoOf(cur);
        if (proto !== _ObjectProto && proto !== null) {
          throw new Error("Granted counter path container must be a plain object");
        }
        const seg = pathParts[i];
        const desc = _getOwnPropDesc(cur, seg);
        if (!desc || !desc.enumerable || !_hasOwn(desc, "value")) {
          throw new Error("Granted counter property must be an own enumerable data property");
        }
        cur = desc.value;
      }
      if (typeof cur !== "number" || !_isSafeInteger(cur)) {
        throw new Error("Granted counter value must be a safe integer");
      }
      return cur;
    };

    const rawCounterGrant = BOOT.legacyMvuCounter;
    const hasValidCounterGrant =
      activeId === 0 &&
      Boolean(rawCounterGrant) &&
      typeof rawCounterGrant === "object" &&
      !_ArrayIsArray(rawCounterGrant) &&
      rawCounterGrant.messageId === 0 &&
      _ArrayIsArray(rawCounterGrant.path) &&
      rawCounterGrant.path.length > 0 &&
      typeof rawCounterGrant.minimum === "number" &&
      _isSafeInteger(rawCounterGrant.minimum) &&
      typeof rawCounterGrant.maximum === "number" &&
      _isSafeInteger(rawCounterGrant.maximum) &&
      rawCounterGrant.minimum < rawCounterGrant.maximum &&
      typeof rawCounterGrant.revision === "number" &&
      _isSafeInteger(rawCounterGrant.revision) &&
      rawCounterGrant.revision >= 0;

    if (hasValidCounterGrant) {
      const grantPath = rawCounterGrant.path.slice();
      const grantMin = rawCounterGrant.minimum;
      const grantMax = rawCounterGrant.maximum;
      let currentRevision = rawCounterGrant.revision;
      let counterWriteInFlight = false;

      const updateVariablesWithFacade = async function updateVariablesWith(updater, option) {
        if (counterWriteInFlight) {
          throw new Error("A counter update is already in flight");
        }
        counterWriteInFlight = true;
        try {
          if (typeof updater !== "function") {
            throw new Error("updateVariablesWith requires a synchronous updater function");
          }
          validateMessageOption(option, "updateVariablesWith");
          const baseStatData = cloneStatDataStrict();
          const expectedVal = readOwnGrantInteger(baseStatData, grantPath);
          const draftContainer = { stat_data: cloneStatDataStrict() };
          const returned = updater(draftContainer);
          if (
            returned &&
            (typeof returned === "object" || typeof returned === "function") &&
            typeof returned.then === "function"
          ) {
            throw new Error("Async updater callbacks are not supported");
          }
          const candidateContainer =
            returned && typeof returned === "object" && !_ArrayIsArray(returned)
              ? returned
              : draftContainer;
          const candidateDesc = _getOwnPropDesc(candidateContainer, "stat_data");
          if (!candidateDesc || !candidateDesc.enumerable || !_hasOwn(candidateDesc, "value")) {
            throw new Error("Updated variables must contain an own enumerable stat_data object");
          }
          const nextVal = readOwnGrantInteger(candidateDesc.value, grantPath);
          if (nextVal === expectedVal) {
            return { stat_data: cloneStatDataStrict() };
          }
          if (_mathAbs(nextVal - expectedVal) !== 1 || nextVal < grantMin || nextVal > grantMax) {
            throw new Error("The opening counter can only change by one step within its granted range");
          }
          const receipt = await callBridge("card_web_mvu_counter", {
            messageId: 0,
            revision: currentRevision,
            expected: expectedVal,
            value: nextVal
          });
          if (
            !receipt ||
            typeof receipt !== "object" ||
            typeof receipt.revision !== "number" ||
            !_isSafeInteger(receipt.revision) ||
            !receipt.data ||
            typeof receipt.data !== "object" ||
            !receipt.data.stat_data ||
            typeof receipt.data.stat_data !== "object" ||
            _ArrayIsArray(receipt.data.stat_data)
          ) {
            throw new Error("Invalid counter settlement receipt");
          }
          currentRevision = receipt.revision;
          replaceCanonicalStatData(receipt.data.stat_data);
          return { stat_data: cloneStatDataStrict() };
        } finally {
          counterWriteInFlight = false;
        }
      };

      try {
        Object.defineProperty(window, "updateVariablesWith", {
          value: updateVariablesWithFacade,
          configurable: false,
          enumerable: true,
          writable: false
        });
      } catch (_e) {
        window.updateVariablesWith = updateVariablesWithFacade;
      }
    }

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

if (
  BOOT.isLegacyOpening &&
  BOOT.pinnedMvuSetup &&
  BOOT.pinnedMvuSetup.mode === "mvu-setup-v1" &&
  BOOT.pinnedMvuSetup.data &&
  BOOT.pinnedMvuSetup.data.stat_data
) {
  const _ReflectOwnKeys = Reflect.ownKeys;
  const _getOwnPropDesc = Object.getOwnPropertyDescriptor;
  const _getProtoOf = Object.getPrototypeOf;
  const _ObjectProto = Object.prototype;
  const _ArrayIsArray = Array.isArray;
  const _hasOwn =
    typeof Object.hasOwn === "function"
      ? Object.hasOwn
      : Function.prototype.call.bind(_ObjectProto.hasOwnProperty);
  const _jsonParse = JSON.parse;
  const _jsonStringify = JSON.stringify;

  let _setupWritable = Boolean(BOOT.pinnedMvuSetup.writable);
  let _setupWriteInFlight = false;
  let _setupStatDataJson = _jsonStringify(BOOT.pinnedMvuSetup.data.stat_data);

  const cloneSetupStatData = function() {
    return _jsonParse(_setupStatDataJson);
  };

  const validateChatOption = function(option, fnName) {
    if (!option || typeof option !== "object" || _ArrayIsArray(option)) {
      throw new Error(fnName + " requires an explicit { type: 'chat' } option");
    }
    const proto = _getProtoOf(option);
    if (proto !== _ObjectProto && proto !== null) {
      throw new Error(fnName + " option must be a plain object");
    }
    const ownKeys = _ReflectOwnKeys(option);
    if (ownKeys.length !== 1 || ownKeys[0] !== "type") {
      throw new Error("Only chat-scoped " + fnName + "({ type: 'chat' }) is supported");
    }
    const desc = _getOwnPropDesc(option, "type");
    if (!desc || !desc.enumerable || !_hasOwn(desc, "value") || desc.value !== "chat") {
      throw new Error("Only chat-scoped " + fnName + "({ type: 'chat' }) is supported");
    }
  };

  const getVariablesSetupFacade = function getVariables(option) {
    validateChatOption(option, "getVariables");
    return { stat_data: cloneSetupStatData() };
  };

  const updateVariablesWithSetupFacade = async function updateVariablesWith(updater, option) {
    if (_setupWriteInFlight) {
      throw new Error("Character setup update is already in flight");
    }
    if (!_setupWritable) {
      throw new Error("Character setup is only writable once, before the first turn");
    }
    _setupWriteInFlight = true;
    try {
      if (typeof updater !== "function") {
        throw new Error("updateVariablesWith requires a synchronous updater function");
      }
      validateChatOption(option, "updateVariablesWith");
      const draftContainer = { stat_data: cloneSetupStatData() };
      const returned = updater(draftContainer);
      if (
        returned &&
        (typeof returned === "object" || typeof returned === "function") &&
        typeof returned.then === "function"
      ) {
        throw new Error("Async updater callbacks are not supported");
      }
      const candidateContainer =
        returned && typeof returned === "object" && !_ArrayIsArray(returned)
          ? returned
          : draftContainer;
      const candidateDesc = _getOwnPropDesc(candidateContainer, "stat_data");
      if (!candidateDesc || !candidateDesc.enumerable || !_hasOwn(candidateDesc, "value")) {
        throw new Error("Updated variables must contain an own enumerable stat_data object");
      }
      const candidateStatData = candidateDesc.value;
      if (!candidateStatData || typeof candidateStatData !== "object" || _ArrayIsArray(candidateStatData)) {
        throw new Error("Updated stat_data must be a plain object");
      }
      const receipt = await callBridge("card_web_mvu_setup", {
        statData: _jsonParse(_jsonStringify(candidateStatData))
      });
      const settled = receipt && receipt.data && receipt.data.stat_data;
      if (!settled || typeof settled !== "object" || _ArrayIsArray(settled)) {
        throw new Error("Invalid character setup settlement receipt");
      }
      _setupStatDataJson = _jsonStringify(settled);
      _setupWritable = false;
      return { stat_data: cloneSetupStatData() };
    } finally {
      _setupWriteInFlight = false;
    }
  };

  const insertOrAssignVariablesSetupFacade = function insertOrAssignVariables(payload, option) {
    validateChatOption(option, "insertOrAssignVariables");
    const desc =
      payload && typeof payload === "object" && !_ArrayIsArray(payload)
        ? _getOwnPropDesc(payload, "stat_data")
        : null;
    if (!desc || !desc.enumerable || !_hasOwn(desc, "value")) {
      return Promise.reject(new Error("insertOrAssignVariables requires a { stat_data } object"));
    }
    const statSnapshot = desc.value;
    return updateVariablesWithSetupFacade(function() {
      return { stat_data: statSnapshot };
    }, option);
  };

  const lockGlobal = function(name, value) {
    try {
      Object.defineProperty(window, name, {
        value: value,
        configurable: false,
        enumerable: true,
        writable: false
      });
    } catch (_e) {
      window[name] = value;
    }
  };
  lockGlobal("getCurrentMessageId", function getCurrentMessageId() { return -1; });
  lockGlobal("getVariables", getVariablesSetupFacade);
  lockGlobal("updateVariablesWith", updateVariablesWithSetupFacade);
  lockGlobal("insertOrAssignVariables", insertOrAssignVariablesSetupFacade);
}

let updatePinnedStatusStatData = null;

if (
  BOOT.pinnedMvuStatus &&
  BOOT.pinnedMvuStatus.data &&
  BOOT.pinnedMvuStatus.data.stat_data
) {
  const _ReflectOwnKeys = Reflect.ownKeys;
  const _getOwnPropDesc = Object.getOwnPropertyDescriptor;
  const _getProtoOf = Object.getPrototypeOf;
  const _ObjectProto = Object.prototype;
  const _ArrayIsArray = Array.isArray;
  const _hasOwn =
    typeof Object.hasOwn === "function"
      ? Object.hasOwn
      : Function.prototype.call.bind(_ObjectProto.hasOwnProperty);
  const _jsonParse = JSON.parse;
  const _jsonStringify = JSON.stringify;

  const _statusPortrait =
    typeof BOOT.pinnedMvuStatus.portrait === "string" && BOOT.pinnedMvuStatus.portrait
      ? BOOT.pinnedMvuStatus.portrait
      : null;
  let _statusStatDataJson = _jsonStringify(BOOT.pinnedMvuStatus.data.stat_data);

  updatePinnedStatusStatData = function(nextStatData) {
    if (!nextStatData || typeof nextStatData !== "object" || _ArrayIsArray(nextStatData)) {
      return;
    }
    const nextJson = _jsonStringify(nextStatData);
    if (typeof nextJson === "string") {
      _statusStatDataJson = nextJson;
    }
  };

  const validateStatusReadOption = function(option) {
    if (option === undefined) return;
    if (!option || typeof option !== "object" || _ArrayIsArray(option)) {
      throw new Error("getVariables option must be undefined or { type: 'chat' }");
    }
    const proto = _getProtoOf(option);
    if (proto !== _ObjectProto && proto !== null) {
      throw new Error("getVariables option must be a plain object");
    }
    const ownKeys = _ReflectOwnKeys(option);
    if (ownKeys.length !== 1 || ownKeys[0] !== "type") {
      throw new Error("Only chat-scoped getVariables({ type: 'chat' }) is supported");
    }
    const desc = _getOwnPropDesc(option, "type");
    if (!desc || !desc.enumerable || !_hasOwn(desc, "value") || desc.value !== "chat") {
      throw new Error("Only chat-scoped getVariables({ type: 'chat' }) is supported");
    }
  };

  const getVariablesStatusFacade = function getVariables(option) {
    validateStatusReadOption(option);
    const statData = _jsonParse(_statusStatDataJson);
    if (
      _statusPortrait &&
      statData &&
      typeof statData === "object" &&
      !_ArrayIsArray(statData)
    ) {
      if (
        !statData.Mainchar ||
        typeof statData.Mainchar !== "object" ||
        _ArrayIsArray(statData.Mainchar)
      ) {
        statData.Mainchar = {};
      }
      statData.Mainchar.Image = [_statusPortrait, "Portrait"];
    }
    return { stat_data: statData };
  };

  const mvuStatusSubset = Object.freeze({
    mode: "mvu-status-v1",
    readOnly: true,
    getMvuData: getVariablesStatusFacade
  });

  const waitGlobalInitializedStatusFacade = function waitGlobalInitialized(name) {
    if (name === "Mvu") {
      return Promise.resolve(mvuStatusSubset);
    }
    return Promise.reject(
      new Error("Global is not available in KT read-only status sandbox: " + String(name))
    );
  };

  const lockStatusGlobal = function(name, value) {
    try {
      Object.defineProperty(window, name, {
        value: value,
        configurable: false,
        enumerable: true,
        writable: false
      });
    } catch (_e) {
      window[name] = value;
    }
  };
  lockStatusGlobal("getCurrentMessageId", function getCurrentMessageId() { return -1; });
  lockStatusGlobal("getVariables", getVariablesStatusFacade);
  lockStatusGlobal("Mvu", mvuStatusSubset);
  lockStatusGlobal("waitGlobalInitialized", waitGlobalInitializedStatusFacade);
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
  if (d.type === "status-data-push" && typeof updatePinnedStatusStatData === "function") {
    updatePinnedStatusStatData(d.statData);
    return;
  }
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
  const isPinnedStatus = Boolean(normalizePinnedMvuStatus(bootData?.pinnedMvuStatus));
  const imgSrcDirective = isPinnedStatus ? "img-src data:" : "img-src 'none'";
  const preheat = buildAuthorPreheatScript(bootData);
  const fullInnerHtml = prependPreheatBeforeAuthorMarkup(authorHtml, preheat);
  const innerHtmlJson = encodeJsonForInlineScript(fullInnerHtml);
  const mountTokenJson = encodeJsonForInlineScript(String(bootData.mountToken || ""));
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'none'; connect-src 'none'; ${imgSrcDirective}; media-src 'none'; font-src 'none'; object-src 'none'; form-action 'none'">
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
const ALLOWED_ACTIONS = new Set([
  "card_web_state",
  "card_web_gameplay",
  "card_web_plugin_request",
  "card_web_mvu_counter",
  "card_web_mvu_setup"
]);
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
      if (d.type === "status-data-push") {
        innerFrame.contentWindow.postMessage({
          __ktrpBridge: "outer-to-inner",
          type: "status-data-push",
          statData: d.statData
        }, "*");
        return;
      }
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
const activeCounterTxByScope = new Map();
const activeSetupTxByScope = new Map();

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
    const activeCounterGrant = ref(null);
    const activePinnedMvuSetup = ref(null);
    const activePinnedMvuStatus = ref(null);
    const hasLegacyLatest = ref(false);
    const latestTurnNumber = ref(null);
    const cachedPanelPayload = ref(null);
    const cachedStatusPayload = ref(null);
    const outerSrcdoc = ref("");
    const outerFrameRef = ref(null);

    let mountSeq = 0;

    const isLegacyOpening = computed(
      () =>
        activeSource.value === "legacyOpening" ||
        props.webPanelMeta?.source === "legacyOpening",
    );

    const hasPinnedStatusMeta = computed(() =>
      Boolean(normalizePinnedMvuStatus(props.webPanelMeta?.pinnedMvuStatus)),
    );

    const pinnedStatusTitle = computed(() => {
      const title = props.webPanelMeta?.pinnedMvuStatus?.title;
      return typeof title === "string" && title.trim() ? title.trim() : "StatusMenu";
    });

    const canSwitchLegacySnapshot = computed(
      () =>
        isOpen.value &&
        !loading.value &&
        Boolean(cachedPanelPayload.value || cachedStatusPayload.value) &&
        isLegacyOpening.value &&
        Boolean(
          hasLegacyLatest.value ||
            Number.isInteger(props.webPanelMeta?.latestMessageId),
        ),
    );

    const canSwitchPinnedStatus = computed(
      () =>
        isOpen.value &&
        !loading.value &&
        Boolean(cachedPanelPayload.value || cachedStatusPayload.value) &&
        hasPinnedStatusMeta.value,
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

    function clearLoadedPayloadAndSnapshotState({ keepPayloadCache = false } = {}) {
      activeMountToken.value = "";
      activePanelScope.value = "";
      if (!keepPayloadCache) {
        cachedPanelPayload.value = null;
        cachedStatusPayload.value = null;
      }
      activeSelectedMessageId.value = null;
      activeCounterGrant.value = null;
      activePinnedMvuSetup.value = null;
      activePinnedMvuStatus.value = null;
      if (!keepPayloadCache) {
        hasLegacyLatest.value = false;
        latestTurnNumber.value = null;
      }
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
      const isStatusTarget = preferredTarget === "status";
      const liveMetaStatus = normalizePinnedMvuStatus(props.webPanelMeta?.pinnedMvuStatus);
      const payloadStatus = normalizePinnedMvuStatus(payload.pinnedMvuStatus);
      const basePinnedStatus = liveMetaStatus || payloadStatus;
      const pinnedMvuStatus =
        isStatusTarget && basePinnedStatus
          ? {
              data: basePinnedStatus.data,
              ...(payloadStatus?.portrait ? { portrait: payloadStatus.portrait } : {}),
            }
          : null;
      const isLegacy =
        !isStatusTarget &&
        (Boolean(payload.legacyOpening) || props.webPanelMeta?.source === "legacyOpening");
      const latestMsg =
        !isStatusTarget &&
        payload.legacyLatest &&
        typeof payload.legacyLatest === "object"
          ? payload.legacyLatest
          : null;
      const openingMsg =
        !isStatusTarget &&
        payload.legacyOpening &&
        typeof payload.legacyOpening === "object"
          ? payload.legacyOpening
          : null;

      if (!isStatusTarget) {
        hasLegacyLatest.value = Boolean(latestMsg);
        latestTurnNumber.value =
          latestMsg && Number.isInteger(latestMsg.message_id)
            ? latestMsg.message_id
            : null;
      }

      const resolvedTarget = isStatusTarget
        ? "status"
        : preferredTarget === "opening" || !latestMsg
          ? "opening"
          : "latest";
      activeSnapshotTarget.value = resolvedTarget;

      // Strictly choose a single snapshot for the author frame: never pass both!
      const singleSelectedMessage = isLegacy
        ? resolvedTarget === "latest" && latestMsg
          ? latestMsg
          : openingMsg
        : null;
      const pinnedMvuSetup =
        isLegacy && resolvedTarget === "opening"
          ? normalizePinnedMvuSetup(payload.pinnedMvuSetup)
          : null;
      const selectedHasStatData = isNonEmptyPlainObject(
        singleSelectedMessage?.data?.stat_data,
      );
      const legacyMvuRead =
        !pinnedMvuStatus &&
        !pinnedMvuSetup &&
        isLegacy &&
        selectedHasStatData &&
        payload.legacyMvuRead &&
        typeof payload.legacyMvuRead === "object" &&
        payload.legacyMvuRead.mode === "kt-message-stat-data-v1"
          ? { mode: "kt-message-stat-data-v1" }
          : null;
      const legacyMvuCounter =
        legacyMvuRead && resolvedTarget === "opening"
          ? normalizeCounterGrant(payload.legacyMvuCounter, singleSelectedMessage)
          : null;

      activeSelectedMessageId.value =
        singleSelectedMessage && Number.isInteger(singleSelectedMessage.message_id)
          ? singleSelectedMessage.message_id
          : null;
      activeCounterGrant.value = legacyMvuCounter;
      activePinnedMvuSetup.value = pinnedMvuSetup;
      activePinnedMvuStatus.value = pinnedMvuStatus;
      activePanelScope.value = String(payload.panelScope);
      activeMountToken.value = token;
      activeTitle.value = String(
        payload.title ||
          (isStatusTarget ? pinnedStatusTitle.value : props.webPanelMeta?.title) ||
          "",
      );
      activeSource.value = isStatusTarget
        ? "pinnedStatus"
        : isLegacy
          ? "legacyOpening"
          : "charx";

      outerSrcdoc.value = buildOuterSandboxSrcdoc(payload.html, {
        mountToken: token,
        isLegacyOpening: isLegacy,
        playerName: props.playerName || "Player",
        characterName: props.characterName || "",
        selectedLegacyMessage: singleSelectedMessage,
        pinnedMvuStatus,
        pinnedMvuSetup,
        legacyMvuRead,
        legacyMvuCounter,
      });
    }

    function selectLegacySnapshot(target) {
      if (target !== "opening" && target !== "latest" && target !== "status") return;
      if (!isOpen.value || loading.value) return;
      if (target === "status") {
        if (!hasPinnedStatusMeta.value) return;
        if (cachedStatusPayload.value) {
          mountFromPayload(cachedStatusPayload.value, "status");
        } else {
          openOrReloadPanel("status");
        }
        return;
      }
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
      const isStatusRequest =
        preferredTarget === "status" && hasPinnedStatusMeta.value;
      const scopeSnap = props.scopeKey;
      const mvuSigSnap = props.mvuPublicSignature;
      const seq = ++mountSeq;

      // Immediately invalidate any previous frame, snapshot controls, and in-flight requests
      clearLoadedPayloadAndSnapshotState({ keepPayloadCache: true });
      isOpen.value = true;
      loading.value = true;
      error.value = "";

      try {
        const res = await props.owner.call(
          "card_web_panel",
          isStatusRequest ? { target: "status" } : {},
        );
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
        if (isStatusRequest) {
          cachedStatusPayload.value = res;
          mountFromPayload(res, "status");
        } else {
          cachedPanelPayload.value = res;
          const target =
            preferredTarget === "opening" || preferredTarget === "latest"
              ? preferredTarget
              : "latest";
          mountFromPayload(res, target);
        }
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
        if (seq === mountSeq || cachedPanelPayload.value || cachedStatusPayload.value) {
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
        action !== "card_web_plugin_request" &&
        action !== "card_web_mvu_counter" &&
        action !== "card_web_mvu_setup"
      ) {
        replyToOuter(false, null, "Unsupported card web action");
        return;
      }

      if (activeSnapshotTarget.value === "status" || activePinnedMvuStatus.value) {
        replyToOuter(false, null, "The author status panel is read-only");
        return;
      }

      if (action === "card_web_mvu_setup") {
        const setupSnap = activePinnedMvuSetup.value;
        if (
          !setupSnap ||
          !setupSnap.writable ||
          activeSnapshotTarget.value !== "opening" ||
          activeSelectedMessageId.value !== 0
        ) {
          replyToOuter(
            false,
            null,
            "Character setup is only writable once, before the first turn",
          );
          return;
        }
        if (activeSetupTxByScope.has(scopeSnap)) {
          replyToOuter(false, null, "Character setup update is already in flight");
          return;
        }
        const reqStatData = payload.statData;
        if (!isNonEmptyPlainObject(reqStatData)) {
          replyToOuter(false, null, "Invalid character setup payload");
          return;
        }
        const txToken = Symbol("setupTx");
        activeSetupTxByScope.set(scopeSnap, txToken);
        try {
          const result = await props.owner.call("card_web_mvu_setup", {
            panelScope: panelScopeSnap,
            statData: reqStatData,
          });
          if (
            !isOpen.value ||
            activeMountToken.value !== tokenSnap ||
            activePanelScope.value !== panelScopeSnap ||
            props.scopeKey !== scopeSnap ||
            props.mvuPublicSignature !== mvuSigSnap ||
            activeSnapshotTarget.value !== "opening" ||
            activeSelectedMessageId.value !== 0
          ) {
            return;
          }
          if (
            result &&
            typeof result === "object" &&
            result.data &&
            typeof result.data === "object" &&
            isNonEmptyPlainObject(result.data.stat_data)
          ) {
            const nextSetup = {
              mode: "mvu-setup-v1",
              writable: false,
              data: { stat_data: result.data.stat_data },
            };
            activePinnedMvuSetup.value = nextSetup;
            if (cachedPanelPayload.value && typeof cachedPanelPayload.value === "object") {
              cachedPanelPayload.value = {
                ...cachedPanelPayload.value,
                pinnedMvuSetup: nextSetup,
              };
            }
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
        } finally {
          if (activeSetupTxByScope.get(scopeSnap) === txToken) {
            activeSetupTxByScope.delete(scopeSnap);
          }
        }
        return;
      }

      if (action === "card_web_mvu_counter") {
        const grantSnap = activeCounterGrant.value;
        if (
          !grantSnap ||
          activeSnapshotTarget.value !== "opening" ||
          activeSelectedMessageId.value !== 0
        ) {
          replyToOuter(false, null, "The opening counter is not writable in this view");
          return;
        }
        if (activeCounterTxByScope.has(scopeSnap)) {
          replyToOuter(false, null, "A counter update is already in flight");
          return;
        }
        const reqRevision = payload.revision;
        const reqExpected = payload.expected;
        const reqValue = payload.value;
        if (
          payload.messageId !== 0 ||
          typeof reqRevision !== "number" ||
          !Number.isSafeInteger(reqRevision) ||
          reqRevision !== grantSnap.revision ||
          typeof reqExpected !== "number" ||
          !Number.isSafeInteger(reqExpected) ||
          typeof reqValue !== "number" ||
          !Number.isSafeInteger(reqValue) ||
          Math.abs(reqValue - reqExpected) !== 1 ||
          reqValue < grantSnap.minimum ||
          reqValue > grantSnap.maximum
        ) {
          replyToOuter(
            false,
            null,
            "The opening counter can only change by one step within its granted range",
          );
          return;
        }
        const txToken = Symbol("counterTx");
        activeCounterTxByScope.set(scopeSnap, txToken);
        try {
          const result = await props.owner.call("card_web_mvu_counter", {
            panelScope: panelScopeSnap,
            messageId: 0,
            revision: grantSnap.revision,
            expected: reqExpected,
            value: reqValue,
          });
          if (
            !isOpen.value ||
            activeMountToken.value !== tokenSnap ||
            activePanelScope.value !== panelScopeSnap ||
            props.scopeKey !== scopeSnap ||
            props.mvuPublicSignature !== mvuSigSnap ||
            activeSnapshotTarget.value !== "opening" ||
            activeSelectedMessageId.value !== 0
          ) {
            return;
          }
          if (
            result &&
            typeof result === "object" &&
            typeof result.revision === "number" &&
            Number.isSafeInteger(result.revision) &&
            result.data &&
            typeof result.data === "object"
          ) {
            activeCounterGrant.value = {
              ...grantSnap,
              revision: result.revision,
            };
            if (cachedPanelPayload.value && typeof cachedPanelPayload.value === "object") {
              cachedPanelPayload.value = {
                ...cachedPanelPayload.value,
                ...(cachedPanelPayload.value.legacyOpening
                  ? {
                      legacyOpening: {
                        ...cachedPanelPayload.value.legacyOpening,
                        data: result.data,
                      },
                    }
                  : {}),
                ...(cachedPanelPayload.value.legacyMvuCounter
                  ? {
                      legacyMvuCounter: {
                        ...cachedPanelPayload.value.legacyMvuCounter,
                        revision: result.revision,
                      },
                    }
                  : {}),
              };
            }
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
        } finally {
          if (activeCounterTxByScope.get(scopeSnap) === txToken) {
            activeCounterTxByScope.delete(scopeSnap);
          }
        }
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
    // - If the user explicitly pinned Opening (#0) or Status, keep the active view;
    // - Otherwise, follow the new Latest turn snapshot automatically.
    watch(
      () => props.webPanelMeta?.latestMessageId,
      (nextId, prevId) => {
        if (!Number.isInteger(nextId) || nextId === prevId) return;
        if (
          isOpen.value &&
          !loading.value &&
          isLegacyOpening.value &&
          activeSnapshotTarget.value !== "status" &&
          !userPinnedOpening.value &&
          nextId !== latestTurnNumber.value
        ) {
          openOrReloadPanel("latest");
        }
      },
    );

    // When trusted pinnedMvuStatus.data updates while the status panel is mounted,
    // push plain JSON over the isolated relay without reloading the iframe.
    watch(
      () => props.webPanelMeta?.pinnedMvuStatus?.data?.stat_data,
      (nextStatData) => {
        if (!isNonEmptyPlainObject(nextStatData)) return;
        let plainStatData = null;
        try {
          plainStatData = JSON.parse(JSON.stringify(nextStatData));
        } catch (_e) {
          return;
        }
        if (!isNonEmptyPlainObject(plainStatData)) return;
        if (cachedStatusPayload.value && typeof cachedStatusPayload.value === "object") {
          const prevStatus = cachedStatusPayload.value.pinnedMvuStatus;
          cachedStatusPayload.value = {
            ...cachedStatusPayload.value,
            pinnedMvuStatus: {
              ...(prevStatus && typeof prevStatus === "object" && typeof prevStatus.portrait === "string"
                ? { portrait: prevStatus.portrait }
                : {}),
              data: { stat_data: plainStatData },
            },
          };
        }
        const tokenSnap = activeMountToken.value;
        const panelScopeSnap = activePanelScope.value;
        const frameWin = outerFrameRef.value?.contentWindow;
        if (
          !isOpen.value ||
          loading.value ||
          activeSnapshotTarget.value !== "status" ||
          !activePinnedMvuStatus.value ||
          !tokenSnap ||
          !panelScopeSnap ||
          !frameWin
        ) {
          return;
        }
        activePinnedMvuStatus.value = {
          ...(typeof activePinnedMvuStatus.value.portrait === "string"
            ? { portrait: activePinnedMvuStatus.value.portrait }
            : {}),
          data: { stat_data: plainStatData },
        };
        frameWin.postMessage(
          {
            __ktrpHostBridge: "host-to-outer",
            mountToken: tokenSnap,
            type: "status-data-push",
            statData: plainStatData,
          },
          "*",
        );
      },
      { deep: true },
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
      canSwitchLegacySnapshot,
      canSwitchPinnedStatus,
      pinnedStatusTitle,
      outerSrcdoc,
      outerFrameRef,
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
            {{ activeTitle || webPanelMeta?.title || t('cardWebPanelDefaultTitle') }}
          </strong>
        </div>

        <div v-if="webPanelMeta" class="ktrp-inline-actions">
          <template v-if="!isOpen">
            <ActionButton
              size="sm"
              variant="primary"
              :disabled="loading"
              data-testid="kt-rp-web-panel-open-btn"
              @click="openOrReloadPanel('latest')"
            >
              {{ t('cardWebPanelOpenBtn') }}
            </ActionButton>
            <ActionButton
              v-if="webPanelMeta.pinnedMvuStatus"
              size="sm"
              :disabled="loading"
              data-testid="kt-rp-web-panel-open-status-btn"
              @click="openOrReloadPanel('status')"
            >
              {{ pinnedStatusTitle }}
            </ActionButton>
          </template>
          <template v-else>
            <template v-if="canSwitchLegacySnapshot || canSwitchPinnedStatus">
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
                v-if="canSwitchLegacySnapshot"
                size="sm"
                :variant="activeSnapshotTarget === 'latest' ? 'primary' : 'default'"
                :disabled="loading || !canSwitchLegacySnapshot"
                data-testid="kt-rp-web-panel-snapshot-latest-btn"
                @click="selectLegacySnapshot('latest')"
              >
                {{ t('cardWebPanelSnapshotLatestBtn') }}
              </ActionButton>
              <ActionButton
                v-if="canSwitchPinnedStatus"
                size="sm"
                :variant="activeSnapshotTarget === 'status' ? 'primary' : 'default'"
                :disabled="loading || !canSwitchPinnedStatus"
                data-testid="kt-rp-web-panel-snapshot-status-btn"
                @click="selectLegacySnapshot('status')"
              >
                {{ pinnedStatusTitle }}
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
