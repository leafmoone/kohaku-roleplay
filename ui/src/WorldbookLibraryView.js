import { computed, ref, watch } from "vue";
import {
  ActionButton,
  confirm,
  notify,
  openTab,
  useOwner,
} from "@kohakuterrarium/ui-sdk";

import {
  DEFAULT_MAX_WORLDBOOK_BYTES,
  base64ToUint8Array,
  normalizeWorldbookDiagnostics,
  normalizeWorldbookEntries,
  readFileAsBase64,
  sanitizeDownloadFilename,
  stripWorldbookExtension,
  validateWorldbookFile,
} from "./helpers.js";
import { useRoleplayText } from "./strings.js";

function formatIssueLabel(t, code, count) {
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

export const WorldbookLibraryView = {
  name: "RoleplayWorldbookLibraryView",
  components: {
    ActionButton,
  },
  setup() {
    const owner = useOwner();
    const t = useRoleplayText();

    const fileInput = ref(null);
    const query = ref("");
    const selectedId = ref("");
    const detail = ref(null);
    const detailLoading = ref(false);
    const detailError = ref("");
    const detailReloadTick = ref(0);
    const busy = ref(false);
    const exporting = ref(false);
    const actionError = ref("");
    const pendingImportedBook = ref(null);

    const previewDraft = ref(null);
    const previewName = ref("");

    const entryQuery = ref("");
    const entryFilter = ref("all");
    const selectedEntryIndex = ref(null);

    let detailSeq = 0;
    let previewSeq = 0;

    const state = computed(() => owner.state.value || {});
    const maxWorldbookBytes = computed(
      () => Number(state.value.maxWorldbookBytes) || DEFAULT_MAX_WORLDBOOK_BYTES,
    );
    const maxWorldbookMiB = computed(
      () => Math.round((maxWorldbookBytes.value / (1024 * 1024)) * 10) / 10,
    );
    const worldbooks = computed(() =>
      Array.isArray(state.value.worldbooks) ? state.value.worldbooks : [],
    );
    const filteredWorldbooks = computed(() => {
      const q = query.value.trim().toLowerCase();
      if (!q) return worldbooks.value;
      return worldbooks.value.filter((wb) =>
        String(wb.name || "").toLowerCase().includes(q),
      );
    });
    const selectedWorldbook = computed(
      () => worldbooks.value.find((wb) => wb.id === selectedId.value) || null,
    );

    const isPreviewMode = computed(() => Boolean(previewDraft.value));
    const activeBook = computed(() => {
      if (previewDraft.value) {
        return previewDraft.value;
      }
      return detail.value;
    });
    const activeDiagnostics = computed(() =>
      normalizeWorldbookDiagnostics(activeBook.value?.diagnostics),
    );
    const activeEntries = computed(() =>
      normalizeWorldbookEntries(activeBook.value?.entries),
    );
    const supportedEntriesCount = computed(
      () => activeEntries.value.filter((entry) => !entry.issue).length,
    );
    const issueEntriesCount = computed(
      () => activeEntries.value.filter((entry) => Boolean(entry.issue)).length,
    );
    const filteredEntries = computed(() => {
      const mode = entryFilter.value;
      const q = entryQuery.value.trim().toLowerCase();
      return activeEntries.value.filter((entry) => {
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
    const selectedEntry = computed(() => {
      const list = filteredEntries.value;
      if (!list.length) return null;
      return (
        list.find((entry) => entry.index === selectedEntryIndex.value) ||
        list[0]
      );
    });

    watch(
      worldbooks,
      (list) => {
        if (!list.length) {
          selectedId.value = "";
          detail.value = null;
          return;
        }
        if (!list.some((wb) => wb.id === selectedId.value)) {
          selectedId.value = list[0].id;
        }
      },
      { immediate: true },
    );

    watch(
      filteredEntries,
      (list) => {
        if (!list.length) {
          selectedEntryIndex.value = null;
          return;
        }
        if (!list.some((entry) => entry.index === selectedEntryIndex.value)) {
          selectedEntryIndex.value = list[0].index;
        }
      },
      { immediate: true },
    );

    watch(
      () => [selectedId.value, owner.status.value, detailReloadTick.value],
      async ([id, status], _, onCleanup) => {
        let stale = false;
        onCleanup(() => {
          stale = true;
        });
        const seq = ++detailSeq;
        detailError.value = "";
        if (!id || status !== "ready") {
          detail.value = null;
          detailLoading.value = false;
          return;
        }
        detailLoading.value = true;
        try {
          const result = await owner.call("worldbook_detail", { id });
          if (!stale && seq === detailSeq) {
            detail.value = result
              ? {
                  ...result,
                  diagnostics: normalizeWorldbookDiagnostics(result.diagnostics),
                  entries: normalizeWorldbookEntries(result.entries),
                }
              : null;
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

    function resetEntryFilters() {
      entryQuery.value = "";
      entryFilter.value = "all";
      selectedEntryIndex.value = null;
    }

    function retryDetailLoad() {
      if (!selectedId.value) return;
      detailReloadTick.value += 1;
    }

    function selectWorldbook(id) {
      if (busy.value) return;
      previewSeq += 1;
      previewDraft.value = null;
      previewName.value = "";
      actionError.value = "";
      pendingImportedBook.value = null;
      resetEntryFilters();
      if (selectedId.value === id) {
        if (!detail.value || detailError.value) {
          detailReloadTick.value += 1;
        }
      } else {
        selectedId.value = id;
      }
    }

    function selectEntry(index) {
      selectedEntryIndex.value = index;
    }

    function openCardLibraryTab() {
      try {
        openTab("kohaku-roleplay/studio");
      } catch (err) {
        actionError.value = err?.message || String(err);
      }
    }

    function triggerChooseFile() {
      if (busy.value) return;
      fileInput.value?.click();
    }

    async function handleFileChange(event) {
      const file = event.target?.files?.[0];
      if (event.target) event.target.value = "";
      if (!file || busy.value) return;

      // Clear any previous preview draft immediately when starting a new file selection
      // so a failed B parse can never leave stale draft A available for confirmImport.
      const seq = ++previewSeq;
      previewDraft.value = null;
      previewName.value = "";
      actionError.value = "";
      pendingImportedBook.value = null;
      resetEntryFilters();

      const check = validateWorldbookFile(file, maxWorldbookBytes.value);
      if (!check.ok) {
        actionError.value =
          check.code === "type"
            ? t("worldbookInvalidType")
            : t("worldbookSizeLimitError", { mb: maxWorldbookMiB.value });
        return;
      }

      const defaultName = stripWorldbookExtension(file.name);
      busy.value = true;
      try {
        const base64 = await readFileAsBase64(file);
        const result = await owner.call("preview_worldbook", {
          data: base64,
          name: defaultName,
        });
        if (seq !== previewSeq) return;
        const resolvedName =
          typeof result?.name === "string" && result.name.trim()
            ? result.name.trim()
            : defaultName;
        resetEntryFilters();
        previewName.value = resolvedName;
        previewDraft.value = {
          data: base64,
          name: resolvedName,
          diagnostics: normalizeWorldbookDiagnostics(result?.diagnostics),
          entries: normalizeWorldbookEntries(result?.entries),
        };
      } catch (err) {
        if (seq === previewSeq) {
          previewDraft.value = null;
          previewName.value = "";
          actionError.value = err?.message || String(err);
        }
      } finally {
        if (seq === previewSeq) {
          busy.value = false;
        }
      }
    }

    function discardPreview() {
      if (busy.value) return;
      previewSeq += 1;
      previewDraft.value = null;
      previewName.value = "";
      actionError.value = "";
      resetEntryFilters();
    }

    async function confirmImport() {
      const draft = previewDraft.value;
      if (!draft || busy.value) return;
      const finalName = previewName.value.trim() || draft.name;
      const seq = ++previewSeq;
      busy.value = true;
      actionError.value = "";
      pendingImportedBook.value = null;
      try {
        const imported = await owner.call("import_worldbook", {
          data: draft.data,
          name: finalName,
        });
        const importedId = typeof imported?.id === "string" ? imported.id : "";
        const importedName =
          typeof imported?.name === "string" && imported.name.trim()
            ? imported.name.trim()
            : finalName;
        previewDraft.value = null;
        previewName.value = "";
        resetEntryFilters();
        const refreshed = await owner.refresh();
        if (!refreshed || owner.status.value !== "ready") {
          pendingImportedBook.value = { id: importedId, name: importedName };
          return;
        }
        pendingImportedBook.value = null;
        if (importedId) {
          if (selectedId.value === importedId) {
            detailReloadTick.value += 1;
          } else {
            selectedId.value = importedId;
          }
        }
        notify(t("worldbookImportedToast"), "success");
      } catch (err) {
        actionError.value = err?.message || String(err);
      } finally {
        if (seq === previewSeq) {
          busy.value = false;
        }
      }
    }

    async function exportSelectedWorldbook() {
      const wb = selectedWorldbook.value;
      if (!wb || isPreviewMode.value || busy.value || exporting.value) return;
      exporting.value = true;
      actionError.value = "";
      try {
        const result = await owner.call("export_worldbook", { id: wb.id });
        const bytes = base64ToUint8Array(result?.data);
        const blob = new Blob([bytes], { type: "application/json" });
        const filename = sanitizeDownloadFilename(result?.name || wb.name, "json");
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

    async function removeSelectedWorldbook() {
      const wb = selectedWorldbook.value;
      if (!wb || isPreviewMode.value || busy.value || exporting.value) return;
      const accepted = await confirm(
        t("worldbookRemoveConfirm", { name: wb.name }),
        t("worldbookRemoveTitle"),
      );
      if (!accepted) return;

      busy.value = true;
      actionError.value = "";
      pendingImportedBook.value = null;
      try {
        const nextState = await owner.call("remove_worldbook", { id: wb.id });
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
        notify(t("worldbookRemovedToast"), "success");
      } catch (err) {
        actionError.value = err?.message || String(err);
      } finally {
        busy.value = false;
      }
    }

    async function refreshLibrary() {
      if (busy.value) return;
      actionError.value = "";
      const pending = pendingImportedBook.value;
      try {
        const refreshed = await owner.refresh();
        if (!refreshed || owner.status.value !== "ready") {
          return;
        }
        if (pending) {
          pendingImportedBook.value = null;
          if (pending.id) {
            if (selectedId.value === pending.id) {
              detailReloadTick.value += 1;
            } else {
              selectedId.value = pending.id;
            }
          }
          notify(t("worldbookImportedToast"), "success");
          return;
        }
        if (selectedId.value && (!detail.value || detailError.value)) {
          detailReloadTick.value += 1;
        }
      } catch (err) {
        actionError.value = err?.message || String(err);
      }
    }

    function issueLabel(code, count = 1) {
      return formatIssueLabel(t, code, count);
    }

    return {
      owner,
      t,
      fileInput,
      query,
      selectedId,
      selectedWorldbook,
      detail,
      detailLoading,
      detailError,
      busy,
      exporting,
      actionError,
      pendingImportedBook,
      previewDraft,
      previewName,
      isPreviewMode,
      activeBook,
      activeDiagnostics,
      activeEntries,
      supportedEntriesCount,
      issueEntriesCount,
      entryQuery,
      entryFilter,
      filteredEntries,
      selectedEntry,
      selectedEntryIndex,
      maxWorldbookMiB,
      worldbooks,
      filteredWorldbooks,
      selectWorldbook,
      selectEntry,
      retryDetailLoad,
      openCardLibraryTab,
      triggerChooseFile,
      handleFileChange,
      discardPreview,
      confirmImport,
      exportSelectedWorldbook,
      removeSelectedWorldbook,
      refreshLibrary,
      issueLabel,
    };
  },
  template: `
    <section
      class="ktrp-library ktrp-library--tab"
      :aria-label="t('worldbookLibraryTitle')"
      :aria-busy="busy"
      data-testid="kt-rp-worldbook-library"
    >
      <div class="ktrp-library-banner" data-testid="kt-rp-wb-discovery">
        <div class="ktrp-library-banner-copy">
          <p class="ktrp-muted">{{ t('worldbookLibraryScope') }}</p>
        </div>
        <div class="ktrp-library-banner-actions">
          <ActionButton
            size="sm"
            variant="ghost"
            icon="i-carbon-book"
            data-testid="kt-rp-open-cards-tab-btn"
            @click="openCardLibraryTab"
          >
            {{ t('openCardLibraryBtn') }}
          </ActionButton>
        </div>
      </div>

      <div
        v-if="pendingImportedBook"
        class="ktrp-banner ktrp-banner--info"
        role="alert"
        data-testid="kt-rp-wb-imported-refresh-error"
      >
        <span>
          {{ t('worldbookImportedRefreshFailed', { name: pendingImportedBook.name }) }}
          <small v-if="owner.error.value">{{ owner.error.value }}</small>
        </span>
        <div class="ktrp-inline-actions">
          <ActionButton
            size="sm"
            variant="primary"
            :disabled="busy"
            data-testid="kt-rp-wb-imported-refresh-retry-btn"
            @click="refreshLibrary"
          >
            {{ t('worldbookRetryRefreshBtn') }}
          </ActionButton>
          <ActionButton
            size="sm"
            variant="ghost"
            :disabled="busy"
            data-testid="kt-rp-wb-imported-refresh-dismiss-btn"
            @click="pendingImportedBook = null"
          >
            {{ t('dismissBtn') }}
          </ActionButton>
        </div>
      </div>

      <div
        v-if="!pendingImportedBook && (owner.status.value === 'error' || owner.status.value === 'absent')"
        class="ktrp-banner ktrp-banner--error"
        role="alert"
        data-testid="kt-rp-wb-load-error"
      >
        <span>{{ t('loadFailed') }} <small v-if="owner.error.value">{{ owner.error.value }}</small></span>
        <ActionButton size="sm" @click="refreshLibrary">{{ t('retry') }}</ActionButton>
      </div>

      <p
        v-else-if="owner.status.value !== 'ready'"
        class="ktrp-muted"
        role="status"
        data-testid="kt-rp-wb-loading"
      >
        {{ t('loading') }}
      </p>

      <template v-else>
        <div
          v-if="actionError"
          class="ktrp-banner ktrp-banner--error"
          role="alert"
          data-testid="kt-rp-wb-action-error"
        >
          <span>{{ t('actionFailed') }}: {{ actionError }}</span>
          <ActionButton size="sm" @click="actionError = ''">{{ t('dismissBtn') }}</ActionButton>
        </div>

        <div class="ktrp-row-between">
          <div>
            <h3>{{ t('worldbookLibraryTitle') }}</h3>
            <p class="ktrp-muted">{{ t('worldbookSupportedHint', { mb: maxWorldbookMiB }) }}</p>
          </div>
          <div class="ktrp-inline-actions">
            <ActionButton
              size="sm"
              variant="ghost"
              icon="i-carbon-renew"
              :disabled="busy"
              data-testid="kt-rp-wb-refresh-btn"
              @click="refreshLibrary"
            >
              {{ t('refresh') }}
            </ActionButton>
            <ActionButton
              variant="primary"
              size="sm"
              :disabled="busy"
              data-testid="kt-rp-wb-choose-file-btn"
              @click="triggerChooseFile"
            >
              {{ busy && !isPreviewMode ? t('worldbookPreviewing') : t('worldbookChooseFileBtn') }}
            </ActionButton>
            <input
              ref="fileInput"
              type="file"
              accept=".json,application/json"
              hidden
              tabindex="-1"
              :disabled="busy"
              data-testid="kt-rp-wb-file-input"
              @change="handleFileChange"
            />
          </div>
        </div>

        <div class="ktrp-library-split">
          <div class="ktrp-card-pane">
            <div class="ktrp-pane-head">
              <input
                v-model="query"
                type="search"
                class="ktrp-input"
                :placeholder="t('worldbookSearchPlaceholder')"
                data-testid="kt-rp-wb-search"
              />
              <span class="ktrp-count" data-testid="kt-rp-wb-count">
                {{ t('worldbookCount', { count: filteredWorldbooks.length }) }}
              </span>
            </div>

            <div v-if="!worldbooks.length" class="ktrp-empty" data-testid="kt-rp-wb-empty">
              {{ t('worldbookEmptyLibrary') }}
            </div>
            <div v-else-if="!filteredWorldbooks.length" class="ktrp-empty" data-testid="kt-rp-wb-no-match">
              {{ t('worldbookNoMatches') }}
            </div>
            <div
              v-else
              class="ktrp-card-grid"
              role="listbox"
              :aria-label="t('worldbookLibraryTitle')"
              data-testid="kt-rp-wb-list"
            >
              <button
                v-for="wb in filteredWorldbooks"
                :key="wb.id"
                type="button"
                class="ktrp-card-tile"
                role="option"
                :disabled="busy"
                :aria-selected="!isPreviewMode && wb.id === selectedId"
                :data-testid="'kt-rp-wb-item-' + wb.id"
                @click="selectWorldbook(wb.id)"
              >
                <div class="ktrp-card-tile-meta">
                  <span class="ktrp-card-tile-name">{{ wb.name }}</span>
                  <span class="ktrp-chip-row">
                    <span class="ktrp-chip">
                      {{ t('worldbookEntriesCount', { count: wb.totalEntries }) }}
                    </span>
                    <span class="ktrp-chip ktrp-chip--accent">
                      {{ wb.supportedEntries }}/{{ wb.totalEntries }}
                    </span>
                  </span>
                </div>
              </button>
            </div>
          </div>

          <div class="ktrp-detail-pane" data-testid="kt-rp-wb-detail">
            <div
              v-if="isPreviewMode"
              class="ktrp-banner ktrp-banner--info"
              data-testid="kt-rp-wb-preview-bar"
            >
              <div class="ktrp-stack" style="flex: 1;">
                <span class="ktrp-chip ktrp-chip--accent" data-testid="kt-rp-wb-preview-badge">
                  {{ t('worldbookPreviewBadge') }}
                </span>
                <div class="ktrp-field-block">
                  <label class="ktrp-label" for="ktrp-wb-preview-name">
                    {{ t('worldbookNameInputLabel') }}
                  </label>
                  <input
                    id="ktrp-wb-preview-name"
                    v-model="previewName"
                    type="text"
                    class="ktrp-input"
                    :disabled="busy"
                    data-testid="kt-rp-wb-preview-name-input"
                  />
                </div>
              </div>
              <div class="ktrp-inline-actions">
                <ActionButton
                  variant="primary"
                  size="sm"
                  :disabled="busy"
                  data-testid="kt-rp-wb-confirm-import-btn"
                  @click="confirmImport"
                >
                  {{ busy ? t('importing') : t('worldbookConfirmImportBtn') }}
                </ActionButton>
                <ActionButton
                  size="sm"
                  variant="ghost"
                  :disabled="busy"
                  data-testid="kt-rp-wb-cancel-preview-btn"
                  @click="discardPreview"
                >
                  {{ t('worldbookCancelPreviewBtn') }}
                </ActionButton>
              </div>
            </div>

            <div
              v-if="!isPreviewMode && !selectedWorldbook"
              class="ktrp-empty"
              data-testid="kt-rp-wb-select-hint"
            >
              {{ t('worldbookSelectHint') }}
            </div>
            <div
              v-else-if="!isPreviewMode && detailLoading"
              class="ktrp-empty"
              role="status"
            >
              {{ t('loading') }}
            </div>
            <div
              v-else-if="!isPreviewMode && detailError"
              class="ktrp-banner ktrp-banner--error"
              role="alert"
              data-testid="kt-rp-wb-detail-error"
            >
              <span>{{ detailError }}</span>
              <ActionButton
                size="sm"
                data-testid="kt-rp-wb-detail-retry-btn"
                @click="retryDetailLoad"
              >
                {{ t('retry') }}
              </ActionButton>
            </div>
            <template v-else-if="activeBook">
              <div class="ktrp-detail-header" data-testid="kt-rp-wb-detail-header">
                <div class="ktrp-row-between">
                  <div class="ktrp-detail-title">
                    <h3 data-testid="kt-rp-wb-detail-title">
                      {{ isPreviewMode ? (previewName || activeBook.name) : activeBook.name }}
                    </h3>
                    <div v-if="activeDiagnostics" class="ktrp-stack" data-testid="kt-rp-wb-diagnostics">
                      <span class="ktrp-muted" data-testid="kt-rp-wb-diag-summary">
                        {{
                          t('worldbookDiagSummary', {
                            supported: activeDiagnostics.supportedEntries,
                            total: activeDiagnostics.totalEntries,
                            skipped: activeDiagnostics.skippedEntries,
                          })
                        }}
                      </span>
                      <div
                        v-if="activeDiagnostics.issues.length"
                        class="ktrp-chip-row"
                        data-testid="kt-rp-wb-diag-issues"
                      >
                        <span
                          v-for="issue in activeDiagnostics.issues"
                          :key="issue.code"
                          class="ktrp-chip"
                          :data-testid="'kt-rp-wb-diag-issue-' + issue.code"
                        >
                          {{ issueLabel(issue.code, issue.count) }}
                        </span>
                      </div>
                      <span v-else class="ktrp-muted">
                        {{ t('worldbookDiagAllSupported') }}
                      </span>
                    </div>
                  </div>
                  <div v-if="!isPreviewMode && selectedWorldbook" class="ktrp-detail-actions">
                    <ActionButton
                      size="sm"
                      :disabled="busy || exporting"
                      data-testid="kt-rp-wb-export-btn"
                      @click="exportSelectedWorldbook"
                    >
                      {{ exporting ? t('exportingCard') : t('worldbookExportBtn') }}
                    </ActionButton>
                    <ActionButton
                      variant="danger"
                      size="sm"
                      :disabled="busy || exporting"
                      data-testid="kt-rp-wb-remove-btn"
                      @click="removeSelectedWorldbook"
                    >
                      {{ t('worldbookRemoveBtn') }}
                    </ActionButton>
                  </div>
                </div>
              </div>

              <div class="ktrp-card-box" data-testid="kt-rp-wb-entries-section">
                <div class="ktrp-row-between">
                  <h4>{{ t('worldbookEntriesDirectoryTitle', { count: activeEntries.length }) }}</h4>
                  <div class="ktrp-inline-actions">
                    <button
                      type="button"
                      class="ktrp-chip"
                      :class="{ 'ktrp-chip--accent': entryFilter === 'all' }"
                      data-testid="kt-rp-wb-entry-filter-all"
                      @click="entryFilter = 'all'"
                    >
                      {{ t('worldbookFilterAll', { count: activeEntries.length }) }}
                    </button>
                    <button
                      type="button"
                      class="ktrp-chip"
                      :class="{ 'ktrp-chip--accent': entryFilter === 'supported' }"
                      data-testid="kt-rp-wb-entry-filter-supported"
                      @click="entryFilter = 'supported'"
                    >
                      {{ t('worldbookFilterSupported', { count: supportedEntriesCount }) }}
                    </button>
                    <button
                      type="button"
                      class="ktrp-chip"
                      :class="{ 'ktrp-chip--accent': entryFilter === 'issues' }"
                      data-testid="kt-rp-wb-entry-filter-issues"
                      @click="entryFilter = 'issues'"
                    >
                      {{ t('worldbookFilterIssues', { count: issueEntriesCount }) }}
                    </button>
                  </div>
                </div>

                <div class="ktrp-field-block">
                  <input
                    v-model="entryQuery"
                    type="search"
                    class="ktrp-input"
                    :placeholder="t('worldbookEntrySearchPlaceholder')"
                    data-testid="kt-rp-wb-entry-search"
                  />
                </div>

                <div
                  v-if="!activeEntries.length"
                  class="ktrp-empty"
                  data-testid="kt-rp-wb-entries-empty"
                >
                  {{ t('worldbookNoEntries') }}
                </div>
                <div
                  v-else-if="!filteredEntries.length"
                  class="ktrp-empty"
                  data-testid="kt-rp-wb-entries-no-match"
                >
                  {{ t('worldbookNoEntryMatches') }}
                </div>
                <template v-else>
                  <div
                    class="ktrp-card-grid"
                    role="listbox"
                    :aria-label="t('worldbookEntriesDirectoryTitle', { count: filteredEntries.length })"
                    data-testid="kt-rp-wb-entry-list"
                  >
                    <button
                      v-for="entry in filteredEntries"
                      :key="entry.index"
                      type="button"
                      class="ktrp-card-tile"
                      role="option"
                      :aria-selected="selectedEntry && entry.index === selectedEntry.index"
                      :data-testid="'kt-rp-wb-entry-item-' + entry.index"
                      @click="selectEntry(entry.index)"
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
                          <span v-if="entry.issue" class="ktrp-chip" :data-testid="'kt-rp-wb-entry-issue-' + entry.index">
                            {{ issueLabel(entry.issue, 1) }}
                          </span>
                          <span v-else class="ktrp-chip ktrp-chip--accent">
                            {{ t('worldbookEntrySupportedBadge') }}
                          </span>
                        </span>
                      </div>
                    </button>
                  </div>

                  <div
                    v-if="selectedEntry"
                    class="ktrp-field-block"
                    data-testid="kt-rp-wb-entry-detail"
                  >
                    <h4 data-testid="kt-rp-wb-entry-title">
                      {{ selectedEntry.name || t('worldbookEntryUntitled', { index: selectedEntry.index + 1 }) }}
                    </h4>
                    <div class="ktrp-chip-row" data-testid="kt-rp-wb-entry-badges">
                      <span class="ktrp-chip">
                        {{ selectedEntry.enabled ? t('worldbookEntryEnabledBadge') : t('worldbookEntryDisabledBadge') }}
                      </span>
                      <span v-if="selectedEntry.position" class="ktrp-chip">
                        {{ t('worldbookEntryPositionLabel', { position: selectedEntry.position }) }}
                      </span>
                      <span v-if="selectedEntry.issue" class="ktrp-chip" data-testid="kt-rp-wb-entry-detail-issue">
                        {{ issueLabel(selectedEntry.issue, 1) }}
                      </span>
                      <span v-else class="ktrp-chip ktrp-chip--accent">
                        {{ t('worldbookEntrySupportedBadge') }}
                      </span>
                    </div>

                    <div class="ktrp-field-block" data-testid="kt-rp-wb-entry-keys">
                      <span class="ktrp-label">{{ t('worldbookEntryPrimaryKeys') }}</span>
                      <div v-if="selectedEntry.keys.length" class="ktrp-tag-list">
                        <span v-for="(k, idx) in selectedEntry.keys" :key="idx" class="ktrp-tag">{{ k }}</span>
                      </div>
                      <p v-else class="ktrp-muted">{{ t('worldbookEntryNoKeys') }}</p>
                    </div>

                    <div
                      v-if="selectedEntry.secondaryKeys.length"
                      class="ktrp-field-block"
                      data-testid="kt-rp-wb-entry-secondary-keys"
                    >
                      <span class="ktrp-label">{{ t('worldbookEntrySecondaryKeys') }}</span>
                      <div class="ktrp-tag-list">
                        <span v-for="(k, idx) in selectedEntry.secondaryKeys" :key="idx" class="ktrp-tag">{{ k }}</span>
                      </div>
                    </div>

                    <div class="ktrp-field-block">
                      <span class="ktrp-label">{{ t('worldbookEntryContentTitle') }}</span>
                      <pre
                        v-if="selectedEntry.content"
                        class="ktrp-pre"
                        data-testid="kt-rp-wb-entry-content"
                      >{{ selectedEntry.content }}</pre>
                      <p
                        v-else
                        class="ktrp-muted"
                        data-testid="kt-rp-wb-entry-content"
                      >{{ t('worldbookEntryEmptyContent') }}</p>
                    </div>
                  </div>
                </template>
              </div>
            </template>
          </div>
        </div>
      </template>
    </section>
  `,
};
