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
  DEFAULT_MAX_CARD_BYTES,
  collectGreetings,
  expandPlaceholders,
  readFileAsBase64,
  validateCardFile,
} from "./helpers.js";
import { PortraitFrame } from "./PortraitFrame.js";
import { useRoleplayText } from "./strings.js";

/**
 * Shared character card library view mounted in both Settings -> Roleplay Cards
 * and the standalone Roleplay Studio workspace tab.
 * When `mode === 'tab'`, also exposes Tavern & Novel launch actions via `kt.api.post(...)`.
 */
export const CardLibraryView = {
  name: "RoleplayCardLibraryView",
  components: { ActionButton, SettingsGroup, SettingsRow, PortraitFrame },
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

    // Studio quick-launch state (used in tab mode)
    const tavernLaunchPlayer = ref("Player");
    const tavernLaunchDesc = ref("");
    const tavernLaunchGreetingIndex = ref(0);
    const novelCastIds = ref([]);
    const novelTitle = ref("");
    const launchedSession = ref(null);

    const state = computed(() => owner.state.value || {});
    const maxCardBytes = computed(() => Number(state.value.maxCardBytes) || DEFAULT_MAX_CARD_BYTES);
    const maxMiB = computed(() => Math.round((maxCardBytes.value / (1024 * 1024)) * 10) / 10);
    const cards = computed(() => (Array.isArray(state.value.cards) ? state.value.cards : []));
    const filteredCards = computed(() => {
      const q = query.value.trim().toLowerCase();
      if (!q) return cards.value;
      return cards.value.filter((card) => String(card.name || "").toLowerCase().includes(q));
    });
    const selectedCard = computed(
      () => cards.value.find((card) => card.id === selectedId.value) || null,
    );
    const greetings = computed(() => collectGreetings(detail.value?.fields));
    const launchGreetingPreview = computed(() => {
      const idx = Number(tavernLaunchGreetingIndex.value) || 0;
      const raw = greetings.value[idx] || "";
      const charName = detail.value?.fields?.name || selectedCard.value?.name || "";
      return expandPlaceholders(raw, charName, tavernLaunchPlayer.value || "Player");
    });
    const tags = computed(() =>
      Array.isArray(detail.value?.fields?.tags) ? detail.value.fields.tags.filter(Boolean) : [],
    );

    watch(
      cards,
      (list) => {
        if (!list.length) {
          selectedId.value = "";
          detail.value = null;
          novelCastIds.value = [];
          return;
        }
        const validIds = new Set(list.map((c) => c.id));
        novelCastIds.value = novelCastIds.value.filter((id) => validIds.has(id));
        if (!list.some((card) => card.id === selectedId.value)) {
          selectedId.value = list[0].id;
        }
      },
      { immediate: true },
    );

    watch(selectedId, () => {
      tavernLaunchGreetingIndex.value = 0;
    });

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
    }

    function triggerImport() {
      if (busy.value) return;
      fileInput.value?.click();
    }

    async function handleFileChange(event) {
      const file = event.target?.files?.[0];
      if (event.target) event.target.value = "";
      if (!file) return;

      actionError.value = "";
      const check = validateCardFile(file, maxCardBytes.value);
      if (!check.ok) {
        actionError.value =
          check.code === "type" ? t("invalidFileType") : t("sizeLimitError", { mb: maxMiB.value });
        return;
      }

      busy.value = true;
      try {
        const base64 = await readFileAsBase64(file);
        const imported = await owner.call("import", { data: base64 });
        await owner.refresh();
        portraitRevision.value += 1;
        if (imported?.id) {
          selectedId.value = imported.id;
        }
      } catch (err) {
        actionError.value = err?.message || String(err);
      } finally {
        busy.value = false;
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
      busy.value = true;
      actionError.value = "";
      try {
        const resp = await kt.api.post("taverns", {
          cardId: card.id,
          player: {
            name: tavernLaunchPlayer.value.trim() || "Player",
            description: tavernLaunchDesc.value.trim(),
          },
          greetingIndex: Number(tavernLaunchGreetingIndex.value) || 0,
        });
        const data = resp?.data || resp || {};
        launchedSession.value = {
          kind: "tavern",
          sessionId: data.sessionId || "",
          creatureId: data.creatureId || "",
          label: detail.value?.fields?.name || card.name,
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
      } else if (novelCastIds.value.length < 32) {
        novelCastIds.value.push(cardId);
      }
    }

    async function launchNovelFromCast() {
      if (!novelCastIds.value.length || busy.value) return;
      busy.value = true;
      actionError.value = "";
      try {
        const payload = { cardIds: [...novelCastIds.value] };
        if (novelTitle.value.trim()) payload.name = novelTitle.value.trim();
        const resp = await kt.api.post("novels", payload);
        const data = resp?.data || resp || {};
        launchedSession.value = {
          kind: "novel",
          sessionId: data.sessionId || "",
          creatureId: data.creatureId || "",
          label: payload.name || t("novelDefaultTitle"),
        };
        notify(t("launchCreatedToast"), "success");
      } catch (err) {
        actionError.value = err?.response?.data?.detail || err?.message || String(err);
      } finally {
        busy.value = false;
      }
    }

    async function refreshLibrary() {
      actionError.value = "";
      try {
        await owner.refresh();
        portraitRevision.value += 1;
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
      detail,
      detailLoading,
      detailError,
      busy,
      actionError,
      portraitRevision,
      maxMiB,
      cards,
      filteredCards,
      greetings,
      tags,
      selectCard,
      triggerImport,
      handleFileChange,
      removeSelectedCard,
      refreshLibrary,
      tavernLaunchPlayer,
      tavernLaunchDesc,
      tavernLaunchGreetingIndex,
      launchGreetingPreview,
      novelCastIds,
      novelTitle,
      launchedSession,
      launchTavernFromCard,
      toggleNovelCast,
      launchNovelFromCast,
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
      <p class="ktrp-muted">{{ t('scope') }}</p>

      <div
        v-if="owner.status.value === 'error' || owner.status.value === 'absent'"
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

        <SettingsGroup :title="t('library')" :description="t('libraryHint')">
          <template #action>
            <ActionButton size="sm" variant="ghost" icon="i-carbon-renew" :disabled="busy" data-testid="kt-rp-refresh-btn" @click="refreshLibrary">
              {{ t('refresh') }}
            </ActionButton>
          </template>
          <SettingsRow :title="t('importCard')" :hint="t('supportedHint', { mb: maxMiB })">
            <ActionButton
              variant="primary"
              :disabled="busy"
              data-testid="kt-rp-import-btn"
              @click="triggerImport"
            >
              {{ busy ? t('importing') : t('importCard') }}
            </ActionButton>
            <input
              ref="fileInput"
              type="file"
              accept=".json,.png,application/json,image/png"
              hidden
              tabindex="-1"
              :disabled="busy"
              data-testid="kt-rp-import-input"
              @change="handleFileChange"
            />
          </SettingsRow>
        </SettingsGroup>

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
                    <span v-if="detail.hasWorldbook" class="ktrp-chip ktrp-chip--accent">{{ t('worldbookTag') }}</span>
                    <span v-if="detail.fields?.creator" class="ktrp-chip">{{ t('creatorLabel') }}: {{ detail.fields.creator }}</span>
                  </div>
                  <div v-if="tags.length" class="ktrp-tag-list">
                    <span v-for="tag in tags" :key="tag" class="ktrp-tag">{{ tag }}</span>
                  </div>
                </div>
                <ActionButton
                  variant="danger"
                  size="sm"
                  :disabled="busy"
                  data-testid="kt-rp-delete-card-btn"
                  @click="removeSelectedCard"
                >
                  {{ t('removeCard') }}
                </ActionButton>
              </div>

              <div v-if="detail.warnings?.length" class="ktrp-banner ktrp-banner--warn" data-testid="kt-rp-card-warnings">
                <div class="ktrp-warn-title">{{ t('warningsTitle') }}</div>
                <ul>
                  <li v-for="(warn, idx) in detail.warnings" :key="idx">{{ warn }}</li>
                </ul>
              </div>

              <div class="ktrp-detail-sections">
                <div v-if="detail.fields?.description" class="ktrp-field-block">
                  <h4>{{ t('descriptionLabel') }}</h4>
                  <p class="ktrp-pre">{{ detail.fields.description }}</p>
                </div>
                <div v-if="detail.fields?.personality" class="ktrp-field-block">
                  <h4>{{ t('personalityLabel') }}</h4>
                  <p class="ktrp-pre">{{ detail.fields.personality }}</p>
                </div>
                <div v-if="detail.fields?.scenario" class="ktrp-field-block">
                  <h4>{{ t('scenarioLabel') }}</h4>
                  <p class="ktrp-pre">{{ detail.fields.scenario }}</p>
                </div>
                <div v-if="greetings.length" class="ktrp-field-block">
                  <h4>{{ t('greetingsLabel', { count: greetings.length }) }}</h4>
                  <div v-for="(greeting, idx) in greetings" :key="idx" class="ktrp-quote-box">
                    <span class="ktrp-quote-idx">#{{ idx + 1 }}</span>
                    <p class="ktrp-pre">{{ greeting }}</p>
                  </div>
                </div>
                <div v-if="detail.fields?.creator_notes" class="ktrp-field-block">
                  <h4>{{ t('creatorNotesLabel') }}</h4>
                  <p class="ktrp-pre">{{ detail.fields.creator_notes }}</p>
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
                    <div v-if="launchGreetingPreview" class="ktrp-quote-box ktrp-pre">
                      {{ launchGreetingPreview }}
                    </div>
                  </div>
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
          </div>
        </div>

        <div v-if="props.mode === 'tab' && cards.length" class="ktrp-card-box" data-testid="kt-rp-studio-novel-builder">
          <div class="ktrp-row-between">
            <div>
              <h4>{{ t('studioLaunchNovelTitle') }}</h4>
              <p class="ktrp-muted">{{ t('studioLaunchNovelHint') }}</p>
            </div>
            <span class="ktrp-chip">{{ t('studioNovelSelectedCount', { count: novelCastIds.length }) }}</span>
          </div>
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
          <div class="ktrp-cast-picker">
            <label
              v-for="card in cards"
              :key="card.id"
              class="ktrp-cast-check"
              :data-testid="'kt-rp-novel-pick-' + card.id"
            >
              <input
                type="checkbox"
                :checked="novelCastIds.includes(card.id)"
                @change="toggleNovelCast(card.id)"
              />
              <span>{{ card.name }}</span>
            </label>
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

        <div v-if="launchedSession" class="ktrp-banner ktrp-banner--info" data-testid="kt-rp-launch-result">
          <div>
            <strong>{{ t('launchReadyTitle', { name: launchedSession.label }) }}</strong>
            <p class="ktrp-muted">
              {{ t('launchReadyIds', { sessionId: launchedSession.sessionId, creatureId: launchedSession.creatureId }) }}
            </p>
          </div>
          <ActionButton
            variant="primary"
            size="sm"
            data-testid="kt-rp-launch-open-session-btn"
            @click="openSessionTab(launchedSession.sessionId)"
          >
            {{ t('launchOpenSession') }}
          </ActionButton>
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
