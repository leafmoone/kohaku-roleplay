import { computed, ref, watch } from "vue";
import { ActionButton } from "@kohakuterrarium/ui-sdk";

import { useRoleplayText } from "./strings.js";

const PRESET_OPTIONS = [
  { id: "expand", labelKey: "selectionStudioPresetExpand" },
  { id: "concise", labelKey: "selectionStudioPresetConcise" },
  { id: "in_character", labelKey: "selectionStudioPresetInCharacter" },
  { id: "vivid", labelKey: "selectionStudioPresetVivid" },
];

/**
 * Mode 1 Selection Studio side/bottom panel for targeted span AI rewrites and manual edits.
 * Never floats over book prose; drives live in-place <mark> preview via emitted preview text.
 */
export const SelectionStudioPanel = {
  name: "RoleplaySelectionStudioPanel",
  components: { ActionButton },
  props: {
    selectionLock: { type: Object, required: true },
    locked: { type: Boolean, default: false },
    onSuggest: { type: Function, required: true },
    onApply: { type: Function, required: true },
  },
  emits: ["close", "preview"],
  setup(props, { emit }) {
    const t = useRoleplayText();

    const studioMode = ref("ai");
    const activePreset = ref("");
    const instruction = ref("");
    const candidates = ref([]);
    const previewIndex = ref(-1);
    const manualText = ref(String(props.selectionLock?.selectedText || ""));
    const generating = ref(false);
    const applying = ref(false);
    const errorText = ref("");

    let suggestSeq = 0;
    let applySeq = 0;

    const charCount = computed(
      () => [...String(props.selectionLock?.selectedText || "")].length,
    );

    const selectedCandidateText = computed(() => {
      const idx = previewIndex.value;
      if (idx >= 0 && idx < candidates.value.length) {
        return candidates.value[idx];
      }
      return null;
    });

    const lockSignature = computed(() => {
      const lock = props.selectionLock || {};
      return JSON.stringify([lock.number, lock.start, lock.end, lock.selectedText]);
    });

    watch(
      lockSignature,
      () => {
        suggestSeq += 1;
        applySeq += 1;
        generating.value = false;
        applying.value = false;
        candidates.value = [];
        previewIndex.value = -1;
        manualText.value = String(props.selectionLock?.selectedText || "");
        errorText.value = "";
        emit("preview", null);
      },
    );

    function emitCurrentPreview() {
      if (studioMode.value === "manual") {
        const orig = String(props.selectionLock?.selectedText || "");
        emit("preview", manualText.value !== orig ? manualText.value : null);
        return;
      }
      emit("preview", selectedCandidateText.value);
    }

    function setStudioMode(nextMode) {
      studioMode.value = nextMode === "manual" ? "manual" : "ai";
      emitCurrentPreview();
    }

    function onManualInput() {
      emitCurrentPreview();
    }

    function togglePreset(presetId) {
      if (generating.value || applying.value) return;
      activePreset.value = activePreset.value === presetId ? "" : presetId;
    }

    function selectOriginalPreview() {
      previewIndex.value = -1;
      emit("preview", null);
    }

    function selectCandidate(idx) {
      if (idx >= 0 && idx < candidates.value.length) {
        previewIndex.value = idx;
        emit("preview", candidates.value[idx]);
      }
    }

    async function generateCandidates() {
      const lock = props.selectionLock;
      if (!lock || props.locked || generating.value || applying.value) return;
      const sigSnap = lockSignature.value;
      const seq = ++suggestSeq;
      generating.value = true;
      errorText.value = "";
      try {
        const res = await props.onSuggest({
          number: lock.number,
          start: lock.cpStart,
          end: lock.cpEnd,
          selectedText: lock.selectedText,
          preset: activePreset.value,
          instruction: instruction.value.trim(),
          count: 2,
        });
        if (seq !== suggestSeq || lockSignature.value !== sigSnap) return;
        const list = Array.isArray(res?.candidates)
          ? res.candidates.filter((c) => typeof c === "string" && c.length > 0)
          : [];
        candidates.value = list;
        previewIndex.value = list.length > 0 ? 0 : -1;
        emit("preview", list.length > 0 ? list[0] : null);
      } catch (err) {
        if (seq === suggestSeq && lockSignature.value === sigSnap) {
          errorText.value = err?.response?.data?.detail?.message || err?.message || String(err);
        }
      } finally {
        if (seq === suggestSeq) {
          generating.value = false;
        }
      }
    }

    async function applyReplacement(replacementText) {
      const lock = props.selectionLock;
      if (!lock || props.locked || applying.value || generating.value) return;
      if (typeof replacementText !== "string") return;
      const sigSnap = lockSignature.value;
      const seq = ++applySeq;
      applying.value = true;
      errorText.value = "";
      try {
        await props.onApply({
          number: lock.number,
          start: lock.cpStart,
          end: lock.cpEnd,
          expectedText: lock.selectedText,
          replacementText,
        });
      } catch (err) {
        if (seq === applySeq && lockSignature.value === sigSnap) {
          errorText.value = err?.response?.data?.detail?.message || err?.message || String(err);
        }
      } finally {
        if (seq === applySeq) {
          applying.value = false;
        }
      }
    }

    function closeStudio() {
      if (applying.value) return;
      emit("preview", null);
      emit("close");
    }

    return {
      props,
      t,
      presetOptions: PRESET_OPTIONS,
      studioMode,
      activePreset,
      instruction,
      candidates,
      previewIndex,
      selectedCandidateText,
      manualText,
      generating,
      applying,
      errorText,
      charCount,
      setStudioMode,
      onManualInput,
      togglePreset,
      selectOriginalPreview,
      selectCandidate,
      generateCandidates,
      applyReplacement,
      closeStudio,
    };
  },
  template: `
    <aside
      class="ktrp-selection-studio"
      :aria-label="t('selectionStudioTitle')"
      data-testid="kt-rp-selection-studio"
    >
      <div class="ktrp-row-between ktrp-selection-studio-head">
        <div class="ktrp-inline-actions">
          <strong class="ktrp-box-head">{{ t('selectionStudioTitle') }}</strong>
          <span class="ktrp-chip">
            {{ t('selectionStudioChapterBadge', { number: props.selectionLock.number }) }}
          </span>
          <span class="ktrp-chip" data-testid="kt-rp-selection-char-count">
            {{ t('selectionStudioCharCount', { count: charCount }) }}
          </span>
        </div>
        <button
          type="button"
          class="ktrp-selection-close-btn"
          :title="t('selectionStudioCloseLabel')"
          :aria-label="t('selectionStudioCloseLabel')"
          :disabled="applying"
          data-testid="kt-rp-selection-close"
          @click="closeStudio"
        >
          ×
        </button>
      </div>

      <blockquote class="ktrp-selection-excerpt ktrp-pre" data-testid="kt-rp-selection-excerpt">
        {{ props.selectionLock.selectedText }}
      </blockquote>

      <div class="ktrp-reader-seg" role="tablist" data-testid="kt-rp-selection-mode">
        <button
          type="button"
          role="tab"
          class="ktrp-reader-seg-btn"
          :class="{ 'is-active': studioMode === 'ai' }"
          :aria-selected="studioMode === 'ai'"
          data-testid="kt-rp-selection-mode-ai"
          @click="setStudioMode('ai')"
        >
          {{ t('selectionStudioModeAi') }}
        </button>
        <button
          type="button"
          role="tab"
          class="ktrp-reader-seg-btn"
          :class="{ 'is-active': studioMode === 'manual' }"
          :aria-selected="studioMode === 'manual'"
          data-testid="kt-rp-selection-mode-manual"
          @click="setStudioMode('manual')"
        >
          {{ t('selectionStudioModeManual') }}
        </button>
      </div>

      <div
        v-if="errorText"
        class="ktrp-banner ktrp-banner--error"
        role="alert"
        data-testid="kt-rp-selection-error"
      >
        <span>{{ errorText }}</span>
      </div>

      <!-- AI Rewrite Mode -->
      <div v-if="studioMode === 'ai'" class="ktrp-stack" data-testid="kt-rp-selection-ai-pane">
        <div class="ktrp-chip-row">
          <button
            v-for="preset in presetOptions"
            :key="preset.id"
            type="button"
            class="ktrp-chip ktrp-selection-preset-btn"
            :class="{ 'ktrp-chip--accent': activePreset === preset.id }"
            :aria-pressed="activePreset === preset.id"
            :disabled="generating || applying"
            :data-preset="preset.id"
            data-testid="kt-rp-selection-preset"
            @click="togglePreset(preset.id)"
          >
            {{ t(preset.labelKey) }}
          </button>
        </div>

        <div class="ktrp-field-block">
          <label class="ktrp-label" for="ktrp-selection-instruction">
            {{ t('selectionStudioInstructionLabel') }}
          </label>
          <input
            id="ktrp-selection-instruction"
            v-model="instruction"
            type="text"
            class="ktrp-input"
            :disabled="props.locked || generating || applying"
            :placeholder="t('selectionStudioInstructionPlaceholder')"
            data-testid="kt-rp-selection-instruction"
            @keydown.enter.prevent="generateCandidates"
          />
        </div>

        <div class="ktrp-row-end">
          <ActionButton
            variant="primary"
            size="sm"
            :disabled="props.locked || generating || applying"
            data-testid="kt-rp-selection-generate"
            @click="generateCandidates"
          >
            {{ generating ? t('selectionStudioGeneratingBtn') : t('selectionStudioGenerateBtn') }}
          </ActionButton>
        </div>

        <div v-if="candidates.length" class="ktrp-stack" data-testid="kt-rp-selection-candidates">
          <div class="ktrp-row-between">
            <span class="ktrp-label">{{ t('selectionStudioCandidatesTitle') }}</span>
            <button
              type="button"
              class="ktrp-chip"
              :class="{ 'ktrp-chip--accent': previewIndex === -1 }"
              data-testid="kt-rp-selection-original"
              @click="selectOriginalPreview"
            >
              {{ t('selectionStudioOriginalBtn') }}
            </button>
          </div>

          <button
            v-for="(cand, idx) in candidates"
            :key="idx"
            type="button"
            class="ktrp-selection-candidate-btn"
            :class="{ 'is-selected': previewIndex === idx }"
            :aria-pressed="previewIndex === idx"
            :data-candidate-index="idx"
            data-testid="kt-rp-selection-candidate"
            @click="selectCandidate(idx)"
          >
            <span class="ktrp-state-label">
              {{ t('selectionStudioCandidateLabel', { index: idx + 1 }) }}
            </span>
            <span class="ktrp-pre">{{ cand }}</span>
          </button>

          <div class="ktrp-row-end">
            <ActionButton
              variant="primary"
              size="sm"
              :disabled="props.locked || applying || generating || selectedCandidateText === null"
              data-testid="kt-rp-selection-apply"
              @click="applyReplacement(selectedCandidateText)"
            >
              {{ applying ? t('selectionStudioApplyingBtn') : t('selectionStudioApplyBtn') }}
            </ActionButton>
          </div>
        </div>
      </div>

      <!-- Manual Edit Mode -->
      <div v-else class="ktrp-stack" data-testid="kt-rp-selection-manual-pane">
        <div class="ktrp-field-block">
          <label class="ktrp-label" for="ktrp-selection-manual-input">
            {{ t('selectionStudioManualLabel') }}
          </label>
          <textarea
            id="ktrp-selection-manual-input"
            v-model="manualText"
            rows="5"
            class="ktrp-textarea"
            :disabled="props.locked || applying"
            data-testid="kt-rp-selection-manual-input"
            @input="onManualInput"
          />
        </div>
        <div class="ktrp-row-end">
          <ActionButton
            variant="primary"
            size="sm"
            :disabled="props.locked || applying || manualText === props.selectionLock.selectedText"
            data-testid="kt-rp-selection-save-manual"
            @click="applyReplacement(manualText)"
          >
            {{ applying ? t('selectionStudioApplyingBtn') : t('selectionStudioSaveManualBtn') }}
          </ActionButton>
        </div>
      </div>
    </aside>
  `,
};
