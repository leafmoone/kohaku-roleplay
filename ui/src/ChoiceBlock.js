import { computed, ref } from "vue";
import { ActionButton, useMessageBlock, useOwner } from "@kohakuterrarium/ui-sdk";

import { parseChoiceFence } from "./helpers.js";
import { useRoleplayText } from "./strings.js";

/**
 * Message renderer for ```kt_roleplay.choices``` fenced blocks.
 * Sends one user turn via block.say(option.text); hides interactive branch cards
 * when live owner state sets enableStoryChoices === false, and falls back to raw pre
 * if the JSON payload is invalid.
 */
export const ChoiceBlock = {
  name: "RoleplayChoiceBlock",
  components: { ActionButton },
  setup() {
    const block = useMessageBlock();
    const t = useRoleplayText();
    let owner = null;
    try {
      owner = useOwner();
    } catch {
      owner = null;
    }

    const sending = ref(false);
    const chosenText = ref("");
    const sendError = ref("");
    const editingIndex = ref(-1);
    const draftText = ref("");

    const parsed = computed(() => parseChoiceFence(block.source.value));
    const storyChoicesEnabled = computed(
      () => owner?.state?.value?.enableStoryChoices !== false,
    );

    function optionPreview(option) {
      if (!option || typeof option !== "object") return "";
      if (option.summary) return option.summary;
      return option.text && option.text !== option.label ? option.text : "";
    }

    async function sendText(rawText, displayLabel) {
      const clean = String(rawText ?? "").trim();
      if (!storyChoicesEnabled.value || sending.value || !clean || clean.startsWith("/")) return;
      sending.value = true;
      sendError.value = "";
      try {
        await block.say(clean);
        chosenText.value = displayLabel || clean;
        editingIndex.value = -1;
        draftText.value = "";
      } catch (err) {
        sendError.value = err?.message || String(err);
      } finally {
        sending.value = false;
      }
    }

    async function choose(option) {
      if (!option?.text) return;
      await sendText(option.text, option.label);
    }

    function startEdit(option, idx) {
      if (sending.value || !option?.text) return;
      editingIndex.value = idx;
      draftText.value = option.text;
      sendError.value = "";
    }

    function cancelEdit() {
      if (sending.value) return;
      editingIndex.value = -1;
      draftText.value = "";
    }

    async function sendEditedDraft() {
      const label = parsed.value?.options?.[editingIndex.value]?.label || "";
      await sendText(draftText.value, label || draftText.value.trim());
    }

    return {
      block,
      t,
      parsed,
      storyChoicesEnabled,
      sending,
      chosenText,
      sendError,
      editingIndex,
      draftText,
      optionPreview,
      choose,
      startEdit,
      cancelEdit,
      sendEditedDraft,
    };
  },
  template: `
    <div v-if="parsed && storyChoicesEnabled" class="ktrp-choices" data-testid="kt-rp-choices">
      <div class="ktrp-choices-prompt">{{ parsed.prompt || t('choicesPromptDefault') }}</div>
      <div class="ktrp-branch-grid">
        <div
          v-for="(option, idx) in parsed.options"
          :key="idx"
          class="ktrp-branch-card"
          :class="{ 'is-chosen': chosenText === option.label, 'is-editing': editingIndex === idx }"
          :data-testid="'kt-rp-choice-card-' + idx"
        >
          <div class="ktrp-branch-head">
            <span v-if="option.tag" class="ktrp-branch-tag" :data-testid="'kt-rp-choice-tag-' + idx">
              {{ option.tag }}
            </span>
            <strong class="ktrp-branch-label">{{ option.label }}</strong>
          </div>
          <p
            v-if="optionPreview(option)"
            class="ktrp-branch-preview"
            :data-testid="'kt-rp-choice-preview-' + idx"
          >
            {{ optionPreview(option) }}
          </p>
          <div class="ktrp-branch-actions">
            <ActionButton
              size="sm"
              :variant="chosenText === option.label ? 'primary' : 'default'"
              :disabled="sending"
              :data-testid="'kt-rp-choice-btn-' + idx"
              @click="choose(option)"
            >
              {{ t('storyChoicesSendBtn') }}
            </ActionButton>
            <ActionButton
              size="sm"
              variant="ghost"
              :disabled="sending"
              :data-testid="'kt-rp-choice-edit-btn-' + idx"
              @click="startEdit(option, idx)"
            >
              {{ t('storyChoicesEditBtn') }}
            </ActionButton>
          </div>
        </div>
      </div>

      <div
        v-if="editingIndex >= 0"
        class="ktrp-choice-draft-box"
        data-testid="kt-rp-choice-draft-box"
      >
        <textarea
          v-model="draftText"
          rows="3"
          class="ktrp-textarea"
          :disabled="sending"
          :placeholder="t('storyChoicesDraftPlaceholder')"
          data-testid="kt-rp-choice-draft-input"
        />
        <div class="ktrp-row-end">
          <ActionButton
            size="sm"
            variant="ghost"
            :disabled="sending"
            data-testid="kt-rp-choice-draft-cancel"
            @click="cancelEdit"
          >
            {{ t('storyChoicesCancelDraftBtn') }}
          </ActionButton>
          <ActionButton
            size="sm"
            variant="primary"
            :disabled="sending || !draftText.trim() || draftText.trimStart().startsWith('/')"
            data-testid="kt-rp-choice-draft-send"
            @click="sendEditedDraft"
          >
            {{ t('storyChoicesSendBtn') }}
          </ActionButton>
        </div>
      </div>

      <p v-if="chosenText" class="ktrp-muted" data-testid="kt-rp-choice-sent">
        {{ t('choicesSent', { choice: chosenText }) }}
      </p>
      <p v-if="sendError" class="ktrp-error-inline" role="alert" data-testid="kt-rp-choice-error">
        {{ sendError }}
      </p>
    </div>
    <pre v-else-if="!parsed" class="ktrp-pre ktrp-choices-fallback" data-testid="kt-rp-choices-fallback">{{ block.source.value }}</pre>
  `,
};
