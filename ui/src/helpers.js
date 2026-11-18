/**
 * Pure helper utilities for kt-roleplay UI components.
 * Keeps file encoding, validation, placeholder preview, safe persona extraction,
 * choice fence parsing, and novel projection allowlisting side-effect-free.
 */

export const DEFAULT_MAX_CARD_BYTES = 12 * 1024 * 1024;

const STORY_OR_INSTRUCTION_LINE_RE =
  /(\{\{(char|user|original)\}\}|<\/?[a-z_]+>|^(system|instruction|rules?|scenario|example|dialogue|plot)\s*:|^\s*["“「*])/i;

/**
 * Validate a selected character card file before reading its bytes.
 */
export function validateCardFile(file, maxBytes = DEFAULT_MAX_CARD_BYTES) {
  if (!file || typeof file.size !== "number") {
    return { ok: false, code: "size" };
  }
  if (file.size <= 0 || file.size > maxBytes) {
    return { ok: false, code: "size" };
  }
  const name = String(file.name || "").toLowerCase();
  const mime = String(file.type || "").toLowerCase();
  const isJson = name.endsWith(".json") || mime === "application/json" || mime === "text/json";
  const isPng = name.endsWith(".png") || mime === "image/png";
  if (!isJson && !isPng) {
    return { ok: false, code: "type" };
  }
  return { ok: true, kind: isPng ? "png" : "json" };
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
 * Strict allowlist projection for novel player view.
 * Aligns strictly to backend public schema:
 * - pendingScene: { number } only (never maps actor names / reports)
 * - latestProse: string (never reads private facts)
 * - cast: [{ name, cardId, hasPortrait, visibleStatus, stateFields }]
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
