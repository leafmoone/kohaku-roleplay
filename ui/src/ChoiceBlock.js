import { computed, ref } from "vue";
import { ActionButton, useMessageBlock } from "@kohakuterrarium/ui-sdk";

import { parseChoiceFence } from "./helpers.js";
import { useRoleplayText } from "./strings.js";

/**
 * Message renderer for ```kt_roleplay.choices``` fenced blocks.
 * Sends one user turn via block.say(option.text); falls back cleanly to raw pre
 * if the JSON block is malformed so plain history never breaks.
 */
export const ChoiceBlock = {
  name: "RoleplayChoiceBlock",
  components: { ActionButton },
  setup() {
    const block = useMessageBlock();
    const t = useRoleplayText();

    const sending = ref(false);
    const chosenText = ref("");
    const sendError = ref("");

    const parsed = computed(() => parseChoiceFence(block.source.value));

    async function choose(option) {
      if (sending.value || !option?.text) return;
      sending.value = true;
      sendError.value = "";
      try {
        await block.say(option.text);
        chosenText.value = option.label;
      } catch (err) {
        sendError.value = err?.message || String(err);
      } finally {
        sending.value = false;
      }
    }

    return {
      block,
      t,
      parsed,
      sending,
      chosenText,
      sendError,
      choose,
    };
  },
  template: `
    <div v-if="parsed" class="ktrp-choices" data-testid="kt-rp-choices">
      <div class="ktrp-choices-prompt">{{ parsed.prompt || t('choicesPromptDefault') }}</div>
      <div class="ktrp-choices-list">
        <ActionButton
          v-for="(option, idx) in parsed.options"
          :key="idx"
          size="sm"
          :variant="chosenText === option.label ? 'primary' : 'default'"
          :disabled="sending"
          :data-testid="'kt-rp-choice-btn-' + idx"
          @click="choose(option)"
        >
          {{ option.label }}
        </ActionButton>
      </div>
      <p v-if="chosenText" class="ktrp-muted" data-testid="kt-rp-choice-sent">
        {{ t('choicesSent', { choice: chosenText }) }}
      </p>
      <p v-if="sendError" class="ktrp-error-inline" role="alert" data-testid="kt-rp-choice-error">
        {{ sendError }}
      </p>
    </div>
    <pre v-else class="ktrp-pre ktrp-choices-fallback" data-testid="kt-rp-choices-fallback">{{ block.source.value }}</pre>
  `,
};
