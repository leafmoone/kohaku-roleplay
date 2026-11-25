/**
 * Pure helper utilities for kt-roleplay UI components.
 * Keeps file encoding, validation, placeholder preview, safe persona extraction,
 * choice fence parsing, and novel projection allowlisting side-effect-free.
 */

export const DEFAULT_MAX_CARD_BYTES = 12 * 1024 * 1024;
export const DEFAULT_MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_WORLDBOOK_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_NOVEL_MEDIA_BYTES = 8 * 1024 * 1024;

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
 * Normalize a choices object ({ prompt, options }) preserving optional tag and summary
 * while staying backward-compatible with legacy string or {label, text} options.
 */
export function normalizeChoicesPayload(rawChoices) {
  if (!rawChoices || typeof rawChoices !== "object" || Array.isArray(rawChoices)) return null;
  const rawOptions = Array.isArray(rawChoices.options) ? rawChoices.options : [];
  const options = [];
  for (const item of rawOptions) {
    let tag = "";
    let label = "";
    let summary = "";
    let text = "";
    if (typeof item === "string") {
      label = item.trim();
      text = label;
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      if (typeof item.tag === "string") {
        tag = item.tag.trim().slice(0, 24);
      }
      label = String(item.label ?? item.text ?? item.value ?? "").trim();
      if (typeof item.summary === "string") {
        summary = item.summary.trim();
      }
      text = String(item.text ?? item.value ?? item.label ?? "").trim();
    }
    if (!label || !text || text.trimStart().startsWith("/")) continue;
    options.push({ tag, label, summary, text });
  }
  if (!options.length) return null;
  const prompt = String(rawChoices.prompt ?? rawChoices.question ?? "").trim();
  return { prompt, options };
}

/**
 * Parse a closed ```kt_roleplay.choices``` fenced block into prompt + clickable options.
 * Returns null on invalid payloads so the caller falls back to raw text.
 */
export function parseChoiceFence(source) {
  if (typeof source !== "string" || !source.trim()) return null;
  try {
    const parsed = JSON.parse(source);
    return normalizeChoicesPayload(parsed);
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
 * Detect supported image kind (png | jpeg | webp) and validate file size for novel media uploads.
 */
export function validateMediaImageFile(file, maxBytes) {
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
    ? Number(maxBytes)
    : DEFAULT_MAX_NOVEL_MEDIA_BYTES;
  if (!file || typeof file.size !== "number" || file.size <= 0 || file.size > limit) {
    return { ok: false, code: "size", kind: "" };
  }
  const name = String(file.name || "").toLowerCase();
  const mime = String(file.type || "").toLowerCase();
  let kind = "";
  if (mime === "image/png" || name.endsWith(".png")) {
    kind = "png";
  } else if (mime === "image/jpeg" || mime === "image/jpg" || name.endsWith(".jpg") || name.endsWith(".jpeg")) {
    kind = "jpeg";
  } else if (mime === "image/webp" || name.endsWith(".webp")) {
    kind = "webp";
  }
  if (!kind) {
    return { ok: false, code: "type", kind: "" };
  }
  return { ok: true, code: "", kind };
}

/**
 * Read a validated PNG/JPEG/WebP image file into a strict data URL matching novel_media.py.
 */
export async function readFileAsImageDataUrl(file, maxBytes) {
  const check = validateMediaImageFile(file, maxBytes);
  if (!check.ok) {
    throw new Error(check.code === "type" ? "Unsupported image type" : "Image file exceeds size limit");
  }
  const base64 = await readFileAsBase64(file);
  return `data:image/${check.kind};base64,${base64}`;
}

/**
 * Normalize a character sheet structure ({ meters, entries, lists }) without mutating input.
 */
export function normalizeSheet(rawSheet) {
  const src = rawSheet && typeof rawSheet === "object" && !Array.isArray(rawSheet) ? rawSheet : {};
  const rawMeters = Array.isArray(src.meters) ? src.meters : [];
  const rawEntries = Array.isArray(src.entries) ? src.entries : [];
  const rawLists = Array.isArray(src.lists) ? src.lists : [];

  const meters = [];
  for (const item of rawMeters) {
    if (!item || typeof item !== "object") continue;
    const key = typeof item.key === "string" ? item.key.trim() : "";
    const current = Number(item.current);
    if (!key || !Number.isFinite(current)) continue;
    const rawMax = item.max === null || item.max === undefined ? null : Number(item.max);
    meters.push({
      key,
      label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : key,
      current,
      max: rawMax !== null && Number.isFinite(rawMax) ? rawMax : null,
      unit: typeof item.unit === "string" ? item.unit : "",
      visibility: item.visibility === "private" ? "private" : "public",
    });
  }

  const entries = [];
  for (const item of rawEntries) {
    if (!item || typeof item !== "object") continue;
    const key = typeof item.key === "string" ? item.key.trim() : "";
    if (!key) continue;
    entries.push({
      key,
      label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : key,
      value: typeof item.value === "string" ? item.value : String(item.value ?? ""),
      visibility: item.visibility === "private" ? "private" : "public",
    });
  }

  const lists = [];
  for (const item of rawLists) {
    if (!item || typeof item !== "object") continue;
    const key = typeof item.key === "string" ? item.key.trim() : "";
    if (!key) continue;
    const items = Array.isArray(item.items) ? item.items.map((v) => String(v ?? "")).filter(Boolean) : [];
    lists.push({
      key,
      label: typeof item.label === "string" && item.label.trim() ? item.label.trim() : key,
      items,
      visibility: item.visibility === "private" ? "private" : "public",
    });
  }

  return { meters, entries, lists };
}

/**
 * Normalize an actor's layered perspective memory ({ impressions, facts_witnessed, beliefs, summary }).
 */
export function normalizeActorMemory(rawMemory) {
  const src = rawMemory && typeof rawMemory === "object" && !Array.isArray(rawMemory) ? rawMemory : {};
  const rawImpressions =
    src.impressions && typeof src.impressions === "object" && !Array.isArray(src.impressions)
      ? src.impressions
      : {};
  const impressions = {};
  for (const [target, note] of Object.entries(rawImpressions)) {
    const cleanTarget = String(target || "").trim();
    const cleanNote = String(note ?? "").trim();
    if (cleanTarget && cleanNote) {
      impressions[cleanTarget] = cleanNote;
    }
  }
  const factsWitnessed = Array.isArray(src.facts_witnessed)
    ? src.facts_witnessed.map((v) => String(v ?? "").trim()).filter(Boolean)
    : [];
  const beliefs = Array.isArray(src.beliefs)
    ? src.beliefs.map((v) => String(v ?? "").trim()).filter(Boolean)
    : [];
  const summary = typeof src.summary === "string" ? src.summary.trim() : "";
  return {
    impressions,
    facts_witnessed: factsWitnessed,
    beliefs,
    summary,
  };
}

/**
 * Normalize novel chapter choices object ({ prompt, options }) into clickable options.
 */
export function normalizeNovelChoices(rawChoices) {
  return normalizeChoicesPayload(rawChoices);
}

/**
 * Normalize a novel chapter record for the Novel Reader stage and TOC.
 */
export function normalizeNovelChapter(rawChapter, fallbackIndex) {
  const src = rawChapter && typeof rawChapter === "object" ? rawChapter : {};
  const parsedNum = Number(src.number);
  const number = Number.isInteger(parsedNum) && parsedNum >= 0 ? parsedNum : fallbackIndex;
  const prose = typeof src.prose === "string" ? src.prose : "";
  const cleanProse = typeof src.cleanProse === "string" ? src.cleanProse : prose;
  const actors = Array.isArray(src.actors)
    ? src.actors.map((a) => String(a ?? "").trim()).filter(Boolean)
    : [];
  return {
    number,
    title: typeof src.title === "string" ? src.title.trim() : "",
    prose,
    cleanProse,
    actors,
    imageUrl: typeof src.imageUrl === "string" && src.imageUrl.trim() ? src.imageUrl.trim() : "",
    imageCaption: typeof src.imageCaption === "string" ? src.imageCaption.trim() : "",
    choices: normalizeNovelChoices(src.choices),
  };
}

/**
 * Split literary prose into non-empty paragraph blocks while preserving exact
 * JS UTF-16 [start, end) offsets inside cleanProse (cleanProse.slice(start, end) === text).
 */
export function buildOffsetParagraphs(cleanProse) {
  const src = typeof cleanProse === "string" ? cleanProse : "";
  if (!src) return [];
  const paragraphs = [];
  const sepRe = /\r?\n[ \t]*\r?\n(?:[ \t]*\r?\n)*/g;
  let cursor = 0;

  const pushSlice = (rawStart, rawEnd) => {
    let start = rawStart;
    let end = rawEnd;
    while (
      start < end &&
      (src[start] === "\r" || src[start] === "\n" || src[start] === " " || src[start] === "\t")
    ) {
      start += 1;
    }
    while (
      end > start &&
      (src[end - 1] === "\r" || src[end - 1] === "\n" || src[end - 1] === " " || src[end - 1] === "\t")
    ) {
      end -= 1;
    }
    if (end > start) {
      paragraphs.push({
        start,
        end,
        text: src.slice(start, end),
      });
    }
  };

  let match;
  while ((match = sepRe.exec(src)) !== null) {
    pushSlice(cursor, match.index);
    cursor = match.index + match[0].length;
  }
  pushSlice(cursor, src.length);
  return paragraphs;
}

/**
 * Convert a JS UTF-16 string offset into a Python Unicode code-point index.
 */
export function utf16OffsetToCodePoint(text, utf16Offset) {
  const src = typeof text === "string" ? text : "";
  const clamped = Math.max(0, Math.min(src.length, Math.floor(Number(utf16Offset) || 0)));
  return [...src.slice(0, clamped)].length;
}

/**
 * Split one paragraph into plain text and highlighted/preview <mark> segments.
 */
export function splitParagraphSegments(
  paragraph,
  selectionLock,
  previewText,
  chapterNumber,
  firstTouchedStart,
) {
  const text = typeof paragraph?.text === "string" ? paragraph.text : "";
  const pStart = Number(paragraph?.start) || 0;
  const pEnd = Number(paragraph?.end) || 0;
  if (
    !selectionLock ||
    selectionLock.number !== chapterNumber ||
    selectionLock.end <= pStart ||
    selectionLock.start >= pEnd
  ) {
    return [{ kind: "text", text, isPreview: false, origStart: pStart, origEnd: pEnd }];
  }

  const localStart = Math.max(0, selectionLock.start - pStart);
  const localEnd = Math.min(text.length, selectionLock.end - pStart);
  if (localEnd <= localStart) {
    return [{ kind: "text", text, isPreview: false, origStart: pStart, origEnd: pEnd }];
  }

  const segments = [];
  if (localStart > 0) {
    segments.push({
      kind: "text",
      text: text.slice(0, localStart),
      isPreview: false,
      origStart: pStart,
      origEnd: pStart + localStart,
    });
  }

  const hasPreview = typeof previewText === "string";
  const isFirst = firstTouchedStart === pStart;
  if (hasPreview) {
    if (isFirst) {
      segments.push({
        kind: "mark",
        text: previewText,
        isPreview: true,
        origStart: pStart + localStart,
        origEnd: pStart + localEnd,
      });
    }
  } else {
    segments.push({
      kind: "mark",
      text: text.slice(localStart, localEnd),
      isPreview: false,
      origStart: pStart + localStart,
      origEnd: pStart + localEnd,
    });
  }

  if (localEnd < text.length) {
    segments.push({
      kind: "text",
      text: text.slice(localEnd),
      isPreview: false,
      origStart: pStart + localEnd,
      origEnd: pEnd,
    });
  }

  return segments;
}

/**
 * Normalize novel latest-scene revision & variant switcher state.
 */
export function normalizeNovelRevision(rawRevision) {
  if (!rawRevision || typeof rawRevision !== "object" || Array.isArray(rawRevision)) {
    return null;
  }
  const sceneNumber = Number(rawRevision.sceneNumber);
  if (!Number.isInteger(sceneNumber) || sceneNumber < 1) {
    return null;
  }
  const variants = Array.isArray(rawRevision.variants)
    ? rawRevision.variants
        .filter((v) => v && typeof v === "object")
        .map((v, idx) => ({
          index: Number.isInteger(Number(v.index)) ? Number(v.index) : idx,
          id: typeof v.id === "string" ? v.id : String(idx),
          mode: typeof v.mode === "string" ? v.mode : "initial",
          instruction: typeof v.instruction === "string" ? v.instruction : "",
        }))
    : [];
  const rawCount = Number(rawRevision.variantCount);
  const variantCount = Number.isInteger(rawCount) && rawCount > 0 ? rawCount : variants.length;
  const rawActive = Number(rawRevision.activeIndex);
  const activeIndex =
    Number.isInteger(rawActive) && rawActive >= 0
      ? Math.min(rawActive, Math.max(0, variantCount - 1))
      : 0;
  return {
    sceneNumber,
    canDirectorRewrite: Boolean(rawRevision.canDirectorRewrite),
    canFullRerun: Boolean(rawRevision.canFullRerun),
    hasCachedReports: Boolean(rawRevision.hasCachedReports),
    lastPlayerInput:
      typeof rawRevision.lastPlayerInput === "string" ? rawRevision.lastPlayerInput : "",
    activeIndex,
    variantCount,
    variants,
  };
}

/**
 * Split literary prose into non-empty paragraph blocks for clean reader typography.
 */
export function splitNovelProseParagraphs(text) {
  return buildOffsetParagraphs(text).map((p) => p.text);
}

/**
 * Render an entire novel session into clean, portable Markdown for local export.
 */
export function exportNovelMarkdown(novelView, labels) {
  const view = novelView && typeof novelView === "object" ? novelView : {};
  const textLabels = labels && typeof labels === "object" ? labels : {};
  const title = (typeof view.title === "string" && view.title.trim()) || textLabels.defaultTitle || "Novel";
  const lines = [`# ${title}`, ""];

  if (typeof view.premise === "string" && view.premise.trim()) {
    lines.push(`> ${view.premise.trim().replace(/\n+/g, "\n> ")}`, "");
  }

  const chapters = Array.isArray(view.chapters) ? view.chapters : [];
  for (const chapter of chapters) {
    const num = Number.isInteger(chapter.number) ? chapter.number : 0;
    const chTitle = chapter.title
      ? chapter.title
      : num === 0
        ? textLabels.prologueLabel || "Prologue"
        : `${textLabels.chapterPrefix || "Chapter"} ${num}`;
    lines.push(`## ${num === 0 ? chTitle : `${num}. ${chTitle}`}`, "");
    if (chapter.imageCaption) {
      lines.push(`*${chapter.imageCaption}*`, "");
    }
    const body = (chapter.cleanProse || chapter.prose || "").trim();
    if (body) {
      lines.push(body, "");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * Project novel root ui_state() into a normalized, safe frontend model.
 */
export function projectNovelView(state) {
  const src = state && typeof state === "object" ? state : {};
  const pendingRaw = src.pendingScene && typeof src.pendingScene === "object" ? src.pendingScene : null;
  const pendingNumber = pendingRaw ? Number(pendingRaw.number) : NaN;
  const pendingScene =
    Number.isInteger(pendingNumber) && pendingNumber > 0
      ? {
          number: pendingNumber,
          waiting: Array.isArray(pendingRaw.waiting)
            ? pendingRaw.waiting.map((a) => String(a ?? "").trim()).filter(Boolean)
            : [],
          reported: Array.isArray(pendingRaw.reported)
            ? pendingRaw.reported.map((a) => String(a ?? "").trim()).filter(Boolean)
            : [],
        }
      : null;

  const rawCast = Array.isArray(src.cast) ? src.cast : [];
  const cast = rawCast
    .filter((entry) => entry && typeof entry === "object")
    .map((entry, idx) => {
      const visible = {};
      const rawStatus =
        entry.visibleStatus && typeof entry.visibleStatus === "object" ? entry.visibleStatus : {};
      for (const [k, v] of Object.entries(rawStatus)) {
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          visible[k] = v;
        }
      }
      const actorId =
        typeof entry.actor === "string" && entry.actor.trim()
          ? entry.actor.trim()
          : `npc_${idx + 1}`;
      const name = String(entry.name || actorId);
      const cardId = typeof entry.cardId === "string" ? entry.cardId : "";
      const customPortraitUrl =
        typeof entry.customPortraitUrl === "string" && entry.customPortraitUrl.trim()
          ? entry.customPortraitUrl.trim()
          : "";
      return {
        actor: actorId,
        name,
        cardId,
        ephemeral: entry.ephemeral !== undefined ? Boolean(entry.ephemeral) : !cardId,
        hasPortrait: Boolean(entry.hasPortrait || customPortraitUrl),
        portraitKey: typeof entry.portraitKey === "string" ? entry.portraitKey : "",
        customPortraitUrl,
        visibleStatus: visible,
        stateFields: normalizeStateFields(entry.stateFields),
        sheet: normalizeSheet(entry.sheet),
        privateSheet: normalizeSheet(entry.privateSheet),
        memory: normalizeActorMemory(entry.memory),
      };
    })
    .filter((entry) => entry.name);

  const playerMode = src.playerMode === "director" ? "director" : "protagonist";
  const rawPlayer = src.player && typeof src.player === "object" ? src.player : null;
  const player =
    playerMode === "protagonist" && rawPlayer
      ? {
          actor: typeof rawPlayer.actor === "string" && rawPlayer.actor ? rawPlayer.actor : "__player__",
          name: typeof rawPlayer.name === "string" && rawPlayer.name.trim() ? rawPlayer.name.trim() : "Player",
          persona: typeof rawPlayer.persona === "string" ? rawPlayer.persona : "",
          sheet: normalizeSheet(rawPlayer.sheet),
        }
      : null;

  const rawWorldbooks = Array.isArray(src.worldbooks) ? src.worldbooks : [];
  const worldbooks = rawWorldbooks
    .filter((wb) => wb && typeof wb === "object")
    .map((wb, idx) => ({
      id: typeof wb.id === "string" ? wb.id : `wb_${idx}`,
      name: typeof wb.name === "string" && wb.name.trim() ? wb.name.trim() : `Worldbook ${idx + 1}`,
      entries: Math.max(0, Number(wb.entries) || 0),
    }));

  const rawNarrator = src.narrator && typeof src.narrator === "object" ? src.narrator : null;
  const narratorName =
    rawNarrator && typeof rawNarrator.name === "string" ? rawNarrator.name.trim() : "";
  const narrator =
    rawNarrator && narratorName
      ? {
          cardId: typeof rawNarrator.cardId === "string" ? rawNarrator.cardId : "",
          name: narratorName,
          isDefault: Boolean(rawNarrator.isDefault),
          portraitUrl:
            typeof rawNarrator.portraitUrl === "string" && rawNarrator.portraitUrl.trim()
              ? rawNarrator.portraitUrl.trim()
              : "",
        }
      : null;

  const rawStyle = src.style && typeof src.style === "object" ? src.style : null;
  const styleName = rawStyle && typeof rawStyle.name === "string" ? rawStyle.name.trim() : "";
  const style =
    rawStyle && styleName
      ? {
          cardId: typeof rawStyle.cardId === "string" ? rawStyle.cardId : "",
          name: styleName,
        }
      : null;

  const rawChapters = Array.isArray(src.chapters) ? src.chapters : [];
  const chapters = rawChapters
    .filter((ch) => ch && typeof ch === "object")
    .map((ch, idx) => normalizeNovelChapter(ch, idx))
    .sort((a, b) => a.number - b.number);

  const rawPool = Array.isArray(src.mediaPool) ? src.mediaPool : [];
  const mediaPool = rawPool
    .filter((item) => item && typeof item === "object" && typeof item.url === "string" && item.url)
    .map((item) => ({
      key: typeof item.key === "string" ? item.key : "",
      name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : String(item.key || ""),
      url: item.url,
      actor: typeof item.actor === "string" ? item.actor : "",
      cardId: typeof item.cardId === "string" ? item.cardId : "",
    }));

  return {
    active: Boolean(src.active),
    title: typeof src.title === "string" && src.title.trim() ? src.title.trim() : "",
    rootCreatureId: typeof src.rootCreatureId === "string" ? src.rootCreatureId : "",
    rootName: typeof src.rootName === "string" ? src.rootName : "",
    enableStoryChoices: src.enableStoryChoices !== false,
    playerMode,
    player,
    premise: typeof src.premise === "string" ? src.premise.trim() : "",
    sheetHint: typeof src.sheetHint === "string" ? src.sheetHint.trim() : "",
    narrator,
    style,
    worldbooks,
    sceneNumber: Number.isInteger(src.sceneNumber) ? src.sceneNumber : Number(src.completed || 0),
    pendingScene,
    isProcessing: Boolean(src.isProcessing),
    cast,
    chapters,
    mediaPool,
    revision: normalizeNovelRevision(src.revision),
    latestProse: typeof src.latestProse === "string" ? src.latestProse : "",
    blockedReason: typeof src.blockedReason === "string" ? src.blockedReason : "",
  };
}

/**
 * Find the privileged root creature identifier and display name from a session creature list.
 */
export function findPrivilegedRootCreature(creatures) {
  const list = Array.isArray(creatures) ? creatures.filter((c) => c && typeof c === "object") : [];
  if (!list.length) return { creatureId: "", name: "" };
  const privileged = list.find((c) => Boolean(c.is_privileged) || Boolean(c.is_root));
  const rootNamed =
    privileged || list.find((c) => c.name === "root" || c.creature_id === "root" || c.id === "root");
  const chosen = rootNamed || list[0];
  const creatureId = String(chosen.creature_id || chosen.id || chosen.agent_id || chosen.name || "");
  const name = String(chosen.name || creatureId || "");
  return { creatureId, name };
}

/**
 * Normalize the built-in default narrator descriptor exposed by CardCatalog ui_state().
 */
export function normalizeDefaultNarrator(rawDefault) {
  const src =
    rawDefault && typeof rawDefault === "object" && !Array.isArray(rawDefault) ? rawDefault : null;
  if (!src) return null;
  const name = typeof src.name === "string" && src.name.trim() ? src.name.trim() : "";
  const portraitUrl =
    typeof src.portraitUrl === "string" && src.portraitUrl.trim()
      ? src.portraitUrl.trim()
      : "/api/ext/kohaku-roleplay/default-narrator.png";
  if (!name && !src.description && !src.personality && !src.examples) {
    return null;
  }
  return {
    id: typeof src.id === "string" && src.id ? src.id : "__default__",
    name: name || "Immersive Novel Narrator",
    portraitUrl,
    description: typeof src.description === "string" ? src.description : "",
    personality: typeof src.personality === "string" ? src.personality : "",
    examples: typeof src.examples === "string" ? src.examples : "",
  };
}
