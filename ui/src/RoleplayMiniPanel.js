import { computed, onUnmounted, ref, watch } from "vue";
import {
  ActionButton,
  notify,
  useCreature,
  useOwner,
  useSession,
} from "@kohakuterrarium/ui-sdk";

import { CardWebPanel } from "./CardWebPanel.js";
import { normalizeStateFields, projectNovelView } from "./helpers.js";
import { usePlayWindow } from "./playWindow.js";
import { useRoleplayText } from "./strings.js";

const MAX_FALLBACK_SUMMARY_ITEMS = 8;

function clampMeter(item) {
  const min = Number.isFinite(Number(item?.min)) ? Number(item.min) : 0;
  const max = Number.isFinite(Number(item?.max)) ? Number(item.max) : 100;
  const val = Number.isFinite(Number(item?.value)) ? Number(item.value) : min;
  return {
    min,
    max,
    value: Math.min(max, Math.max(min, val)),
  };
}

function formatCompactValue(item, t) {
  if (!item || typeof item !== "object") return "";
  const type = item.type;
  if (type === "meter") {
    const { max, value } = clampMeter(item);
    return `${item.value ?? value}/${max}`;
  }
  if (type === "inventory") {
    const list = Array.isArray(item.items) ? item.items : [];
    if (!list.length) return t("nativeInventoryEmpty");
    const preview = list
      .slice(0, 2)
      .map((entry) =>
        t("nativeInventoryItem", {
          label: entry?.label || "",
          quantity: entry?.quantity ?? 1,
        }),
      )
      .join(", ");
    return list.length > 2 ? `${preview} +${list.length - 2}` : preview;
  }
  if (type === "quest") {
    const done = Boolean(item.completed);
    const status = typeof item.status === "string" ? item.status.trim() : "";
    const badge = t(done ? "nativeCompleted" : "nativeNotCompleted");
    return status ? `${status} (${badge})` : badge;
  }
  if (type === "list") {
    const arr = Array.isArray(item.value) ? item.value.map((v) => String(v ?? "")) : [];
    if (!arr.length) return t("stateFieldEmpty");
    const joined = arr.slice(0, 3).join(", ");
    return arr.length > 3 ? `${joined} +${arr.length - 3}` : joined;
  }
  if (type === "number") {
    const hasMin = typeof item.min === "number" && Number.isFinite(item.min);
    const hasMax = typeof item.max === "number" && Number.isFinite(item.max);
    if (hasMin && hasMax) return `${item.value}/${item.max}`;
    return String(item.value ?? "");
  }
  if (type === "mvu") {
    const val = item.value;
    if (val !== null && typeof val === "object") {
      try {
        const raw = JSON.stringify(val);
        return raw.length > 48 ? `${raw.slice(0, 45)}…` : raw;
      } catch {
        return String(val);
      }
    }
    return String(val ?? "");
  }
  const str = String(item.value ?? "").trim();
  if (!str) return t("stateFieldEmpty");
  return str.length > 48 ? `${str.slice(0, 45)}…` : str;
}

function formatFullValue(item, t) {
  if (!item || typeof item !== "object") return "";
  const type = item.type;
  if (type === "meter") {
    const { min, max, value } = clampMeter(item);
    return `${item.value ?? value}/${max} (${min}..${max})`;
  }
  if (type === "inventory") {
    const list = Array.isArray(item.items) ? item.items : [];
    if (!list.length) return t("nativeInventoryEmpty");
    return list
      .map((entry) =>
        t("nativeInventoryItem", {
          label: entry?.label || "",
          quantity: entry?.quantity ?? 1,
        }),
      )
      .join("\n");
  }
  if (type === "quest") {
    const done = Boolean(item.completed);
    const status = typeof item.status === "string" ? item.status.trim() : "";
    const badge = t(done ? "nativeCompleted" : "nativeNotCompleted");
    const head = status ? `${status} (${badge})` : badge;
    const objectives = Array.isArray(item.objectives)
      ? item.objectives.filter((obj) => obj && typeof obj === "object" && obj.label)
      : [];
    if (!objectives.length) return head;
    const objLines = objectives.map((obj) => {
      const objBadge = t(obj.done ? "nativeCompleted" : "nativeNotCompleted");
      return `${obj.label} (${objBadge})`;
    });
    return [head, ...objLines].join("\n");
  }
  if (type === "list") {
    const arr = Array.isArray(item.value) ? item.value.map((v) => String(v ?? "")) : [];
    if (!arr.length) return t("stateFieldEmpty");
    return arr.join("\n");
  }
  if (type === "number") {
    const hasMin = typeof item.min === "number" && Number.isFinite(item.min);
    const hasMax = typeof item.max === "number" && Number.isFinite(item.max);
    if (hasMin && hasMax) return `${item.value}/${item.max} (${item.min}..${item.max})`;
    if (hasMin) return `${item.value} (>= ${item.min})`;
    if (hasMax) return `${item.value} (<= ${item.max})`;
    return String(item.value ?? "");
  }
  if (type === "mvu") {
    const val = item.value;
    if (val !== null && typeof val === "object") {
      try {
        return JSON.stringify(val, null, 2);
      } catch {
        return String(val);
      }
    }
    return String(val ?? "");
  }
  const str = String(item.value ?? "");
  if (!str.trim()) return t("stateFieldEmpty");
  return str;
}

function projectSummaryRow(item, t) {
  const hasMeter =
    item.type === "meter" ||
    (item.type === "number" &&
      typeof item.min === "number" &&
      typeof item.max === "number" &&
      item.max > item.min);
  let meterPercent = 0;
  let meterMin = 0;
  let meterMax = 100;
  let meterValue = 0;
  if (hasMeter) {
    const clamped = clampMeter(item);
    meterMin = clamped.min;
    meterMax = clamped.max;
    meterValue = clamped.value;
    meterPercent =
      meterMax > meterMin
        ? Math.round(((meterValue - meterMin) / (meterMax - meterMin)) * 100)
        : 0;
  }
  return {
    id: item.id,
    label: item.label,
    type: String(item.type || "text"),
    displayValue: formatCompactValue(item, t),
    hasMeter,
    meterPercent,
    meterMin,
    meterMax,
    meterValue,
  };
}

function isFiniteNumericValue(val) {
  return typeof val === "number" && Number.isFinite(val);
}

function buildPublicFallbackItems(view, maxCount) {
  const rawPanels = Array.isArray(view?.nativePanels) ? view.nativePanels : [];
  const rawFields = normalizeStateFields(view?.stateFields);
  const rawMvuValues = Array.isArray(view?.mvu?.values) ? view.mvu.values : [];

  const buckets = [[], [], [], []];

  for (const panel of rawPanels) {
    if (
      panel &&
      typeof panel === "object" &&
      typeof panel.id === "string" &&
      panel.id &&
      typeof panel.label === "string" &&
      panel.label &&
      (panel.type === "meter" || panel.type === "inventory" || panel.type === "quest")
    ) {
      buckets[0].push({ ...panel, id: `panel:${panel.id}` });
    }
  }

  for (const field of rawFields) {
    if (field && typeof field.key === "string" && field.key && typeof field.label === "string" && field.label) {
      const bucketIdx = field.type === "number" ? 1 : 2;
      buckets[bucketIdx].push({ ...field, id: `field:${field.key}` });
    }
  }

  for (const entry of rawMvuValues) {
    if (
      entry &&
      typeof entry === "object" &&
      typeof entry.id === "string" &&
      entry.id &&
      typeof entry.label === "string" &&
      entry.label
    ) {
      const candidate = {
        id: `mvu:${entry.id}`,
        label: entry.label,
        type: "mvu",
        value: entry.value,
      };
      if (isFiniteNumericValue(entry.value) || typeof entry.value === "boolean") {
        buckets[1].push(candidate);
      } else if (typeof entry.value === "string") {
        const trimmed = entry.value.trim();
        if (trimmed.length <= 48 && !trimmed.includes("\n")) {
          buckets[2].push(candidate);
        } else {
          buckets[3].push(candidate);
        }
      } else {
        buckets[3].push(candidate);
      }
    }
  }

  const ordered = [...buckets[0], ...buckets[1], ...buckets[2], ...buckets[3]];
  return ordered.slice(0, maxCount);
}

/**
 * Compact floating gameplay panel (`ext:kohaku-roleplay/gameplay`).
 * Shows public summary metrics (respecting user pins or safely falling back to public projections)
 * and quick gameplay actions without embedding settings, worldbooks, or large author web iframes.
 */
export const RoleplayMiniPanel = {
  name: "RoleplayMiniPanel",
  components: {
    ActionButton,
    CardWebPanel,
  },
  setup() {
    const owner = useOwner();
    const session = useSession();
    const creature = useCreature();
    const t = useRoleplayText();

    const rootEl = ref(null);
    const {
      isPhone: playWindowIsPhone,
      isExpanded: playWindowExpanded,
      toggleWindowExpand,
      startMove: startPlayWindowMove,
      startResize: startPlayWindowResize,
    } = usePlayWindow(rootEl);

    const summaryExpanded = ref(false);

    const scriptBusy = ref(false);
    const scriptError = ref("");
    const scriptSuccessNotice = ref("");
    let scriptMutationSeq = 0;

    const choiceSending = ref(false);
    const choiceError = ref("");
    let choiceMutationSeq = 0;

    const resumingScene = ref(false);
    const resumeError = ref("");
    let resumeMutationSeq = 0;

    let unmounted = false;
    let focusEpoch = 0;

    const focusScopeKey = computed(() =>
      JSON.stringify([session.value?.id || "", creature.value?.name || ""]),
    );
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
    const isActiveTavern = computed(
      () => owner.status.value === "ready" && mode.value === "tavern" && active.value,
    );
    const tavernScopeKey = computed(() =>
      JSON.stringify([session.value?.id || "", creature.value?.name || "", state.value.cardId || ""]),
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
    const novelView = computed(() => projectNovelView(state.value));

    const summaryMode = computed(() => {
      if (!isActiveTavern.value) return "none";
      const pinnedItems = state.value.headerSummary?.items;
      if (Array.isArray(pinnedItems) && pinnedItems.length > 0) return "pinned";
      return "fallback";
    });

    const rawSummaryItems = computed(() => {
      if (!isActiveTavern.value) return [];
      const pinnedItems = state.value.headerSummary?.items;
      const maxPins =
        Number.isInteger(state.value.headerSummary?.maxPins) &&
        state.value.headerSummary.maxPins > 0
          ? state.value.headerSummary.maxPins
          : MAX_FALLBACK_SUMMARY_ITEMS;
      return Array.isArray(pinnedItems) && pinnedItems.length > 0
        ? pinnedItems.filter(
            (item) =>
              item &&
              typeof item === "object" &&
              typeof item.id === "string" &&
              item.id &&
              typeof item.label === "string" &&
              item.label,
          )
        : buildPublicFallbackItems(state.value, maxPins);
    });

    const summaryItems = computed(() =>
      rawSummaryItems.value.map((item) => projectSummaryRow(item, t)),
    );

    const expandedSummaryItems = computed(() => {
      if (!summaryExpanded.value) return [];
      return rawSummaryItems.value.map((raw, idx) => ({
        ...summaryItems.value[idx],
        fullValue: formatFullValue(raw, t),
      }));
    });

    const runnableScriptButtonGroups = computed(() => {
      if (!isActiveTavern.value) return [];
      const raw = state.value.cardScripts;
      if (!raw || typeof raw !== "object" || Array.isArray(raw) || !raw.enabled) return [];
      const entries = Array.isArray(raw.entries) ? raw.entries : [];
      return entries
        .filter(
          (entry) =>
            entry &&
            typeof entry === "object" &&
            typeof entry.id === "string" &&
            entry.id &&
            Boolean(entry.enabled) &&
            !(typeof entry.issue === "string" && entry.issue) &&
            Array.isArray(entry.buttons) &&
            entry.buttons.length > 0,
        )
        .map((entry) => ({
          id: entry.id,
          name: typeof entry.name === "string" ? entry.name : entry.id,
          buttons: entry.buttons.filter((b) => typeof b === "string" && b),
        }))
        .filter((grp) => grp.buttons.length > 0);
    });

    const nativeChoicePanels = computed(() => {
      if (!isActiveTavern.value) return [];
      const panels = Array.isArray(state.value.nativePanels) ? state.value.nativePanels : [];
      return panels.filter(
        (panel) =>
          panel &&
          typeof panel === "object" &&
          panel.type === "choices" &&
          typeof panel.id === "string" &&
          panel.id &&
          Array.isArray(panel.options) &&
          panel.options.length > 0,
      );
    });

    function clearActionFeedback() {
      scriptMutationSeq += 1;
      choiceMutationSeq += 1;
      resumeMutationSeq += 1;
      scriptBusy.value = false;
      scriptError.value = "";
      scriptSuccessNotice.value = "";
      choiceSending.value = false;
      choiceError.value = "";
      resumingScene.value = false;
      resumeError.value = "";
    }

    // Clear stale owner state immediately when focus (session/creature) changes
    // so previous creature's writable actions cannot be invoked while host refresh is in flight.
    watch(
      focusScopeKey,
      () => {
        focusEpoch += 1;
        owner.state.value = null;
        summaryExpanded.value = false;
        clearActionFeedback();
      },
      { flush: "sync" },
    );

    watch(tavernScopeKey, () => {
      summaryExpanded.value = false;
      clearActionFeedback();
    });

    onUnmounted(() => {
      unmounted = true;
      focusEpoch += 1;
      summaryExpanded.value = false;
      clearActionFeedback();
    });

    async function invokeCardScriptButton(scriptId, buttonName) {
      if (unmounted || scriptBusy.value || !scriptId || !buttonName) return;
      const epochSnap = focusEpoch;
      const focusSnap = focusScopeKey.value;
      const scopeSnap = tavernScopeKey.value;
      const seq = ++scriptMutationSeq;
      scriptBusy.value = true;
      scriptError.value = "";
      scriptSuccessNotice.value = "";
      try {
        const nextView = await owner.call("invoke_script_button", {
          scriptId,
          button: buttonName,
        });
        if (
          unmounted ||
          epochSnap !== focusEpoch ||
          focusScopeKey.value !== focusSnap ||
          seq !== scriptMutationSeq ||
          tavernScopeKey.value !== scopeSnap
        ) {
          return;
        }
        if (nextView && typeof nextView === "object") {
          owner.state.value = nextView;
        }
        scriptSuccessNotice.value = t("cardScriptsButtonInvokedToast", { button: buttonName });
      } catch (err) {
        if (
          !unmounted &&
          epochSnap === focusEpoch &&
          focusScopeKey.value === focusSnap &&
          seq === scriptMutationSeq &&
          tavernScopeKey.value === scopeSnap
        ) {
          scriptError.value = err?.message || String(err);
          scriptSuccessNotice.value = "";
        }
      } finally {
        if (!unmounted && seq === scriptMutationSeq) {
          scriptBusy.value = false;
        }
      }
    }

    async function chooseNativeOption(panelId, index) {
      if (unmounted || choiceSending.value || !panelId) return;
      const epochSnap = focusEpoch;
      const focusSnap = focusScopeKey.value;
      const scopeSnap = tavernScopeKey.value;
      const seq = ++choiceMutationSeq;
      choiceSending.value = true;
      choiceError.value = "";
      try {
        await owner.call("choose_panel_option", { panelId, index });
      } catch (err) {
        if (
          !unmounted &&
          epochSnap === focusEpoch &&
          focusScopeKey.value === focusSnap &&
          seq === choiceMutationSeq &&
          tavernScopeKey.value === scopeSnap
        ) {
          choiceError.value = err?.message || t("nativeChoiceError");
        }
      } finally {
        if (!unmounted && seq === choiceMutationSeq) {
          choiceSending.value = false;
        }
      }
    }

    async function resumePendingScene() {
      const pending = novelView.value.pendingScene;
      if (unmounted || !pending || resumingScene.value) return;
      const sceneNum = pending.number;
      const epochSnap = focusEpoch;
      const focusSnap = focusScopeKey.value;
      const seq = ++resumeMutationSeq;
      resumingScene.value = true;
      resumeError.value = "";
      try {
        await owner.call("resume_scene", { scene: sceneNum });
        if (
          unmounted ||
          epochSnap !== focusEpoch ||
          focusScopeKey.value !== focusSnap ||
          seq !== resumeMutationSeq
        ) {
          return;
        }
        await owner.refresh();
        if (
          unmounted ||
          epochSnap !== focusEpoch ||
          focusScopeKey.value !== focusSnap ||
          seq !== resumeMutationSeq
        ) {
          return;
        }
        notify(t("novelResumeSentToast", { number: sceneNum }), "info");
      } catch (err) {
        if (
          !unmounted &&
          epochSnap === focusEpoch &&
          focusScopeKey.value === focusSnap &&
          seq === resumeMutationSeq
        ) {
          resumeError.value = err?.message || String(err);
        }
      } finally {
        if (!unmounted && seq === resumeMutationSeq) {
          resumingScene.value = false;
        }
      }
    }

    function itemTestId(id) {
      return `kt-rp-mini-summary-item-${encodeURIComponent(id)}`;
    }

    function detailTestId(id) {
      return `kt-rp-mini-summary-detail-${encodeURIComponent(id)}`;
    }

    return {
      owner,
      t,
      rootEl,
      playWindowIsPhone,
      playWindowExpanded,
      toggleWindowExpand,
      startPlayWindowMove,
      startPlayWindowResize,
      state,
      mode,
      active,
      isActiveTavern,
      tavernScopeKey,
      mvuPublicSignature,
      novelView,
      summaryMode,
      summaryItems,
      expandedSummaryItems,
      summaryExpanded,
      runnableScriptButtonGroups,
      nativeChoicePanels,
      scriptBusy,
      scriptError,
      scriptSuccessNotice,
      choiceSending,
      choiceError,
      resumingScene,
      resumeError,
      invokeCardScriptButton,
      chooseNativeOption,
      resumePendingScene,
      itemTestId,
      detailTestId,
    };
  },
  template: `
    <div
      ref="rootEl"
      class="ktrp-mini-panel"
      :data-window-expanded="String(playWindowExpanded)"
      data-testid="kt-rp-mini-panel"
    >
      <div class="ktrp-play-window-bar" data-testid="kt-rp-mini-head">
        <button
          v-if="!playWindowIsPhone"
          type="button"
          class="ktrp-play-move-handle"
          :title="t('playWindowMoveLabel')"
          :aria-label="t('playWindowMoveLabel')"
          data-testid="kt-rp-play-move-handle"
          @pointerdown="startPlayWindowMove"
        >
          <span class="ktrp-play-move-grip" aria-hidden="true">⋮⋮</span>
          <strong
            v-if="isActiveTavern"
            class="ktrp-mini-char-name"
            data-testid="kt-rp-mini-char-name"
          >{{ state.name }}</strong>
          <span v-else>{{ t('playWindowMoveLabel') }}</span>
        </button>
        <strong
          v-else-if="isActiveTavern"
          class="ktrp-mini-char-name"
          data-testid="kt-rp-mini-char-name"
        >{{ state.name }}</strong>
        <span v-else class="ktrp-muted" />
        <ActionButton
          size="sm"
          variant="ghost"
          :aria-expanded="String(playWindowExpanded)"
          data-testid="kt-rp-play-window-toggle"
          @click="toggleWindowExpand"
        >
          {{ playWindowExpanded ? t('playWindowRestoreBtn') : t('playWindowExpandBtn') }}
        </ActionButton>
      </div>

      <div
        v-if="owner.status.value === 'error' || owner.status.value === 'absent'"
        class="ktrp-banner ktrp-banner--error"
        role="alert"
        data-testid="kt-rp-mini-error"
      >
        <span>{{ t('loadFailed') }} <small v-if="owner.error.value">{{ owner.error.value }}</small></span>
        <ActionButton size="sm" @click="owner.refresh()">{{ t('retry') }}</ActionButton>
      </div>

      <p
        v-else-if="owner.status.value !== 'ready'"
        class="ktrp-muted"
        role="status"
        data-testid="kt-rp-mini-loading"
      >
        {{ t('loading') }}
      </p>

      <template v-else-if="isActiveTavern">
        <div
          v-if="summaryItems.length"
          class="ktrp-mini-section"
          :data-summary-source="summaryMode"
          :data-summary-expanded="String(summaryExpanded)"
          data-testid="kt-rp-mini-summary"
        >
          <div class="ktrp-row-between">
            <span class="ktrp-label">{{ t('cardStateTitle') }}</span>
            <ActionButton
              size="sm"
              variant="ghost"
              :aria-expanded="String(summaryExpanded)"
              data-testid="kt-rp-mini-summary-toggle-btn"
              @click="summaryExpanded = !summaryExpanded"
            >
              {{ summaryExpanded ? t('collapseFieldBtn') : t('expandFieldBtn') }}
            </ActionButton>
          </div>
          <div v-if="!summaryExpanded" class="ktrp-header-summary">
            <div
              v-for="item in summaryItems"
              :key="item.id"
              class="ktrp-header-summary-pill"
              :data-summary-type="item.type"
              :data-testid="itemTestId(item.id)"
            >
              <span class="ktrp-header-summary-label" :data-testid="itemTestId(item.id) + '-label'">
                {{ item.label }}
              </span>
              <span class="ktrp-header-summary-value" :data-testid="itemTestId(item.id) + '-value'">
                {{ item.displayValue }}
              </span>
              <span
                v-if="item.hasMeter"
                class="ktrp-header-summary-meter"
                aria-hidden="true"
                :data-testid="itemTestId(item.id) + '-meter'"
              >
                <span
                  class="ktrp-header-summary-meter-fill"
                  :style="{ width: item.meterPercent + '%' }"
                />
              </span>
            </div>
          </div>
          <div
            v-else
            class="ktrp-state-list ktrp-state-list--compact"
            data-testid="kt-rp-mini-summary-details"
          >
            <div
              v-for="item in expandedSummaryItems"
              :key="item.id"
              class="ktrp-state-item"
              :data-summary-type="item.type"
              :data-testid="detailTestId(item.id)"
            >
              <div class="ktrp-state-head">
                <span class="ktrp-state-label" :data-testid="detailTestId(item.id) + '-label'">
                  {{ item.label }}
                </span>
                <span v-if="item.hasMeter" class="ktrp-state-num-wrap">
                  <strong class="ktrp-state-num">{{ item.displayValue }}</strong>
                  <span class="ktrp-state-bounds">({{ item.meterMin }}..{{ item.meterMax }})</span>
                </span>
              </div>
              <div
                v-if="item.hasMeter"
                class="ktrp-state-meter"
                role="progressbar"
                :aria-label="item.label"
                :aria-valuemin="item.meterMin"
                :aria-valuemax="item.meterMax"
                :aria-valuenow="item.meterValue"
              >
                <div class="ktrp-state-meter-fill" :style="{ width: item.meterPercent + '%' }" />
              </div>
              <p
                class="ktrp-state-text ktrp-pre"
                :data-testid="detailTestId(item.id) + '-value'"
                v-text="item.fullValue"
              ></p>
            </div>
          </div>
        </div>
        <p
          v-else
          class="ktrp-muted"
          data-testid="kt-rp-mini-summary-empty"
        >
          {{ t('miniPanelNoPublicSummary') }}
        </p>

        <CardWebPanel
          v-if="state.webPanel"
          :key="'mini-web:' + tavernScopeKey + ':' + mvuPublicSignature"
          :owner="owner"
          :scope-key="tavernScopeKey"
          :mvu-public-signature="mvuPublicSignature"
          :web-panel-meta="state.webPanel"
          :player-name="state.player?.name || 'Player'"
          :character-name="state.name || ''"
        />

        <div
          v-if="runnableScriptButtonGroups.length"
          class="ktrp-mini-section"
          data-testid="kt-rp-mini-scripts"
        >
          <div
            v-if="scriptError"
            class="ktrp-banner ktrp-banner--error"
            role="alert"
            data-testid="kt-rp-mini-script-error"
          >
            <span>{{ scriptError }}</span>
          </div>
          <p
            v-if="scriptSuccessNotice"
            class="ktrp-muted"
            role="status"
            data-testid="kt-rp-mini-script-status"
          >
            {{ scriptSuccessNotice }}
          </p>
          <div
            v-for="group in runnableScriptButtonGroups"
            :key="group.id"
            class="ktrp-mini-script-group"
            :data-testid="'kt-rp-mini-script-group-' + group.id"
          >
            <span class="ktrp-label">{{ group.name }}</span>
            <div class="ktrp-inline-actions">
              <ActionButton
                v-for="(btnName, btnIdx) in group.buttons"
                :key="btnName"
                size="sm"
                :disabled="scriptBusy"
                :data-testid="'kt-rp-mini-script-btn-' + group.id + '-' + btnIdx"
                :data-script-id="group.id"
                :data-button-name="btnName"
                @click="invokeCardScriptButton(group.id, btnName)"
              >
                {{ btnName }}
              </ActionButton>
            </div>
          </div>
        </div>

        <div
          v-if="nativeChoicePanels.length"
          class="ktrp-mini-section"
          data-testid="kt-rp-mini-choices"
        >
          <p v-if="choiceError" class="ktrp-error-inline" role="alert" data-testid="kt-rp-mini-choice-error">
            {{ choiceError }}
          </p>
          <div
            v-for="panel in nativeChoicePanels"
            :key="panel.id"
            class="ktrp-mini-script-group"
            :data-testid="'kt-rp-mini-choice-panel-' + panel.id"
          >
            <span class="ktrp-label">{{ panel.label }}</span>
            <div class="ktrp-inline-actions">
              <ActionButton
                v-for="(opt, idx) in panel.options"
                :key="idx"
                size="sm"
                :disabled="choiceSending"
                :data-testid="'kt-rp-mini-choice-btn-' + panel.id + '-' + idx"
                @click="chooseNativeOption(panel.id, idx)"
              >
                {{ opt.label }}
              </ActionButton>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="mode === 'novel' && novelView.active">
        <div class="ktrp-mini-head" data-testid="kt-rp-mini-novel">
          <div class="ktrp-inline-actions">
            <span class="ktrp-chip">{{ t('novelSceneCompleted', { count: novelView.sceneNumber }) }}</span>
            <ActionButton
              v-if="novelView.pendingScene"
              size="sm"
              :disabled="resumingScene"
              data-testid="kt-rp-mini-novel-resume-btn"
              @click="resumePendingScene"
            >
              {{ resumingScene ? t('novelResumingBtn') : t('novelResumeBtn') }}
            </ActionButton>
          </div>
          <div
            v-if="resumeError"
            class="ktrp-banner ktrp-banner--error"
            role="alert"
            data-testid="kt-rp-mini-novel-error"
          >
            <span>{{ resumeError }}</span>
          </div>
        </div>
      </template>

      <template v-else>
        <div class="ktrp-mini-head" data-testid="kt-rp-mini-inactive">
          <p class="ktrp-muted">{{ t('miniPanelInactiveHint') }}</p>
        </div>
      </template>

      <button
        v-if="!playWindowIsPhone"
        type="button"
        class="ktrp-play-resize-handle"
        :title="t('playWindowResizeLabel')"
        :aria-label="t('playWindowResizeLabel')"
        data-testid="kt-rp-play-resize-handle"
        @pointerdown="startPlayWindowResize"
      />
    </div>
  `,
};
