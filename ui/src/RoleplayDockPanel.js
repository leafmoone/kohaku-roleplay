import { computed, ref, watch } from "vue";
import { ActionButton, confirm, notify, openTab, useCreature, useOwner, useSession } from "@kohakuterrarium/ui-sdk";

import {
  collectGreetings,
  expandPlaceholders,
  extractSafePersonaDraft,
  normalizeStateFields,
  projectNovelView,
} from "./helpers.js";
import { CardMediaGallery } from "./CardMediaGallery.js";
import { MvuPanel } from "./MvuPanel.js";
import { PortraitFrame } from "./PortraitFrame.js";
import { StateFieldsView } from "./StateFieldsView.js";
import { useRoleplayText } from "./strings.js";

/**
 * Creature-scoped session dock panel for plugin:roleplay.
 * Switches between Persona Attachment, Tavern Play, Novel Reader Projection, and NPC Actor
 * purely from owner.state; opening never advances any turn or writes state.
 */
export const RoleplayDockPanel = {
  name: "RoleplayDockPanel",
  components: { ActionButton, CardMediaGallery, MvuPanel, PortraitFrame, StateFieldsView },
  setup() {
    const owner = useOwner();
    const session = useSession();
    const creature = useCreature();
    const t = useRoleplayText();

    const cards = ref([]);
    const cardsLoading = ref(false);
    const cardsError = ref("");
    const selectedCardId = ref("");
    const selectedDetail = ref(null);
    const detailLoading = ref(false);
    const detailError = ref("");
    const busy = ref(false);
    const actionError = ref("");

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
    });
    const notesDraft = ref("");
    const notesDirty = ref(false);
    const worldbookInput = ref(null);
    const worldbookError = ref("");
    const resumingScene = ref(false);
    const resumeError = ref("");

    const state = computed(() => owner.state.value || {});
    const mode = computed(() => {
      if (state.value.mode === "tavern" || state.value.mode === "novel" || state.value.mode === "npc") {
        return state.value.mode;
      }
      return "persona";
    });
    const active = computed(() => Boolean(state.value.active));
    const greetings = computed(() => collectGreetings(selectedDetail.value?.fields));
    const greetingPreviewText = computed(() => {
      const idx = Number(tavernForm.value.greetingIndex) || 0;
      const raw = greetings.value[idx] || "";
      const charName = selectedDetail.value?.fields?.name || selectedCardSummary.value?.name || "";
      return expandPlaceholders(raw, charName, tavernForm.value.playerName || "Player");
    });
    const selectedCardSummary = computed(
      () => cards.value.find((card) => card.id === selectedCardId.value) || null,
    );
    const activeCardSummary = computed(
      () => cards.value.find((card) => card.id === state.value.cardId) || null,
    );
    const tavernStateFields = computed(() => normalizeStateFields(state.value.stateFields));
    const mvuScopeKey = computed(() => JSON.stringify([session.value?.id, creature.value?.name, state.value.cardId]));
    const saveMvuSelection = (ids) => owner.call("set_mvu_public", { ids });
    const novelView = computed(() => projectNovelView(state.value));

    const WORLDBOOK_ISSUE_KEYS = {
      unsupported_position: "worldbookIssueUnsupportedPosition",
      unsupported_trigger: "worldbookIssueUnsupportedTrigger",
      unsupported_key: "worldbookIssueUnsupportedKey",
      script_content: "worldbookIssueScriptContent",
      invalid_entry: "worldbookIssueInvalidEntry",
    };

    function normalizeWorldbookDiagnostics(raw) {
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

    function worldbookIssueLabel(issue) {
      const i18nKey = WORLDBOOK_ISSUE_KEYS[issue?.code];
      if (i18nKey) return t(i18nKey, { count: issue.count });
      return t("worldbookIssueUnknown", { code: issue?.code || "unknown", count: issue?.count || 0 });
    }

    const sessionWorldbookDiag = computed(() => normalizeWorldbookDiagnostics(state.value.worldbookDiagnostics));
    const cardLoreDiag = computed(() => normalizeWorldbookDiagnostics(state.value.cardLoreDiagnostics));

    async function loadCards() {
      if (owner.status.value !== "ready") return;
      cardsLoading.value = true;
      cardsError.value = "";
      try {
        const result = await owner.call("cards", {});
        cards.value = Array.isArray(result?.cards) ? result.cards : Array.isArray(result) ? result : [];
        if (state.value.cardId && cards.value.some((c) => c.id === state.value.cardId)) {
          selectedCardId.value = state.value.cardId;
        } else if (!selectedCardId.value || !cards.value.some((c) => c.id === selectedCardId.value)) {
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
        if (status === "ready" && cardId && (currentMode === "persona" || currentMode === "tavern")) {
          tavernForm.value.greetingIndex = 0;
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
        await owner.call("start_tavern", {
          cardId: selectedCardId.value,
          player: {
            name: tavernForm.value.playerName.trim() || "Player",
            description: tavernForm.value.playerDescription.trim(),
          },
          greetingIndex: Number(tavernForm.value.greetingIndex) || 0,
        });
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

    function triggerWorldbookUpload() {
      if (busy.value) return;
      worldbookError.value = "";
      worldbookInput.value?.click();
    }

    async function handleWorldbookFileChange(event) {
      const file = event.target?.files?.[0];
      if (event.target) event.target.value = "";
      if (!file) return;

      worldbookError.value = "";
      actionError.value = "";
      if (file.size <= 0 || file.size > 12 * 1024 * 1024) {
        worldbookError.value = t("worldbookInvalidJson");
        return;
      }
      busy.value = true;
      try {
        const rawText = await file.text();
        const parsed = JSON.parse(rawText);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error(t("worldbookInvalidJson"));
        }
        await owner.call("set_worldbook", { book: parsed });
        notify(t("worldbookBoundToast"), "success");
      } catch (err) {
        worldbookError.value = err?.message || String(err);
      } finally {
        busy.value = false;
      }
    }

    async function clearSessionWorldbook() {
      if (busy.value) return;
      busy.value = true;
      worldbookError.value = "";
      actionError.value = "";
      try {
        await owner.call("set_worldbook", { book: null });
        notify(t("worldbookClearedToast"), "info");
      } catch (err) {
        worldbookError.value = err?.message || String(err);
      } finally {
        busy.value = false;
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

    function openLibrarySettings() {
      try {
        openTab({ kind: "settings", id: "settings", section: "ext:kohaku-roleplay/library" });
      } catch {
        // Fallback no-op when host doesn't expose settings navigation.
      }
    }

    const modeBadgeLabel = computed(() => {
      if (mode.value === "tavern") return t("modeTavern");
      if (mode.value === "novel") return t("modeNovel");
      if (mode.value === "npc") return t("modeNpc");
      return t("modePersona");
    });

    return {
      owner,
      t,
      state,
      mode,
      modeBadgeLabel,
      active,
      cards,
      cardsLoading,
      cardsError,
      selectedCardId,
      selectedCardSummary,
      activeCardSummary,
      selectedDetail,
      detailLoading,
      detailError,
      greetings,
      greetingPreviewText,
      personaForm,
      personaDirty,
      tavernForm,
      notesDraft,
      notesDirty,
      worldbookInput,
      worldbookError,
      tavernStateFields,
      mvuScopeKey,
      saveMvuSelection,
      sessionWorldbookDiag,
      cardLoreDiag,
      worldbookIssueLabel,
      resumingScene,
      resumeError,
      novelView,
      busy,
      actionError,
      loadCards,
      fillSafeDraft,
      applyPersona,
      removePersona,
      startTavern,
      saveNotes,
      triggerWorldbookUpload,
      handleWorldbookFileChange,
      clearSessionWorldbook,
      resumePendingScene,
      openLibraryTab,
      openLibrarySettings,
    };
  },
  template: `
    <div class="ktrp-panel" :aria-busy="busy" data-testid="kt-rp-panel">
      <header class="ktrp-panel-head">
        <div class="ktrp-panel-title-wrap">
          <strong class="ktrp-panel-title">{{ t('panelTitle') }}</strong>
          <span class="ktrp-chip ktrp-chip--accent" data-testid="kt-rp-mode-badge">{{ modeBadgeLabel }}</span>
        </div>
        <div class="ktrp-panel-actions">
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
              <p class="ktrp-muted">{{ t('tavernPlayerSummary', { name: state.player?.name || 'Player' }) }}</p>
              <span
                v-if="state.openingSent"
                class="ktrp-chip ktrp-chip--accent"
                data-testid="kt-rp-tavern-opening-sent"
              >
                {{ t('tavernOpeningSent') }}
              </span>
            </div>
          </div>

          <div
            v-if="tavernStateFields.length"
            class="ktrp-card-box"
            data-testid="kt-rp-tavern-state-card"
          >
            <div class="ktrp-box-head">{{ t('cardStateTitle') }}</div>
            <StateFieldsView :fields="tavernStateFields" test-id="kt-rp-tavern-state-fields" />
          </div>

          <MvuPanel
            v-if="state.mvu"
            :key="mvuScopeKey"
            :mvu="state.mvu"
            :save-selection="saveMvuSelection"
            :disabled="busy"
          />

          <CardMediaGallery
            :card-id="state.cardId || ''"
            :media="state.media || []"
            :media-issues="state.mediaIssues || null"
            compact
            test-id-prefix="kt-rp-tavern-media"
          />

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
            <div v-if="worldbookError" class="ktrp-banner ktrp-banner--error" role="alert" data-testid="kt-rp-worldbook-error">
              <span>{{ worldbookError }}</span>
            </div>
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

          <div v-if="state.greeting" class="ktrp-field-block">
            <h4>{{ t('greetingPreview') }}</h4>
            <p class="ktrp-quote-box ktrp-pre">{{ state.greeting }}</p>
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
              <div v-if="greetingPreviewText" class="ktrp-quote-box ktrp-pre" data-testid="kt-rp-greeting-preview">
                {{ greetingPreviewText }}
              </div>
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
