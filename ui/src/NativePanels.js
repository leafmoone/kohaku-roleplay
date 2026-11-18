import { computed, ref } from "vue";
import { ActionButton } from "@kohakuterrarium/ui-sdk";

import { useRoleplayText } from "./strings.js";

const PANEL_TYPES = new Set(["meter", "inventory", "quest", "choices"]);

/** Tavern owner projections only; the dock supplies the scoped choice action. */
export const NativePanels = {
  name: "RoleplayNativePanels",
  components: { ActionButton },
  props: {
    panels: { type: Array, default: () => [] },
    invalidCount: { type: Number, default: 0 },
    chooseOption: { type: Function, required: true },
    disabled: { type: Boolean, default: false },
  },
  setup(props) {
    const t = useRoleplayText();
    const panelsToShow = computed(() => props.panels.filter((panel) => PANEL_TYPES.has(panel?.type)));
    const sending = ref(false);
    const choiceFailed = ref(false);

    async function choose(panelId, index) {
      if (props.disabled || sending.value) return;
      sending.value = true;
      choiceFailed.value = false;
      try {
        await props.chooseOption(panelId, index);
      } catch {
        choiceFailed.value = true;
      } finally {
        sending.value = false;
      }
    }

    function meterValue(panel) {
      return Math.min(panel.max, Math.max(panel.min, panel.value));
    }

    function meterPercent(panel) {
      const span = panel.max - panel.min;
      return span > 0 ? ((meterValue(panel) - panel.min) / span) * 100 : 0;
    }

    function panelTestId(id) {
      return `kt-rp-native-panel-${encodeURIComponent(id)}`;
    }

    return { t, panelsToShow, sending, choiceFailed, choose, meterValue, meterPercent, panelTestId };
  },
  template: `
    <section v-if="panelsToShow.length || invalidCount > 0 || sending || choiceFailed"
      class="ktrp-card-box ktrp-native-panels" data-testid="kt-rp-native-panels">
      <div class="ktrp-box-head">{{ t('nativePanelsTitle') }}</div>
      <p v-if="invalidCount > 0" class="ktrp-muted" data-testid="kt-rp-native-invalid">
        {{ t('nativeInvalidPanels', { count: invalidCount }) }}
      </p>
      <p v-if="sending" class="ktrp-muted" role="status" data-testid="kt-rp-native-choice-pending">
        {{ t('nativeChoiceSending') }}
      </p>
      <p v-if="choiceFailed" class="ktrp-error-inline" role="alert" data-testid="kt-rp-native-choice-error">
        {{ t('nativeChoiceError') }}
      </p>

      <div v-for="panel in panelsToShow" :key="panel.id" class="ktrp-state-item"
        :data-testid="panelTestId(panel.id)" :data-panel-type="panel.type">
        <div class="ktrp-box-head">{{ panel.label }}</div>

        <div v-if="panel.type === 'meter'" class="ktrp-field-block" data-testid="kt-rp-native-meter">
          <div class="ktrp-state-num-wrap">
            <strong class="ktrp-state-num">{{ panel.value }}</strong>
            <span class="ktrp-state-bounds">({{ panel.min }}..{{ panel.max }})</span>
          </div>
          <div class="ktrp-state-meter" role="meter" :aria-label="panel.label"
            :aria-valuemin="panel.min" :aria-valuemax="panel.max" :aria-valuenow="meterValue(panel)">
            <div class="ktrp-state-meter-fill" :style="{ width: meterPercent(panel) + '%' }"></div>
          </div>
        </div>

        <div v-else-if="panel.type === 'inventory'" class="ktrp-tag-list" data-testid="kt-rp-native-inventory">
          <span v-if="!panel.items.length" class="ktrp-muted">{{ t('nativeInventoryEmpty') }}</span>
          <span v-for="(item, index) in panel.items" :key="index" class="ktrp-tag"
            :data-testid="'kt-rp-native-item-' + index">
            {{ t('nativeInventoryItem', { label: item.label, quantity: item.quantity }) }}
          </span>
        </div>

        <div v-else-if="panel.type === 'quest'" class="ktrp-field-block" data-testid="kt-rp-native-quest"
          :data-completed="panel.completed">
          <div class="ktrp-state-head">
            <span v-if="panel.status" class="ktrp-pre">{{ panel.status }}</span>
            <span class="ktrp-chip" :class="{ 'ktrp-chip--accent': panel.completed }">
              {{ t(panel.completed ? 'nativeCompleted' : 'nativeNotCompleted') }}
            </span>
          </div>
          <div v-for="(objective, index) in panel.objectives" :key="index" class="ktrp-state-head"
            :data-testid="'kt-rp-native-objective-' + index" :data-done="objective.done">
            <span class="ktrp-pre">{{ objective.label }}</span>
            <span class="ktrp-muted">{{ t(objective.done ? 'nativeCompleted' : 'nativeNotCompleted') }}</span>
          </div>
        </div>

        <div v-else-if="panel.type === 'choices'" class="ktrp-state-list" data-testid="kt-rp-native-choices">
          <p class="ktrp-muted">{{ t('nativeChoiceHint') }}</p>
          <div v-for="(option, index) in panel.options" :key="index" class="ktrp-state-item">
            <pre class="ktrp-pre ktrp-native-option-text"
              :data-testid="'kt-rp-native-option-text-' + index" v-text="option.text"></pre>
            <div class="ktrp-row-end">
              <ActionButton size="sm" type="button" :disabled="disabled || sending"
                :data-testid="'kt-rp-native-option-' + index" @click="choose(panel.id, index)">
                {{ t('nativeChoiceSend', { label: option.label }) }}
              </ActionButton>
            </div>
          </div>
        </div>
      </div>
    </section>
  `,
};
