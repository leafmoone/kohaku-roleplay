import { computed, ref, watch } from "vue";
import { ActionButton } from "@kohakuterrarium/ui-sdk";

import { useRoleplayText } from "./strings.js";

export const MvuPanel = {
  name: "RoleplayMvuPanel",
  components: { ActionButton },
  props: {
    mvu: { type: Object, required: true },
    saveSelection: { type: Function, required: true },
    disabled: { type: Boolean, default: false },
  },
  setup(props) {
    const t = useRoleplayText();
    const draft = ref(null);
    const saving = ref(false);
    const feedback = ref("");

    const options = computed(() => props.mvu.options);
    const selected = computed(() => new Set(props.mvu.selected));
    const checked = computed(() => draft.value ?? selected.value);
    const dirty = computed(() => options.value.some(({ id }) => checked.value.has(id) !== selected.value.has(id)));
    const values = computed(() => props.mvu.values.filter(
      ({ id }) => selected.value.has(id) && checked.value.has(id),
    ));

    // A new saved selection takes precedence; value-only events leave an edit in progress intact.
    watch(() => JSON.stringify(props.mvu.selected), () => {
      draft.value = null;
      if (feedback.value === "error") feedback.value = "";
    });

    function setChecked(id, isChecked) {
      if (props.disabled || saving.value) return;
      const next = new Set(checked.value);
      if (isChecked) next.add(id);
      else next.delete(id);
      draft.value = next;
      feedback.value = "";
    }

    const canSave = computed(() => !props.disabled && !saving.value && dirty.value && feedback.value !== "saved");
    async function save() {
      if (!canSave.value) return;
      const ids = options.value.filter(({ id }) => checked.value.has(id)).map(({ id }) => id);
      saving.value = true;
      feedback.value = "";
      try {
        await props.saveSelection(ids);
        // The action reply acknowledges the save; only owner state supplies display values.
        feedback.value = "saved";
      } catch {
        feedback.value = "error";
      } finally {
        saving.value = false;
      }
    }

    function formatValue(value) {
      if (value !== null && typeof value === "object") return JSON.stringify(value, null, 2);
      return String(value);
    }

    function testId(kind, id) {
      return `kt-rp-mvu-${kind}-${encodeURIComponent(id)}`;
    }

    return { t, options, checked, values, saving, feedback, canSave, setChecked, save, formatValue, testId };
  },
  template: `
    <section class="ktrp-card-box" data-testid="kt-rp-mvu-section" :aria-busy="saving">
      <div class="ktrp-box-head">{{ t('mvuTitle') }}</div>
      <p v-if="mvu.invalidInitializers > 0" class="ktrp-muted" data-testid="kt-rp-mvu-invalid-initializers">
        {{ t('mvuInvalidInitializers', { count: mvu.invalidInitializers }) }}
      </p>

      <template v-if="options.length">
        <p class="ktrp-muted">{{ t('mvuSelectionHint') }}</p>
        <fieldset class="ktrp-mvu-options" data-testid="kt-rp-mvu-options" :disabled="disabled || saving">
          <legend class="ktrp-box-head">{{ t('mvuOptions') }}</legend>
          <div class="ktrp-mvu-option-list">
            <label v-for="option in options" :key="option.id" class="ktrp-mvu-option">
              <input
                type="checkbox"
                :checked="checked.has(option.id)"
                :data-testid="testId('option', option.id)"
                @change="setChecked(option.id, $event.target.checked)"
              />
              <span>{{ option.label }}</span>
            </label>
          </div>
        </fieldset>
        <div class="ktrp-row-end">
          <ActionButton size="sm" :disabled="!canSave" data-testid="kt-rp-mvu-save" @click="save">
            {{ t(saving ? 'mvuSaving' : 'mvuSave') }}
          </ActionButton>
        </div>
        <p v-if="feedback === 'error'" class="ktrp-error-inline" role="alert" data-testid="kt-rp-mvu-error">
          {{ t('mvuSaveFailed') }}
        </p>
        <p v-else-if="feedback === 'saved'" class="ktrp-muted" role="status" data-testid="kt-rp-mvu-saved">
          {{ t('mvuSaved') }}
        </p>
      </template>
      <p v-else class="ktrp-muted" data-testid="kt-rp-mvu-no-options">{{ t('mvuNoOptions') }}</p>

      <div class="ktrp-field-block" data-testid="kt-rp-mvu-values">
        <div class="ktrp-box-head">{{ t('mvuValues') }}</div>
        <dl v-if="values.length" class="ktrp-state-list ktrp-mvu-values">
          <div v-for="row in values" :key="row.id" class="ktrp-state-item">
            <dt class="ktrp-state-label ktrp-mvu-value-label">{{ row.label }}</dt>
            <dd class="ktrp-mvu-value">
              <pre
                class="ktrp-state-text ktrp-pre"
                :data-testid="testId('value', row.id)"
                v-text="formatValue(row.value)"
              ></pre>
            </dd>
          </div>
        </dl>
        <p v-else class="ktrp-muted" data-testid="kt-rp-mvu-empty">{{ t('mvuNoValues') }}</p>
      </div>
    </section>
  `,
};
