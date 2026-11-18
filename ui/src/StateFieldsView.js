import { computed } from "vue";

import { normalizeStateFields } from "./helpers.js";
import { useRoleplayText } from "./strings.js";

/**
 * Shared read-only renderer for card-authored public stateFields in Tavern and Novel views.
 * Renders nothing when no public stateFields are defined.
 */
export const StateFieldsView = {
  name: "RoleplayStateFieldsView",
  props: {
    fields: { type: Array, default: () => [] },
    compact: { type: Boolean, default: false },
    testId: { type: String, default: "kt-rp-state-fields" },
  },
  setup(props) {
    const t = useRoleplayText();
    const items = computed(() => normalizeStateFields(props.fields));

    function hasRange(field) {
      return (
        field.type === "number" &&
        typeof field.min === "number" &&
        typeof field.max === "number" &&
        field.max > field.min
      );
    }

    function rangePercent(field) {
      if (!hasRange(field)) return 0;
      const ratio = ((field.value - field.min) / (field.max - field.min)) * 100;
      return Math.max(0, Math.min(100, Math.round(ratio * 10) / 10));
    }

    function numberBoundsText(field) {
      const hasMin = typeof field.min === "number";
      const hasMax = typeof field.max === "number";
      if (hasMin && hasMax) return `${field.min}..${field.max}`;
      if (hasMin) return `>= ${field.min}`;
      if (hasMax) return `<= ${field.max}`;
      return "";
    }

    return {
      props,
      t,
      items,
      hasRange,
      rangePercent,
      numberBoundsText,
    };
  },
  template: `
    <div
      v-if="items.length"
      class="ktrp-state-list"
      :class="{ 'ktrp-state-list--compact': props.compact }"
      :data-testid="props.testId"
    >
      <div
        v-for="field in items"
        :key="field.key"
        class="ktrp-state-item"
        :data-field-type="field.type"
        :data-testid="'kt-rp-state-field-' + field.key"
      >
        <div class="ktrp-state-head">
          <span class="ktrp-state-label">{{ field.label }}</span>
          <span v-if="field.type === 'enum'" class="ktrp-chip ktrp-chip--accent" data-testid="kt-rp-state-enum-value">
            {{ field.value }}
          </span>
          <span v-else-if="field.type === 'number'" class="ktrp-state-num-wrap">
            <strong class="ktrp-state-num" data-testid="kt-rp-state-number-value">{{ field.value }}</strong>
            <span v-if="numberBoundsText(field)" class="ktrp-state-bounds">({{ numberBoundsText(field) }})</span>
          </span>
        </div>

        <div
          v-if="hasRange(field)"
          class="ktrp-state-meter"
          role="progressbar"
          :aria-label="field.label"
          :aria-valuemin="field.min"
          :aria-valuemax="field.max"
          :aria-valuenow="field.value"
        >
          <div class="ktrp-state-meter-fill" :style="{ width: rangePercent(field) + '%' }" />
        </div>

        <div v-else-if="field.type === 'list'" class="ktrp-tag-list" data-testid="kt-rp-state-list-value">
          <span v-if="!field.value.length" class="ktrp-muted">{{ t('stateFieldEmpty') }}</span>
          <span v-for="(entry, idx) in field.value" :key="idx" class="ktrp-tag">{{ entry }}</span>
        </div>

        <p v-else-if="field.type === 'text'" class="ktrp-state-text ktrp-pre" data-testid="kt-rp-state-text-value">
          {{ field.value || t('stateFieldEmpty') }}
        </p>
      </div>
    </div>
  `,
};
