import { computed, ref, watch } from "vue";
import {
  ActionButton,
  SettingsGroup,
  SettingsRow,
  confirm,
  notify,
  openTab,
  useExtension,
  useOwner,
} from "@kohakuterrarium/ui-sdk";

import {
  DEFAULT_MAX_ARCHIVE_BYTES,
  DEFAULT_MAX_CARD_BYTES,
  base64ToUint8Array,
  collectGreetings,
  normalizeDefaultNarrator,
  normalizeWorldbookDiagnostics,
  normalizeWorldbookEntries,
  readFileAsBase64,
  sanitizeDownloadFilename,
  validateCardFile,
} from "./helpers.js";
import { CardCopyEditor } from "./CardCopyEditor.js";
import { CardMediaGallery } from "./CardMediaGallery.js";
import { PortraitFrame } from "./PortraitFrame.js";
import { PortraitRuleEditor } from "./PortraitRuleEditor.js";
import { useRoleplayText } from "./strings.js";

/**
 * Shared character card library view mounted in both Settings -> Roleplay Cards
 * and the standalone Roleplay Studio workspace tab.
 * When `mode === 'tab'`, also exposes Tavern & Novel launch actions via `kt.api.post(...)`.
 */
const NOVEL_CAST_LIMIT = 32;
const NOVEL_WORLDBOOK_LIMIT = 8;

function normalizeScriptDependencies(rawScripts) {
  if (!Array.isArray(rawScripts)) return [];
  return rawScripts
    .filter((item) => item && typeof item === "object")
    .map((item, idx) => {
      const scriptId =
        typeof item.scriptId === "string" && item.scriptId.trim()
          ? item.scriptId.trim()
          : `script-${idx + 1}`;
      const name =
        typeof item.name === "string" && item.name.trim() ? item.name.trim() : scriptId;
      const enabled = Boolean(item.enabled);
      const syntaxError = Boolean(item.syntaxError);
      const truncated = Boolean(item.truncated);
      const eligible = enabled && !syntaxError && !truncated;
      const references = Array.isArray(item.references)
        ? item.references
            .filter((refItem) => refItem && typeof refItem === "object")
            .map((refItem) => {
              const specifier =
                typeof refItem.specifier === "string" && refItem.specifier.trim()
                  ? refItem.specifier.trim()
                  : null;
              const kind =
                refItem.kind === "https" || refItem.kind === "relative"
                  ? refItem.kind
                  : "unsupported";
              const dynamic = Boolean(refItem.dynamic);
              return {
                specifier,
                kind,
                dynamic,
                selectable: Boolean(eligible && kind === "https" && !dynamic && specifier),
              };
            })
        : [];
      const compatibilityNotes = Array.isArray(item.compatibilityNotes)
        ? item.compatibilityNotes.filter((n) => typeof n === "string" && n.trim())
        : [];
      return {
        scriptId,
        name,
        enabled,
        syntaxError,
        truncated,
        eligible,
        references,
        compatibilityNotes,
      };
    });
}

function collectEligibleHttpsUrls(normalizedScripts) {
  const seen = new Set();
  const urls = [];
  for (const script of normalizedScripts) {
    if (!script.eligible) continue;
    for (const refItem of script.references) {
      if (refItem.selectable && refItem.specifier && !seen.has(refItem.specifier)) {
        seen.add(refItem.specifier);
        urls.push(refItem.specifier);
      }
    }
  }
  return urls;
}

const ASSET_ISSUE_MESSAGE_KEYS = {
  dependency_dynamic_import: "cardScriptIssueDependencyDynamicImport",
  dependency_unsupported: "cardScriptIssueDependencyUnsupported",
  dependency_missing: "cardScriptIssueDependencyMissing",
  dependency_unapproved_transitive: "cardScriptIssueDependencyUnapprovedTransitive",
};

function normalizeAssetIssues(rawIssues) {
  if (!Array.isArray(rawIssues)) return [];
  return rawIssues
    .filter(
      (item) =>
        item &&
        typeof item === "object" &&
        typeof item.message === "string" &&
        item.message.trim(),
    )
    .map((item) => ({
      kind: typeof item.kind === "string" ? item.kind : "asset",
      id: typeof item.id === "string" ? item.id : "",
      name: typeof item.name === "string" ? item.name.trim() : "",
      message: item.message.trim(),
    }));
}

export const CardLibraryView = {
  name: "RoleplayCardLibraryView",
  components: {
    ActionButton,
    SettingsGroup,
    SettingsRow,
    PortraitFrame,
    CardCopyEditor,
    PortraitRuleEditor,
    CardMediaGallery,
  },
  props: {
    mode: { type: String, default: "settings" },
  },
  setup(props) {
    const owner = useOwner();
    const kt = useExtension();
    const t = useRoleplayText();

    const fileInput = ref(null);
    const query = ref("");
    const selectedId = ref("");
    const detail = ref(null);
    const detailLoading = ref(false);
    const detailError = ref("");
    const busy = ref(false);
    const actionError = ref("");
    const portraitRevision = ref(0);
    const editingCopy = ref(false);
    const editingPortraits = ref(false);
    const savedCopyBanner = ref(false);
    const exporting = ref(false);

    // Card default worldbook & embedded worldbook inspector state
    const defaultWorldbookDraft = ref("");
    const savingDefaultWorldbook = ref(false);
    const savingCardScriptsDefault = ref(false);
    const embeddedInspectorOpen = ref(false);
    const embeddedBook = ref(null);
    const embeddedLoading = ref(false);
    const embeddedError = ref("");
    const embeddedEntryQuery = ref("");
    const embeddedEntryFilter = ref("all");
    const selectedEmbeddedEntryIndex = ref(null);
    let embeddedSeq = 0;

    // Pre-import & existing card asset preparation state
    const pendingImportDeps = ref(null);
    const pendingImportedCardRefresh = ref(null);
    const preparingDetailAssets = ref(false);
    const detailAssetsError = ref("");
    const detailAssetIssues = ref([]);
    let importPreviewSeq = 0;
    let detailAssetsSeq = 0;

    // External opening page & opening module plan diagnostics state (per-card)
    const openingPlan = ref(null);
    const openingPlanLoading = ref(false);
    const openingPlanError = ref("");
    let openingPlanSeq = 0;

    // Studio quick-launch state (used in tab mode)
    const tavernLaunchPlayer = ref("Player");
    const tavernLaunchDesc = ref("");
    const tavernLaunchGreetingIndex = ref(0);
    const tavernLaunchWorldbookMode = ref("__default__");
    const tavernLaunchScriptsMode = ref("__default__");
    const novelCastIds = ref([]);
    const novelTitle = ref("");
    const novelPlayerMode = ref("protagonist");
    const novelPlayerName = ref("Player");
    const novelPlayerPersona = ref("");
    const novelNarratorCardId = ref("__default__");
    const novelStyleCardId = ref("");
    const defaultNarratorRulesExpanded = ref(false);
    const copyingDefaultNarrator = ref(false);
    const novelWorldbookIds = ref([]);
    const novelIncludeCardLore = ref(false);
    const novelPremise = ref("");
    const novelSheetHint = ref("");
    const novelPrologueMode = ref("none");
    const novelPrologueTitle = ref("");
    const novelPrologueText = ref("");
    const novelProloguePrompt = ref("");
    const launchedSession = ref(null);

    const state = computed(() => owner.state.value || {});
    const maxCardBytes = computed(() => Number(state.value.maxCardBytes) || DEFAULT_MAX_CARD_BYTES);
    const maxArchiveBytes = computed(
      () => Number(state.value.maxArchiveBytes) || DEFAULT_MAX_ARCHIVE_BYTES,
    );
    const maxMiB = computed(() => Math.round((maxCardBytes.value / (1024 * 1024)) * 10) / 10);
    const maxArchiveMiB = computed(
      () => Math.round((maxArchiveBytes.value / (1024 * 1024)) * 10) / 10,
    );
    const isCharxCard = computed(() => detail.value?.sourceFormat === "charx");
    const cards = computed(() => (Array.isArray(state.value.cards) ? state.value.cards : []));
    const cardScriptsDefault = computed(() => state.value.cardScriptsDefault !== false);
    const worldbooks = computed(() =>
      Array.isArray(state.value.worldbooks) ? state.value.worldbooks : [],
    );
    const cardWorldbookDefaults = computed(() =>
      state.value.cardWorldbookDefaults && typeof state.value.cardWorldbookDefaults === "object"
        ? state.value.cardWorldbookDefaults
        : {},
    );
    const currentCardDefaultWorldbookId = computed(() => {
      const id = selectedId.value;
      if (!id) return "";
      const raw = cardWorldbookDefaults.value[id];
      return typeof raw === "string" ? raw : "";
    });
    const currentCardDefaultWorldbook = computed(
      () => worldbooks.value.find((wb) => wb.id === currentCardDefaultWorldbookId.value) || null,
    );
    const embeddedDiagnostics = computed(() =>
      normalizeWorldbookDiagnostics(
        embeddedBook.value?.diagnostics || detail.value?.bookSummary?.diagnostics,
      ),
    );
    const embeddedEntries = computed(() =>
      normalizeWorldbookEntries(embeddedBook.value?.entries),
    );
    const embeddedSupportedCount = computed(
      () => embeddedEntries.value.filter((entry) => !entry.issue).length,
    );
    const embeddedIssuesCount = computed(
      () => embeddedEntries.value.filter((entry) => Boolean(entry.issue)).length,
    );
    const filteredEmbeddedEntries = computed(() => {
      const mode = embeddedEntryFilter.value;
      const q = embeddedEntryQuery.value.trim().toLowerCase();
      return embeddedEntries.value.filter((entry) => {
        if (mode === "supported" && entry.issue) return false;
        if (mode === "issues" && !entry.issue) return false;
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
    const selectedEmbeddedEntry = computed(() => {
      const list = filteredEmbeddedEntries.value;
      if (!list.length) return null;
      return (
        list.find((entry) => entry.index === selectedEmbeddedEntryIndex.value) ||
        list[0]
      );
    });
    const detailScriptDependencies = computed(() =>
      normalizeScriptDependencies(detail.value?.scriptDependencies),
    );
    const detailSavedModules = computed(() =>
      Array.isArray(detail.value?.scriptModules)
        ? detail.value.scriptModules
            .filter((m) => m && typeof m === "object" && typeof m.url === "string" && m.url)
            .map((m) => ({ url: m.url, size: Number(m.size) || 0 }))
        : [],
    );
    const detailSavedModuleMap = computed(
      () => new Map(detailSavedModules.value.map((m) => [m.url, m.size])),
    );
    const detailEligibleHttpsUrls = computed(() =>
      collectEligibleHttpsUrls(detailScriptDependencies.value),
    );
    const pendingEligibleHttpsUrls = computed(() =>
      collectEligibleHttpsUrls(pendingImportDeps.value?.scripts || []),
    );
    const pendingHasPreparableAssets = computed(
      () =>
        pendingEligibleHttpsUrls.value.length > 0 ||
        Boolean(pendingImportDeps.value?.remoteOpeningPage?.url),
    );
    const detailRemoteOpeningPage = computed(() => {
      const currentId = selectedId.value;
      if (!currentId || !detail.value || detail.value.id !== currentId) {
        return null;
      }
      const raw = detail.value.remoteOpeningPage;
      if (!raw || typeof raw !== "object" || typeof raw.url !== "string" || !raw.url) {
        return null;
      }
      const snap =
        raw.snapshot &&
        typeof raw.snapshot === "object" &&
        typeof raw.snapshot.url === "string"
          ? {
              url: raw.snapshot.url,
              size: Number(raw.snapshot.size) || 0,
            }
          : null;
      return {
        cardId: currentId,
        title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : "",
        marker: typeof raw.marker === "string" ? raw.marker : "",
        url: raw.url,
        snapshot: snap,
      };
    });
    const detailHasPreparableAssets = computed(
      () =>
        detailEligibleHttpsUrls.value.length > 0 ||
        Boolean(detailRemoteOpeningPage.value),
    );
    const filteredCards = computed(() => {
      const q = query.value.trim().toLowerCase();
      if (!q) return cards.value;
      return cards.value.filter((card) => String(card.name || "").toLowerCase().includes(q));
    });
    const selectedCard = computed(
      () => cards.value.find((card) => card.id === selectedId.value) || null,
    );
    const expandedDetails = ref({});
    const greetingsExpanded = ref(false);
    const greetings = computed(() => collectGreetings(detail.value?.fields));
    const tags = computed(() =>
      Array.isArray(detail.value?.fields?.tags) ? detail.value.fields.tags.filter(Boolean) : [],
    );
    const novelCastSummary = computed(() => {
      if (!novelCastIds.value.length) return "";
      const byId = new Map(cards.value.map((c) => [c.id, c.name || c.id]));
      const names = novelCastIds.value.map((id) => byId.get(id) || id);
      const preview = names.slice(0, 3).join(", ");
      return names.length > 3 ? `${preview} +${names.length - 3}` : preview;
    });
    const quickLaunchNovelHint = computed(() => {
      if (novelCastIds.value.length) {
        return t("quickLaunchNovelCastHint", {
          count: novelCastIds.value.length,
          names: novelCastSummary.value,
        });
      }
      const fallbackName = selectedCard.value?.name || cards.value[0]?.name || "";
      return t("quickLaunchNovelSelectedHint", { name: fallbackName });
    });
    const novelCastAtLimit = computed(() => novelCastIds.value.length >= NOVEL_CAST_LIMIT);
    const novelWorldbooksAtLimit = computed(
      () => novelWorldbookIds.value.length >= NOVEL_WORLDBOOK_LIMIT,
    );
    const defaultNarrator = computed(() => {
      const normalized = normalizeDefaultNarrator(state.value.defaultNarrator);
      if (normalized) return normalized;
      return {
        id: "__default__",
        name: t("novelDefaultNarratorTitle"),
        portraitUrl: "/api/ext/kohaku-roleplay/default-narrator.png",
        description: "",
        personality: "",
        examples: "",
      };
    });

    function hasAnyCardTag(card, targetTags) {
      const tagsList = Array.isArray(card?.tags) ? card.tags : [];
      const lower = new Set(tagsList.map((tag) => String(tag || "").trim().toLowerCase()));
      return targetTags.some((target) => lower.has(target));
    }

    const narratorCardOptions = computed(() => {
      const tagged = [];
      const others = [];
      for (const card of cards.value) {
        if (hasAnyCardTag(card, ["narrator"])) {
          tagged.push({
            id: card.id,
            label: t("novelNarratorTaggedBadge", { name: card.name }),
          });
        } else {
          others.push({ id: card.id, label: card.name });
        }
      }
      return [...tagged, ...others];
    });

    const styleCardOptions = computed(() => {
      const tagged = [];
      const others = [];
      for (const card of cards.value) {
        if (hasAnyCardTag(card, ["style", "prose"])) {
          tagged.push({
            id: card.id,
            label: t("novelStyleTaggedBadge", { name: card.name }),
          });
        } else {
          others.push({ id: card.id, label: card.name });
        }
      }
      return [...tagged, ...others];
    });

    watch(
      cards,
      (list) => {
        if (!list.length) {
          selectedId.value = "";
          detail.value = null;
          novelCastIds.value = [];
          if (novelNarratorCardId.value !== "__default__" && novelNarratorCardId.value !== "__none__") {
            novelNarratorCardId.value = "__default__";
          }
          novelStyleCardId.value = "";
          return;
        }
        const validIds = new Set(list.map((c) => c.id));
        novelCastIds.value = novelCastIds.value.filter((id) => validIds.has(id));
        if (
          novelNarratorCardId.value !== "__default__" &&
          novelNarratorCardId.value !== "__none__" &&
          !validIds.has(novelNarratorCardId.value)
        ) {
          novelNarratorCardId.value = "__default__";
        }
        if (novelStyleCardId.value && !validIds.has(novelStyleCardId.value)) {
          novelStyleCardId.value = "";
        }
        if (!list.some((card) => card.id === selectedId.value)) {
          selectedId.value = list[0].id;
        }
      },
      { immediate: true },
    );

    watch(
      worldbooks,
      (list) => {
        const validIds = new Set(list.map((wb) => wb.id));
        novelWorldbookIds.value = novelWorldbookIds.value.filter((id) => validIds.has(id));
      },
      { immediate: true },
    );

    watch(selectedId, () => {
      embeddedSeq += 1;
      detailAssetsSeq += 1;
      openingPlanSeq += 1;
      tavernLaunchGreetingIndex.value = 0;
      tavernLaunchWorldbookMode.value = "__default__";
      tavernLaunchScriptsMode.value = "__default__";
      editingCopy.value = false;
      editingPortraits.value = false;
      expandedDetails.value = {};
      greetingsExpanded.value = false;
      embeddedInspectorOpen.value = false;
      embeddedLoading.value = false;
      embeddedBook.value = null;
      embeddedError.value = "";
      embeddedEntryQuery.value = "";
      embeddedEntryFilter.value = "all";
      selectedEmbeddedEntryIndex.value = null;
      preparingDetailAssets.value = false;
      detailAssetsError.value = "";
      detailAssetIssues.value = [];
      openingPlan.value = null;
      openingPlanLoading.value = false;
      openingPlanError.value = "";
    });

    watch(
      [selectedId, currentCardDefaultWorldbookId],
      ([, defId]) => {
        defaultWorldbookDraft.value = defId || "";
      },
      { immediate: true },
    );

    watch(
      filteredEmbeddedEntries,
      (list) => {
        if (!list.length) {
          selectedEmbeddedEntryIndex.value = null;
          return;
        }
        if (!list.some((entry) => entry.index === selectedEmbeddedEntryIndex.value)) {
          selectedEmbeddedEntryIndex.value = list[0].index;
        }
      },
      { immediate: true },
    );

    function isDetailExpanded(key) {
      return Boolean(expandedDetails.value[key]);
    }

    function toggleDetailExpanded(key) {
      expandedDetails.value = {
        ...expandedDetails.value,
        [key]: !expandedDetails.value[key],
      };
    }

    function toggleGreetingsExpanded() {
      greetingsExpanded.value = !greetingsExpanded.value;
    }

    function openStudioTab() {
      try {
        openTab("kohaku-roleplay/studio");
      } catch (err) {
        actionError.value = err?.message || String(err);
      }
    }

    function openSettingsLibrary() {
      try {
        openTab({ kind: "settings", id: "settings", section: "ext:kohaku-roleplay/library" });
      } catch (err) {
        actionError.value = err?.message || String(err);
      }
    }

    function openWorldbookLibraryTab() {
      try {
        openTab("kohaku-roleplay/worldbooks");
      } catch (err) {
        actionError.value = err?.message || String(err);
      }
    }

    function openNovelReaderTab() {
      try {
        openTab("kohaku-roleplay/novel-reader");
      } catch (err) {
        actionError.value = err?.message || String(err);
      }
    }

    function assetIssueDisplayLabel(issue) {
      if (!issue || typeof issue !== "object") return "";
      const name = typeof issue.name === "string" ? issue.name.trim() : "";
      if (name) return name;
      return typeof issue.id === "string" ? issue.id : "";
    }

    function assetIssueDisplayMessage(issue) {
      const msg = typeof issue?.message === "string" ? issue.message.trim() : "";
      const key = Object.hasOwn(ASSET_ISSUE_MESSAGE_KEYS, msg)
        ? ASSET_ISSUE_MESSAGE_KEYS[msg]
        : null;
      return key ? t(key) : msg;
    }

    function worldbookIssueLabel(code, count = 1) {
      switch (code) {
        case "unsupported_position":
          return t("worldbookIssueUnsupportedPosition", { count });
        case "unsupported_trigger":
          return t("worldbookIssueUnsupportedTrigger", { count });
        case "unsupported_key":
          return t("worldbookIssueUnsupportedKey", { count });
        case "script_content":
          return t("worldbookIssueScriptContent", { count });
        case "invalid_entry":
          return t("worldbookIssueInvalidEntry", { count });
        default:
          return t("worldbookIssueUnknown", { code, count });
      }
    }

    async function saveCardScriptsDefault(nextEnabled) {
      if (busy.value || savingCardScriptsDefault.value) return;
      const enabled = Boolean(nextEnabled);
      savingCardScriptsDefault.value = true;
      actionError.value = "";
      try {
        const nextState = await owner.call("set_card_scripts_default", {
          enabled,
        });
        if (nextState && typeof nextState === "object") {
          owner.state.value = nextState;
          owner.status.value = "ready";
          owner.error.value = "";
        } else {
          const refreshed = await owner.refresh();
          if (!refreshed || owner.status.value !== "ready") {
            return;
          }
        }
        notify(t("cardScriptsDefaultSavedToast"), "success");
      } catch (err) {
        actionError.value = err?.message || String(err);
      } finally {
        savingCardScriptsDefault.value = false;
      }
    }

    async function saveCardDefaultWorldbook() {
      const card = selectedCard.value;
      if (!card || busy.value || savingDefaultWorldbook.value) return;
      const targetCardId = card.id;
      const bookId = defaultWorldbookDraft.value ? defaultWorldbookDraft.value : null;
      savingDefaultWorldbook.value = true;
      actionError.value = "";
      try {
        const nextState = await owner.call("set_default_worldbook", {
          cardId: targetCardId,
          bookId,
        });
        if (nextState && typeof nextState === "object") {
          owner.state.value = nextState;
          owner.status.value = "ready";
          owner.error.value = "";
        } else {
          const refreshed = await owner.refresh();
          if (!refreshed || owner.status.value !== "ready") {
            return;
          }
        }
        notify(t("cardDefaultWorldbookSavedToast"), "success");
      } catch (err) {
        actionError.value = err?.message || String(err);
      } finally {
        savingDefaultWorldbook.value = false;
      }
    }

    async function toggleEmbeddedInspector() {
      if (embeddedInspectorOpen.value) {
        embeddedSeq += 1;
        embeddedLoading.value = false;
        embeddedInspectorOpen.value = false;
        return;
      }
      const card = selectedCard.value;
      if (!card) return;
      const targetCardId = card.id;
      embeddedInspectorOpen.value = true;
      embeddedError.value = "";
      embeddedEntryQuery.value = "";
      embeddedEntryFilter.value = "all";
      selectedEmbeddedEntryIndex.value = null;
      if (embeddedBook.value && embeddedBook.value.cardId === targetCardId) {
        return;
      }
      const seq = ++embeddedSeq;
      embeddedLoading.value = true;
      try {
        const result = await owner.call("embedded_worldbook", { id: targetCardId });
        if (seq === embeddedSeq && selectedId.value === targetCardId) {
          embeddedBook.value = result
            ? {
                cardId: targetCardId,
                name: result.name || card.name,
                diagnostics: normalizeWorldbookDiagnostics(result.diagnostics),
                entries: normalizeWorldbookEntries(result.entries),
              }
            : null;
        }
      } catch (err) {
        if (seq === embeddedSeq && selectedId.value === targetCardId) {
          embeddedError.value = err?.message || String(err);
        }
      } finally {
        if (seq === embeddedSeq) {
          embeddedLoading.value = false;
        }
      }
    }

    function selectEmbeddedEntry(index) {
      selectedEmbeddedEntryIndex.value = index;
    }

    function normalizeOpeningPlan(rawPlan, fallbackUrl) {
      if (!rawPlan || typeof rawPlan !== "object") return null;
      const url =
        typeof rawPlan.url === "string" && rawPlan.url ? rawPlan.url : fallbackUrl || "";
      const status =
        typeof rawPlan.status === "string" && rawPlan.status
          ? rawPlan.status
          : "entry_unconfirmed";
      const saved = Array.isArray(rawPlan.saved)
        ? rawPlan.saved
            .filter((item) => item && typeof item === "object" && typeof item.url === "string" && item.url)
            .map((item) => ({
              url: item.url,
              size: Number(item.size) || 0,
            }))
        : [];
      const pending = Array.isArray(rawPlan.pending)
        ? rawPlan.pending
            .filter((item) => item && typeof item === "object" && typeof item.url === "string" && item.url)
            .map((item) => ({
              url: item.url,
              parentUrl:
                typeof item.parentUrl === "string" && item.parentUrl
                  ? item.parentUrl
                  : null,
            }))
        : [];
      return {
        url,
        status,
        saved,
        pending,
      };
    }

    function openingPlanStatusLabel(status) {
      switch (status) {
        case "entry_unconfirmed":
          return t("openingPlanStatusEntryUnconfirmed");
        case "self_contained":
          return t("openingPlanStatusSelfContained");
        case "modules_missing":
          return t("openingPlanStatusModulesMissing");
        case "static_graph_complete":
          return t("openingPlanStatusStaticGraphComplete");
        case "other_resources":
          return t("openingPlanStatusOtherResources");
        case "unsupported":
        default:
          return t("openingPlanStatusUnsupported");
      }
    }

    async function loadOpeningModulePlan(targetCardId = selectedId.value) {
      const cardId = typeof targetCardId === "string" ? targetCardId : "";
      const remotePage = detail.value?.id === cardId ? detailRemoteOpeningPage.value : null;
      if (!cardId || !remotePage) {
        openingPlan.value = null;
        openingPlanLoading.value = false;
        openingPlanError.value = "";
        return;
      }
      const seq = ++openingPlanSeq;
      openingPlanLoading.value = true;
      openingPlanError.value = "";
      try {
        const res = await owner.call("preview_card_opening_module_plan", { id: cardId });
        if (seq !== openingPlanSeq || selectedId.value !== cardId || detail.value?.id !== cardId) {
          return;
        }
        openingPlan.value = normalizeOpeningPlan(res, remotePage.url);
      } catch (err) {
        if (seq === openingPlanSeq && selectedId.value === cardId && detail.value?.id === cardId) {
          openingPlanError.value = err?.message || String(err);
        }
      } finally {
        if (seq === openingPlanSeq) {
          openingPlanLoading.value = false;
        }
      }
    }

    function applyPreparedAssetsToDetail(cardId, res) {
      const savedList = Array.isArray(res?.modules) ? res.modules : [];
      if (detail.value && detail.value.id === cardId) {
        const nextDetail = {
          ...detail.value,
          scriptModules: savedList,
        };
        if (nextDetail.remoteOpeningPage && res?.openingPage) {
          nextDetail.remoteOpeningPage = {
            ...nextDetail.remoteOpeningPage,
            snapshot: {
              url:
                typeof res.openingPage.url === "string" && res.openingPage.url
                  ? res.openingPage.url
                  : nextDetail.remoteOpeningPage.url,
              size: Number(res.openingPage.size) || 0,
            },
          };
        }
        detail.value = nextDetail;
      }
      if (selectedId.value === cardId) {
        if (res?.openingPlan) {
          openingPlan.value = normalizeOpeningPlan(
            res.openingPlan,
            detail.value?.remoteOpeningPage?.url || "",
          );
          openingPlanError.value = "";
        } else if (detail.value?.id === cardId && detail.value?.remoteOpeningPage?.url) {
          void loadOpeningModulePlan(cardId);
        }
      }
    }

    async function prepareDetailCardAssets() {
      const card = selectedCard.value;
      if (!card || busy.value || preparingDetailAssets.value) return;
      const targetCardId = card.id;
      const seq = ++detailAssetsSeq;
      preparingDetailAssets.value = true;
      detailAssetsError.value = "";
      actionError.value = "";
      try {
        const res = await owner.call("prepare_card_assets", {
          id: targetCardId,
        });
        if (seq !== detailAssetsSeq || selectedId.value !== targetCardId) return;
        applyPreparedAssetsToDetail(targetCardId, res);
        const issues = normalizeAssetIssues(res?.issues);
        detailAssetIssues.value = issues;
        if (!issues.length) {
          notify(t("cardAssetsPreparedToast"), "success");
        }
      } catch (err) {
        if (seq === detailAssetsSeq && selectedId.value === targetCardId) {
          detailAssetsError.value = err?.message || String(err);
        }
      } finally {
        if (seq === detailAssetsSeq) {
          preparingDetailAssets.value = false;
        }
      }
    }

    let detailSeq = 0;
    watch(
      () => [selectedId.value, owner.status.value],
      async ([id, status], _, onCleanup) => {
        let stale = false;
        onCleanup(() => {
          stale = true;
        });
        const seq = ++detailSeq;
        detailError.value = "";
        if (!id || status !== "ready") {
          detail.value = null;
          return;
        }
        detailLoading.value = true;
        try {
          const result = await owner.call("detail", { id });
          if (!stale && seq === detailSeq) {
            detail.value = result || null;
            if (result?.remoteOpeningPage && typeof result.remoteOpeningPage.url === "string") {
              void loadOpeningModulePlan(id);
            } else {
              openingPlan.value = null;
              openingPlanLoading.value = false;
              openingPlanError.value = "";
            }
          }
        } catch (err) {
          if (!stale && seq === detailSeq) {
            detail.value = null;
            detailError.value = err?.message || String(err);
          }
        } finally {
          if (!stale && seq === detailSeq) {
            detailLoading.value = false;
          }
        }
      },
      { immediate: true },
    );

    function selectCard(id) {
      selectedId.value = id;
      savedCopyBanner.value = false;
    }

    function openCopyEditor() {
      if (!selectedCard.value || busy.value || isCharxCard.value) return;
      actionError.value = "";
      savedCopyBanner.value = false;
      editingPortraits.value = false;
      editingCopy.value = !editingCopy.value;
    }

    function cancelCopyEditor() {
      editingCopy.value = false;
    }

    function openPortraitsEditor() {
      if (!selectedCard.value || busy.value || isCharxCard.value) return;
      actionError.value = "";
      savedCopyBanner.value = false;
      editingCopy.value = false;
      editingPortraits.value = !editingPortraits.value;
    }

    function cancelPortraitsEditor() {
      editingPortraits.value = false;
    }

    async function handleCopySaved(created) {
      editingCopy.value = false;
      editingPortraits.value = false;
      actionError.value = "";
      try {
        await owner.refresh();
        portraitRevision.value += 1;
        if (created?.id) {
          selectedId.value = created.id;
        }
        savedCopyBanner.value = true;
        notify(t("editorSavedCopyToast"), "success");
      } catch (err) {
        actionError.value = err?.message || String(err);
      }
    }

    async function exportSelectedCard() {
      const card = selectedCard.value;
      if (!card || busy.value || exporting.value) return;
      exporting.value = true;
      actionError.value = "";
      try {
        const result = await owner.call("export_original", { id: card.id });
        const fmt =
          result?.format === "png" ? "png" : result?.format === "charx" ? "charx" : "json";
        const bytes = base64ToUint8Array(result?.data);
        const blob = new Blob([bytes], {
          type:
            fmt === "png"
              ? "image/png"
              : fmt === "charx"
                ? "application/octet-stream"
                : "application/json",
        });
        const filename = sanitizeDownloadFilename(
          detail.value?.fields?.name || card.name,
          fmt,
        );
        const url = URL.createObjectURL(blob);
        try {
          const link = document.createElement("a");
          link.href = url;
          link.download = filename;
          link.style.display = "none";
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }
        notify(t("exportCardSuccess", { filename }), "success");
      } catch (err) {
        actionError.value = err?.message || String(err);
      } finally {
        exporting.value = false;
      }
    }

    function triggerImport() {
      if (busy.value) return;
      fileInput.value?.click();
    }

    async function handleFileChange(event) {
      const file = event.target?.files?.[0];
      if (event.target) event.target.value = "";
      if (!file || busy.value) return;

      const seq = ++importPreviewSeq;
      pendingImportDeps.value = null;
      pendingImportedCardRefresh.value = null;
      actionError.value = "";
      const check = validateCardFile(file, maxCardBytes.value, maxArchiveBytes.value);
      if (!check.ok) {
        actionError.value =
          check.code === "type"
            ? t("invalidFileType")
            : check.kind === "charx"
              ? t("archiveSizeLimitError", { mb: maxArchiveMiB.value })
              : t("sizeLimitError", { mb: maxMiB.value });
        return;
      }

      busy.value = true;
      try {
        const base64 = await readFileAsBase64(file);
        const preview = await owner.call("preview_card_dependencies", { data: base64 });
        if (seq !== importPreviewSeq) return;
        const scripts = normalizeScriptDependencies(preview?.scripts);
        const remoteOpeningPage =
          preview?.remoteOpeningPage &&
          typeof preview.remoteOpeningPage === "object" &&
          typeof preview.remoteOpeningPage.url === "string" &&
          preview.remoteOpeningPage.url
            ? {
                title:
                  typeof preview.remoteOpeningPage.title === "string"
                    ? preview.remoteOpeningPage.title.trim()
                    : "",
                marker:
                  typeof preview.remoteOpeningPage.marker === "string"
                    ? preview.remoteOpeningPage.marker
                    : "",
                url: preview.remoteOpeningPage.url,
              }
            : null;
        const resolvedName =
          typeof preview?.name === "string" && preview.name.trim()
            ? preview.name.trim()
            : file.name;
        if (scripts.length > 0 || remoteOpeningPage) {
          pendingImportDeps.value = {
            data: base64,
            name: resolvedName,
            scripts,
            remoteOpeningPage,
            importedId: "",
            downloadError: "",
            issues: [],
            refreshFailed: false,
          };
          return;
        }
        const imported = await owner.call("import", { data: base64 });
        const importedId = typeof imported?.id === "string" ? imported.id : "";
        const importedName =
          typeof imported?.name === "string" && imported.name.trim()
            ? imported.name.trim()
            : resolvedName;
        const refreshed = await owner.refresh();
        portraitRevision.value += 1;
        if (!refreshed || owner.status.value !== "ready") {
          pendingImportedCardRefresh.value = { id: importedId, name: importedName };
          return;
        }
        if (importedId) {
          selectedId.value = importedId;
        }
      } catch (err) {
        if (seq === importPreviewSeq) {
          actionError.value = err?.message || String(err);
        }
      } finally {
        if (seq === importPreviewSeq) {
          busy.value = false;
        }
      }
    }

    function cancelPendingImport() {
      if (busy.value) return;
      importPreviewSeq += 1;
      const pending = pendingImportDeps.value;
      if (pending?.importedId && pending?.refreshFailed) {
        pendingImportedCardRefresh.value = {
          id: pending.importedId,
          name: pending.name,
        };
      }
      pendingImportDeps.value = null;
      actionError.value = "";
    }

    async function completePendingImport(withPrepareAssets) {
      const pending = pendingImportDeps.value;
      if (!pending || busy.value) return;
      const seq = ++importPreviewSeq;
      busy.value = true;
      actionError.value = "";
      pending.downloadError = "";
      pending.issues = [];
      try {
        let cardId = pending.importedId;
        if (!cardId) {
          const imported = await owner.call("import", { data: pending.data });
          cardId = typeof imported?.id === "string" ? imported.id : "";
          pending.importedId = cardId;
          if (typeof imported?.name === "string" && imported.name.trim()) {
            pending.name = imported.name.trim();
          }
          const refreshed = await owner.refresh();
          portraitRevision.value += 1;
          if (!refreshed || owner.status.value !== "ready") {
            pending.refreshFailed = true;
          } else {
            pending.refreshFailed = false;
            if (cardId) {
              selectedId.value = cardId;
            }
          }
        } else if (pending.refreshFailed) {
          const refreshed = await owner.refresh();
          if (refreshed && owner.status.value === "ready") {
            pending.refreshFailed = false;
            if (cardId) {
              selectedId.value = cardId;
            }
          }
        }
        if (withPrepareAssets && pendingHasPreparableAssets.value && cardId) {
          try {
            const res = await owner.call("prepare_card_assets", {
              id: cardId,
            });
            applyPreparedAssetsToDetail(cardId, res);
            const issues = normalizeAssetIssues(res?.issues);
            if (issues.length > 0) {
              pending.issues = issues;
              if (selectedId.value === cardId) {
                detailAssetIssues.value = issues;
              }
              return;
            }
            notify(t("cardAssetsPreparedToast"), "success");
          } catch (dlErr) {
            pending.downloadError = dlErr?.message || String(dlErr);
            return;
          }
        }
        if (pending.refreshFailed) {
          pendingImportedCardRefresh.value = { id: cardId, name: pending.name };
        }
        pendingImportDeps.value = null;
      } catch (err) {
        actionError.value = err?.message || String(err);
      } finally {
        if (seq === importPreviewSeq) {
          busy.value = false;
        }
      }
    }

    async function removeSelectedCard() {
      const card = selectedCard.value;
      if (!card || busy.value) return;
      const accepted = await confirm(
        t("removeCardConfirm", { name: card.name }),
        t("removeCardTitle"),
      );
      if (!accepted) return;

      busy.value = true;
      actionError.value = "";
      try {
        await owner.call("remove", { id: card.id });
        await owner.refresh();
        notify(t("removeCard"), "success");
      } catch (err) {
        actionError.value = err?.message || String(err);
      } finally {
        busy.value = false;
      }
    }

    function openSessionTab(sessionId) {
      if (!sessionId) return;
      try {
        openTab({ kind: "attach", id: `attach:${sessionId}`, target: sessionId });
      } catch (err) {
        actionError.value = err?.message || String(err);
      }
    }

    async function launchTavernFromCard() {
      const card = selectedCard.value;
      if (!card || busy.value) return;
      const launchLabel = card.name;
      busy.value = true;
      actionError.value = "";
      try {
        const payload = {
          cardId: card.id,
          player: {
            name: tavernLaunchPlayer.value.trim() || "Player",
            description: tavernLaunchDesc.value.trim(),
          },
          greetingIndex: Number(tavernLaunchGreetingIndex.value) || 0,
        };
        if (tavernLaunchWorldbookMode.value === "__none__") {
          payload.worldbookId = null;
        } else if (
          tavernLaunchWorldbookMode.value &&
          tavernLaunchWorldbookMode.value !== "__default__"
        ) {
          payload.worldbookId = tavernLaunchWorldbookMode.value;
        }
        if (tavernLaunchScriptsMode.value === "on") {
          payload.enableCardScripts = true;
        } else if (tavernLaunchScriptsMode.value === "off") {
          payload.enableCardScripts = false;
        }
        const resp = await kt.api.post("taverns", payload);
        const data = resp?.data || resp || {};
        launchedSession.value = {
          kind: "tavern",
          sessionId: data.sessionId || "",
          creatureId: data.creatureId || "",
          label: launchLabel,
        };
        notify(t("launchCreatedToast"), "success");
      } catch (err) {
        actionError.value = err?.response?.data?.detail || err?.message || String(err);
      } finally {
        busy.value = false;
      }
    }

    function toggleNovelCast(cardId) {
      const idx = novelCastIds.value.indexOf(cardId);
      if (idx >= 0) {
        novelCastIds.value.splice(idx, 1);
      } else if (novelCastIds.value.length < NOVEL_CAST_LIMIT) {
        novelCastIds.value.push(cardId);
      }
    }

    function toggleNovelWorldbook(bookId) {
      const idx = novelWorldbookIds.value.indexOf(bookId);
      if (idx >= 0) {
        novelWorldbookIds.value.splice(idx, 1);
      } else if (novelWorldbookIds.value.length < NOVEL_WORLDBOOK_LIMIT) {
        novelWorldbookIds.value.push(bookId);
      }
    }

    function buildNovelLaunchPayload(cardIds) {
      const resolvedName = novelTitle.value.trim() || t("novelDefaultTitle");
      const modeValue = novelPlayerMode.value === "director" ? "director" : "protagonist";
      const payload = {
        cardIds: [...cardIds],
        name: resolvedName,
        narratorCardId: novelNarratorCardId.value || "__default__",
        worldbookIds: [...novelWorldbookIds.value],
        includeCardLore: Boolean(novelIncludeCardLore.value),
        playerMode: modeValue,
        playerName: modeValue === "protagonist" ? novelPlayerName.value.trim() || "Player" : "Player",
        playerPersona: modeValue === "protagonist" ? novelPlayerPersona.value.trim() : "",
        premise: novelPremise.value.trim(),
        sheetHint: novelSheetHint.value.trim(),
        prologueTitle: novelPrologueMode.value === "static" ? novelPrologueTitle.value.trim() : "",
        prologueText: novelPrologueMode.value === "static" ? novelPrologueText.value.trim() : "",
        prologuePrompt: novelPrologueMode.value === "prompt" ? novelProloguePrompt.value.trim() : "",
      };
      if (novelStyleCardId.value) {
        payload.styleCardId = novelStyleCardId.value;
      }
      return payload;
    }

    async function copyDefaultNarrator() {
      if (busy.value || copyingDefaultNarrator.value) return;
      copyingDefaultNarrator.value = true;
      actionError.value = "";
      try {
        const res = await owner.call("copy_default_narrator", {});
        if (res?.state && typeof res.state === "object") {
          owner.state.value = res.state;
          owner.status.value = "ready";
          owner.error.value = "";
        } else {
          await owner.refresh();
        }
        portraitRevision.value += 1;
        if (res?.card?.id) {
          selectedId.value = res.card.id;
        }
        notify(t("novelCopiedDefaultNarratorToast"), "success");
      } catch (err) {
        actionError.value = err?.message || String(err);
      } finally {
        copyingDefaultNarrator.value = false;
      }
    }

    async function launchNovelWithIds(cardIds) {
      if (!cardIds.length || busy.value) return;
      const payload = buildNovelLaunchPayload(cardIds);
      busy.value = true;
      actionError.value = "";
      try {
        const resp = await kt.api.post("novels", payload);
        const data = resp?.data || resp || {};
        launchedSession.value = {
          kind: "novel",
          sessionId: data.sessionId || "",
          creatureId: data.creatureId || "",
          label: payload.name,
        };
        notify(t("launchCreatedToast"), "success");
      } catch (err) {
        actionError.value = err?.response?.data?.detail || err?.message || String(err);
      } finally {
        busy.value = false;
      }
    }

    async function launchNovelFromCast() {
      await launchNovelWithIds(novelCastIds.value);
    }

    async function launchNovelQuick() {
      if (novelCastIds.value.length) {
        await launchNovelWithIds(novelCastIds.value);
        return;
      }
      const fallbackId = selectedCard.value?.id || cards.value[0]?.id;
      if (fallbackId) {
        await launchNovelWithIds([fallbackId]);
      }
    }

    async function refreshLibrary() {
      if (busy.value) return;
      actionError.value = "";
      const pendingCard = pendingImportedCardRefresh.value;
      const pendingDeps = pendingImportDeps.value;
      try {
        const refreshed = await owner.refresh();
        portraitRevision.value += 1;
        if (!refreshed || owner.status.value !== "ready") {
          return;
        }
        if (pendingCard) {
          pendingImportedCardRefresh.value = null;
          if (pendingCard.id) {
            selectedId.value = pendingCard.id;
          }
        }
        if (pendingDeps?.importedId && pendingDeps.refreshFailed) {
          pendingDeps.refreshFailed = false;
          selectedId.value = pendingDeps.importedId;
        }
      } catch (err) {
        actionError.value = err?.message || String(err);
      }
    }

    return {
      props,
      owner,
      t,
      fileInput,
      query,
      selectedId,
      selectedCard,
      expandedDetails,
      greetingsExpanded,
      isDetailExpanded,
      toggleDetailExpanded,
      toggleGreetingsExpanded,
      openStudioTab,
      openSettingsLibrary,
      openWorldbookLibraryTab,
      openNovelReaderTab,
      worldbooks,
      cardWorldbookDefaults,
      currentCardDefaultWorldbookId,
      currentCardDefaultWorldbook,
      defaultWorldbookDraft,
      savingDefaultWorldbook,
      cardScriptsDefault,
      savingCardScriptsDefault,
      saveCardScriptsDefault,
      saveCardDefaultWorldbook,
      embeddedInspectorOpen,
      embeddedBook,
      embeddedLoading,
      embeddedError,
      embeddedDiagnostics,
      embeddedEntries,
      embeddedSupportedCount,
      embeddedIssuesCount,
      embeddedEntryQuery,
      embeddedEntryFilter,
      filteredEmbeddedEntries,
      selectedEmbeddedEntry,
      selectedEmbeddedEntryIndex,
      toggleEmbeddedInspector,
      selectEmbeddedEntry,
      worldbookIssueLabel,
      assetIssueDisplayLabel,
      assetIssueDisplayMessage,
      pendingImportDeps,
      pendingEligibleHttpsUrls,
      pendingHasPreparableAssets,
      pendingImportedCardRefresh,
      cancelPendingImport,
      completePendingImport,
      detailScriptDependencies,
      detailSavedModules,
      detailSavedModuleMap,
      detailEligibleHttpsUrls,
      detailHasPreparableAssets,
      preparingDetailAssets,
      detailAssetsError,
      detailAssetIssues,
      prepareDetailCardAssets,
      detailRemoteOpeningPage,
      openingPlan,
      openingPlanLoading,
      openingPlanError,
      openingPlanStatusLabel,
      loadOpeningModulePlan,
      detail,
      detailLoading,
      detailError,
      busy,
      actionError,
      portraitRevision,
      editingCopy,
      editingPortraits,
      savedCopyBanner,
      exporting,
      maxCardBytes,
      maxArchiveBytes,
      maxMiB,
      maxArchiveMiB,
      isCharxCard,
      cards,
      filteredCards,
      greetings,
      tags,
      selectCard,
      openCopyEditor,
      cancelCopyEditor,
      openPortraitsEditor,
      cancelPortraitsEditor,
      handleCopySaved,
      exportSelectedCard,
      triggerImport,
      handleFileChange,
      removeSelectedCard,
      refreshLibrary,
      tavernLaunchPlayer,
      tavernLaunchDesc,
      tavernLaunchGreetingIndex,
      tavernLaunchWorldbookMode,
      tavernLaunchScriptsMode,
      novelCastIds,
      novelCastLimit: NOVEL_CAST_LIMIT,
      novelWorldbookLimit: NOVEL_WORLDBOOK_LIMIT,
      novelCastAtLimit,
      novelWorldbooksAtLimit,
      quickLaunchNovelHint,
      novelTitle,
      novelPlayerMode,
      novelPlayerName,
      novelPlayerPersona,
      novelNarratorCardId,
      novelStyleCardId,
      defaultNarrator,
      defaultNarratorRulesExpanded,
      copyingDefaultNarrator,
      narratorCardOptions,
      styleCardOptions,
      copyDefaultNarrator,
      novelWorldbookIds,
      novelIncludeCardLore,
      novelPremise,
      novelSheetHint,
      novelPrologueMode,
      novelPrologueTitle,
      novelPrologueText,
      novelProloguePrompt,
      launchedSession,
      launchTavernFromCard,
      toggleNovelCast,
      toggleNovelWorldbook,
      launchNovelFromCast,
      launchNovelQuick,
      openSessionTab,
    };
  },
  template: `
    <section
      class="ktrp-library"
      :class="{ 'ktrp-library--tab': props.mode === 'tab' }"
      :aria-label="t('library')"
      :aria-busy="busy"
      data-testid="kt-rp-library"
    >
      <div class="ktrp-library-banner" data-testid="kt-rp-studio-discovery">
        <div class="ktrp-library-banner-copy">
          <p class="ktrp-muted">{{ t('scope') }}</p>
          <p class="ktrp-muted">{{ t('studioDiscoverHint') }}</p>
        </div>
        <div class="ktrp-library-banner-actions">
          <ActionButton
            size="sm"
            variant="ghost"
            icon="i-carbon-notebook"
            data-testid="kt-rp-open-worldbooks-tab-btn"
            @click="openWorldbookLibraryTab"
          >
            {{ t('openWorldbookLibraryBtn') }}
          </ActionButton>
          <ActionButton
            v-if="props.mode === 'settings'"
            size="sm"
            variant="primary"
            icon="i-carbon-book"
            data-testid="kt-rp-open-studio-tab-btn"
            @click="openStudioTab"
          >
            {{ t('openStudioLibraryBtn') }}
          </ActionButton>
          <ActionButton
            v-else
            size="sm"
            variant="ghost"
            icon="i-carbon-settings"
            data-testid="kt-rp-open-settings-library-btn"
            @click="openSettingsLibrary"
          >
            {{ t('openSettingsLibraryBtn') }}
          </ActionButton>
        </div>
      </div>

      <div v-if="launchedSession" class="ktrp-banner ktrp-banner--info" data-testid="kt-rp-launch-result">
        <div>
          <strong>{{ t('launchReadyTitle', { name: launchedSession.label }) }}</strong>
          <p class="ktrp-muted">
            {{ t('launchReadyIds', { sessionId: launchedSession.sessionId, creatureId: launchedSession.creatureId }) }}
          </p>
        </div>
        <div class="ktrp-inline-actions">
          <ActionButton
            v-if="launchedSession.kind === 'novel'"
            size="sm"
            data-testid="kt-rp-launch-open-reader-btn"
            @click="openNovelReaderTab"
          >
            {{ t('launchOpenReaderBtn') }}
          </ActionButton>
          <ActionButton
            variant="primary"
            size="sm"
            data-testid="kt-rp-launch-open-session-btn"
            @click="openSessionTab(launchedSession.sessionId)"
          >
            {{ t('launchOpenSession') }}
          </ActionButton>
        </div>
      </div>

      <!-- Top-level notice when a card was imported but catalog refresh failed -->
      <div
        v-if="pendingImportedCardRefresh"
        class="ktrp-banner ktrp-banner--info"
        role="alert"
        data-testid="kt-rp-card-imported-refresh-error"
      >
        <span>
          {{ t('cardDepsImportedRefreshFailedBanner', { name: pendingImportedCardRefresh.name }) }}
          <small v-if="owner.error.value">{{ owner.error.value }}</small>
        </span>
        <div class="ktrp-inline-actions">
          <ActionButton
            size="sm"
            variant="primary"
            :disabled="busy"
            data-testid="kt-rp-card-imported-refresh-retry-btn"
            @click="refreshLibrary"
          >
            {{ t('cardDepsRetryRefreshBtn') }}
          </ActionButton>
          <ActionButton
            size="sm"
            variant="ghost"
            :disabled="busy"
            data-testid="kt-rp-card-imported-refresh-dismiss-btn"
            @click="pendingImportedCardRefresh = null"
          >
            {{ t('dismissBtn') }}
          </ActionButton>
        </div>
      </div>

      <!-- Top-level pre-import / post-import module dependency review panel (remains visible even if owner.refresh failed) -->
      <div
        v-if="pendingImportDeps"
        class="ktrp-card-box"
        data-testid="kt-rp-card-deps-preview"
      >
        <div class="ktrp-row-between">
          <div>
            <span class="ktrp-chip ktrp-chip--accent" data-testid="kt-rp-card-deps-preview-badge">
              {{ t('cardDepsPreviewBadge') }}
            </span>
            <h4 data-testid="kt-rp-card-deps-preview-title">
              {{ t('cardDepsPreviewTitle', { name: pendingImportDeps.name }) }}
            </h4>
            <p class="ktrp-muted">{{ t('cardDepsPreviewHint') }}</p>
          </div>
        </div>

        <div
          v-if="pendingImportDeps.refreshFailed"
          class="ktrp-banner ktrp-banner--info"
          role="alert"
          data-testid="kt-rp-card-deps-preview-refresh-error"
        >
          <span>
            {{ t('cardDepsImportedRefreshFailedBanner', { name: pendingImportDeps.name }) }}
            <small v-if="owner.error.value">{{ owner.error.value }}</small>
          </span>
          <ActionButton
            size="sm"
            :disabled="busy"
            data-testid="kt-rp-card-deps-preview-refresh-retry-btn"
            @click="refreshLibrary"
          >
            {{ t('cardDepsRetryRefreshBtn') }}
          </ActionButton>
        </div>

        <div
          v-if="pendingImportDeps.downloadError"
          class="ktrp-banner ktrp-banner--error"
          role="alert"
          data-testid="kt-rp-card-deps-preview-download-error"
        >
          <span>
            {{
              t('cardDepsImportedDownloadFailedBanner', {
                name: pendingImportDeps.name,
                error: pendingImportDeps.downloadError,
              })
            }}
          </span>
        </div>

        <div
          v-if="pendingImportDeps.issues?.length"
          class="ktrp-field-block"
          role="alert"
          data-testid="kt-rp-card-deps-preview-issues"
        >
          <span class="ktrp-label">
            {{ t('cardAssetsIssuesTitle', { count: pendingImportDeps.issues.length }) }}
          </span>
          <div class="ktrp-stack">
            <div
              v-for="(issue, iIdx) in pendingImportDeps.issues"
              :key="iIdx"
              class="ktrp-banner ktrp-banner--error"
              :data-testid="'kt-rp-card-deps-preview-issue-' + iIdx"
              :data-issue-kind="issue.kind"
            >
              <span>
                <strong v-if="assetIssueDisplayLabel(issue)">{{ assetIssueDisplayLabel(issue) }}: </strong>{{ assetIssueDisplayMessage(issue) }}
              </span>
            </div>
          </div>
        </div>

        <div
          v-if="pendingImportDeps.remoteOpeningPage"
          class="ktrp-sub-card"
          data-testid="kt-rp-card-deps-preview-opening"
        >
          <div class="ktrp-row-between">
            <strong>
              {{ pendingImportDeps.remoteOpeningPage.title || t('openingPlanEntryDefaultTitle') }}
            </strong>
            <span v-if="pendingImportDeps.remoteOpeningPage.marker" class="ktrp-chip">
              {{ pendingImportDeps.remoteOpeningPage.marker }}
            </span>
          </div>
          <code class="ktrp-pre" style="word-break: break-all;">{{
            pendingImportDeps.remoteOpeningPage.url
          }}</code>
        </div>

        <div
          v-if="pendingImportDeps.scripts.length"
          class="ktrp-stack"
          data-testid="kt-rp-card-deps-preview-scripts"
        >
          <div
            v-for="script in pendingImportDeps.scripts"
            :key="script.scriptId"
            class="ktrp-sub-card"
            :data-testid="'kt-rp-card-deps-preview-script-' + script.scriptId"
          >
            <div class="ktrp-row-between">
              <strong>{{ script.name }}</strong>
              <div class="ktrp-chip-row">
                <span class="ktrp-chip">
                  {{
                    script.enabled
                      ? t('cardScriptsEntryEnabledBadge')
                      : t('cardScriptsEntryDisabledBadge')
                  }}
                </span>
                <span
                  v-if="script.syntaxError"
                  class="ktrp-chip"
                  :data-testid="'kt-rp-card-deps-preview-syntax-error-' + script.scriptId"
                >
                  {{ t('cardDepsScriptSyntaxErrorBadge') }}
                </span>
                <span
                  v-if="script.truncated"
                  class="ktrp-chip"
                  :data-testid="'kt-rp-card-deps-preview-truncated-' + script.scriptId"
                >
                  {{ t('cardDepsScriptTruncatedBadge') }}
                </span>
              </div>
            </div>

            <p
              v-if="script.compatibilityNotes.includes('external_mvu_zod_schema')"
              class="ktrp-muted"
              :data-testid="'kt-rp-card-deps-preview-note-zod-' + script.scriptId"
            >
              {{ t('cardDepsNoteExternalMvuZod') }}
            </p>

            <div
              v-if="script.references.length"
              class="ktrp-stack"
              :data-testid="'kt-rp-card-deps-preview-refs-' + script.scriptId"
            >
              <div
                v-for="(refItem, rIdx) in script.references"
                :key="rIdx"
                class="ktrp-row-between"
                :data-testid="'kt-rp-card-deps-preview-ref-' + script.scriptId + '-' + rIdx"
              >
                <div class="ktrp-inline-actions" style="min-width: 0; flex: 1;">
                  <code class="ktrp-pre" style="word-break: break-all;">{{
                    refItem.specifier || t('cardDepsRefUnspecified')
                  }}</code>
                </div>
                <span
                  class="ktrp-chip"
                  :class="{ 'ktrp-chip--accent': refItem.selectable }"
                  :data-testid="'kt-rp-card-deps-preview-kind-' + script.scriptId + '-' + rIdx"
                >
                  {{
                    refItem.kind === 'https'
                      ? refItem.selectable
                        ? t('cardDepsRefKindHttps')
                        : t('cardDepsRefKindHttpsIneligible')
                      : refItem.kind === 'relative'
                        ? t('cardDepsRefKindRelative')
                        : t('cardDepsRefKindUnsupported')
                  }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <div class="ktrp-inline-actions" data-testid="kt-rp-card-deps-preview-actions">
          <ActionButton
            v-if="pendingHasPreparableAssets"
            variant="primary"
            size="sm"
            :disabled="busy"
            data-testid="kt-rp-card-deps-confirm-import-btn"
            @click="completePendingImport(true)"
          >
            {{
              busy
                ? t('cardAssetsPreparingBtn')
                : t('cardAssetsPrepareBtn')
            }}
          </ActionButton>
          <ActionButton
            v-if="!pendingImportDeps.importedId"
            size="sm"
            :variant="pendingHasPreparableAssets ? 'ghost' : 'primary'"
            :disabled="busy"
            data-testid="kt-rp-card-deps-import-without-modules-btn"
            @click="completePendingImport(false)"
          >
            {{ t('cardDepsImportWithoutModulesBtn') }}
          </ActionButton>
          <ActionButton
            size="sm"
            variant="ghost"
            :disabled="busy"
            data-testid="kt-rp-card-deps-cancel-import-btn"
            @click="cancelPendingImport"
          >
            {{
              pendingImportDeps.importedId
                ? t('cardDepsKeepImportedWithoutModulesBtn')
                : t('cardDepsCancelImportBtn')
            }}
          </ActionButton>
        </div>
      </div>

      <div
        v-if="!pendingImportedCardRefresh && !pendingImportDeps && (owner.status.value === 'error' || owner.status.value === 'absent')"
        class="ktrp-banner ktrp-banner--error"
        role="alert"
        data-testid="kt-rp-library-load-error"
      >
        <span>{{ t('loadFailed') }} <small v-if="owner.error.value">{{ owner.error.value }}</small></span>
        <ActionButton size="sm" @click="refreshLibrary">{{ t('retry') }}</ActionButton>
      </div>

      <p v-else-if="owner.status.value !== 'ready'" class="ktrp-muted" role="status" data-testid="kt-rp-library-loading">
        {{ t('loading') }}
      </p>

      <template v-else>
        <div
          v-if="actionError"
          class="ktrp-banner ktrp-banner--error"
          role="alert"
          data-testid="kt-rp-library-action-error"
        >
          <span>{{ t('actionFailed') }}: {{ actionError }}</span>
          <ActionButton size="sm" @click="actionError = ''">{{ t('retry') }}</ActionButton>
        </div>

          <div class="ktrp-row-between">
            <p class="ktrp-muted">{{ t('supportedHint', { mb: maxMiB, archiveMb: maxArchiveMiB }) }}</p>
            <div class="ktrp-inline-actions">
              <ActionButton
                size="sm"
                variant="ghost"
                icon="i-carbon-renew"
                :disabled="busy"
                data-testid="kt-rp-refresh-btn"
                @click="refreshLibrary"
              >
                {{ t('refresh') }}
              </ActionButton>
              <ActionButton
                variant="primary"
                size="sm"
                :disabled="busy"
                data-testid="kt-rp-import-btn"
                @click="triggerImport"
              >
                {{ busy ? t('importing') : t('importCard') }}
              </ActionButton>
              <input
                ref="fileInput"
                type="file"
                accept=".json,.png,.charx,application/json,image/png,application/zip"
                hidden
                tabindex="-1"
                :disabled="busy"
                data-testid="kt-rp-import-input"
                @change="handleFileChange"
              />
            </div>
          </div>

          <div
            class="ktrp-card-box"
            data-testid="kt-rp-card-scripts-default-section"
          >
            <div class="ktrp-row-between">
              <div>
                <h4>{{ t('cardScriptsDefaultTitle') }}</h4>
                <p class="ktrp-muted">{{ t('cardScriptsDefaultHint') }}</p>
              </div>
              <label class="ktrp-inline-actions">
                <input
                  type="checkbox"
                  :checked="cardScriptsDefault"
                  :disabled="busy || savingCardScriptsDefault"
                  data-testid="kt-rp-card-scripts-default-toggle"
                  @change="saveCardScriptsDefault($event.target.checked)"
                />
                <span>{{ t('cardScriptsDefaultTitle') }}</span>
              </label>
            </div>
          </div>

          <div
            v-if="props.mode === 'tab' && cards.length"
            class="ktrp-quick-launch-bar"
            data-testid="kt-rp-quick-launch-bar"
          >
            <div class="ktrp-quick-launch-copy">
              <strong>{{ t('quickLaunchBarTitle') }}</strong>
              <span class="ktrp-muted" data-testid="kt-rp-quick-launch-tavern-hint">
                {{ t('quickLaunchTavernHint', { name: selectedCard?.name || cards[0]?.name || '' }) }}
              </span>
              <span class="ktrp-muted" data-testid="kt-rp-quick-launch-novel-hint">
                {{ quickLaunchNovelHint }}
              </span>
            </div>
            <div class="ktrp-quick-launch-actions">
              <ActionButton
                variant="primary"
                size="sm"
                icon="i-carbon-chat"
                :disabled="busy || !selectedCard"
                data-testid="kt-rp-quick-launch-tavern-btn"
                @click="launchTavernFromCard"
              >
                {{ t('studioLaunchTavernBtn') }}
              </ActionButton>
              <ActionButton
                size="sm"
                icon="i-carbon-book"
                :disabled="busy || !cards.length"
                data-testid="kt-rp-quick-launch-novel-btn"
                @click="launchNovelQuick"
              >
                {{ novelCastIds.length ? t('studioLaunchNovelBtn') : t('quickLaunchNovelFromSelectedBtn') }}
              </ActionButton>
            </div>
          </div>

        <div class="ktrp-library-split">
          <div class="ktrp-card-pane">
            <div class="ktrp-pane-head">
              <input
                v-model="query"
                type="search"
                class="ktrp-input"
                :placeholder="t('searchPlaceholder')"
                data-testid="kt-rp-library-search"
              />
              <span class="ktrp-count">{{ t('cardCount', { count: filteredCards.length }) }}</span>
            </div>

            <div v-if="!cards.length" class="ktrp-empty" data-testid="kt-rp-library-empty">
              {{ t('emptyLibrary') }}
            </div>
            <div v-else-if="!filteredCards.length" class="ktrp-empty" data-testid="kt-rp-library-no-match">
              {{ t('noMatches') }}
            </div>
            <div v-else class="ktrp-card-grid" role="listbox" :aria-label="t('library')">
              <button
                v-for="card in filteredCards"
                :key="card.id"
                type="button"
                class="ktrp-card-tile"
                role="option"
                :aria-selected="card.id === selectedId"
                :data-testid="'kt-rp-card-' + card.id"
                @click="selectCard(card.id)"
              >
                <PortraitFrame
                  :card-id="card.id"
                  :name="card.name"
                  :has-portrait="card.hasPortrait"
                  arg-key="id"
                  size="sm"
                  :revision="portraitRevision"
                />
                <div class="ktrp-card-tile-meta">
                  <span class="ktrp-card-tile-name">{{ card.name }}</span>
                  <span class="ktrp-chip-row">
                    <span class="ktrp-chip">{{ t('versionTag', { version: card.version }) }}</span>
                    <span v-if="card.hasPortrait" class="ktrp-chip ktrp-chip--accent">{{ t('portraitTag') }}</span>
                  </span>
                </div>
              </button>
            </div>
          </div>

          <div class="ktrp-detail-pane" data-testid="kt-rp-card-detail">
            <div v-if="!selectedCard" class="ktrp-empty">
              {{ t('selectCardHint') }}
            </div>
            <div v-else-if="detailLoading" class="ktrp-empty" role="status">
              {{ t('loading') }}
            </div>
            <div v-else-if="detailError" class="ktrp-banner ktrp-banner--error" role="alert">
              <span>{{ detailError }}</span>
            </div>
            <template v-else-if="detail">
              <div class="ktrp-detail-header">
                <div class="ktrp-detail-header-top">
                  <PortraitFrame
                    :card-id="detail.id"
                    :name="detail.fields?.name || selectedCard.name"
                    :has-portrait="detail.hasPortrait"
                    arg-key="id"
                    size="lg"
                    :revision="portraitRevision"
                  />
                  <div class="ktrp-detail-title">
                    <h3>{{ detail.fields?.name || selectedCard.name }}</h3>
                    <div class="ktrp-chip-row">
                      <span class="ktrp-chip">{{ t('versionTag', { version: detail.version }) }}</span>
                      <span
                        v-if="detail.sourceFormat"
                        class="ktrp-chip"
                        :class="{ 'ktrp-chip--accent': isCharxCard }"
                        data-testid="kt-rp-card-format-badge"
                      >
                        {{ detail.sourceFormat.toUpperCase() }}
                      </span>
                      <span v-if="detail.hasWorldbook" class="ktrp-chip ktrp-chip--accent">{{ t('worldbookTag') }}</span>
                      <span v-if="detail.fields?.creator" class="ktrp-chip">{{ t('creatorLabel') }}: {{ detail.fields.creator }}</span>
                    </div>
                    <div v-if="tags.length" class="ktrp-tag-list" data-testid="kt-rp-card-tags">
                      <span v-for="tag in tags" :key="tag" class="ktrp-tag">{{ tag }}</span>
                    </div>
                  </div>
                </div>
                <div class="ktrp-detail-actions">
                  <ActionButton
                    size="sm"
                    :disabled="busy || exporting || isCharxCard"
                    data-testid="kt-rp-edit-copy-btn"
                    @click="openCopyEditor"
                  >
                    {{ editingCopy ? t('editorCancelBtn') : t('editAsNewCardBtn') }}
                  </ActionButton>
                  <ActionButton
                    size="sm"
                    :disabled="busy || exporting || isCharxCard"
                    data-testid="kt-rp-edit-portraits-btn"
                    @click="openPortraitsEditor"
                  >
                    {{ editingPortraits ? t('editorCancelBtn') : t('editPortraitsBtn') }}
                  </ActionButton>
                  <ActionButton
                    size="sm"
                    :disabled="busy || exporting"
                    data-testid="kt-rp-export-card-btn"
                    @click="exportSelectedCard"
                  >
                    {{ exporting ? t('exportingCard') : t('exportCardBtn') }}
                  </ActionButton>
                  <ActionButton
                    variant="danger"
                    size="sm"
                    :disabled="busy || exporting"
                    data-testid="kt-rp-delete-card-btn"
                    @click="removeSelectedCard"
                  >
                    {{ t('removeCard') }}
                  </ActionButton>
                </div>
              </div>

              <div
                v-if="isCharxCard"
                class="ktrp-banner ktrp-banner--info"
                data-testid="kt-rp-charx-readonly-notice"
              >
                <span>{{ t('charxReadonlyNotice') }}</span>
              </div>

              <div
                v-if="savedCopyBanner"
                class="ktrp-banner ktrp-banner--info"
                role="status"
                data-testid="kt-rp-copy-saved-banner"
              >
                <span>{{ t('editorSavedCopyBanner') }}</span>
                <ActionButton size="sm" variant="ghost" @click="savedCopyBanner = false">
                  {{ t('dismissBtn') }}
                </ActionButton>
              </div>

              <CardCopyEditor
                v-if="editingCopy"
                :card-id="detail.id"
                :card-name="detail.fields?.name || selectedCard.name"
                @cancel="cancelCopyEditor"
                @saved="handleCopySaved"
              />

              <PortraitRuleEditor
                v-else-if="editingPortraits"
                :card-id="detail.id"
                :card-name="detail.fields?.name || selectedCard.name"
                :max-bytes="maxCardBytes"
                @cancel="cancelPortraitsEditor"
                @saved="handleCopySaved"
              />

              <template v-else>
              <div v-if="detail.warnings?.length" class="ktrp-banner ktrp-banner--warn" data-testid="kt-rp-card-warnings">
                <div class="ktrp-warn-title">{{ t('warningsTitle') }}</div>
                <ul>
                  <li v-for="(warn, idx) in detail.warnings" :key="idx">{{ warn }}</li>
                </ul>
              </div>

              <CardMediaGallery
                :card-id="detail.id"
                :media="detail.media || []"
                :media-issues="detail.mediaIssues || null"
                :revision="portraitRevision"
                test-id-prefix="kt-rp-detail-media"
              />

              <div
                class="ktrp-card-box"
                data-testid="kt-rp-card-default-worldbook"
              >
                <div class="ktrp-row-between">
                  <div>
                    <h4>{{ t('cardDefaultWorldbookTitle') }}</h4>
                    <p class="ktrp-muted">{{ t('cardDefaultWorldbookHint') }}</p>
                  </div>
                  <span
                    v-if="currentCardDefaultWorldbook"
                    class="ktrp-chip ktrp-chip--accent"
                    data-testid="kt-rp-card-default-worldbook-current"
                  >
                    {{ currentCardDefaultWorldbook.name }}
                  </span>
                </div>
                <div class="ktrp-row-between">
                  <select
                    v-model="defaultWorldbookDraft"
                    class="ktrp-select"
                    :disabled="busy || savingDefaultWorldbook"
                    data-testid="kt-rp-card-default-worldbook-select"
                  >
                    <option value="">{{ t('cardDefaultWorldbookNone') }}</option>
                    <option
                      v-for="wb in worldbooks"
                      :key="wb.id"
                      :value="wb.id"
                    >
                      {{ wb.name }} ({{ wb.supportedEntries }}/{{ wb.totalEntries }})
                    </option>
                  </select>
                  <ActionButton
                    size="sm"
                    variant="primary"
                    :disabled="busy || savingDefaultWorldbook"
                    data-testid="kt-rp-card-default-worldbook-save-btn"
                    @click="saveCardDefaultWorldbook"
                  >
                    {{ t('cardDefaultWorldbookSaveBtn') }}
                  </ActionButton>
                </div>
              </div>

              <div
                v-if="detail.hasWorldbook"
                class="ktrp-card-box"
                data-testid="kt-rp-card-embedded-worldbook"
              >
                <div class="ktrp-row-between">
                  <div>
                    <h4>{{ t('cardEmbeddedWorldbookTitle') }}</h4>
                    <p
                      v-if="embeddedDiagnostics"
                      class="ktrp-muted"
                      data-testid="kt-rp-card-embedded-diag-summary"
                    >
                      {{
                        t('worldbookDiagSummary', {
                          supported: embeddedDiagnostics.supportedEntries,
                          total: embeddedDiagnostics.totalEntries,
                          skipped: embeddedDiagnostics.skippedEntries,
                        })
                      }}
                    </p>
                  </div>
                  <ActionButton
                    size="sm"
                    :disabled="busy || embeddedLoading"
                    data-testid="kt-rp-card-embedded-inspect-btn"
                    @click="toggleEmbeddedInspector"
                  >
                    {{
                      embeddedInspectorOpen
                        ? t('cardEmbeddedWorldbookHideBtn')
                        : t('cardEmbeddedWorldbookInspectBtn')
                    }}
                  </ActionButton>
                </div>

                <div
                  v-if="embeddedDiagnostics && embeddedDiagnostics.issues.length"
                  class="ktrp-chip-row"
                  data-testid="kt-rp-card-embedded-diag-issues"
                >
                  <span
                    v-for="issue in embeddedDiagnostics.issues"
                    :key="issue.code"
                    class="ktrp-chip"
                    :data-testid="'kt-rp-card-embedded-issue-' + issue.code"
                  >
                    {{ worldbookIssueLabel(issue.code, issue.count) }}
                  </span>
                </div>

                <div
                  v-if="embeddedInspectorOpen"
                  class="ktrp-stack"
                  data-testid="kt-rp-card-embedded-reader"
                >
                  <div v-if="embeddedLoading" class="ktrp-empty" role="status">
                    {{ t('loading') }}
                  </div>
                  <div
                    v-else-if="embeddedError"
                    class="ktrp-banner ktrp-banner--error"
                    role="alert"
                  >
                    <span>{{ embeddedError }}</span>
                  </div>
                  <template v-else-if="embeddedBook">
                    <div class="ktrp-row-between">
                      <strong>{{ t('worldbookEntriesDirectoryTitle', { count: embeddedEntries.length }) }}</strong>
                      <div class="ktrp-inline-actions">
                        <button
                          type="button"
                          class="ktrp-chip"
                          :class="{ 'ktrp-chip--accent': embeddedEntryFilter === 'all' }"
                          data-testid="kt-rp-card-embedded-filter-all"
                          @click="embeddedEntryFilter = 'all'"
                        >
                          {{ t('worldbookFilterAll', { count: embeddedEntries.length }) }}
                        </button>
                        <button
                          type="button"
                          class="ktrp-chip"
                          :class="{ 'ktrp-chip--accent': embeddedEntryFilter === 'supported' }"
                          data-testid="kt-rp-card-embedded-filter-supported"
                          @click="embeddedEntryFilter = 'supported'"
                        >
                          {{ t('worldbookFilterSupported', { count: embeddedSupportedCount }) }}
                        </button>
                        <button
                          type="button"
                          class="ktrp-chip"
                          :class="{ 'ktrp-chip--accent': embeddedEntryFilter === 'issues' }"
                          data-testid="kt-rp-card-embedded-filter-issues"
                          @click="embeddedEntryFilter = 'issues'"
                        >
                          {{ t('worldbookFilterIssues', { count: embeddedIssuesCount }) }}
                        </button>
                      </div>
                    </div>

                    <input
                      v-model="embeddedEntryQuery"
                      type="search"
                      class="ktrp-input"
                      :placeholder="t('worldbookEntrySearchPlaceholder')"
                      data-testid="kt-rp-card-embedded-entry-search"
                    />

                    <div
                      v-if="!embeddedEntries.length"
                      class="ktrp-empty"
                      data-testid="kt-rp-card-embedded-entries-empty"
                    >
                      {{ t('worldbookNoEntries') }}
                    </div>
                    <div
                      v-else-if="!filteredEmbeddedEntries.length"
                      class="ktrp-empty"
                      data-testid="kt-rp-card-embedded-entries-no-match"
                    >
                      {{ t('worldbookNoEntryMatches') }}
                    </div>
                    <template v-else>
                      <div
                        class="ktrp-card-grid"
                        role="listbox"
                        data-testid="kt-rp-card-embedded-entry-list"
                      >
                        <button
                          v-for="entry in filteredEmbeddedEntries"
                          :key="entry.index"
                          type="button"
                          class="ktrp-card-tile"
                          role="option"
                          :aria-selected="selectedEmbeddedEntry && entry.index === selectedEmbeddedEntry.index"
                          :data-testid="'kt-rp-card-embedded-entry-item-' + entry.index"
                          @click="selectEmbeddedEntry(entry.index)"
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
                                :data-testid="'kt-rp-card-embedded-entry-issue-' + entry.index"
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
                        v-if="selectedEmbeddedEntry"
                        class="ktrp-sub-card"
                        data-testid="kt-rp-card-embedded-entry-detail"
                      >
                        <h4 data-testid="kt-rp-card-embedded-entry-title">
                          {{
                            selectedEmbeddedEntry.name ||
                            t('worldbookEntryUntitled', { index: selectedEmbeddedEntry.index + 1 })
                          }}
                        </h4>
                        <div class="ktrp-chip-row" data-testid="kt-rp-card-embedded-entry-badges">
                          <span class="ktrp-chip">
                            {{
                              selectedEmbeddedEntry.enabled
                                ? t('worldbookEntryEnabledBadge')
                                : t('worldbookEntryDisabledBadge')
                            }}
                          </span>
                          <span v-if="selectedEmbeddedEntry.position" class="ktrp-chip">
                            {{ t('worldbookEntryPositionLabel', { position: selectedEmbeddedEntry.position }) }}
                          </span>
                          <span
                            v-if="selectedEmbeddedEntry.issue"
                            class="ktrp-chip"
                            data-testid="kt-rp-card-embedded-entry-detail-issue"
                          >
                            {{ worldbookIssueLabel(selectedEmbeddedEntry.issue, 1) }}
                          </span>
                          <span v-else class="ktrp-chip ktrp-chip--accent">
                            {{ t('worldbookEntrySupportedBadge') }}
                          </span>
                        </div>

                        <div class="ktrp-field-block" data-testid="kt-rp-card-embedded-entry-keys">
                          <span class="ktrp-label">{{ t('worldbookEntryPrimaryKeys') }}</span>
                          <div v-if="selectedEmbeddedEntry.keys.length" class="ktrp-tag-list">
                            <span
                              v-for="(k, idx) in selectedEmbeddedEntry.keys"
                              :key="idx"
                              class="ktrp-tag"
                            >{{ k }}</span>
                          </div>
                          <p v-else class="ktrp-muted">{{ t('worldbookEntryNoKeys') }}</p>
                        </div>

                        <div
                          v-if="selectedEmbeddedEntry.secondaryKeys.length"
                          class="ktrp-field-block"
                          data-testid="kt-rp-card-embedded-entry-secondary-keys"
                        >
                          <span class="ktrp-label">{{ t('worldbookEntrySecondaryKeys') }}</span>
                          <div class="ktrp-tag-list">
                            <span
                              v-for="(k, idx) in selectedEmbeddedEntry.secondaryKeys"
                              :key="idx"
                              class="ktrp-tag"
                            >{{ k }}</span>
                          </div>
                        </div>

                        <div class="ktrp-field-block">
                          <span class="ktrp-label">{{ t('worldbookEntryContentTitle') }}</span>
                          <pre
                            v-if="selectedEmbeddedEntry.content"
                            class="ktrp-pre"
                            data-testid="kt-rp-card-embedded-entry-content"
                          >{{ selectedEmbeddedEntry.content }}</pre>
                          <p
                            v-else
                            class="ktrp-muted"
                            data-testid="kt-rp-card-embedded-entry-content"
                          >{{ t('worldbookEntryEmptyContent') }}</p>
                        </div>
                      </div>
                    </template>
                  </template>
                </div>
              </div>

              <!-- One-Click Card Assets Preparation & Diagnostics -->
              <div
                v-if="detailScriptDependencies.length || detailSavedModules.length || detailRemoteOpeningPage"
                class="ktrp-card-box"
                data-testid="kt-rp-card-assets-box"
              >
                <div class="ktrp-row-between">
                  <div>
                    <h4 data-testid="kt-rp-card-assets-title">{{ t('cardAssetsSectionTitle') }}</h4>
                    <p class="ktrp-muted">{{ t('cardAssetsSectionHint') }}</p>
                  </div>
                  <ActionButton
                    v-if="detailHasPreparableAssets"
                    variant="primary"
                    size="sm"
                    :disabled="busy || preparingDetailAssets || openingPlanLoading"
                    data-testid="kt-rp-card-prepare-assets-btn"
                    @click="prepareDetailCardAssets"
                  >
                    {{
                      preparingDetailAssets
                        ? t('cardAssetsPreparingBtn')
                        : t('cardAssetsPrepareBtn')
                    }}
                  </ActionButton>
                </div>

                <div
                  v-if="detailAssetsError"
                  class="ktrp-banner ktrp-banner--error"
                  role="alert"
                  data-testid="kt-rp-card-assets-error"
                >
                  <span>{{ detailAssetsError }}</span>
                </div>

                <div
                  v-if="detailAssetIssues.length"
                  class="ktrp-field-block"
                  role="alert"
                  data-testid="kt-rp-card-assets-issues"
                >
                  <span class="ktrp-label">
                    {{ t('cardAssetsIssuesTitle', { count: detailAssetIssues.length }) }}
                  </span>
                  <div class="ktrp-stack">
                    <div
                      v-for="(issue, iIdx) in detailAssetIssues"
                      :key="iIdx"
                      class="ktrp-banner ktrp-banner--error"
                      :data-testid="'kt-rp-card-assets-issue-' + iIdx"
                      :data-issue-kind="issue.kind"
                    >
                      <span>
                        <strong v-if="assetIssueDisplayLabel(issue)">{{ assetIssueDisplayLabel(issue) }}: </strong>{{ assetIssueDisplayMessage(issue) }}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Card Script Module Dependencies & Saved Offline Snapshots -->
              <div
                v-if="detailScriptDependencies.length || detailSavedModules.length"
                class="ktrp-card-box"
                data-testid="kt-rp-card-script-deps"
              >
                <div class="ktrp-row-between">
                  <div>
                    <h4>{{ t('cardDepsDetailTitle') }}</h4>
                    <p class="ktrp-muted">{{ t('cardDepsDetailHint') }}</p>
                  </div>
                </div>

                <div class="ktrp-field-block" data-testid="kt-rp-card-saved-modules">
                  <span class="ktrp-label">
                    {{ t('cardDepsSavedModulesTitle', { count: detailSavedModules.length }) }}
                  </span>
                  <div v-if="detailSavedModules.length" class="ktrp-stack">
                    <div
                      v-for="(mod, mIdx) in detailSavedModules"
                      :key="mod.url"
                      class="ktrp-row-between"
                      :data-testid="'kt-rp-card-saved-module-' + mIdx"
                      :data-url="mod.url"
                    >
                      <code class="ktrp-pre" style="word-break: break-all;">{{ mod.url }}</code>
                      <span class="ktrp-chip ktrp-chip--accent">
                        {{ t('cardDepsRefKindHttpsSaved', { size: mod.size }) }}
                      </span>
                    </div>
                  </div>
                  <p v-else class="ktrp-muted" data-testid="kt-rp-card-no-saved-modules">
                    {{ t('cardDepsNoSavedModules') }}
                  </p>
                </div>

                <div
                  v-if="detailScriptDependencies.length"
                  class="ktrp-stack"
                  data-testid="kt-rp-card-script-deps-list"
                >
                  <div
                    v-for="script in detailScriptDependencies"
                    :key="script.scriptId"
                    class="ktrp-sub-card"
                    :data-testid="'kt-rp-card-script-dep-' + script.scriptId"
                  >
                    <div class="ktrp-row-between">
                      <strong>{{ script.name }}</strong>
                      <div class="ktrp-chip-row">
                        <span class="ktrp-chip">
                          {{
                            script.enabled
                              ? t('cardScriptsEntryEnabledBadge')
                              : t('cardScriptsEntryDisabledBadge')
                          }}
                        </span>
                        <span
                          v-if="script.syntaxError"
                          class="ktrp-chip"
                          :data-testid="'kt-rp-card-script-dep-syntax-error-' + script.scriptId"
                        >
                          {{ t('cardDepsScriptSyntaxErrorBadge') }}
                        </span>
                        <span
                          v-if="script.truncated"
                          class="ktrp-chip"
                          :data-testid="'kt-rp-card-script-dep-truncated-' + script.scriptId"
                        >
                          {{ t('cardDepsScriptTruncatedBadge') }}
                        </span>
                      </div>
                    </div>

                    <p
                      v-if="script.compatibilityNotes.includes('external_mvu_zod_schema')"
                      class="ktrp-muted"
                      :data-testid="'kt-rp-card-script-dep-note-zod-' + script.scriptId"
                    >
                      {{ t('cardDepsNoteExternalMvuZod') }}
                    </p>

                    <div
                      v-if="script.references.length"
                      class="ktrp-stack"
                      :data-testid="'kt-rp-card-script-dep-refs-' + script.scriptId"
                    >
                      <div
                        v-for="(refItem, rIdx) in script.references"
                        :key="rIdx"
                        class="ktrp-row-between"
                        :data-testid="'kt-rp-card-script-dep-ref-' + script.scriptId + '-' + rIdx"
                      >
                        <div class="ktrp-inline-actions" style="min-width: 0; flex: 1;">
                          <code class="ktrp-pre" style="word-break: break-all;">{{
                            refItem.specifier || t('cardDepsRefUnspecified')
                          }}</code>
                        </div>
                        <span
                          class="ktrp-chip"
                          :class="{ 'ktrp-chip--accent': refItem.selectable }"
                          :data-testid="'kt-rp-card-script-dep-kind-' + script.scriptId + '-' + rIdx"
                        >
                          {{
                            refItem.kind === 'https'
                              ? detailSavedModuleMap.has(refItem.specifier)
                                ? t('cardDepsRefKindHttpsSaved', {
                                    size: detailSavedModuleMap.get(refItem.specifier),
                                  })
                                : refItem.selectable
                                  ? t('cardDepsRefKindHttps')
                                  : t('cardDepsRefKindHttpsIneligible')
                              : refItem.kind === 'relative'
                                ? t('cardDepsRefKindRelative')
                                : t('cardDepsRefKindUnsupported')
                          }}
                        </span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Declared External Opening Page & Module Plan (only shown when detail.remoteOpeningPage exists) -->
              <div
                v-if="detailRemoteOpeningPage"
                class="ktrp-card-box"
                data-testid="kt-rp-card-opening-plan"
              >
                <div class="ktrp-row-between">
                  <div>
                    <div class="ktrp-inline-actions">
                      <h4 data-testid="kt-rp-card-opening-plan-title">
                        {{ t('openingPlanSectionTitle') }}
                      </h4>
                      <span
                        v-if="openingPlan"
                        class="ktrp-chip"
                        :class="{
                          'ktrp-chip--accent':
                            openingPlan.status === 'self_contained' ||
                            openingPlan.status === 'static_graph_complete',
                        }"
                        :data-status="openingPlan.status"
                        data-testid="kt-rp-card-opening-plan-status"
                      >
                        {{ openingPlanStatusLabel(openingPlan.status) }}
                      </span>
                    </div>
                    <p class="ktrp-muted">{{ t('openingPlanSectionHint') }}</p>
                  </div>
                  <ActionButton
                    size="sm"
                    variant="ghost"
                    :disabled="busy || openingPlanLoading || preparingDetailAssets"
                    data-testid="kt-rp-card-opening-plan-refresh-btn"
                    @click="loadOpeningModulePlan(selectedId)"
                  >
                    {{ openingPlanLoading ? t('loading') : t('openingPlanRefreshBtn') }}
                  </ActionButton>
                </div>

                <div
                  v-if="openingPlanError"
                  class="ktrp-banner ktrp-banner--error"
                  role="alert"
                  data-testid="kt-rp-card-opening-plan-error"
                >
                  <span>{{ openingPlanError }}</span>
                  <ActionButton
                    size="sm"
                    :disabled="busy || openingPlanLoading"
                    data-testid="kt-rp-card-opening-plan-retry-btn"
                    @click="loadOpeningModulePlan(selectedId)"
                  >
                    {{ t('retry') }}
                  </ActionButton>
                </div>

                <!-- Step 1: Declared external opening page HTML entry -->
                <div class="ktrp-sub-card" data-testid="kt-rp-card-opening-entry">
                  <div class="ktrp-row-between">
                    <div>
                      <strong>
                        {{ detailRemoteOpeningPage.title || t('openingPlanEntryDefaultTitle') }}
                      </strong>
                      <span v-if="detailRemoteOpeningPage.marker" class="ktrp-chip">
                        {{ detailRemoteOpeningPage.marker }}
                      </span>
                    </div>
                    <span
                      v-if="
                        detailRemoteOpeningPage.snapshot ||
                        (openingPlan && openingPlan.status !== 'entry_unconfirmed')
                      "
                      class="ktrp-chip ktrp-chip--accent"
                      data-testid="kt-rp-card-opening-entry-saved-badge"
                    >
                      {{
                        detailRemoteOpeningPage.snapshot
                          ? t('cardDepsRefKindHttpsSaved', {
                              size: detailRemoteOpeningPage.snapshot.size,
                            })
                          : t('openingPlanEntrySavedBadge')
                      }}
                    </span>
                  </div>
                  <code
                    class="ktrp-pre"
                    style="word-break: break-all;"
                    data-testid="kt-rp-card-opening-entry-url"
                  >{{ detailRemoteOpeningPage.url }}</code>
                </div>

                <p
                  v-if="openingPlanLoading && !openingPlan"
                  class="ktrp-muted"
                  role="status"
                  data-testid="kt-rp-card-opening-plan-loading"
                >
                  {{ t('loading') }}
                </p>

                <template v-if="openingPlan">
                  <p
                    v-if="openingPlan.status === 'static_graph_complete'"
                    class="ktrp-muted"
                    data-testid="kt-rp-card-opening-plan-complete-note"
                  >
                    {{ t('openingPlanStaticGraphCompleteNote') }}
                  </p>
                  <p
                    v-else-if="openingPlan.status === 'other_resources'"
                    class="ktrp-muted"
                    data-testid="kt-rp-card-opening-plan-other-resources-note"
                  >
                    {{ t('openingPlanOtherResourcesNote') }}
                  </p>
                  <p
                    v-else-if="openingPlan.status === 'unsupported'"
                    class="ktrp-muted"
                    data-testid="kt-rp-card-opening-plan-unsupported-note"
                  >
                    {{ t('openingPlanUnsupportedNote') }}
                  </p>

                  <!-- Saved opening page modules -->
                  <div
                    class="ktrp-field-block"
                    data-testid="kt-rp-card-opening-saved-modules"
                  >
                    <span class="ktrp-label">
                      {{ t('openingPlanSavedModulesTitle', { count: openingPlan.saved.length }) }}
                    </span>
                    <div v-if="openingPlan.saved.length" class="ktrp-stack">
                      <div
                        v-for="(mod, sIdx) in openingPlan.saved"
                        :key="mod.url"
                        class="ktrp-row-between"
                        :data-testid="'kt-rp-card-opening-saved-module-' + sIdx"
                        :data-url="mod.url"
                      >
                        <code class="ktrp-pre" style="word-break: break-all;">{{ mod.url }}</code>
                        <span class="ktrp-chip ktrp-chip--accent">
                          {{ t('cardDepsRefKindHttpsSaved', { size: mod.size }) }}
                        </span>
                      </div>
                    </div>
                    <p
                      v-else
                      class="ktrp-muted"
                      data-testid="kt-rp-card-opening-no-saved-modules"
                    >
                      {{ t('openingPlanNoSavedModules') }}
                    </p>
                  </div>

                  <!-- Pending opening page modules -->
                  <div
                    v-if="openingPlan.pending.length"
                    class="ktrp-field-block"
                    data-testid="kt-rp-card-opening-pending-modules"
                  >
                    <span class="ktrp-label">
                      {{ t('openingPlanPendingModulesTitle', { count: openingPlan.pending.length }) }}
                    </span>
                    <div class="ktrp-stack">
                      <div
                        v-for="(item, pIdx) in openingPlan.pending"
                        :key="item.url"
                        class="ktrp-sub-card"
                        :data-testid="'kt-rp-card-opening-pending-module-' + pIdx"
                        :data-url="item.url"
                        :data-parent-url="item.parentUrl || ''"
                      >
                        <code
                          class="ktrp-pre"
                          style="word-break: break-all;"
                          :data-testid="'kt-rp-card-opening-pending-url-' + pIdx"
                        >{{ item.url }}</code>
                        <p
                          v-if="item.parentUrl"
                          class="ktrp-muted"
                          :data-testid="'kt-rp-card-opening-pending-parent-' + pIdx"
                        >
                          {{ t('openingPlanPendingFromParent', { parentUrl: item.parentUrl }) }}
                        </p>
                        <p
                          v-else
                          class="ktrp-muted"
                          :data-testid="'kt-rp-card-opening-pending-parent-' + pIdx"
                        >
                          {{ t('openingPlanPendingFromEntry') }}
                        </p>
                      </div>
                    </div>
                  </div>
                </template>
              </div>

            <div class="ktrp-detail-sections">
                <div
                  v-if="detail.fields?.description"
                  class="ktrp-field-block ktrp-collapsible-block"
                  data-testid="kt-rp-detail-section-description"
                >
                  <button
                    type="button"
                    class="ktrp-collapse-toggle"
                    :aria-expanded="isDetailExpanded('description')"
                    data-testid="kt-rp-toggle-description"
                    @click="toggleDetailExpanded('description')"
                  >
                    <span class="ktrp-collapse-title">{{ t('descriptionLabel') }}</span>
                    <span class="ktrp-collapse-meta">
                      {{ isDetailExpanded('description') ? t('collapseFieldBtn') : t('expandFieldBtn') }}
                    </span>
                  </button>
                  <p
                    class="ktrp-pre ktrp-collapsible-body"
                    :class="{ 'is-collapsed': !isDetailExpanded('description') }"
                  >{{ detail.fields.description }}</p>
                </div>

                <div
                  v-if="detail.fields?.personality"
                  class="ktrp-field-block ktrp-collapsible-block"
                  data-testid="kt-rp-detail-section-personality"
                >
                  <button
                    type="button"
                    class="ktrp-collapse-toggle"
                    :aria-expanded="isDetailExpanded('personality')"
                    data-testid="kt-rp-toggle-personality"
                    @click="toggleDetailExpanded('personality')"
                  >
                    <span class="ktrp-collapse-title">{{ t('personalityLabel') }}</span>
                    <span class="ktrp-collapse-meta">
                      {{ isDetailExpanded('personality') ? t('collapseFieldBtn') : t('expandFieldBtn') }}
                    </span>
                  </button>
                  <p
                    class="ktrp-pre ktrp-collapsible-body"
                    :class="{ 'is-collapsed': !isDetailExpanded('personality') }"
                  >{{ detail.fields.personality }}</p>
                </div>

                <div
                  v-if="detail.fields?.scenario"
                  class="ktrp-field-block ktrp-collapsible-block"
                  data-testid="kt-rp-detail-section-scenario"
                >
                  <button
                    type="button"
                    class="ktrp-collapse-toggle"
                    :aria-expanded="isDetailExpanded('scenario')"
                    data-testid="kt-rp-toggle-scenario"
                    @click="toggleDetailExpanded('scenario')"
                  >
                    <span class="ktrp-collapse-title">{{ t('scenarioLabel') }}</span>
                    <span class="ktrp-collapse-meta">
                      {{ isDetailExpanded('scenario') ? t('collapseFieldBtn') : t('expandFieldBtn') }}
                    </span>
                  </button>
                  <p
                    class="ktrp-pre ktrp-collapsible-body"
                    :class="{ 'is-collapsed': !isDetailExpanded('scenario') }"
                  >{{ detail.fields.scenario }}</p>
                </div>

                <div
                  v-if="greetings.length"
                  class="ktrp-field-block ktrp-collapsible-block"
                  data-testid="kt-rp-detail-section-greetings"
                >
                  <button
                    type="button"
                    class="ktrp-collapse-toggle"
                    :aria-expanded="greetingsExpanded"
                    data-testid="kt-rp-toggle-greetings"
                    @click="toggleGreetingsExpanded"
                  >
                    <span class="ktrp-collapse-title">{{ t('greetingsLabel', { count: greetings.length }) }}</span>
                    <span class="ktrp-collapse-meta">
                      {{ greetingsExpanded ? t('collapseFieldBtn') : t('expandFieldBtn') }}
                    </span>
                  </button>
                  <div v-if="greetingsExpanded" class="ktrp-stack">
                    <div v-for="(greeting, idx) in greetings" :key="idx" class="ktrp-quote-box">
                      <span class="ktrp-quote-idx">#{{ idx + 1 }}</span>
                      <p class="ktrp-pre">{{ greeting }}</p>
                    </div>
                  </div>
                  <div v-else class="ktrp-quote-box ktrp-collapsible-preview">
                    <span class="ktrp-quote-idx">#1</span>
                    <p class="ktrp-pre ktrp-collapsible-body is-collapsed">{{ greetings[0] }}</p>
                  </div>
                </div>

                <div
                  v-if="detail.fields?.creator_notes"
                  class="ktrp-field-block ktrp-collapsible-block"
                  data-testid="kt-rp-detail-section-creator-notes"
                >
                  <button
                    type="button"
                    class="ktrp-collapse-toggle"
                    :aria-expanded="isDetailExpanded('creator_notes')"
                    data-testid="kt-rp-toggle-creator-notes"
                    @click="toggleDetailExpanded('creator_notes')"
                  >
                    <span class="ktrp-collapse-title">{{ t('creatorNotesLabel') }}</span>
                    <span class="ktrp-collapse-meta">
                      {{ isDetailExpanded('creator_notes') ? t('collapseFieldBtn') : t('expandFieldBtn') }}
                    </span>
                  </button>
                  <p
                    class="ktrp-pre ktrp-collapsible-body"
                    :class="{ 'is-collapsed': !isDetailExpanded('creator_notes') }"
                  >{{ detail.fields.creator_notes }}</p>
                </div>
              </div>

              <!-- Studio quick-launch controls (always visible in tab mode; settings mode shows one-click shortcut to Studio tab) -->
              <div v-if="props.mode !== 'tab'" class="ktrp-launch-section" data-testid="kt-rp-settings-launch-cta">
                <div class="ktrp-card-box">
                  <div class="ktrp-row-between">
                    <div>
                      <h4>{{ t('settingsLaunchTitle') }}</h4>
                      <p class="ktrp-muted">{{ t('settingsLaunchHint') }}</p>
                    </div>
                    <ActionButton
                      variant="primary"
                      size="sm"
                      icon="i-carbon-play"
                      data-testid="kt-rp-settings-open-studio-btn"
                      @click="openStudioTab"
                    >
                      {{ t('openStudioLibraryBtn') }}
                    </ActionButton>
                  </div>
                </div>
              </div>

              <!-- Studio launch controls (shown in tab mode) -->
              <div v-if="props.mode === 'tab'" class="ktrp-launch-section" data-testid="kt-rp-studio-launch">
                <div class="ktrp-card-box">
                  <h4>{{ t('studioLaunchTavernTitle') }}</h4>
                  <p class="ktrp-muted">{{ t('tavernSetupHint') }}</p>
                  <div class="ktrp-field-block">
                    <label class="ktrp-label" for="ktrp-studio-player-name">{{ t('playerName') }}</label>
                    <input
                      id="ktrp-studio-player-name"
                      v-model="tavernLaunchPlayer"
                      type="text"
                      class="ktrp-input"
                      data-testid="kt-rp-studio-player-name"
                    />
                  </div>
                  <div class="ktrp-field-block">
                    <label class="ktrp-label" for="ktrp-studio-player-desc">{{ t('playerDescription') }}</label>
                    <textarea
                      id="ktrp-studio-player-desc"
                      v-model="tavernLaunchDesc"
                      rows="2"
                      class="ktrp-textarea"
                      data-testid="kt-rp-studio-player-desc"
                    />
                  </div>
                  <div v-if="greetings.length" class="ktrp-field-block">
                    <label class="ktrp-label" for="ktrp-studio-greeting-select">{{ t('greetingSelect') }}</label>
                    <select
                      id="ktrp-studio-greeting-select"
                      v-model.number="tavernLaunchGreetingIndex"
                      class="ktrp-select"
                      data-testid="kt-rp-studio-greeting-select"
                    >
                      <option v-for="(_, idx) in greetings" :key="idx" :value="idx">
                        {{ idx === 0 ? t('greetingPrimary') : t('greetingAlternate', { index: idx + 1 }) }}
                      </option>
                    </select>
                  </div>
                  <div class="ktrp-field-block">
                    <label class="ktrp-label" for="ktrp-studio-worldbook-select">
                      {{ t('sessionWorldbookLaunchLabel') }}
                    </label>
                    <select
                      id="ktrp-studio-worldbook-select"
                      v-model="tavernLaunchWorldbookMode"
                      class="ktrp-select"
                      data-testid="kt-rp-studio-worldbook-select"
                    >
                      <option value="__default__">
                        {{
                          currentCardDefaultWorldbook
                            ? t('sessionWorldbookFollowDefault', { name: currentCardDefaultWorldbook.name })
                            : t('sessionWorldbookFollowDefaultNone')
                        }}
                      </option>
                      <option value="__none__">{{ t('sessionWorldbookExplicitNone') }}</option>
                      <option v-for="wb in worldbooks" :key="wb.id" :value="wb.id">
                        {{ t('sessionWorldbookLibraryPick', { name: wb.name }) }}
                      </option>
                    </select>
                  </div>
                  <div class="ktrp-field-block">
                    <label class="ktrp-label" for="ktrp-studio-scripts-select">
                      {{ t('sessionScriptsLaunchLabel') }}
                    </label>
                    <select
                      id="ktrp-studio-scripts-select"
                      v-model="tavernLaunchScriptsMode"
                      class="ktrp-select"
                      data-testid="kt-rp-studio-scripts-select"
                    >
                      <option value="__default__">
                        {{
                          cardScriptsDefault
                            ? t('sessionScriptsFollowDefaultOn')
                            : t('sessionScriptsFollowDefaultOff')
                        }}
                      </option>
                      <option value="on">{{ t('sessionScriptsExplicitOn') }}</option>
                      <option value="off">{{ t('sessionScriptsExplicitOff') }}</option>
                    </select>
                  </div>
                  <p
                    v-if="detailRemoteOpeningPage"
                    class="ktrp-muted"
                    data-testid="kt-rp-studio-opening-modules-note"
                  >
                    {{ t('studioLaunchCachedOpeningAutoHint') }}
                  </p>
                  <div class="ktrp-row-end">
                    <ActionButton
                      variant="primary"
                      size="sm"
                      :disabled="busy"
                      data-testid="kt-rp-studio-launch-tavern-btn"
                      @click="launchTavernFromCard"
                    >
                      {{ t('studioLaunchTavernBtn') }}
                    </ActionButton>
                  </div>
                </div>
              </div>
              </template>
            </template>
          </div>
        </div>

        <div v-if="props.mode === 'tab' && cards.length" class="ktrp-card-box" data-testid="kt-rp-studio-novel-builder">
          <div class="ktrp-row-between">
            <div>
              <h4>{{ t('studioLaunchNovelTitle') }}</h4>
              <p class="ktrp-muted">{{ t('studioLaunchNovelHint', { max: novelCastLimit }) }}</p>
            </div>
            <span class="ktrp-chip" :class="{ 'ktrp-chip--accent': novelCastAtLimit }" data-testid="kt-rp-novel-cast-count">
              {{ t('studioNovelSelectedCount', { count: novelCastIds.length, max: novelCastLimit }) }}
            </span>
          </div>
          <p v-if="novelCastAtLimit" class="ktrp-muted" data-testid="kt-rp-novel-cast-limit-hint">
            {{ t('studioNovelLimitReached', { max: novelCastLimit }) }}
          </p>

          <div class="ktrp-form-grid">
            <div class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-studio-novel-name">{{ t('studioNovelNameLabel') }}</label>
              <input
                id="ktrp-studio-novel-name"
                v-model="novelTitle"
                type="text"
                class="ktrp-input"
                :placeholder="t('novelDefaultTitle')"
                data-testid="kt-rp-studio-novel-name"
              />
            </div>

            <div class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-novel-player-mode">{{ t('novelPlayerModeLabel') }}</label>
              <select
                id="ktrp-novel-player-mode"
                v-model="novelPlayerMode"
                class="ktrp-select"
                data-testid="kt-rp-novel-player-mode"
              >
                <option value="protagonist">{{ t('novelPlayerModeProtagonist') }}</option>
                <option value="director">{{ t('novelPlayerModeDirector') }}</option>
              </select>
            </div>
          </div>

          <div v-if="novelPlayerMode === 'protagonist'" class="ktrp-sub-card" data-testid="kt-rp-novel-protagonist-fields">
            <div class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-novel-player-name">{{ t('novelPlayerNameLabel') }}</label>
              <input
                id="ktrp-novel-player-name"
                v-model="novelPlayerName"
                type="text"
                class="ktrp-input"
                maxlength="80"
                data-testid="kt-rp-novel-player-name"
              />
            </div>
            <div class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-novel-player-persona">{{ t('novelPlayerPersonaLabel') }}</label>
              <textarea
                id="ktrp-novel-player-persona"
                v-model="novelPlayerPersona"
                rows="2"
                class="ktrp-textarea"
                maxlength="4000"
                :placeholder="t('novelPlayerPersonaPlaceholder')"
                data-testid="kt-rp-novel-player-persona"
              />
            </div>
          </div>

          <div class="ktrp-field-block">
            <span class="ktrp-label">{{ t('novelCastTitle') }}</span>
            <div class="ktrp-cast-picker">
              <label
                v-for="card in cards"
                :key="card.id"
                class="ktrp-cast-check"
                :class="{ 'is-disabled': novelCastAtLimit && !novelCastIds.includes(card.id) }"
                :data-testid="'kt-rp-novel-pick-' + card.id"
              >
                <input
                  type="checkbox"
                  :checked="novelCastIds.includes(card.id)"
                  :disabled="novelCastAtLimit && !novelCastIds.includes(card.id)"
                  @change="toggleNovelCast(card.id)"
                />
                <span>{{ card.name }}</span>
              </label>
            </div>
            <p class="ktrp-muted" data-testid="kt-rp-novel-first-mes-note">
              {{ t('novelFirstMesIgnoredNote') }}
            </p>
          </div>

          <div class="ktrp-form-grid">
            <div class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-novel-narrator-card">{{ t('novelNarratorLabel') }}</label>
              <select
                id="ktrp-novel-narrator-card"
                v-model="novelNarratorCardId"
                class="ktrp-select"
                data-testid="kt-rp-novel-narrator-card"
              >
                <option value="__default__">{{ t('novelNarratorDefaultOption') }}</option>
                <option value="__none__">{{ t('novelNarratorNoneOption') }}</option>
                <option v-for="item in narratorCardOptions" :key="'narr-' + item.id" :value="item.id">
                  {{ item.label }}
                </option>
              </select>
            </div>

            <div class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-novel-style-card">{{ t('novelStyleCardLabel') }}</label>
              <select
                id="ktrp-novel-style-card"
                v-model="novelStyleCardId"
                class="ktrp-select"
                data-testid="kt-rp-novel-style-card"
              >
                <option value="">{{ t('novelStyleCardNoneOption') }}</option>
                <option v-for="item in styleCardOptions" :key="'style-' + item.id" :value="item.id">
                  {{ item.label }}
                </option>
              </select>
            </div>
          </div>

          <div
            v-if="novelNarratorCardId === '__default__'"
            class="ktrp-sub-card ktrp-default-narrator-card"
            data-testid="kt-rp-default-narrator-preview"
          >
            <div class="ktrp-default-narrator-head">
              <img
                :src="defaultNarrator.portraitUrl"
                :alt="defaultNarrator.name"
                class="ktrp-narrator-thumb"
                data-testid="kt-rp-default-narrator-thumb"
              />
              <div class="ktrp-default-narrator-meta">
                <div class="ktrp-row-between">
                  <strong>{{ defaultNarrator.name }}</strong>
                  <div class="ktrp-inline-actions">
                    <ActionButton
                      v-if="defaultNarrator.description || defaultNarrator.personality || defaultNarrator.examples"
                      size="sm"
                      variant="ghost"
                      :aria-expanded="String(defaultNarratorRulesExpanded)"
                      data-testid="kt-rp-default-narrator-rules-toggle"
                      @click="defaultNarratorRulesExpanded = !defaultNarratorRulesExpanded"
                    >
                      {{ defaultNarratorRulesExpanded ? t('novelDefaultNarratorCollapseBtn') : t('novelDefaultNarratorExpandBtn') }}
                    </ActionButton>
                    <ActionButton
                      size="sm"
                      :disabled="busy || copyingDefaultNarrator"
                      data-testid="kt-rp-copy-default-narrator"
                      @click="copyDefaultNarrator"
                    >
                      {{ copyingDefaultNarrator ? t('novelCopyingDefaultNarratorBtn') : t('novelCopyDefaultNarratorBtn') }}
                    </ActionButton>
                  </div>
                </div>
                <p v-if="defaultNarrator.description && !defaultNarratorRulesExpanded" class="ktrp-muted ktrp-narrator-summary">
                  {{ defaultNarrator.description }}
                </p>
              </div>
            </div>
            <div
              v-if="defaultNarratorRulesExpanded"
              class="ktrp-stack"
              data-testid="kt-rp-default-narrator-rules"
            >
              <p v-if="defaultNarrator.description" class="ktrp-muted ktrp-pre">{{ defaultNarrator.description }}</p>
              <p v-if="defaultNarrator.personality" class="ktrp-muted ktrp-pre">{{ defaultNarrator.personality }}</p>
              <pre v-if="defaultNarrator.examples" class="ktrp-quote-box ktrp-pre">{{ defaultNarrator.examples }}</pre>
            </div>
          </div>

          <div class="ktrp-field-block">
            <span class="ktrp-label">{{ t('novelWorldbooksLabel', { max: novelWorldbookLimit }) }}</span>
            <div
              v-if="worldbooks.length"
              class="ktrp-cast-picker"
              data-testid="kt-rp-novel-worldbooks"
            >
              <label
                v-for="wb in worldbooks"
                :key="wb.id"
                class="ktrp-cast-check"
                :class="{ 'is-disabled': novelWorldbooksAtLimit && !novelWorldbookIds.includes(wb.id) }"
              >
                <input
                  type="checkbox"
                  :checked="novelWorldbookIds.includes(wb.id)"
                  :disabled="novelWorldbooksAtLimit && !novelWorldbookIds.includes(wb.id)"
                  :data-testid="'kt-rp-novel-worldbook-' + wb.id"
                  @change="toggleNovelWorldbook(wb.id)"
                />
                <span>{{ wb.name }} ({{ wb.supportedEntries }}/{{ wb.totalEntries }})</span>
              </label>
            </div>
            <p v-else class="ktrp-muted" data-testid="kt-rp-novel-worldbooks">
              {{ t('novelWorldbooksEmpty') }}
            </p>
            <label class="ktrp-mvu-option">
              <input
                v-model="novelIncludeCardLore"
                type="checkbox"
                data-testid="kt-rp-novel-include-card-lore"
              />
              <span>{{ t('novelIncludeCardLoreLabel') }}</span>
            </label>
          </div>

          <div class="ktrp-field-block">
            <label class="ktrp-label" for="ktrp-novel-premise">{{ t('novelPremiseLabel') }}</label>
            <textarea
              id="ktrp-novel-premise"
              v-model="novelPremise"
              rows="2"
              class="ktrp-textarea"
              maxlength="8000"
              :placeholder="t('novelPremisePlaceholder')"
              data-testid="kt-rp-novel-premise"
            />
          </div>

          <div class="ktrp-field-block">
            <label class="ktrp-label" for="ktrp-novel-sheet-hint">{{ t('novelSheetHintLabel') }}</label>
            <input
              id="ktrp-novel-sheet-hint"
              v-model="novelSheetHint"
              type="text"
              class="ktrp-input"
              maxlength="1000"
              :placeholder="t('novelSheetHintPlaceholder')"
              data-testid="kt-rp-novel-sheet-hint"
            />
          </div>

          <div class="ktrp-field-block">
            <label class="ktrp-label" for="ktrp-novel-prologue-mode">{{ t('novelPrologueModeLabel') }}</label>
            <select
              id="ktrp-novel-prologue-mode"
              v-model="novelPrologueMode"
              class="ktrp-select"
              data-testid="kt-rp-novel-prologue-mode"
            >
              <option value="none">{{ t('novelPrologueNone') }}</option>
              <option value="static">{{ t('novelPrologueStatic') }}</option>
              <option value="prompt">{{ t('novelProloguePrompt') }}</option>
            </select>
          </div>

          <div v-if="novelPrologueMode === 'static'" class="ktrp-sub-card" data-testid="kt-rp-novel-prologue-static">
            <div class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-novel-prologue-title">{{ t('novelPrologueTitleLabel') }}</label>
              <input
                id="ktrp-novel-prologue-title"
                v-model="novelPrologueTitle"
                type="text"
                class="ktrp-input"
                maxlength="200"
                :placeholder="t('novelPrologueTitleDefault')"
                data-testid="kt-rp-novel-prologue-title"
              />
            </div>
            <div class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-novel-prologue-text">{{ t('novelPrologueTextLabel') }}</label>
              <textarea
                id="ktrp-novel-prologue-text"
                v-model="novelPrologueText"
                rows="4"
                class="ktrp-textarea"
                maxlength="20000"
                :placeholder="t('novelPrologueTextPlaceholder')"
                data-testid="kt-rp-novel-prologue-text"
              />
            </div>
          </div>

          <div v-else-if="novelPrologueMode === 'prompt'" class="ktrp-sub-card" data-testid="kt-rp-novel-prologue-prompt-box">
            <div class="ktrp-field-block">
              <label class="ktrp-label" for="ktrp-novel-prologue-prompt">{{ t('novelProloguePromptLabel') }}</label>
              <textarea
                id="ktrp-novel-prologue-prompt"
                v-model="novelProloguePrompt"
                rows="3"
                class="ktrp-textarea"
                maxlength="4000"
                :placeholder="t('novelProloguePromptPlaceholder')"
                data-testid="kt-rp-novel-prologue-prompt"
              />
            </div>
          </div>

          <div class="ktrp-row-end">
            <ActionButton
              variant="primary"
              size="sm"
              :disabled="busy || !novelCastIds.length"
              data-testid="kt-rp-studio-launch-novel-btn"
              @click="launchNovelFromCast"
            >
              {{ t('studioLaunchNovelBtn') }}
            </ActionButton>
          </div>
        </div>

        <SettingsGroup :title="t('usageGuideTitle')">
          <SettingsRow :title="t('modePersona')" :hint="t('usageGuidePersona')" />
          <SettingsRow :title="t('modeTavern')" :hint="t('usageGuideTavern')" />
          <SettingsRow :title="t('modeNovel')" :hint="t('usageGuideNovel')" />
        </SettingsGroup>
      </template>
    </section>
  `,
};
