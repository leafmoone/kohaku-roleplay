/**
 * Pure helper utilities for kt-roleplay UI components.
 * Keeps file encoding, validation, placeholder preview, safe persona extraction,
 * choice fence parsing, and novel projection allowlisting side-effect-free.
 */

export const DEFAULT_MAX_CARD_BYTES = 12 * 1024 * 1024;
export const DEFAULT_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_WORLDBOOK_BYTES = 2 * 1024 * 1024;

export function validateWorldbookFile(file, maxBytes = DEFAULT_MAX_WORLDBOOK_BYTES) {
  if (!file || typeof file.size !== "number") {
    return { ok: false, code: "size" };
  }
  const name = String(file.name || "").toLowerCase();
  const mime = String(file.type || "").toLowerCase();
  const isJson = name.endsWith(".json") || mime === "application/json" || mime === "text/json";
  if (!isJson) {
    return { ok: false, code: "type" };
  }
  if (file.size <= 0 || file.size > maxBytes) {
    return { ok: false, code: "size" };
  }
  return { ok: true };
}

export function stripWorldbookExtension(filename) {
  const raw = String(filename || "").trim();
  const stripped = raw.toLowerCase().endsWith(".json") ? raw.slice(0, -5).trim() : raw;
  return (stripped || "Worldbook").slice(0, 120);
}

export function normalizeWorldbookDiagnostics(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const totalEntries = Number(raw.totalEntries);
  const supportedEntries = Number(raw.supportedEntries);
  if (!Number.isFinite(totalEntries) || !Number.isFinite(supportedEntries)) return null;
  const rawIssues = Array.isArray(raw.issues) ? raw.issues : [];
  const issues = rawIssues
    .filter((item) => item && typeof item === "object" && typeof item.code === "string" && item.code)
    .map((item) => ({
      code: item.code,
      count: Math.max(0, Number(item.count) || 0),
    }))
    .filter((item) => item.count > 0);
  const skippedEntries = Math.max(
    0,
    totalEntries - supportedEntries,
    issues.reduce((sum, item) => sum + item.count, 0),
  );
  return {
    totalEntries: Math.max(0, totalEntries),
    supportedEntries: Math.max(0, supportedEntries),
    skippedEntries,
    issues,
  };
}

export function normalizeWorldbookEntries(rawEntries) {
  if (!Array.isArray(rawEntries)) return [];
  return rawEntries.map((item, idx) => {
    const src = item && typeof item === "object" ? item : {};
    const index = Number.isInteger(src.index) ? src.index : idx;
    const keys = Array.isArray(src.keys) ? src.keys.filter((k) => typeof k === "string" && k.trim()) : [];
    const secondaryKeys = Array.isArray(src.secondaryKeys)
      ? src.secondaryKeys.filter((k) => typeof k === "string" && k.trim())
      : [];
    return {
      index,
      name: typeof src.name === "string" ? src.name.trim() : "",
      content: typeof src.content === "string" ? src.content : "",
      keys,
      secondaryKeys,
      position: typeof src.position === "string" ? src.position : null,
      enabled: Boolean(src.enabled),
      issue: typeof src.issue === "string" && src.issue ? src.issue : null,
    };
  });
}

const STORY_OR_INSTRUCTION_LINE_RE =
  /(\{\{(char|user|original)\}\}|<\/?[a-z_]+>|^(system|instruction|rules?|scenario|example|dialogue|plot)\s*:|^\s*["“「*])/i;

/**
 * Validate a selected character card file before reading its bytes.
 */
export function validateCardFile(
  file,
  maxBytes = DEFAULT_MAX_CARD_BYTES,
  maxArchiveBytes = DEFAULT_MAX_ARCHIVE_BYTES,
) {
  if (!file || typeof file.size !== "number") {
    return { ok: false, code: "size" };
  }
  const name = String(file.name || "").toLowerCase();
  const mime = String(file.type || "").toLowerCase();
  const isJson = name.endsWith(".json") || mime === "application/json" || mime === "text/json";
  const isPng = name.endsWith(".png") || mime === "image/png";
  const isCharx = name.endsWith(".charx");
  if (!isJson && !isPng && !isCharx) {
    return { ok: false, code: "type" };
  }
  const limit = isCharx ? maxArchiveBytes : maxBytes;
  if (file.size <= 0 || file.size > limit) {
    return { ok: false, code: "size", kind: isCharx ? "charx" : isPng ? "png" : "json" };
  }
  return { ok: true, kind: isCharx ? "charx" : isPng ? "png" : "json" };
}

/**
 * Read a browser File into ASCII Base64 in bounded chunks.
 */
export async function readFileAsBase64(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

/**
 * Preview-only expansion for {{char}} and {{user}} placeholders.
 */
export function expandPlaceholders(text, charName = "", userName = "") {
  const src = typeof text === "string" ? text : "";
  if (!src) return "";
  return src.replace(/\{\{(char|user)\}\}/g, (_, key) => {
    if (key === "char") return charName || "{{char}}";
    return userName || "{{user}}";
  });
}

/**
 * Extract a conservative, user-editable persona draft from a card.
 * Never passes plot-heavy or instruction-laden descriptions verbatim as confirmed appearance.
 */
export function extractSafePersonaDraft(cardDetail) {
  const fields = cardDetail?.fields || {};
  const rawName = String(fields.name || cardDetail?.name || "").trim();
  const rawPersonality = String(fields.personality || "").trim();
  const rawDescription = String(fields.description || "").trim();

  const safeLines = [];
  let charCount = 0;
  for (const rawLine of rawDescription.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (STORY_OR_INSTRUCTION_LINE_RE.test(line)) continue;
    if (charCount + line.length > 260) break;
    safeLines.push(line);
    charCount += line.length;
  }

  return {
    name: rawName,
    appearance: safeLines.join(" "),
    personality: rawPersonality.slice(0, 400),
    voice: "",
  };
}

/**
 * Build the list of opening greetings from card fields.
 */
export function collectGreetings(fields) {
  if (!fields || typeof fields !== "object") return [];
  const list = [];
  if (typeof fields.first_mes === "string") {
    list.push(fields.first_mes);
  }
  if (Array.isArray(fields.alternate_greetings)) {
    for (const item of fields.alternate_greetings) {
      if (typeof item === "string") list.push(item);
    }
  }
  return list;
}

/**
 * Parse a closed ```kt_roleplay.choices``` fenced block into prompt + clickable options.
 * Returns null on invalid payloads so the caller falls back to raw text.
 */
export function parseChoiceFence(source) {
  if (typeof source !== "string" || !source.trim()) return null;
  try {
    const parsed = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const rawOptions = Array.isArray(parsed.options) ? parsed.options : [];
    const options = [];
    for (const item of rawOptions) {
      let label = "";
      let text = "";
      if (typeof item === "string") {
        label = item.trim();
        text = label;
      } else if (item && typeof item === "object") {
        label = String(item.label ?? item.text ?? item.value ?? "").trim();
        text = String(item.text ?? item.value ?? item.label ?? "").trim();
      }
      if (!label || !text || text.startsWith("/")) continue;
      options.push({ label, text });
    }
    if (!options.length) return null;
    const prompt = String(parsed.prompt ?? parsed.question ?? "").trim();
    return { prompt, options };
  } catch {
    return null;
  }
}

/**
 * Normalize public card-authored state fields from backend stateFields array.
 * Strictly allowlists public display properties (never forwards options/private fields).
 */
export function normalizeStateFields(rawFields) {
  if (!Array.isArray(rawFields)) return [];
  const out = [];
  for (const item of rawFields) {
    if (!item || typeof item !== "object") continue;
    const key = typeof item.key === "string" ? item.key.trim() : "";
    const label = typeof item.label === "string" ? item.label.trim() : "";
    const type = item.type;
    if (!key || !label) continue;
    if (type === "number") {
      if (typeof item.value !== "number" || !Number.isFinite(item.value)) continue;
      const entry = { key, label, type, value: item.value };
      if (typeof item.min === "number" && Number.isFinite(item.min)) entry.min = item.min;
      if (typeof item.max === "number" && Number.isFinite(item.max)) entry.max = item.max;
      out.push(entry);
    } else if (type === "list") {
      const listVal = Array.isArray(item.value)
        ? item.value.filter((v) => typeof v === "string")
        : [];
      out.push({ key, label, type, value: listVal });
    } else if (type === "enum" || type === "text") {
      out.push({
        key,
        label,
        type,
        value: typeof item.value === "string" ? item.value : String(item.value ?? ""),
      });
    }
  }
  return out;
}

/**
 * Sanitize a character name into a safe download filename for PNG, JSON, or CHARX export.
 */
export function sanitizeDownloadFilename(name, format = "json") {
  const ext = format === "png" ? ".png" : format === "charx" ? ".charx" : ".json";
  const cleaned = String(name || "")
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 80)
    .trim();
  return `${cleaned || "character"}${ext}`;
}

/**
 * Decode an ASCII Base64 string into raw bytes for local Blob download.
 */
export function base64ToUint8Array(base64) {
  const binary = atob(String(base64 || ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const STRING_CARD_FIELDS = [
  "name",
  "description",
  "personality",
  "scenario",
  "first_mes",
  "mes_example",
  "creator_notes",
  "creator",
  "system_prompt",
  "post_history_instructions",
];

const ARRAY_CARD_FIELDS = ["alternate_greetings", "tags"];

/**
 * Normalize raw CardFields from edit_draft into a clean mutable draft object.
 */
export function cloneEditableFields(rawFields) {
  const src = rawFields && typeof rawFields === "object" ? rawFields : {};
  const out = {};
  for (const key of STRING_CARD_FIELDS) {
    out[key] = typeof src[key] === "string" ? src[key] : "";
  }
  for (const key of ARRAY_CARD_FIELDS) {
    out[key] = Array.isArray(src[key]) ? src[key].map((v) => String(v ?? "")) : [];
  }
  return out;
}

/**
 * Compute minimal patch of changed CardFields between original draft and edited draft.
 * Preserves multi-line newlines in text/greetings without stripping internal line breaks.
 */
export function diffCardFields(originalFields, editedFields) {
  const orig = cloneEditableFields(originalFields);
  const next = cloneEditableFields(editedFields);
  const patch = {};
  for (const key of STRING_CARD_FIELDS) {
    if (next[key] !== orig[key]) {
      patch[key] = next[key];
    }
  }
  for (const key of ARRAY_CARD_FIELDS) {
    const a = orig[key];
    const b = next[key];
    if (a.length !== b.length || a.some((val, idx) => val !== b[idx])) {
      patch[key] = [...b];
    }
  }
  return patch;
}

const STATE_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/;

/**
 * Convert backend StateField[] into interactive form rows for the editor.
 */
export function cloneStateDefinitionsToForm(defs) {
  if (!Array.isArray(defs)) return [];
  return defs.map((item) => {
    const type = item?.type === "number" || item?.type === "enum" || item?.type === "list" ? item.type : "text";
    const visibility = item?.visibility === "private" ? "private" : "public";
    if (type === "number") {
      return {
        key: String(item?.key || ""),
        label: String(item?.label || ""),
        type,
        visibility,
        initialText: item?.initial !== undefined && item?.initial !== null ? String(item.initial) : "0",
        minText: item?.min !== undefined && item?.min !== null ? String(item.min) : "",
        maxText: item?.max !== undefined && item?.max !== null ? String(item.max) : "",
        options: [],
        listItems: [],
      };
    }
    if (type === "enum") {
      const options = Array.isArray(item?.options) ? item.options.map(String) : [];
      const initial = typeof item?.initial === "string" && options.includes(item.initial) ? item.initial : options[0] || "";
      return {
        key: String(item?.key || ""),
        label: String(item?.label || ""),
        type,
        visibility,
        initialText: initial,
        minText: "",
        maxText: "",
        options,
        listItems: [],
      };
    }
    if (type === "list") {
      return {
        key: String(item?.key || ""),
        label: String(item?.label || ""),
        type,
        visibility,
        initialText: "",
        minText: "",
        maxText: "",
        options: [],
        listItems: Array.isArray(item?.initial) ? item.initial.map(String) : [],
      };
    }
    return {
      key: String(item?.key || ""),
      label: String(item?.label || ""),
      type: "text",
      visibility,
      initialText: typeof item?.initial === "string" ? item.initial : "",
      minText: "",
      maxText: "",
      options: [],
      listItems: [],
    };
  });
}

function parseOptionalFiniteNumber(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { present: false, ok: true, value: undefined };
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return { present: true, ok: false, value: NaN };
  return { present: true, ok: true, value: num };
}

/**
 * Validate interactive state definition rows and build strict StateField[] payload.
 * Returns { ok: true, definitions } or { ok: false, code, index, key }.
 */
export function buildStateDefinitionsPayload(rows) {
  if (!Array.isArray(rows)) return { ok: true, definitions: [] };
  const seenKeys = new Set();
  const definitions = [];

  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx] || {};
    const key = String(row.key ?? "").trim();
    const label = String(row.label ?? "").trim();
    const type = row.type;
    const visibility = row.visibility === "private" ? "private" : "public";

    if (!STATE_KEY_RE.test(key)) {
      return { ok: false, code: "key", index: idx, key };
    }
    if (seenKeys.has(key)) {
      return { ok: false, code: "duplicateKey", index: idx, key };
    }
    seenKeys.add(key);

    if (!label) {
      return { ok: false, code: "label", index: idx, key };
    }

    if (type === "number") {
      const minRes = parseOptionalFiniteNumber(row.minText);
      const maxRes = parseOptionalFiniteNumber(row.maxText);
      const initRes = parseOptionalFiniteNumber(row.initialText);
      if (!initRes.present || !initRes.ok) {
        return { ok: false, code: "numberInitial", index: idx, key };
      }
      if (!minRes.ok || !maxRes.ok) {
        return { ok: false, code: "numberBounds", index: idx, key };
      }
      if (minRes.present && maxRes.present && maxRes.value < minRes.value) {
        return { ok: false, code: "numberRangeOrder", index: idx, key };
      }
      if (
        (minRes.present && initRes.value < minRes.value) ||
        (maxRes.present && initRes.value > maxRes.value)
      ) {
        return { ok: false, code: "numberOutOfBounds", index: idx, key };
      }
      const out = { key, label, type: "number", initial: initRes.value, visibility };
      if (minRes.present) out.min = minRes.value;
      if (maxRes.present) out.max = maxRes.value;
      definitions.push(out);
    } else if (type === "enum") {
      const options = Array.isArray(row.options) ? row.options.map((v) => String(v)) : [];
      if (!options.length || new Set(options).size !== options.length) {
        return { ok: false, code: "enumOptions", index: idx, key };
      }
      const initial = String(row.initialText ?? "");
      if (!options.includes(initial)) {
        return { ok: false, code: "enumInitial", index: idx, key };
      }
      definitions.push({ key, label, type: "enum", initial, visibility, options });
    } else if (type === "list") {
      const listVal = Array.isArray(row.listItems) ? row.listItems.map((v) => String(v)) : [];
      definitions.push({ key, label, type: "list", initial: listVal, visibility });
    } else {
      definitions.push({
        key,
        label,
        type: "text",
        initial: String(row.initialText ?? ""),
        visibility,
      });
    }
  }

  return { ok: true, definitions };
}

/**
 * Compare original backend StateField[] with edited definitions to decide
 * whether stateDefinitions should be sent on save_copy.
 */
export function areStateDefinitionsEqual(origDefs, nextDefs) {
  const canonicalOrig = buildStateDefinitionsPayload(cloneStateDefinitionsToForm(origDefs));
  if (!canonicalOrig.ok) return false;
  return JSON.stringify(canonicalOrig.definitions) === JSON.stringify(nextDefs || []);
}

/**
 * Validate a selected PNG file for local portrait asset embedding.
 */
export function validatePortraitPngFile(file, maxBytes = DEFAULT_MAX_CARD_BYTES) {
  if (!file || typeof file.size !== "number" || file.size <= 0 || file.size > maxBytes) {
    return { ok: false, code: "size" };
  }
  const name = String(file.name || "").toLowerCase();
  const mime = String(file.type || "").toLowerCase();
  if (!name.endsWith(".png") && mime !== "image/png") {
    return { ok: false, code: "type" };
  }
  return { ok: true };
}

/**
 * Filter card state definitions strictly to public text/enum/number fields
 * eligible for portrait matching rules (never exposes private or list fields).
 */
export function extractPublicPortraitFields(stateDefinitions) {
  if (!Array.isArray(stateDefinitions)) return [];
  return stateDefinitions
    .filter(
      (f) =>
        f &&
        typeof f === "object" &&
        f.visibility === "public" &&
        (f.type === "text" || f.type === "number" || f.type === "enum") &&
        typeof f.key === "string" &&
        f.key.trim(),
    )
    .map((f) => ({
      key: f.key,
      label: String(f.label || f.key),
      type: f.type,
      min: typeof f.min === "number" && Number.isFinite(f.min) ? f.min : undefined,
      max: typeof f.max === "number" && Number.isFinite(f.max) ? f.max : undefined,
      options: f.type === "enum" && Array.isArray(f.options) ? f.options.map(String) : [],
    }));
}

/**
 * Convert backend portrait_draft.portraits into interactive form rows.
 */
export function clonePortraitsToForm(rawPortraits, publicFields = []) {
  if (!Array.isArray(rawPortraits)) return [];
  const fallbackField = publicFields[0]?.key || "";
  return rawPortraits.map((item) => {
    const hasField = typeof item?.field === "string" && item.field.length > 0;
    return {
      key: String(item?.key || ""),
      isDefault: !hasField,
      field: hasField ? item.field : fallbackField,
      equalsText:
        hasField && item?.equals !== undefined && item?.equals !== null ? String(item.equals) : "",
      data: typeof item?.data === "string" ? item.data : "",
    };
  });
}

/**
 * Validate portrait editor rows against backend PortraitAsset rules and build payload.
 * Returns { ok: true, portraits } or { ok: false, code, index, key }.
 */
export function buildPortraitsPayload(rows, publicFields = [], maxBytes = DEFAULT_MAX_CARD_BYTES) {
  if (!Array.isArray(rows)) return { ok: true, portraits: [] };
  const fieldMap = new Map(publicFields.map((f) => [f.key, f]));
  const seenKeys = new Set();
  const seenConditions = new Set();
  const portraits = [];
  let totalBase64Len = 0;

  for (let idx = 0; idx < rows.length; idx += 1) {
    const row = rows[idx] || {};
    const key = String(row.key ?? "").trim();
    if (!STATE_KEY_RE.test(key)) {
      return { ok: false, code: "key", index: idx, key };
    }
    if (seenKeys.has(key)) {
      return { ok: false, code: "duplicateKey", index: idx, key };
    }
    seenKeys.add(key);

    const data = typeof row.data === "string" ? row.data.trim() : "";
    if (!data) {
      return { ok: false, code: "missingImage", index: idx, key };
    }
    totalBase64Len += data.length;
    if (totalBase64Len > 4 * Math.ceil(maxBytes / 3)) {
      return { ok: false, code: "totalSize", index: idx, key };
    }

    if (row.isDefault) {
      if (seenConditions.has("__DEFAULT__")) {
        return { ok: false, code: "duplicateDefault", index: idx, key };
      }
      seenConditions.add("__DEFAULT__");
      portraits.push({ key, data });
      continue;
    }

    const fieldKey = String(row.field || "").trim();
    const fieldDef = fieldMap.get(fieldKey);
    if (!fieldDef) {
      return { ok: false, code: "invalidField", index: idx, key };
    }

    let equalsValue;
    if (fieldDef.type === "number") {
      const raw = String(row.equalsText ?? "").trim();
      const num = Number(raw);
      if (!raw || !Number.isFinite(num)) {
        return { ok: false, code: "invalidNumber", index: idx, key };
      }
      if (
        (fieldDef.min !== undefined && num < fieldDef.min) ||
        (fieldDef.max !== undefined && num > fieldDef.max)
      ) {
        return { ok: false, code: "numberOutOfBounds", index: idx, key };
      }
      equalsValue = num;
    } else if (fieldDef.type === "enum") {
      const val = String(row.equalsText ?? "");
      if (!fieldDef.options.includes(val)) {
        return { ok: false, code: "invalidEnum", index: idx, key };
      }
      equalsValue = val;
    } else {
      equalsValue = String(row.equalsText ?? "");
    }

    const condSig = `${fieldKey}\u0000${typeof equalsValue}:${String(equalsValue)}`;
    if (seenConditions.has(condSig)) {
      return { ok: false, code: "duplicateCondition", index: idx, key };
    }
    seenConditions.add(condSig);
    portraits.push({ key, field: fieldKey, equals: equalsValue, data });
  }

  return { ok: true, portraits };
}

export function normalizeMediaList(rawMedia) {
  if (!Array.isArray(rawMedia)) return [];
  const out = [];
  for (const item of rawMedia) {
    if (!item || typeof item !== "object") continue;
    const key = typeof item.key === "string" ? item.key.trim() : "";
    if (!key) continue;
    out.push({
      key,
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : key,
      kind: typeof item.kind === "string" ? item.kind.trim() : "",
    });
  }
  return out;
}

export function normalizeMediaIssues(rawIssues) {
  if (!rawIssues || typeof rawIssues !== "object" || Array.isArray(rawIssues)) return [];
  const out = [];
  for (const [code, rawCount] of Object.entries(rawIssues)) {
    const count = Number(rawCount);
    if (!code || !Number.isFinite(count) || count <= 0) continue;
    out.push({ code, count: Math.floor(count) });
  }
  return out;
}

/**
 * Strict allowlist projection for novel player view.
 * Aligns strictly to backend public schema:
 * - pendingScene: { number } only (never maps actor names / reports)
 * - latestProse: string (never reads private facts)
 * - cast: [{ name, cardId, hasPortrait, portraitKey, visibleStatus, stateFields }]
 */
export function projectNovelView(state) {
  const src = state && typeof state === "object" ? state : {};
  const pendingRaw = src.pendingScene && typeof src.pendingScene === "object" ? src.pendingScene : null;
  const pendingNumber = pendingRaw ? Number(pendingRaw.number) : NaN;
  const pendingScene =
    Number.isInteger(pendingNumber) && pendingNumber > 0 ? { number: pendingNumber } : null;

  const rawCast = Array.isArray(src.cast) ? src.cast : [];
  const cast = rawCast
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => {
      const visible = {};
      const rawStatus =
        entry.visibleStatus && typeof entry.visibleStatus === "object" ? entry.visibleStatus : {};
      for (const [k, v] of Object.entries(rawStatus)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          visible[k] = v;
        }
      }
      return {
        name: String(entry.name || ""),
        cardId: typeof entry.cardId === "string" ? entry.cardId : "",
        hasPortrait: Boolean(entry.hasPortrait),
        portraitKey: typeof entry.portraitKey === "string" ? entry.portraitKey : "",
        visibleStatus: visible,
        stateFields: normalizeStateFields(entry.stateFields),
      };
    })
    .filter((entry) => entry.name);

  return {
    active: Boolean(src.active),
    sceneNumber: Number.isInteger(src.sceneNumber) ? src.sceneNumber : Number(src.completed || 0),
    pendingScene,
    cast,
    latestProse: typeof src.latestProse === "string" ? src.latestProse : "",
    blockedReason: typeof src.blockedReason === "string" ? src.blockedReason : "",
  };
}
