import { computed, ref, watch } from "vue";
import {
  ActionButton,
  confirm,
  notify,
  openTab,
  useCreature,
  useExtension,
  useOwner,
  useSession,
} from "@kohakuterrarium/ui-sdk";

import {
  collectGreetings,
  extractSafePersonaDraft,
  normalizeStateFields,
  normalizeWorldbookDiagnostics,
  normalizeWorldbookEntries,
  projectNovelView,
} from "./helpers.js";
import { CardMediaGallery } from "./CardMediaGallery.js";
import { CardWebPanel } from "./CardWebPanel.js";
import { MvuPanel } from "./MvuPanel.js";
import { NativePanels } from "./NativePanels.js";
import { PortraitFrame } from "./PortraitFrame.js";
import { RoleplayHeaderSummary } from "./RoleplayHeaderSummary.js";
import { StateFieldsView } from "./StateFieldsView.js";
import { useRoleplayText } from "./strings.js";

const WORLDBOOK_ISSUE_KEYS = {
  unsupported_position: "worldbookIssueUnsupportedPosition",
  unsupported_trigger: "worldbookIssueUnsupportedTrigger",
  unsupported_key: "worldbookIssueUnsupportedKey",
  script_content: "worldbookIssueScriptContent",
  invalid_entry: "worldbookIssueInvalidEntry",
};

const CARD_SCRIPT_ISSUE_KEYS = {
  invalid_script: "cardScriptIssueInvalidScript",
  module_dependency: "cardScriptIssueModuleDependency",
  dependency_missing: "cardScriptIssueDependencyMissing",
  dependency_unapproved_transitive: "cardScriptIssueDependencyUnapprovedTransitive",
  dependency_unsupported: "cardScriptIssueDependencyUnsupported",
  dependency_limit: "cardScriptIssueDependencyLimit",
  module_linker_unavailable: "cardScriptIssueModuleLinkerUnavailable",
  module_link_failed: "cardScriptIssueModuleLinkFailed",
};

/**
 * Creature-scoped session dock panel for plugin:roleplay.
 * Switches between Persona Attachment, Tavern Play, Novel Reader Projection, and NPC Actor
 * purely from owner.state; opening never advances any turn or writes state.
 */
export const RoleplayDockPanel = {
  name: "RoleplayDockPanel",
  components: {
    ActionButton,
    CardMediaGallery,
    CardWebPanel,
    MvuPanel,
    NativePanels,
    PortraitFrame,
    RoleplayHeaderSummary,
    StateFieldsView,
  },
  setup() {
    const owner = useOwner();
    const session = useSession();
    const creature = useCreature();
    const t = useRoleplayText();
    let kt = null;
    try {
      kt = useExtension();
    } catch {
      kt = null;
    }

    const cards = ref([]);
    const cardsLoading = ref(false);
    const cardsError = ref("");
    const selectedCardId = ref("");
    const selectedDetail = ref(null);
    const detailLoading = ref(false);
    const detailError = ref("");
    const busy = ref(false);
    const actionError = ref("");

    // Package catalog worldbooks & card defaults (loaded via package:kohaku-roleplay)
    const catalogWorldbooks = ref([]);
    const catalogCardDefaults = ref({});
    const catalogCardScriptsDefault = ref(true);
    const catalogLoading = ref(false);
    let catalogSeq = 0;

    const personaForm = ref({
      name: "",
      appearance: "",
      personality: "",
      voice: "",
    });
    const personaDirty = ref(false);

    const tavernForm = ref({
      playerName: "Player",
      playerDescription: "",
      greetingIndex: 0,
      worldbookMode: "__default__",
      scriptsMode: "__default__",
    });
    const notesDraft = ref("");
    const notesDirty = ref(false);
    const worldbookInput = ref(null);
    const worldbookError = ref("");
    const selectedSessionWorldbookId = ref("");

    // Session worldbook snapshot reader state ("attached" | "embedded")
    const activeWorldbookSlot = ref("");
    const slotSnapshot = ref(null);
    const slotLoading = ref(false);
    const slotError = ref("");
    const slotEntryQuery = ref("");
    const slotEntryFilter = ref("all");
    const selectedSlotEntryIndex = ref(null);
    let slotSeq = 0;
    let worldbookMutationSeq = 0;

    // Session card scripts state
    const scriptBusy = ref(false);
    const scriptError = ref("");
    const scriptSuccessNotice = ref("");
    const scriptFloatingExpanded = ref(false);
    const invokingScriptButtonKey = ref("");
    let scriptMutationSeq = 0;

    // Session summary pins & secondary config collapsible state
    const headerPinsDraft = ref([]);
    const headerPinsDirty = ref(false);
    const headerPinsBusy = ref(false);
    const headerPinsError = ref("");
    const headerPinsSaved = ref(false);
    const panelMoreExpanded = ref(false);
    let headerPinsSeq = 0;

    const resumingScene = ref(false);
    const resumeError = ref("");

    const state = computed(() => owner.state.value || {});
    const mode = computed(() => {
      if (
        state.value.mode === "tavern" ||
        state.value.mode === "novel" ||
        state.value.mode === "npc"
      ) {
        return state.value.mode;
      }
      return "persona";
    });
    const active = computed(() => Boolean(state.value.active));
    const greetings = computed(() => collectGreetings(selectedDetail.value?.fields));
    const selectedCardSummary = computed(
      () => cards.value.find((card) => card.id === selectedCardId.value) || null,
    );
    const activeCardSummary = computed(
      () => cards.value.find((card) => card.id === state.value.cardId) || null,
    );
    const selectedCardDefaultWorldbook = computed(() => {
      const id = selectedCardId.value;
      if (!id) return null;
      const bookId = catalogCardDefaults.value?.[id];
      if (typeof bookId !== "string" || !bookId) return null;
      return catalogWorldbooks.value.find((wb) => wb.id === bookId) || null;
    });
    const tavernStateFields = computed(() => normalizeStateFields(state.value.stateFields));
    const tavernScopeKey = computed(() =>
      JSON.stringify([session.value?.id, creature.value?.name, state.value.cardId]),
    );
    const mvuPublicSignature = computed(() => {
      const selected = state.value.mvu?.selected;
      if (!Array.isArray(selected)) return "[]";
      const ids = selected
        .filter((id) => typeof id === "string" && id)
        .slice()
        .sort();
      return JSON.stringify(ids);
    });
    const saveMvuSelection = (ids) => owner.call("set_mvu_public", { ids });
    const chooseNativeOption = (panelId, index) =>
      owner.call("choose_panel_option", { panelId, index });
    const novelView = computed(() => projectNovelView(state.value));

    function worldbookIssueLabel(issueOrCode, countArg = 1) {
      const code =
        typeof issueOrCode === "string"
          ? issueOrCode
          : issueOrCode?.code || "unknown";
      const count =
        typeof issueOrCode === "object" && issueOrCode !== null
          ? Number(issueOrCode.count) || 0
          : Number(countArg) || 0;
      const i18nKey = WORLDBOOK_ISSUE_KEYS[code];
      if (i18nKey) return t(i18nKey, { count });
      return t("worldbookIssueUnknown", { code, count });
    }

    function cardScriptIssueLabel(issueCode) {
      const code = typeof issueCode === "string" ? issueCode.trim() : "";
      if (!code) return "";
      const i18nKey = CARD_SCRIPT_ISSUE_KEYS[code];
      if (i18nKey) return t(i18nKey);
      return t("cardScriptIssueUnknown", { issue: code });
    }

    const sessionCardScripts = computed(() => {
      const raw = state.value.cardScripts;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const entries = Array.isArray(raw.entries)
        ? raw.entries
            .filter((item) => item && typeof item === "object" && typeof item.id === "string" && item.id)
            .map((item) => ({
              id: item.id,
              name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : item.id,
              enabled: Boolean(item.enabled),
              issue: typeof item.issue === "string" && item.issue ? item.issue : null,
              module: Boolean(item.module),
              buttons: Array.isArray(item.buttons)
                ? item.buttons.filter((btn) => typeof btn === "string" && btn.trim())
                : [],
            }))
        : [];
      const rawIssues = raw.issues && typeof raw.issues === "object" && !Array.isArray(raw.issues)
        ? raw.issues
        : {};
      const runtimeIssues = Object.entries(rawIssues)
        .filter(([k, v]) => typeof k === "string" && k && typeof v === "string" && v.trim())
        .map(([key, message]) => ({
          key,
          label:
            key === "$host"
              ? t("cardScriptsHostIssueLabel")
              : entries.find((e) => e.id === key)?.name || key,
          message: message.trim(),
        }));
      const rawInactive =
        raw.inactiveEvents && typeof raw.inactiveEvents === "object" && !Array.isArray(raw.inactiveEvents)
          ? raw.inactiveEvents
          : {};
      const inactiveEvents = {};
      for (const [scriptId, evList] of Object.entries(rawInactive)) {
        if (Array.isArray(evList)) {
          const valid = evList.filter((ev) => typeof ev === "string" && ev.trim());
          if (valid.length) inactiveEvents[scriptId] = valid;
        }
      }
      return {
        entries,
        canEnable: Boolean(raw.canEnable),
        enabled: Boolean(raw.enabled),
        runtimeIssues,
        inactiveEvents,
      };
    });

    const runnableScriptButtonGroups = computed(() => {
      const scripts = sessionCardScripts.value;
      if (!scripts || !scripts.enabled) return [];
      return scripts.entries
        .filter((entry) => entry.enabled && !entry.issue && entry.buttons.length > 0)
        .map((entry) => ({
          id: entry.id,
          name: entry.name,
          buttons: entry.buttons,
        }));
    });

    const runnableScriptButtonTotal = computed(() =>
      runnableScriptButtonGroups.value.reduce((sum, grp) => sum + grp.buttons.length, 0),
    );

    const sessionHeaderSummary = computed(() => {
      const raw = state.value.headerSummary;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const options = Array.isArray(raw.options)
        ? raw.options
            .filter(
              (item) =>
                item &&
                typeof item === "object" &&
                typeof item.id === "string" &&
                item.id &&
                typeof item.label === "string" &&
                item.label,
            )
            .map((item) => ({
              id: item.id,
              label: item.label,
              type: typeof item.type === "string" ? item.type : "text",
            }))
        : [];
      const optionSet = new Set(options.map((o) => o.id));
      const pinned = Array.isArray(raw.pinned)
        ? raw.pinned.filter((id) => typeof id === "string" && optionSet.has(id))
        : [];
      const maxPins = Number.isInteger(raw.maxPins) && raw.maxPins > 0 ? raw.maxPins : 8;
      return {
        options,
        pinned,
        maxPins,
      };
    });

    const sessionWorldbookDiag = computed(() =>
      normalizeWorldbookDiagnostics(state.value.worldbookDiagnostics),
    );
    const cardLoreDiag = computed(() =>
      normalizeWorldbookDiagnostics(state.value.cardLoreDiagnostics),
    );
    const attachedWorldbookRef = computed(() => {
      const refObj = state.value.worldbookRef;
      if (refObj && typeof refObj === "object" && typeof refObj.id === "string" && refObj.id) {
        return {
          id: refObj.id,
          name: typeof refObj.name === "string" ? refObj.name : refObj.id,
        };
      }
      return null;
    });
    const hasAttachedWorldbook = computed(
      () => state.value.worldbookEntries != null || Boolean(sessionWorldbookDiag.value),
    );
    const hasEmbeddedWorldbook = computed(() => Boolean(cardLoreDiag.value));
    const sessionWorldbookSourceLabel = computed(() => {
      if (attachedWorldbookRef.value) {
        return t("sessionWorldbookActiveSourceLibrary", {
          name: attachedWorldbookRef.value.name,
        });
      }
      if (hasAttachedWorldbook.value) {
        return t("sessionWorldbookActiveSourceLocal");
      }
      return t("sessionWorldbookActiveSourceNone");
    });

    const slotEntries = computed(() =>
      normalizeWorldbookEntries(slotSnapshot.value?.entries),
    );
    const slotDiagnostics = computed(() =>
      normalizeWorldbookDiagnostics(slotSnapshot.value?.diagnostics),
    );
    const slotSupportedCount = computed(
      () => slotEntries.value.filter((entry) => !entry.issue).length,
    );
    const slotIssuesCount = computed(
      () => slotEntries.value.filter((entry) => Boolean(entry.issue)).length,
    );
    const filteredSlotEntries = computed(() => {
      const filterMode = slotEntryFilter.value;
      const q = slotEntryQuery.value.trim().toLowerCase();
      return slotEntries.value.filter((entry) => {
        if (filterMode === "supported" && entry.issue) return false;
        if (filterMode === "issues" && !entry.issue) return false;
        if (!q) return true;
        const title = (
          entry.name || t("worldbookEntryUntitled", { index: entry.index + 1 })
        ).toLowerCase();
        if (title.includes(q)) return true;
        if (entry.keys.some((k) => k.toLowerCase().includes(q))) return true;
        if (entry.secondaryKeys.some((k) => k.toLowerCase().includes(q))) return true;
        return false;
      });
    });
    const selectedSlotEntry = computed(() => {
      const list = filteredSlotEntries.value;
      if (!list.length) return null;
      return (
        list.find((entry) => entry.index === selectedSlotEntryIndex.value) ||
        list[0]
      );
    });

    watch(
      filteredSlotEntries,
      (list) => {
        if (!list.length) {
          selectedSlotEntryIndex.value = null;
          return;
        }
        if (!list.some((entry) => entry.index === selectedSlotEntryIndex.value)) {
          selectedSlotEntryIndex.value = list[0].index;
        }
      },
      { immediate: true },
    );

    function resetSlotInspector() {
      slotSeq += 1;
      activeWorldbookSlot.value = "";
      slotSnapshot.value = null;
      slotLoading.value = false;
      slotError.value = "";
      slotEntryQuery.value = "";
      slotEntryFilter.value = "all";
      selectedSlotEntryIndex.value = null;
    }

    // Reset session-scoped worldbook inspector & transient states whenever session/creature/card scope changes
    watch(tavernScopeKey, () => {
      worldbookMutationSeq += 1;
      scriptMutationSeq += 1;
      headerPinsSeq += 1;
      worldbookError.value = "";
      scriptBusy.value = false;
      scriptError.value = "";
      scriptSuccessNotice.value = "";
      scriptFloatingExpanded.value = false;
      invokingScriptButtonKey.value = "";
      headerPinsDirty.value = false;
      headerPinsBusy.value = false;
      headerPinsError.value = "";
      headerPinsSaved.value = false;
      panelMoreExpanded.value = false;
      resetSlotInspector();
    });

    watch(
      () => sessionHeaderSummary.value,
      (summary) => {
        if (!summary) {
          headerPinsDraft.value = [];
          headerPinsDirty.value = false;
          return;
        }
        const optionIds = new Set(summary.options.map((o) => o.id));
        if (!headerPinsDirty.value) {
          headerPinsDraft.value = [...summary.pinned];
        } else {
          headerPinsDraft.value = headerPinsDraft.value.filter((id) => optionIds.has(id));
        }
      },
      { immediate: true, deep: true },
    );

    watch(
      () => state.value.worldbookRef?.id || "",
      (refId) => {
        selectedSessionWorldbookId.value = typeof refId === "string" ? refId : "";
      },
      { immediate: true },
    );

    async function loadCatalogWorldbooks() {
      const seq = ++catalogSeq;
      catalogLoading.value = true;
      try {
        let catalogState = null;
        if (kt?.api?.request) {
          const resp = await kt.api.request({
            method: "POST",
            url: "../../extensions/owner/state",
            data: {
              owner: "package:kohaku-roleplay",
              session_id: "",
              creature_id: "",
            },
          });
          catalogState = resp?.data?.state || null;
        }
        if (seq === catalogSeq && catalogState && typeof catalogState === "object") {
          catalogWorldbooks.value = Array.isArray(catalogState.worldbooks)
            ? catalogState.worldbooks
            : [];
          catalogCardDefaults.value =
            catalogState.cardWorldbookDefaults &&
            typeof catalogState.cardWorldbookDefaults === "object"
              ? catalogState.cardWorldbookDefaults
              : {};
          catalogCardScriptsDefault.value = catalogState.cardScriptsDefault !== false;
        }
      } catch {
        // Non-fatal: library dropdown simply stays empty until refreshed.
      } finally {
        if (seq === catalogSeq) {
          catalogLoading.value = false;
        }
      }
    }

    async function loadCards() {
      if (owner.status.value !== "ready") return;
      cardsLoading.value = true;
      cardsError.value = "";
      try {
        const [result] = await Promise.all([
          owner.call("cards", {}),
          loadCatalogWorldbooks(),
        ]);
        cards.value = Array.isArray(result?.cards)
          ? result.cards
          : Array.isArray(result)
            ? result
            : [];
        if (state.value.cardId && cards.value.some((c) => c.id === state.value.cardId)) {
          selectedCardId.value = state.value.cardId;
        } else if (
          !selectedCardId.value ||
          !cards.value.some((c) => c.id === selectedCardId.value)
        ) {
          selectedCardId.value = cards.value[0]?.id || "";
        }
      } catch (err) {
        cardsError.value = err?.message || String(err);
      } finally {
        cardsLoading.value = false;
      }
    }

    let detailSeq = 0;
    async function loadCardDetail(cardId) {
      const seq = ++detailSeq;
      detailError.value = "";
      if (!cardId || owner.status.value !== "ready") {
        selectedDetail.value = null;
        return;
      }
      detailLoading.value = true;
      try {
        const detail = await owner.call("detail", { id: cardId });
        if (seq === detailSeq) {
          selectedDetail.value = detail || null;
        }
      } catch (err) {
        if (seq === detailSeq) {
          selectedDetail.value = null;
          detailError.value = err?.message || String(err);
        }
      } finally {
        if (seq === detailSeq) {
          detailLoading.value = false;
        }
      }
    }

    watch(
      () => [owner.status.value, mode.value],
      ([status, currentMode]) => {
        if (status === "ready" && (currentMode === "persona" || currentMode === "tavern")) {
          loadCards();
        } else if (currentMode === "novel" || currentMode === "npc") {
          cards.value = [];
          selectedCardId.value = "";
          selectedDetail.value = null;
          cardsError.value = "";
          detailError.value = "";
        }
      },
      { immediate: true },
    );

    watch(
      () => [selectedCardId.value, owner.status.value, mode.value],
      ([cardId, status, currentMode]) => {
        if (
          status === "ready" &&
          cardId &&
          (currentMode === "persona" || currentMode === "tavern")
        ) {
          tavernForm.value.greetingIndex = 0;
          tavernForm.value.worldbookMode = "__default__";
          tavernForm.value.scriptsMode = "__default__";
          loadCardDetail(cardId);
        } else {
          selectedDetail.value = null;
        }
      },
      { immediate: true },
    );

    watch(
      () => state.value,
      (next) => {
        if (next?.mode === "novel") {
          resumeError.value = "";
          return;
        }
        if (next?.mode === "npc") {
          return;
        }
        if (next.cardId && !selectedCardId.value) {
          selectedCardId.value = next.cardId;
        }
        if (next.mode === "persona" && next.active && next.persona && !personaDirty.value) {
          personaForm.value = {
            name: String(next.persona.name || ""),
            appearance: String(next.persona.appearance || ""),
            personality: String(next.persona.personality || ""),
            voice: String(next.persona.voice || ""),
          };
        }
        if (next.mode === "tavern" && next.active && !notesDirty.value) {
          notesDraft.value = String(next.notes || "");
        }
      },
      { immediate: true, deep: true },
    );

    function fillSafeDraft() {
      if (!selectedDetail.value) return;
      personaForm.value = extractSafePersonaDraft(selectedDetail.value);
      personaDirty.value = true;
      actionError.value = "";
    }

    async function applyPersona() {
      if (busy.value) return;
      actionError.value = "";
      const confirmedName = personaForm.value.name.trim();
      if (!confirmedName) {
        actionError.value = t("personaNameRequired");
        return;
      }
      if (!selectedCardId.value) return;

      busy.value = true;
      try {
        await owner.call("apply_persona", {
          cardId: selectedCardId.value,
          persona: {
            name: confirmedName,
            appearance: personaForm.value.appearance.trim(),
            personality: personaForm.value.personality.trim(),
            voice: personaForm.value.voice.trim(),
          },
        });
        personaDirty.value = false;
        notify(t("personaApplied"), "success");
      } catch (err) {
        actionError.value = err?.message || String(err);
      } finally {
        busy.value = false;
      }
    }

    async function removePersona() {
      if (busy.value) return;
      const accepted = await confirm(t("removePersonaConfirm"), t("removePersona"));
      if (!accepted) return;

      busy.value = true;
      actionError.value = "";
      try {
        await owner.call("remove_persona", {});
        personaDirty.value = false;
        personaForm.value = { name: "", appearance: "", personality: "", voice: "" };
        notify(t("personaRemoved"), "info");
      } catch (err) {
        actionError.value = err?.message || String(err);
      } finally {
        busy.value = false;
      }
    }

    async function startTavern() {
      if (busy.value || !selectedCardId.value) return;
      busy.value = true;
      actionError.value = "";
      try {
        const payload = {
          cardId: selectedCardId.value,
          player: {
            name: tavernForm.value.playerName.trim() || "Player",
            description: tavernForm.value.playerDescription.trim(),
          },
          greetingIndex: Number(tavernForm.value.greetingIndex) || 0,
        };
        if (tavernForm.value.worldbookMode === "__none__") {
          payload.worldbookId = null;
        } else if (
          tavernForm.value.worldbookMode &&
          tavernForm.value.worldbookMode !== "__default__"
        ) {
          payload.worldbookId = tavernForm.value.worldbookMode;
        }
        if (tavernForm.value.scriptsMode === "on") {
          payload.enableCardScripts = true;
        } else if (tavernForm.value.scriptsMode === "off") {
          payload.enableCardScripts = false;
        }
        await owner.call("start_tavern", payload);
        notesDirty.value = false;
        notify(t("tavernStarted"), "success");
      } catch (err) {
        actionError.value = err?.message || String(err);
      } finally {
        busy.value = false;
      }
    }

    async function saveNotes() {
      if (busy.value) return;
      busy.value = true;
      actionError.value = "";
      try {
        await owner.call("set_notes", { notes: notesDraft.value });
        notesDirty.value = false;
        notify(t("notesSaved"), "success");
      } catch (err) {
        actionError.value = err?.message || String(err);
      } finally {
        busy.value = false;
      }
    }

    async function applySessionLibraryWorldbook() {
      if (busy.value) return;
      const scopeSnap = tavernScopeKey.value;
      const mutSeq = ++worldbookMutationSeq;
      const bookId = selectedSessionWorldbookId.value
        ? selectedSessionWorldbookId.value
        : null;
      busy.value = true;
      worldbookError.value = "";
      actionError.value = "";
      try {
        const nextView = await owner.call("bind_library_worldbook", { bookId });
        if (mutSeq !== worldbookMutationSeq || tavernScopeKey.value !== scopeSnap) return;
        if (nextView && typeof nextView === "object") {
          owner.state.value = nextView;
        }
        if (activeWorldbookSlot.value === "attached") {
          if (bookId) {
            await loadWorldbookSlot("attached", true);
          } else {
            resetSlotInspector();
          }
        }
        notify(
          bookId ? t("worldbookBoundToast") : t("worldbookClearedToast"),
          bookId ? "success" : "info",
        );
      } catch (err) {
        if (mutSeq === worldbookMutationSeq && tavernScopeKey.value === scopeSnap) {
          worldbookError.value = err?.message || String(err);
        }
      } finally {
        if (mutSeq === worldbookMutationSeq) {
          busy.value = false;
        }
      }
    }

    function triggerWorldbookUpload() {
      if (busy.value) return;
      worldbookError.value = "";
      worldbookInput.value?.click();
    }

    async function handleWorldbookFileChange(event) {
      const file = event.target?.files?.[0];
      if (event.target) event.target.value = "";
      if (!file || busy.value) return;

      worldbookError.value = "";
      actionError.value = "";
      if (file.size <= 0 || file.size > 12 * 1024 * 1024) {
        worldbookError.value = t("worldbookInvalidJson");
        return;
      }
      const scopeSnap = tavernScopeKey.value;
      const mutSeq = ++worldbookMutationSeq;
      busy.value = true;
      try {
        const rawText = await file.text();
        const parsed = JSON.parse(rawText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(t("worldbookInvalidJson"));
        }
        const nextView = await owner.call("set_worldbook", { book: parsed });
        if (mutSeq !== worldbookMutationSeq || tavernScopeKey.value !== scopeSnap) return;
        if (nextView && typeof nextView === "object") {
          owner.state.value = nextView;
        }
        if (activeWorldbookSlot.value === "attached") {
          await loadWorldbookSlot("attached", true);
        }
        notify(t("worldbookBoundToast"), "success");
      } catch (err) {
        if (mutSeq === worldbookMutationSeq && tavernScopeKey.value === scopeSnap) {
          worldbookError.value = err?.message || String(err);
        }
      } finally {
        if (mutSeq === worldbookMutationSeq) {
          busy.value = false;
        }
      }
    }

    async function clearSessionWorldbook() {
      if (busy.value) return;
      const scopeSnap = tavernScopeKey.value;
      const mutSeq = ++worldbookMutationSeq;
      busy.value = true;
      worldbookError.value = "";
      actionError.value = "";
      try {
        const nextView = await owner.call("bind_library_worldbook", { bookId: null });
        if (mutSeq !== worldbookMutationSeq || tavernScopeKey.value !== scopeSnap) return;
        if (nextView && typeof nextView === "object") {
          owner.state.value = nextView;
        }
        selectedSessionWorldbookId.value = "";
        if (activeWorldbookSlot.value === "attached") {
          resetSlotInspector();
        }
        notify(t("worldbookClearedToast"), "info");
      } catch (err) {
        if (mutSeq === worldbookMutationSeq && tavernScopeKey.value === scopeSnap) {
          worldbookError.value = err?.message || String(err);
        }
      } finally {
        if (mutSeq === worldbookMutationSeq) {
          busy.value = false;
        }
      }
    }

    async function loadWorldbookSlot(slot, forceReload = false) {
      if (slot !== "attached" && slot !== "embedded") return;
      if (!forceReload && activeWorldbookSlot.value === slot) {
        resetSlotInspector();
        return;
      }
      const scopeSnap = tavernScopeKey.value;
      const seq = ++slotSeq;
      activeWorldbookSlot.value = slot;
      slotSnapshot.value = null;
      slotError.value = "";
      slotEntryQuery.value = "";
      slotEntryFilter.value = "all";
      selectedSlotEntryIndex.value = null;
      slotLoading.value = true;
      try {
        const result = await owner.call("worldbook_slot_detail", { slot });
        if (seq !== slotSeq || tavernScopeKey.value !== scopeSnap) return;
        slotSnapshot.value = result
          ? {
              slot,
              name:
                result.name ||
                (slot === "embedded"
                  ? state.value.name || ""
                  : attachedWorldbookRef.value?.name || ""),
              diagnostics: normalizeWorldbookDiagnostics(result.diagnostics),
              entries: normalizeWorldbookEntries(result.entries),
            }
          : null;
      } catch (err) {
        if (seq === slotSeq && tavernScopeKey.value === scopeSnap) {
          slotError.value = err?.message || String(err);
        }
      } finally {
        if (seq === slotSeq && tavernScopeKey.value === scopeSnap) {
          slotLoading.value = false;
        }
      }
    }

    function selectSlotEntry(index) {
      selectedSlotEntryIndex.value = index;
    }

    async function setSessionCardScripts(enabled) {
      if (busy.value || scriptBusy.value) return;
      const scopeSnap = tavernScopeKey.value;
      const seq = ++scriptMutationSeq;
      scriptBusy.value = true;
      scriptError.value = "";
      scriptSuccessNotice.value = "";
      actionError.value = "";
      try {
        const nextView = await owner.call("set_card_scripts", { enabled: Boolean(enabled) });
        if (seq !== scriptMutationSeq || tavernScopeKey.value !== scopeSnap) return;
        if (nextView && typeof nextView === "object") {
          owner.state.value = nextView;
        }
        notify(
          enabled ? t("cardScriptsEnabledToast") : t("cardScriptsDisabledToast"),
          enabled ? "success" : "info",
        );
      } catch (err) {
        if (seq === scriptMutationSeq && tavernScopeKey.value === scopeSnap) {
          scriptError.value = err?.message || String(err);
        }
      } finally {
        if (seq === scriptMutationSeq) {
          scriptBusy.value = false;
        }
      }
    }

    async function invokeCardScriptButton(scriptId, buttonName) {
      if (busy.value || scriptBusy.value || !scriptId || !buttonName) return;
      const scopeSnap = tavernScopeKey.value;
      const seq = ++scriptMutationSeq;
      const btnKey = `${scriptId}\u0000${buttonName}`;
      scriptBusy.value = true;
      invokingScriptButtonKey.value = btnKey;
      scriptError.value = "";
      scriptSuccessNotice.value = "";
      actionError.value = "";
      try {
        const nextView = await owner.call("invoke_script_button", {
          scriptId,
          button: buttonName,
        });
        if (seq !== scriptMutationSeq || tavernScopeKey.value !== scopeSnap) return;
        if (nextView && typeof nextView === "object") {
          owner.state.value = nextView;
        }
        scriptSuccessNotice.value = t("cardScriptsButtonInvokedToast", { button: buttonName });
      } catch (err) {
        if (seq === scriptMutationSeq && tavernScopeKey.value === scopeSnap) {
          scriptError.value = err?.message || String(err);
          scriptSuccessNotice.value = "";
        }
      } finally {
        if (seq === scriptMutationSeq) {
          scriptBusy.value = false;
          invokingScriptButtonKey.value = "";
        }
      }
    }

    function headerPinTestId(id) {
      return `kt-rp-header-pin-option-${encodeURIComponent(id)}`;
    }

    function toggleHeaderPinOption(id) {
      const summary = sessionHeaderSummary.value;
      if (!summary || busy.value || headerPinsBusy.value || !id) return;
      if (!summary.options.some((o) => o.id === id)) return;
      const list = [...headerPinsDraft.value];
      const idx = list.indexOf(id);
      if (idx >= 0) {
        list.splice(idx, 1);
        headerPinsDraft.value = list;
        headerPinsDirty.value = true;
        headerPinsError.value = "";
        headerPinsSaved.value = false;
      } else if (list.length < summary.maxPins) {
        list.push(id);
        headerPinsDraft.value = list;
        headerPinsDirty.value = true;
        headerPinsError.value = "";
        headerPinsSaved.value = false;
      }
    }

    async function saveHeaderSummaryPins() {
      const summary = sessionHeaderSummary.value;
      if (!summary || busy.value || headerPinsBusy.value) return;
      const scopeSnap = tavernScopeKey.value;
      const seq = ++headerPinsSeq;
      const optionIds = new Set(summary.options.map((o) => o.id));
      const ids = headerPinsDraft.value
        .filter((id) => optionIds.has(id))
        .slice(0, summary.maxPins);
      headerPinsBusy.value = true;
      headerPinsError.value = "";
      headerPinsSaved.value = false;
      actionError.value = "";
      try {
        const nextView = await owner.call("set_header_pins", { ids });
        if (seq !== headerPinsSeq || tavernScopeKey.value !== scopeSnap) return;
        headerPinsDirty.value = false;
        if (nextView && typeof nextView === "object") {
          owner.state.value = nextView;
        }
        headerPinsSaved.value = true;
      } catch (err) {
        if (seq === headerPinsSeq && tavernScopeKey.value === scopeSnap) {
          headerPinsError.value = err?.message || String(err);
          headerPinsSaved.value = false;
        }
      } finally {
        if (seq === headerPinsSeq) {
          headerPinsBusy.value = false;
        }
      }
    }

    async function resumePendingScene() {
      const pending = novelView.value.pendingScene;
      if (!pending || busy.value || resumingScene.value) return;
      resumingScene.value = true;
      resumeError.value = "";
      try {
        await owner.call("resume_scene", { scene: pending.number });
        await owner.refresh();
        notify(t("novelResumeSentToast", { number: pending.number }), "info");
      } catch (err) {
        resumeError.value = err?.message || String(err);
      } finally {
        resumingScene.value = false;
      }
    }

    function openLibraryTab() {
      try {
        openTab("kohaku-roleplay/studio");
      } catch {
        openLibrarySettings();
      }
    }

    function openWorldbooksTab() {
      try {
        openTab("kohaku-roleplay/worldbooks");
      } catch {
        openLibraryTab();
      }
    }

    function openLibrarySettings() {
      try {
        openTab({ kind: "settings", id: "settings", section: "ext:kohaku-roleplay/library" });
      } catch {
        // Fallback no-op when host doesn't expose settings navigation.
      }
    }

    return {
      owner,
      t,
      state,
      mode,
      active,
      cards,
      cardsLoading,
      cardsError,
      selectedCardId,
      selectedCardSummary,
      activeCardSummary,
      selectedCardDefaultWorldbook,
      selectedDetail,
      detailLoading,
      detailError,
      catalogWorldbooks,
      catalogCardScriptsDefault,
      catalogLoading,
      greetings,
      personaForm,
      personaDirty,
      tavernForm,
      notesDraft,
      notesDirty,
      worldbookInput,
      worldbookError,
      selectedSessionWorldbookId,
      attachedWorldbookRef,
      hasAttachedWorldbook,
      hasEmbeddedWorldbook,
      sessionWorldbookSourceLabel,
      activeWorldbookSlot,
      slotSnapshot,
      slotLoading,
      slotError,
      slotEntries,
      slotDiagnostics,
      slotSupportedCount,
      slotIssuesCount,
      slotEntryQuery,
      slotEntryFilter,
      filteredSlotEntries,
      selectedSlotEntry,
      selectedSlotEntryIndex,
      tavernStateFields,
      tavernScopeKey,
      mvuPublicSignature,
      saveMvuSelection,
      chooseNativeOption,
      sessionWorldbookDiag,
      cardLoreDiag,
      worldbookIssueLabel,
      sessionCardScripts,
      runnableScriptButtonGroups,
      runnableScriptButtonTotal,
      cardScriptIssueLabel,
      scriptBusy,
      scriptError,
      scriptSuccessNotice,
      scriptFloatingExpanded,
      invokingScriptButtonKey,
      setSessionCardScripts,
      invokeCardScriptButton,
      sessionHeaderSummary,
      headerPinsDraft,
      headerPinsDirty,
      headerPinsBusy,
      headerPinsError,
      headerPinsSaved,
      panelMoreExpanded,
      headerPinTestId,
      toggleHeaderPinOption,
      saveHeaderSummaryPins,
      resumingScene,
      resumeError,
      novelView,
      busy,
      actionError,
      loadCards,
      loadCatalogWorldbooks,
      fillSafeDraft,
      applyPersona,
      removePersona,
      startTavern,
      saveNotes,
      applySessionLibraryWorldbook,
      triggerWorldbookUpload,
      handleWorldbookFileChange,
      clearSessionWorldbook,
      loadWorldbookSlot,
      resetSlotInspector,
      selectSlotEntry,
      resumePendingScene,
      openLibraryTab,
      openWorldbooksTab,
      openLibrarySettings,
    };
  },
  template: `
    <div class="ktrp-panel" :aria-busy="busy" data-testid="kt-rp-panel">
      <header class="ktrp-panel-head">
        <div class="ktrp-panel-actions">
          <ActionButton
            size="sm"
            variant="ghost"
            icon="i-carbon-notebook"
            data-testid="kt-rp-open-worldbooks-btn"
            @click="openWorldbooksTab"
          >
            {{ t('openWorldbookLibraryBtn') }}
          </ActionButton>
          <ActionButton
            size="sm"
            variant="ghost"
            icon="i-carbon-book"
            data-testid="kt-rp-open-library-btn"
            @click="openLibraryTab"
          >
            {{ t('openLibrary') }}
          </ActionButton>
        </div>
      </header>

      <div
        v-if="owner.status.value === 'error' || owner.status.value === 'absent'"
        class="ktrp-banner ktrp-banner--error"
        role="alert"
        data-testid="kt-rp-panel-error"
      >
        <span>{{ t('loadFailed') }} <small v-if="owner.error.value">{{ owner.error.value }}</small></span>
        <ActionButton size="sm" @click="owner.refresh()">{{ t('retry') }}</ActionButton>
      </div>

      <p v-else-if="owner.status.value !== 'ready'" class="ktrp-muted" role="status" data-testid="kt-rp-panel-loading">
        {{ t('loading') }}
      </p>

      <template v-else>
        <div
          v-if="actionError"
          class="ktrp-banner ktrp-banner--error"
          role="alert"
          data-testid="kt-rp-panel-action-error"
        >
          <span>{{ actionError }}</span>
          <ActionButton size="sm" @click="actionError = ''">{{ t('retry') }}</ActionButton>
        </div>

        <!-- NPC MODE: Perspective-isolated actor node; no card library or persona controls -->
        <section v-if="mode === 'npc'" class="ktrp-stack" data-testid="kt-rp-npc-view">
          <div class="ktrp-banner ktrp-banner--info">
            <div>
              <strong>{{ t('npcModeTitle') }}</strong>
              <p class="ktrp-muted">{{ t('npcModeNotice') }}</p>
            </div>
          </div>
        </section>

        <!-- NOVEL MODE: Strict reader/player projection only -->
        <section v-else-if="mode === 'novel'" class="ktrp-stack" data-testid="kt-rp-novel-view">
          <div class="ktrp-banner ktrp-banner--info">
            <div>
              <strong>{{ t('novelProjectionTitle') }}</strong>
              <p class="ktrp-muted">{{ t('novelProjectionNotice') }}</p>
            </div>
          </div>

          <div v-if="!novelView.active" class="ktrp-empty" data-testid="kt-rp-novel-inactive">
            {{ novelView.blockedReason || t('novelPendingIntegration') }}
          </div>
          <template v-else>
            <div class="ktrp-stat-row">
              <span class="ktrp-chip">{{ t('novelSceneCompleted', { count: novelView.sceneNumber }) }}</span>
              <span v-if="novelView.pendingScene" class="ktrp-chip ktrp-chip--accent">
                {{ t('novelScenePending', { number: novelView.pendingScene.number }) }}
              </span>
            </div>

            <div v-if="novelView.pendingScene" class="ktrp-card-box" data-testid="kt-rp-novel-pending">
              <div class="ktrp-row-between">
                <p class="ktrp-muted">
                  {{ t('novelScenePending', { number: novelView.pendingScene.number }) }}
                </p>
                <ActionButton
                  size="sm"
                  :disabled="busy || resumingScene"
                  data-testid="kt-rp-novel-resume-btn"
                  @click="resumePendingScene"
                >
                  {{ resumingScene ? t('novelResumingBtn') : t('novelResumeBtn') }}
                </ActionButton>
              </div>
              <p class="ktrp-muted">{{ t('novelResumeHint') }}</p>
              <div
                v-if="resumeError"
                class="ktrp-banner ktrp-banner--error"
                role="alert"
                data-testid="kt-rp-novel-resume-error"
              >
                <span>{{ resumeError }}</span>
              </div>
            </div>

            <div class="ktrp-field-block">
              <h4>{{ t('novelCastTitle') }}</h4>
              <div v-if="!novelView.cast.length" class="ktrp-empty">{{ t('novelNoCast') }}</div>
              <div v-else class="ktrp-cast-list">
                <div
                  v-for="actor in novelView.cast"
                  :key="actor.name"
                  class="ktrp-cast-item"
                  :data-testid="'kt-rp-novel-cast-' + actor.name"
                >
                  <PortraitFrame
                    :card-id="actor.cardId"
                    :name="actor.name"
                    :has-portrait="actor.hasPortrait"
                    :variant="actor.portraitKey"
                    arg-key="id"
                    size="sm"
                  />
                  <div class="ktrp-cast-meta">
                    <div class="ktrp-cast-head">
                      <strong>{{ actor.name }}</strong>
                      <span v-if="actor.role" class="ktrp-chip">{{ actor.role }}</span>
                    </div>
                    <StateFieldsView
                      v-if="actor.stateFields.length"
                      :fields="actor.stateFields"
                      compact
                      :test-id="'kt-rp-novel-cast-state-' + actor.name"
                    />
                    <div v-if="Object.keys(actor.visibleStatus).length" class="ktrp-chip-row">
                      <span v-for="(val, key) in actor.visibleStatus" :key="key" class="ktrp-chip">
                        {{ key }}: {{ val }}
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div v-if="novelView.latestProse" class="ktrp-field-block" data-testid="kt-rp-novel-latest-prose">
              <h4>{{ t('novelLatestChapterTitle') }}</h4>
              <p class="ktrp-quote-box ktrp-pre">{{ novelView.latestProse }}</p>
            </div>
          </template>
        </section>

        <!-- TAVERN MODE (active) -->
        <section v-else-if="mode === 'tavern' && active" class="ktrp-stack" data-testid="kt-rp-tavern-active">
          <div class="ktrp-active-card">
            <PortraitFrame
              :card-id="state.cardId || ''"
              :name="state.name || ''"
              :has-portrait="Boolean(state.hasPortrait ?? activeCardSummary?.hasPortrait ?? true)"
              :variant="state.portraitKey || ''"
              arg-key="id"
              size="md"
            />
            <div class="ktrp-active-meta">
              <h4>{{ state.name }}</h4>
            </div>
          </div>

          <RoleplayHeaderSummary />

          <div
            v-if="runnableScriptButtonGroups.length"
            class="ktrp-card-box ktrp-script-floating-bar"
            role="region"
            :aria-label="t('cardScriptsFloatingBarTitle')"
            data-testid="kt-rp-script-floating-bar"
          >
            <div class="ktrp-row-between">
              <div class="ktrp-inline-actions">
                <strong class="ktrp-box-head" data-testid="kt-rp-script-floating-title">
                  {{ t('cardScriptsFloatingBarTitle') }}
                </strong>
                <span
                  class="ktrp-chip ktrp-chip--accent"
                  data-testid="kt-rp-script-floating-count"
                >
                  {{ t('cardScriptsFloatingBarCount', { count: runnableScriptButtonTotal }) }}
                </span>
              </div>
              <ActionButton
                size="sm"
                :aria-expanded="String(scriptFloatingExpanded)"
                data-testid="kt-rp-script-floating-toggle-btn"
                @click="scriptFloatingExpanded = !scriptFloatingExpanded"
              >
                {{
                  scriptFloatingExpanded
                    ? t('cardScriptsFloatingCollapseBtn')
                    : t('cardScriptsFloatingExpandBtn')
                }}
              </ActionButton>
            </div>

            <div
              v-if="scriptError"
              class="ktrp-banner ktrp-banner--error"
              role="alert"
              data-testid="kt-rp-script-floating-error"
            >
              <span>{{ scriptError }}</span>
            </div>

            <p
              v-if="scriptSuccessNotice"
              class="ktrp-muted"
              role="status"
              data-testid="kt-rp-script-floating-status"
            >
              {{ scriptSuccessNotice }}
            </p>

            <div
              v-if="scriptFloatingExpanded"
              class="ktrp-stack ktrp-script-floating-body"
              data-testid="kt-rp-script-floating-body"
            >
              <div
                v-for="group in runnableScriptButtonGroups"
                :key="group.id"
                class="ktrp-script-floating-group"
                :data-testid="'kt-rp-card-script-buttons-' + group.id"
              >
                <span class="ktrp-label" :data-testid="'kt-rp-script-floating-group-name-' + group.id">
                  {{ group.name }}
                </span>
                <div class="ktrp-inline-actions">
                  <ActionButton
                    v-for="(btnName, btnIdx) in group.buttons"
                    :key="btnName"
                    size="sm"
                    :disabled="busy || scriptBusy"
                    :data-testid="'kt-rp-card-script-btn-' + group.id + '-' + btnIdx"
                    :data-script-id="group.id"
                    :data-button-name="btnName"
                    @click="invokeCardScriptButton(group.id, btnName)"
                  >
                    {{ btnName }}
                  </ActionButton>
                </div>
              </div>
            </div>
          </div>

          <CardWebPanel
            v-if="state.webPanel || state.webPanelIssue"
            :key="'web:' + tavernScopeKey + ':' + mvuPublicSignature"
            :owner="owner"
            :scope-key="tavernScopeKey"
            :mvu-public-signature="mvuPublicSignature"
            :web-panel-meta="state.webPanel || null"
            :web-panel-issue="state.webPanelIssue || ''"
            :player-name="state.player?.name || 'Player'"
            :character-name="state.name || ''"
          />

          <div
            v-if="state.openingGameplayIssue"
            class="ktrp-banner ktrp-banner--info"
            role="status"
            data-testid="kt-rp-opening-gameplay-issue"
          >
            <span>{{ state.openingGameplayIssue }}</span>
          </div>

          <div
            v-if="tavernStateFields.length"
            class="ktrp-card-box"
            data-testid="kt-rp-tavern-state-card"
          >
            <div class="ktrp-box-head">{{ t('cardStateTitle') }}</div>
            <StateFieldsView :fields="tavernStateFields" test-id="kt-rp-tavern-state-fields" />
          </div>

          <NativePanels
            v-if="state.nativePanels || state.invalidNativePanels"
            :key="'native:' + tavernScopeKey"
            :panels="state.nativePanels || []"
            :invalid-count="state.invalidNativePanels || 0"
            :choose-option="chooseNativeOption"
            :disabled="busy"
          />

          <MvuPanel
            v-if="state.mvu"
            :key="tavernScopeKey"
            :mvu="state.mvu"
            :save-selection="saveMvuSelection"
            :disabled="busy"
          />

          <div class="ktrp-card-box" data-testid="kt-rp-panel-more-box">
            <div class="ktrp-row-between">
              <strong class="ktrp-box-head" data-testid="kt-rp-panel-more-title">
                {{ t('panelMoreSectionTitle') }}
              </strong>
              <ActionButton
                size="sm"
                variant="ghost"
                :aria-expanded="String(panelMoreExpanded)"
                data-testid="kt-rp-panel-more-toggle-btn"
                @click="panelMoreExpanded = !panelMoreExpanded"
              >
                {{ panelMoreExpanded ? t('panelMoreCollapseBtn') : t('panelMoreExpandBtn') }}
              </ActionButton>
            </div>
          </div>

          <div
            v-show="panelMoreExpanded"
            class="ktrp-stack"
            data-testid="kt-rp-panel-more-body"
          >
          <div
            v-if="sessionCardScripts"
            class="ktrp-card-box"
            data-testid="kt-rp-tavern-scripts"
          >
            <div class="ktrp-row-between">
              <div class="ktrp-box-head">{{ t('cardScriptsSessionTitle') }}</div>
              <div class="ktrp-inline-actions">
                <span
                  class="ktrp-chip"
                  :class="{ 'ktrp-chip--accent': sessionCardScripts.enabled }"
                  data-testid="kt-rp-card-scripts-status"
                >
                  {{
                    sessionCardScripts.enabled
                      ? t('cardScriptsStatusActive')
                      : t('cardScriptsStatusInactive')
                  }}
                </span>
                <ActionButton
                  size="sm"
                  :variant="sessionCardScripts.enabled ? 'danger' : 'primary'"
                  :disabled="busy || scriptBusy || (!sessionCardScripts.enabled && !sessionCardScripts.canEnable)"
                  data-testid="kt-rp-card-scripts-toggle-btn"
                  @click="setSessionCardScripts(!sessionCardScripts.enabled)"
                >
                  {{
                    sessionCardScripts.enabled
                      ? t('cardScriptsDisableBtn')
                      : t('cardScriptsEnableBtn')
                  }}
                </ActionButton>
              </div>
            </div>

            <div
              v-if="scriptError"
              class="ktrp-banner ktrp-banner--error"
              role="alert"
              data-testid="kt-rp-card-scripts-error"
            >
              <span>{{ scriptError }}</span>
            </div>

            <div
              v-if="sessionCardScripts.runtimeIssues.length"
              class="ktrp-stack"
              data-testid="kt-rp-card-scripts-runtime-issues"
            >
              <span class="ktrp-label">{{ t('cardScriptsRuntimeIssuesTitle') }}</span>
              <div
                v-for="rtIssue in sessionCardScripts.runtimeIssues"
                :key="rtIssue.key"
                class="ktrp-banner ktrp-banner--error"
                :data-testid="'kt-rp-card-script-runtime-issue-' + rtIssue.key"
              >
                <span><strong>{{ rtIssue.label }}:</strong> {{ rtIssue.message }}</span>
              </div>
            </div>

            <div class="ktrp-stack" data-testid="kt-rp-card-scripts-list">
              <div
                v-for="script in sessionCardScripts.entries"
                :key="script.id"
                class="ktrp-sub-card"
                :data-testid="'kt-rp-card-script-entry-' + script.id"
              >
                <div class="ktrp-row-between">
                  <strong :data-testid="'kt-rp-card-script-name-' + script.id">
                    {{ script.name }}
                  </strong>
                  <div class="ktrp-chip-row">
                    <span class="ktrp-chip">
                      {{
                        script.enabled
                          ? t('cardScriptsEntryEnabledBadge')
                          : t('cardScriptsEntryDisabledBadge')
                      }}
                    </span>
                    <span
                      v-if="script.issue"
                      class="ktrp-chip"
                      :data-testid="'kt-rp-card-script-issue-' + script.id"
                    >
                      {{ cardScriptIssueLabel(script.issue) }}
                    </span>
                    <span
                      v-else-if="script.enabled"
                      class="ktrp-chip ktrp-chip--accent"
                      :data-testid="'kt-rp-card-script-compatible-' + script.id"
                    >
                      {{ t('cardScriptsEntryCompatibleBadge') }}
                    </span>
                  </div>
                </div>

                <p
                  v-if="sessionCardScripts.inactiveEvents[script.id]"
                  class="ktrp-muted"
                  :data-testid="'kt-rp-card-script-inactive-events-' + script.id"
                >
                  {{
                    t('cardScriptsInactiveEventsLabel', {
                      events: sessionCardScripts.inactiveEvents[script.id].join(', '),
                    })
                  }}
                </p>

                <p
                  v-if="sessionCardScripts.enabled && script.enabled && !script.issue && script.buttons.length"
                  class="ktrp-muted"
                  :data-testid="'kt-rp-card-script-buttons-summary-' + script.id"
                >
                  {{
                    t('cardScriptsEntryButtonsSummary', {
                      count: script.buttons.length,
                      buttons: script.buttons.join(', '),
                    })
                  }}
                </p>
              </div>
            </div>
          </div>

          <CardMediaGallery
            :card-id="state.cardId || ''"
            :media="state.media || []"
            :media-issues="state.mediaIssues || null"
            :scene-media-key="state.sceneMediaKey"
            compact
            test-id-prefix="kt-rp-tavern-media"
          />

          <div
            v-if="sessionHeaderSummary"
            class="ktrp-card-box"
            data-testid="kt-rp-header-pins-section"
          >
            <div class="ktrp-row-between">
              <div class="ktrp-box-head">{{ t('headerSummaryTitle') }}</div>
              <span
                class="ktrp-chip"
                :class="{ 'ktrp-chip--accent': headerPinsDraft.length > 0 }"
                data-testid="kt-rp-header-pins-count"
              >
                {{
                  t('headerSummaryCount', {
                    count: headerPinsDraft.length,
                    max: sessionHeaderSummary.maxPins,
                  })
                }}
              </span>
            </div>
            <p class="ktrp-muted">
              {{ t('headerSummaryHint', { max: sessionHeaderSummary.maxPins }) }}
            </p>

            <div
              v-if="headerPinsError"
              class="ktrp-banner ktrp-banner--error"
              role="alert"
              data-testid="kt-rp-header-pins-error"
            >
              <span>{{ headerPinsError }}</span>
            </div>

            <p
              v-if="headerPinsSaved"
              class="ktrp-muted"
              role="status"
              data-testid="kt-rp-header-pins-status"
            >
              {{ t('headerSummarySavedToast') }}
            </p>

            <template v-if="sessionHeaderSummary.options.length">
              <div class="ktrp-mvu-option-list" data-testid="kt-rp-header-pins-options">
                <label
                  v-for="opt in sessionHeaderSummary.options"
                  :key="opt.id"
                  class="ktrp-mvu-option"
                >
                  <input
                    type="checkbox"
                    :checked="headerPinsDraft.includes(opt.id)"
                    :disabled="
                      busy ||
                      headerPinsBusy ||
                      (!headerPinsDraft.includes(opt.id) &&
                        headerPinsDraft.length >= sessionHeaderSummary.maxPins)
                    "
                    :data-testid="headerPinTestId(opt.id)"
                    :data-pin-id="opt.id"
                    @change="toggleHeaderPinOption(opt.id)"
                  />
                  <span>{{ opt.label }}</span>
                </label>
              </div>
              <div class="ktrp-row-end">
                <ActionButton
                  size="sm"
                  variant="primary"
                  :disabled="busy || headerPinsBusy"
                  data-testid="kt-rp-header-pins-save-btn"
                  @click="saveHeaderSummaryPins"
                >
                  {{ headerPinsBusy ? t('headerSummarySavingBtn') : t('headerSummarySaveBtn') }}
                </ActionButton>
              </div>
            </template>
            <p
              v-else
              class="ktrp-muted"
              data-testid="kt-rp-header-pins-empty"
            >
              {{ t('headerSummaryNoOptions') }}
            </p>
          </div>

          <div class="ktrp-card-box" data-testid="kt-rp-tavern-worldbook">
            <div class="ktrp-row-between">
              <div class="ktrp-box-head">{{ t('tavernSessionWorldbookTitle') }}</div>
              <span
                v-if="state.worldbookEntries != null"
                class="ktrp-chip ktrp-chip--accent"
                data-testid="kt-rp-worldbook-count"
              >
                {{ t('worldbookEntriesCount', { count: state.worldbookEntries }) }}
              </span>
            </div>
            <p class="ktrp-muted">{{ t('worldbookSessionHint') }}</p>

            <div class="ktrp-chip-row">
              <span class="ktrp-chip" data-testid="kt-rp-session-worldbook-source">
                {{ sessionWorldbookSourceLabel }}
              </span>
            </div>

            <div v-if="worldbookError" class="ktrp-banner ktrp-banner--error" role="alert" data-testid="kt-rp-worldbook-error">
              <span>{{ worldbookError }}</span>
            </div>

            <!-- Library worldbook selector + apply button -->
            <div class="ktrp-row-between" data-testid="kt-rp-session-worldbook-library-picker">
              <select
                v-model="selectedSessionWorldbookId"
                class="ktrp-select"
                :disabled="busy || catalogLoading"
                data-testid="kt-rp-session-worldbook-select"
              >
                <option value="">{{ t('sessionWorldbookExplicitNone') }}</option>
                <option
                  v-for="wb in catalogWorldbooks"
                  :key="wb.id"
                  :value="wb.id"
                >
                  {{ wb.name }} ({{ wb.supportedEntries }}/{{ wb.totalEntries }})
                </option>
              </select>
              <ActionButton
                size="sm"
                variant="primary"
                :disabled="busy"
                data-testid="kt-rp-session-worldbook-apply-btn"
                @click="applySessionLibraryWorldbook"
              >
                {{ t('sessionWorldbookApplyLibraryBtn') }}
              </ActionButton>
            </div>

            <!-- Direct local JSON upload & clear controls -->
            <div class="ktrp-row-end">
              <ActionButton
                size="sm"
                :disabled="busy"
                data-testid="kt-rp-worldbook-bind-btn"
                @click="triggerWorldbookUpload"
              >
                {{ state.worldbookEntries != null ? t('worldbookReplaceBtn') : t('worldbookBindBtn') }}
              </ActionButton>
              <ActionButton
                v-if="state.worldbookEntries != null"
                size="sm"
                variant="danger"
                :disabled="busy"
                data-testid="kt-rp-worldbook-clear-btn"
                @click="clearSessionWorldbook"
              >
                {{ t('worldbookClearBtn') }}
              </ActionButton>
              <input
                ref="worldbookInput"
                type="file"
                accept=".json,application/json"
                hidden
                tabindex="-1"
                :disabled="busy"
                data-testid="kt-rp-worldbook-input"
                @change="handleWorldbookFileChange"
              />
            </div>

            <div
              v-if="sessionWorldbookDiag"
              class="ktrp-diag-block"
              data-testid="kt-rp-session-worldbook-diag"
            >
              <div class="ktrp-row-between">
                <span class="ktrp-diag-title">{{ t('worldbookDiagSessionTitle') }}</span>
                <span class="ktrp-chip" data-testid="kt-rp-session-worldbook-diag-summary">
                  {{
                    t('worldbookDiagSummary', {
                      supported: sessionWorldbookDiag.supportedEntries,
                      total: sessionWorldbookDiag.totalEntries,
                      skipped: sessionWorldbookDiag.skippedEntries,
                    })
                  }}
                </span>
              </div>
              <p v-if="!sessionWorldbookDiag.issues.length" class="ktrp-muted">
                {{ t('worldbookDiagAllSupported') }}
              </p>
              <div v-else class="ktrp-tag-list" data-testid="kt-rp-session-worldbook-diag-issues">
                <span
                  v-for="issue in sessionWorldbookDiag.issues"
                  :key="issue.code"
                  class="ktrp-chip"
                  :data-testid="'kt-rp-session-worldbook-issue-' + issue.code"
                >
                  {{ worldbookIssueLabel(issue) }}
                </span>
              </div>
            </div>

            <div v-if="hasAttachedWorldbook" class="ktrp-row-end">
              <ActionButton
                size="sm"
                variant="ghost"
                :disabled="busy || (slotLoading && activeWorldbookSlot === 'attached')"
                data-testid="kt-rp-session-worldbook-inspect-attached-btn"
                @click="loadWorldbookSlot('attached')"
              >
                {{
                  activeWorldbookSlot === 'attached'
                    ? t('sessionWorldbookHideInspectorBtn')
                    : t('sessionWorldbookInspectAttachedBtn')
                }}
              </ActionButton>
            </div>
          </div>

          <div
            v-if="cardLoreDiag"
            class="ktrp-card-box"
            data-testid="kt-rp-card-lore-diag"
          >
            <div class="ktrp-row-between">
              <div class="ktrp-box-head">{{ t('worldbookDiagCardTitle') }}</div>
              <span class="ktrp-chip" data-testid="kt-rp-card-lore-diag-summary">
                {{
                  t('worldbookDiagSummary', {
                    supported: cardLoreDiag.supportedEntries,
                    total: cardLoreDiag.totalEntries,
                    skipped: cardLoreDiag.skippedEntries,
                  })
                }}
              </span>
            </div>
            <p v-if="!cardLoreDiag.issues.length" class="ktrp-muted">
              {{ t('worldbookDiagAllSupported') }}
            </p>
            <div v-else class="ktrp-tag-list" data-testid="kt-rp-card-lore-diag-issues">
              <span
                v-for="issue in cardLoreDiag.issues"
                :key="issue.code"
                class="ktrp-chip"
                :data-testid="'kt-rp-card-lore-issue-' + issue.code"
              >
                {{ worldbookIssueLabel(issue) }}
              </span>
            </div>
            <div v-if="hasEmbeddedWorldbook" class="ktrp-row-end">
              <ActionButton
                size="sm"
                variant="ghost"
                :disabled="busy || (slotLoading && activeWorldbookSlot === 'embedded')"
                data-testid="kt-rp-session-worldbook-inspect-embedded-btn"
                @click="loadWorldbookSlot('embedded')"
              >
                {{
                  activeWorldbookSlot === 'embedded'
                    ? t('sessionWorldbookHideInspectorBtn')
                    : t('sessionWorldbookInspectEmbeddedBtn')
                }}
              </ActionButton>
            </div>
          </div>

          <!-- Session Worldbook Snapshot Reader (Attached or Embedded) -->
          <div
            v-if="activeWorldbookSlot"
            class="ktrp-card-box"
            data-testid="kt-rp-session-worldbook-reader"
            :data-slot="activeWorldbookSlot"
          >
            <div class="ktrp-row-between">
              <div class="ktrp-box-head" data-testid="kt-rp-session-worldbook-reader-title">
                {{
                  activeWorldbookSlot === 'embedded'
                    ? t('cardEmbeddedWorldbookTitle')
                    : t('tavernSessionWorldbookTitle')
                }}
                <span v-if="slotSnapshot?.name" class="ktrp-muted">
                  ({{ slotSnapshot.name }})
                </span>
              </div>
              <ActionButton
                size="sm"
                variant="ghost"
                data-testid="kt-rp-session-worldbook-reader-close-btn"
                @click="resetSlotInspector"
              >
                {{ t('sessionWorldbookHideInspectorBtn') }}
              </ActionButton>
            </div>

            <div v-if="slotLoading" class="ktrp-empty" role="status" data-testid="kt-rp-session-worldbook-reader-loading">
              {{ t('loading') }}
            </div>
            <div
              v-else-if="slotError"
              class="ktrp-banner ktrp-banner--error"
              role="alert"
              data-testid="kt-rp-session-worldbook-reader-error"
            >
              <span>{{ slotError }}</span>
            </div>
            <template v-else-if="slotSnapshot">
              <div class="ktrp-row-between">
                <strong>{{ t('worldbookEntriesDirectoryTitle', { count: slotEntries.length }) }}</strong>
                <div class="ktrp-inline-actions">
                  <button
                    type="button"
                    class="ktrp-chip"
                    :class="{ 'ktrp-chip--accent': slotEntryFilter === 'all' }"
                    data-testid="kt-rp-session-worldbook-filter-all"
                    @click="slotEntryFilter = 'all'"
                  >
                    {{ t('worldbookFilterAll', { count: slotEntries.length }) }}
                  </button>
                  <button
                    type="button"
                    class="ktrp-chip"
                    :class="{ 'ktrp-chip--accent': slotEntryFilter === 'supported' }"
                    data-testid="kt-rp-session-worldbook-filter-supported"
                    @click="slotEntryFilter = 'supported'"
                  >
                    {{ t('worldbookFilterSupported', { count: slotSupportedCount }) }}
                  </button>
                  <button
                    type="button"
                    class="ktrp-chip"
                    :class="{ 'ktrp-chip--accent': slotEntryFilter === 'issues' }"
                    data-testid="kt-rp-session-worldbook-filter-issues"
                    @click="slotEntryFilter = 'issues'"
                  >
                    {{ t('worldbookFilterIssues', { count: slotIssuesCount }) }}
                  </button>
                </div>
              </div>

              <input
                v-model="slotEntryQuery"
                type="search"
                class="ktrp-input"
                :placeholder="t('worldbookEntrySearchPlaceholder')"
                data-testid="kt-rp-session-worldbook-entry-search"
              />

              <div
                v-if="!slotEntries.length"
                class="ktrp-empty"
                data-testid="kt-rp-session-worldbook-entries-empty"
              >
                {{ t('worldbookNoEntries') }}
              </div>
              <div
                v-else-if="!filteredSlotEntries.length"
                class="ktrp-empty"
                data-testid="kt-rp-session-worldbook-entries-no-match"
              >
                {{ t('worldbookNoEntryMatches') }}
              </div>
              <template v-else>
                <div
                  class="ktrp-card-grid"
                  role="listbox"
                  data-testid="kt-rp-session-worldbook-entry-list"
                >
                  <button
                    v-for="entry in filteredSlotEntries"
                    :key="entry.index"
                    type="button"
                    class="ktrp-card-tile"
                    role="option"
                    :aria-selected="selectedSlotEntry && entry.index === selectedSlotEntry.index"
                    :data-testid="'kt-rp-session-worldbook-entry-item-' + entry.index"
                    @click="selectSlotEntry(entry.index)"
                  >
                    <div class="ktrp-card-tile-meta">
                      <span class="ktrp-card-tile-name">
                        {{ entry.name || t('worldbookEntryUntitled', { index: entry.index + 1 }) }}
                      </span>
                      <span class="ktrp-chip-row">
                        <span class="ktrp-chip">
                          {{ entry.enabled ? t('worldbookEntryEnabledBadge') : t('worldbookEntryDisabledBadge') }}
                        </span>
                        <span v-if="entry.position" class="ktrp-chip">
                          {{ t('worldbookEntryPositionLabel', { position: entry.position }) }}
                        </span>
                        <span
                          v-if="entry.issue"
                          class="ktrp-chip"
                          :data-testid="'kt-rp-session-worldbook-entry-issue-' + entry.index"
                        >
                          {{ worldbookIssueLabel(entry.issue, 1) }}
                        </span>
                        <span v-else class="ktrp-chip ktrp-chip--accent">
                          {{ t('worldbookEntrySupportedBadge') }}
                        </span>
                      </span>
                    </div>
                  </button>
                </div>

                <div
                  v-if="selectedSlotEntry"
                  class="ktrp-sub-card"
                  data-testid="kt-rp-session-worldbook-entry-detail"
                >
                  <h4 data-testid="kt-rp-session-worldbook-entry-title">
                    {{
                      selectedSlotEntry.name ||
                      t('worldbookEntryUntitled', { index: selectedSlotEntry.index + 1 })
                    }}
                  </h4>
                  <div class="ktrp-chip-row" data-testid="kt-rp-session-worldbook-entry-badges">
                    <span class="ktrp-chip">
                      {{
                        selectedSlotEntry.enabled
                          ? t('worldbookEntryEnabledBadge')
                          : t('worldbookEntryDisabledBadge')
                      }}
                    </span>
                    <span v-if="selectedSlotEntry.position" class="ktrp-chip">
                      {{ t('worldbookEntryPositionLabel', { position: selectedSlotEntry.position }) }}
                    </span>
                    <span
                      v-if="selectedSlotEntry.issue"
                      class="ktrp-chip"
                      data-testid="kt-rp-session-worldbook-entry-detail-issue"
                    >
                      {{ worldbookIssueLabel(selectedSlotEntry.issue, 1) }}
                    </span>
                    <span v-else class="ktrp-chip ktrp-chip--accent">
                      {{ t('worldbookEntrySupportedBadge') }}
                    </span>
                  </div>

                  <div class="ktrp-field-block" data-testid="kt-rp-session-worldbook-entry-keys">
                    <span class="ktrp-label">{{ t('worldbookEntryPrimaryKeys') }}</span>
                    <div v-if="selectedSlotEntry.keys.length" class="ktrp-tag-list">
                      <span
                        v-for="(k, idx) in selectedSlotEntry.keys"
                        :key="idx"
                        class="ktrp-tag"
                      >{{ k }}</span>
                    </div>
                    <p v-else class="ktrp-muted">{{ t('worldbookEntryNoKeys') }}</p>
                  </div>

                  <div
                    v-if="selectedSlotEntry.secondaryKeys.length"
                    class="ktrp-field-block"
                    data-testid="kt-rp-session-worldbook-entry-secondary-keys"
                  >
                    <span class="ktrp-label">{{ t('worldbookEntrySecondaryKeys') }}</span>
                    <div class="ktrp-tag-list">
                      <span
                        v-for="(k, idx) in selectedSlotEntry.secondaryKeys"
                        :key="idx"
                        class="ktrp-tag"
                      >{{ k }}</span>
                    </div>
                  </div>

                  <div class="ktrp-field-block">
                    <span class="ktrp-label">{{ t('worldbookEntryContentTitle') }}</span>
                    <pre
                      v-if="selectedSlotEntry.content"
                      class="ktrp-pre"
                      data-testid="kt-rp-session-worldbook-entry-content"
                    >{{ selectedSlotEntry.content }}</pre>
                    <p
                      v-else
                      class="ktrp-muted"
                      data-testid="kt-rp-session-worldbook-entry-content"
                    >{{ t('worldbookEntryEmptyContent') }}</p>
                  </div>
                </div>
              </template>
            </template>
          </div>

          <div v-if="state.lore" class="ktrp-card-box" data-testid="kt-rp-tavern-lore">
            <div class="ktrp-box-head">{{ t('tavernWorldbookTitle') }}</div>
            <p class="ktrp-muted">
              {{
                t('tavernWorldbookActive', {
                  count: state.lore.totalEntries ?? state.lore.activeCount ?? state.lore.activeTitles?.length ?? 0,
                  used: state.lore.usedTokens ?? 0,
                  budget: state.lore.budgetTokens ?? 0,
                })
              }}
            </p>
            <div v-if="state.lore.activeTitles?.length" class="ktrp-tag-list">
              <span v-for="title in state.lore.activeTitles" :key="title" class="ktrp-tag">{{ title }}</span>
            </div>
          </div>

          <div class="ktrp-field-block">
            <label class="ktrp-label" for="ktrp-tavern-notes">{{ t('tavernNotesLabel') }}</label>
            <textarea
              id="ktrp-tavern-notes"
              v-model="notesDraft"
              rows="4"
              class="ktrp-textarea"
              :placeholder="t('tavernNotesPlaceholder')"
              data-testid="kt-rp-tavern-notes"
              @input="notesDirty = true"
            />
            <div class="ktrp-row-end">
              <ActionButton
                variant="primary"
                size="sm"
                :disabled="busy"
                data-testid="kt-rp-save-notes-btn"
                @click="saveNotes"
              >
                {{ t('saveNotes') }}
              </ActionButton>
            </div>
          </div>
          </div>
        </section>

        <!-- SETUP OR PERSONA MODE -->
        <section v-else class="ktrp-stack">
          <!-- Active persona banner -->
          <div v-if="mode === 'persona' && active" class="ktrp-active-card" data-testid="kt-rp-persona-active">
            <PortraitFrame
              :card-id="state.cardId || ''"
              :name="state.persona?.name || ''"
              :has-portrait="Boolean(state.hasPortrait ?? activeCardSummary?.hasPortrait ?? true)"
              arg-key="id"
              size="md"
            />
            <div class="ktrp-active-meta">
              <span class="ktrp-chip ktrp-chip--accent">{{ t('personaActiveBanner') }}</span>
              <h4>{{ state.persona?.name }}</h4>
              <p v-if="state.persona?.voice" class="ktrp-muted">{{ state.persona.voice }}</p>
            </div>
            <ActionButton
              variant="danger"
              size="sm"
              :disabled="busy"
              data-testid="kt-rp-persona-remove-btn"
              @click="removePersona"
            >
              {{ t('removePersona') }}
            </ActionButton>
          </div>

          <!-- Card selector shared by Persona and Tavern setup -->
          <div class="ktrp-field-block">
            <div class="ktrp-row-between">
              <label class="ktrp-label" for="ktrp-card-select">{{ t('chooseCard') }}</label>
              <ActionButton
                size="sm"
                variant="ghost"
                :disabled="cardsLoading"
                data-testid="kt-rp-refresh-cards-btn"
                @click="loadCards"
              >
                {{ t('refreshCards') }}
              </ActionButton>
            </div>

            <div v-if="cardsError" class="ktrp-banner ktrp-banner--error" role="alert">{{ cardsError }}</div>
            <div v-else-if="cardsLoading && !cards.length" class="ktrp-muted">{{ t('loading') }}</div>
            <div v-else-if="!cards.length" class="ktrp-empty" data-testid="kt-rp-panel-no-cards">
              <p>{{ t('noCardsInPanel') }}</p>
              <ActionButton size="sm" @click="openLibraryTab">{{ t('openLibrary') }}</ActionButton>
            </div>
            <select
              v-else
              id="ktrp-card-select"
              v-model="selectedCardId"
              class="ktrp-select"
              data-testid="kt-rp-card-select"
            >
              <option v-for="card in cards" :key="card.id" :value="card.id">
                {{ card.name }} (V{{ card.version }})
              </option>
            </select>
          </div>

          <div v-if="detailError" class="ktrp-banner ktrp-banner--error" role="alert">{{ detailError }}</div>
          <div v-else-if="selectedCardSummary" class="ktrp-card-preview">
            <PortraitFrame
              :card-id="selectedCardSummary.id"
              :name="selectedCardSummary.name"
              :has-portrait="selectedCardSummary.hasPortrait"
              arg-key="id"
              size="sm"
            />
            <div class="ktrp-active-meta">
              <strong>{{ selectedCardSummary.name }}</strong>
              <div class="ktrp-chip-row">
                <span class="ktrp-chip">{{ t('versionTag', { version: selectedCardSummary.version }) }}</span>
                <span v-if="selectedDetail?.hasWorldbook" class="ktrp-chip ktrp-chip--accent">
                  {{ t('worldbookTag') }}
                </span>
              </div>
            </div>
          </div>

          <!-- TAVERN SETUP -->
          <div v-if="mode === 'tavern'" class="ktrp-stack" data-testid="kt-rp-tavern-setup">
            <div>
              <h4>{{ t('tavernSetupTitle') }}</h4>
              <p class="ktrp-muted">{{ t('tavernSetupHint') }}</p>
            </div>

            <div class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-player-name">{{ t('playerName') }}</label>
              <input
                id="ktrp-player-name"
                v-model="tavernForm.playerName"
                type="text"
                class="ktrp-input"
                data-testid="kt-rp-player-name"
              />
            </div>

            <div class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-player-desc">{{ t('playerDescription') }}</label>
              <textarea
                id="ktrp-player-desc"
                v-model="tavernForm.playerDescription"
                rows="3"
                class="ktrp-textarea"
                data-testid="kt-rp-player-desc"
              />
            </div>

            <div v-if="greetings.length" class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-greeting-select">{{ t('greetingSelect') }}</label>
              <select
                id="ktrp-greeting-select"
                v-model.number="tavernForm.greetingIndex"
                class="ktrp-select"
                data-testid="kt-rp-greeting-select"
              >
                <option v-for="(_, idx) in greetings" :key="idx" :value="idx">
                  {{ idx === 0 ? t('greetingPrimary') : t('greetingAlternate', { index: idx + 1 }) }}
                </option>
              </select>
            </div>

            <div class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-setup-worldbook-select">
                {{ t('sessionWorldbookLaunchLabel') }}
              </label>
              <select
                id="ktrp-setup-worldbook-select"
                v-model="tavernForm.worldbookMode"
                class="ktrp-select"
                data-testid="kt-rp-setup-worldbook-select"
              >
                <option value="__default__">
                  {{
                    selectedCardDefaultWorldbook
                      ? t('sessionWorldbookFollowDefault', { name: selectedCardDefaultWorldbook.name })
                      : t('sessionWorldbookFollowDefaultNone')
                  }}
                </option>
                <option value="__none__">{{ t('sessionWorldbookExplicitNone') }}</option>
                <option v-for="wb in catalogWorldbooks" :key="wb.id" :value="wb.id">
                  {{ t('sessionWorldbookLibraryPick', { name: wb.name }) }}
                </option>
              </select>
            </div>

            <div class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-setup-scripts-select">
                {{ t('sessionScriptsLaunchLabel') }}
              </label>
              <select
                id="ktrp-setup-scripts-select"
                v-model="tavernForm.scriptsMode"
                class="ktrp-select"
                data-testid="kt-rp-setup-scripts-select"
              >
                <option value="__default__">
                  {{
                    catalogCardScriptsDefault
                      ? t('sessionScriptsFollowDefaultOn')
                      : t('sessionScriptsFollowDefaultOff')
                  }}
                </option>
                <option value="on">{{ t('sessionScriptsExplicitOn') }}</option>
                <option value="off">{{ t('sessionScriptsExplicitOff') }}</option>
              </select>
            </div>

            <div class="ktrp-row-end">
              <ActionButton
                variant="primary"
                :disabled="busy || !selectedCardId || detailLoading"
                data-testid="kt-rp-tavern-start-btn"
                @click="startTavern"
              >
                {{ t('startTavern') }}
              </ActionButton>
            </div>
          </div>

          <!-- PERSONA CONFIRMATION FORM -->
          <div v-else class="ktrp-stack" data-testid="kt-rp-persona-form">
            <div class="ktrp-row-between">
              <div>
                <h4>{{ t('personaSectionTitle') }}</h4>
                <p class="ktrp-muted">{{ t('personaSectionHint') }}</p>
              </div>
            </div>

            <ActionButton
              size="sm"
              :disabled="!selectedDetail || detailLoading || busy"
              data-testid="kt-rp-persona-extract-btn"
              @click="fillSafeDraft"
            >
              {{ t('extractFromCard') }}
            </ActionButton>

            <div class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-persona-name">{{ t('personaName') }}</label>
              <input
                id="ktrp-persona-name"
                v-model="personaForm.name"
                type="text"
                class="ktrp-input"
                data-testid="kt-rp-persona-name"
                @input="personaDirty = true"
              />
            </div>

            <div class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-persona-appearance">{{ t('personaAppearance') }}</label>
              <textarea
                id="ktrp-persona-appearance"
                v-model="personaForm.appearance"
                rows="3"
                class="ktrp-textarea"
                data-testid="kt-rp-persona-appearance"
                @input="personaDirty = true"
              />
            </div>

            <div class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-persona-personality">{{ t('personaPersonality') }}</label>
              <textarea
                id="ktrp-persona-personality"
                v-model="personaForm.personality"
                rows="2"
                class="ktrp-textarea"
                data-testid="kt-rp-persona-personality"
                @input="personaDirty = true"
              />
            </div>

            <div class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-persona-voice">{{ t('personaVoice') }}</label>
              <textarea
                id="ktrp-persona-voice"
                v-model="personaForm.voice"
                rows="2"
                class="ktrp-textarea"
                data-testid="kt-rp-persona-voice"
                @input="personaDirty = true"
              />
            </div>

            <div class="ktrp-row-end">
              <ActionButton
                variant="primary"
                :disabled="busy || !selectedCardId"
                data-testid="kt-rp-persona-apply-btn"
                @click="applyPersona"
              >
                {{ active ? t('updatePersona') : t('applyPersona') }}
              </ActionButton>
            </div>
          </div>
        </section>
      </template>
    </div>
  `,
};
