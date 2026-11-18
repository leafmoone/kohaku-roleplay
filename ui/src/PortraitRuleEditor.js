import { computed, ref, watch } from "vue";
import { ActionButton, useOwner } from "@kohakuterrarium/ui-sdk";

import {
  DEFAULT_MAX_CARD_BYTES,
  buildPortraitsPayload,
  clonePortraitsToForm,
  extractPublicPortraitFields,
  readFileAsBase64,
  validatePortraitPngFile,
} from "./helpers.js";
import { useRoleplayText } from "./strings.js";

/**
 * Interactive local PNG portrait & rule manager for the Card Library (Settings & Studio Tab).
 * Loads via `portrait_draft { id }` + `edit_draft { id }` (for public state definitions),
 * supports local PNG upload & preview, default portrait + public text/enum/number matching rules,
 * priority reordering (first match wins), removal, and saving strictly as a new card copy
 * via `save_portraits_copy { id, portraits }`.
 */
export const PortraitRuleEditor = {
  name: "RoleplayPortraitRuleEditor",
  components: { ActionButton },
  props: {
    cardId: { type: String, required: true },
    cardName: { type: String, default: "" },
    maxBytes: { type: Number, default: DEFAULT_MAX_CARD_BYTES },
  },
  emits: ["cancel", "saved"],
  setup(props, { emit }) {
    const owner = useOwner();
    const t = useRoleplayText();

    const loading = ref(false);
    const saving = ref(false);
    const loadError = ref("");
    const saveError = ref("");

    const publicFields = ref([]);
    const portraitRows = ref([]);
    const fileInput = ref(null);
    const pendingUploadIdx = ref(-1);

    const fieldMap = computed(() => new Map(publicFields.value.map((f) => [f.key, f])));
    const maxMiB = computed(() => Math.round((props.maxBytes / (1024 * 1024)) * 10) / 10);

    let loadSeq = 0;
    async function loadDraft(cardId) {
      const seq = ++loadSeq;
      loadError.value = "";
      saveError.value = "";
      if (!cardId || owner.status.value !== "ready") return;
      loading.value = true;
      try {
        const [portraitDraft, cardDraft] = await Promise.all([
          owner.call("portrait_draft", { id: cardId }),
          owner.call("edit_draft", { id: cardId }),
        ]);
        if (seq !== loadSeq) return;
        const pub = extractPublicPortraitFields(cardDraft?.stateDefinitions);
        publicFields.value = pub;
        portraitRows.value = clonePortraitsToForm(portraitDraft?.portraits, pub);
      } catch (err) {
        if (seq === loadSeq) {
          loadError.value = err?.message || String(err);
        }
      } finally {
        if (seq === loadSeq) {
          loading.value = false;
        }
      }
    }

    watch(
      () => [props.cardId, owner.status.value],
      ([id, status]) => {
        if (id && status === "ready") {
          loadDraft(id);
        }
      },
      { immediate: true },
    );

    function fieldForRow(row) {
      return fieldMap.value.get(row?.field) || null;
    }

    function addPortraitRule(asDefault = false) {
      const canCondition = !asDefault && publicFields.value.length > 0;
      const firstField = canCondition ? publicFields.value[0] : null;
      let initialEquals = "";
      if (firstField?.type === "enum") {
        initialEquals = firstField.options[0] || "";
      } else if (firstField?.type === "number") {
        initialEquals = firstField.min !== undefined ? String(firstField.min) : "0";
      }
      portraitRows.value.push({
        key: "",
        isDefault: !canCondition,
        field: firstField ? firstField.key : "",
        equalsText: initialEquals,
        data: "",
      });
    }

    function removePortraitRule(idx) {
      portraitRows.value.splice(idx, 1);
    }

    function moveRule(idx, delta) {
      const target = idx + delta;
      if (target < 0 || target >= portraitRows.value.length) return;
      const copy = [...portraitRows.value];
      const [item] = copy.splice(idx, 1);
      copy.splice(target, 0, item);
      portraitRows.value = copy;
    }

    function onScopeChange(row) {
      if (row.isDefault) {
        row.equalsText = "";
        return;
      }
      if (!fieldMap.value.has(row.field)) {
        row.field = publicFields.value[0]?.key || "";
      }
      onFieldChange(row);
    }

    function onFieldChange(row) {
      const def = fieldForRow(row);
      if (!def) {
        row.equalsText = "";
        return;
      }
      if (def.type === "enum") {
        if (!def.options.includes(row.equalsText)) {
          row.equalsText = def.options[0] || "";
        }
      } else if (def.type === "number") {
        const num = Number(row.equalsText);
        if (!row.equalsText || !Number.isFinite(num)) {
          row.equalsText = def.min !== undefined ? String(def.min) : "0";
        }
      } else {
        row.equalsText = String(row.equalsText ?? "");
      }
    }

    function triggerPngSelect(idx) {
      if (saving.value) return;
      saveError.value = "";
      pendingUploadIdx.value = idx;
      fileInput.value?.click();
    }

    async function handlePngSelected(event) {
      const file = event.target?.files?.[0];
      if (event.target) event.target.value = "";
      const idx = pendingUploadIdx.value;
      pendingUploadIdx.value = -1;
      if (!file || idx < 0 || idx >= portraitRows.value.length) return;

      const check = validatePortraitPngFile(file, props.maxBytes);
      if (!check.ok) {
        saveError.value =
          check.code === "type"
            ? t("portraitErrPngType")
            : t("portraitErrPngSize", { mb: maxMiB.value });
        return;
      }
      try {
        const base64 = await readFileAsBase64(file);
        portraitRows.value[idx].data = base64;
      } catch (err) {
        saveError.value = err?.message || String(err);
      }
    }

    function clearAllPortraits() {
      if (saving.value) return;
      portraitRows.value = [];
      saveError.value = "";
    }

    function formatValidationError(err) {
      const n = (err.index ?? 0) + 1;
      const key = err.key || `#${n}`;
      switch (err.code) {
        case "key":
          return t("portraitErrKey", { index: n });
        case "duplicateKey":
          return t("portraitErrDuplicateKey", { key });
        case "missingImage":
          return t("portraitErrMissingImage", { key });
        case "totalSize":
          return t("portraitErrTotalSize", { mb: maxMiB.value });
        case "duplicateDefault":
          return t("portraitErrDuplicateDefault");
        case "invalidField":
          return t("portraitErrInvalidField", { key });
        case "invalidNumber":
          return t("portraitErrInvalidNumber", { key });
        case "numberOutOfBounds":
          return t("portraitErrNumberBounds", { key });
        case "invalidEnum":
          return t("portraitErrInvalidEnum", { key });
        case "duplicateCondition":
          return t("portraitErrDuplicateCondition", { key });
        default:
          return t("actionFailed");
      }
    }

    async function savePortraitsCopy() {
      if (saving.value || loading.value) return;
      saveError.value = "";
      const built = buildPortraitsPayload(portraitRows.value, publicFields.value, props.maxBytes);
      if (!built.ok) {
        saveError.value = formatValidationError(built);
        return;
      }
      saving.value = true;
      try {
        const created = await owner.call("save_portraits_copy", {
          id: props.cardId,
          portraits: built.portraits,
        });
        emit("saved", created);
      } catch (err) {
        saveError.value = err?.message || String(err);
      } finally {
        saving.value = false;
      }
    }

    function cancelEdit() {
      if (saving.value) return;
      emit("cancel");
    }

    return {
      props,
      t,
      loading,
      saving,
      loadError,
      saveError,
      publicFields,
      portraitRows,
      fileInput,
      fieldForRow,
      loadDraft,
      addPortraitRule,
      removePortraitRule,
      moveRule,
      onScopeChange,
      onFieldChange,
      triggerPngSelect,
      handlePngSelected,
      clearAllPortraits,
      savePortraitsCopy,
      cancelEdit,
    };
  },
  template: `
    <div class="ktrp-editor" data-testid="kt-rp-portraits-editor">
      <div class="ktrp-row-between">
        <div>
          <h3>{{ t('portraitEditorTitle', { name: props.cardName }) }}</h3>
          <p class="ktrp-muted">{{ t('portraitEditorNotice') }}</p>
        </div>
        <div class="ktrp-row-end">
          <ActionButton
            size="sm"
            variant="ghost"
            :disabled="saving"
            data-testid="kt-rp-portraits-cancel-btn"
            @click="cancelEdit"
          >
            {{ t('editorCancelBtn') }}
          </ActionButton>
          <ActionButton
            size="sm"
            variant="primary"
            :disabled="loading || saving"
            data-testid="kt-rp-portraits-save-btn"
            @click="savePortraitsCopy"
          >
            {{ saving ? t('editorSaving') : t('portraitSaveCopyBtn') }}
          </ActionButton>
        </div>
      </div>

      <div v-if="loading" class="ktrp-empty" role="status" data-testid="kt-rp-portraits-loading">
        {{ t('loading') }}
      </div>
      <div v-else-if="loadError" class="ktrp-banner ktrp-banner--error" role="alert" data-testid="kt-rp-portraits-load-error">
        <span>{{ loadError }}</span>
        <ActionButton size="sm" @click="loadDraft(props.cardId)">{{ t('retry') }}</ActionButton>
      </div>

      <template v-else>
        <div v-if="saveError" class="ktrp-banner ktrp-banner--error" role="alert" data-testid="kt-rp-portraits-error">
          <span>{{ saveError }}</span>
        </div>

        <input
          ref="fileInput"
          type="file"
          accept=".png,image/png"
          hidden
          tabindex="-1"
          :disabled="saving"
          data-testid="kt-rp-portraits-file-input"
          @change="handlePngSelected"
        />

        <div class="ktrp-card-box">
          <div class="ktrp-row-between">
            <div>
              <div class="ktrp-box-head">{{ t('portraitRulesSection') }}</div>
              <p class="ktrp-muted">{{ t('portraitRulesHint') }}</p>
            </div>
            <div class="ktrp-row-end">
              <ActionButton
                size="sm"
                :disabled="saving"
                data-testid="kt-rp-portraits-add-default-btn"
                @click="addPortraitRule(true)"
              >
                {{ t('portraitAddDefaultBtn') }}
              </ActionButton>
              <ActionButton
                size="sm"
                :disabled="saving || !publicFields.length"
                data-testid="kt-rp-portraits-add-rule-btn"
                @click="addPortraitRule(false)"
              >
                {{ t('portraitAddRuleBtn') }}
              </ActionButton>
              <ActionButton
                v-if="portraitRows.length"
                size="sm"
                variant="danger"
                :disabled="saving"
                data-testid="kt-rp-portraits-clear-btn"
                @click="clearAllPortraits"
              >
                {{ t('portraitClearAllBtn') }}
              </ActionButton>
            </div>
          </div>

          <p v-if="!publicFields.length" class="ktrp-muted" data-testid="kt-rp-portraits-no-public-fields">
            {{ t('portraitNoPublicFieldsHint') }}
          </p>

          <div v-if="!portraitRows.length" class="ktrp-empty" data-testid="kt-rp-portraits-empty">
            {{ t('portraitEmptyList') }}
          </div>

          <div
            v-for="(row, idx) in portraitRows"
            :key="idx"
            class="ktrp-sub-card ktrp-portrait-rule-row"
            :data-testid="'kt-rp-portrait-row-' + idx"
          >
            <div class="ktrp-row-between">
              <strong class="ktrp-muted">
                {{ t('portraitRuleOrderTitle', { index: idx + 1 }) }}
                <span v-if="row.isDefault" class="ktrp-chip ktrp-chip--accent">{{ t('portraitDefaultBadge') }}</span>
              </strong>
              <div class="ktrp-row-end">
                <ActionButton
                  size="sm"
                  variant="ghost"
                  :disabled="saving || idx === 0"
                  :data-testid="'kt-rp-portrait-up-' + idx"
                  @click="moveRule(idx, -1)"
                >
                  {{ t('portraitMoveUp') }}
                </ActionButton>
                <ActionButton
                  size="sm"
                  variant="ghost"
                  :disabled="saving || idx === portraitRows.length - 1"
                  :data-testid="'kt-rp-portrait-down-' + idx"
                  @click="moveRule(idx, 1)"
                >
                  {{ t('portraitMoveDown') }}
                </ActionButton>
                <ActionButton
                  size="sm"
                  variant="danger"
                  :disabled="saving"
                  :data-testid="'kt-rp-portrait-remove-' + idx"
                  @click="removePortraitRule(idx)"
                >
                  {{ t('editorRemoveItem') }}
                </ActionButton>
              </div>
            </div>

            <div class="ktrp-portrait-rule-body">
              <div class="ktrp-portrait-upload-col">
                <div class="ktrp-portrait ktrp-portrait--md" :data-has-image="Boolean(row.data)">
                  <img
                    v-if="row.data"
                    :src="'data:image/png;base64,' + row.data"
                    :alt="row.key || 'Portrait preview'"
                    class="ktrp-portrait-img"
                    :data-testid="'kt-rp-portrait-preview-' + idx"
                  />
                  <span v-else class="ktrp-portrait-monogram" aria-hidden="true">PNG</span>
                </div>
                <ActionButton
                  size="sm"
                  :disabled="saving"
                  :data-testid="'kt-rp-portrait-pick-png-' + idx"
                  @click="triggerPngSelect(idx)"
                >
                  {{ row.data ? t('portraitReplacePngBtn') : t('portraitPickPngBtn') }}
                </ActionButton>
              </div>

              <div class="ktrp-portrait-fields-col">
                <div class="ktrp-form-grid">
                  <div class="ktrp-field-block">
                    <label class="ktrp-label" :for="'ktrp-pr-key-' + idx">{{ t('portraitKeyLabel') }}</label>
                    <input
                      :id="'ktrp-pr-key-' + idx"
                      v-model="row.key"
                      type="text"
                      class="ktrp-input"
                      :placeholder="t('portraitKeyPlaceholder')"
                      :data-testid="'kt-rp-portrait-key-' + idx"
                    />
                  </div>

                  <div class="ktrp-field-block">
                    <label class="ktrp-label" :for="'ktrp-pr-scope-' + idx">{{ t('portraitScopeLabel') }}</label>
                    <select
                      :id="'ktrp-pr-scope-' + idx"
                      v-model="row.isDefault"
                      class="ktrp-select"
                      :data-testid="'kt-rp-portrait-scope-' + idx"
                      @change="onScopeChange(row)"
                    >
                      <option :value="true">{{ t('portraitScopeDefault') }}</option>
                      <option v-if="publicFields.length" :value="false">{{ t('portraitScopeMatch') }}</option>
                    </select>
                  </div>
                </div>

                <div v-if="!row.isDefault && publicFields.length" class="ktrp-form-grid">
                  <div class="ktrp-field-block">
                    <label class="ktrp-label" :for="'ktrp-pr-field-' + idx">{{ t('portraitFieldLabel') }}</label>
                    <select
                      :id="'ktrp-pr-field-' + idx"
                      v-model="row.field"
                      class="ktrp-select"
                      :data-testid="'kt-rp-portrait-field-' + idx"
                      @change="onFieldChange(row)"
                    >
                      <option v-for="f in publicFields" :key="f.key" :value="f.key">
                        {{ f.label }} ({{ f.key }} · {{ f.type }})
                      </option>
                    </select>
                  </div>

                  <div class="ktrp-field-block">
                    <label class="ktrp-label" :for="'ktrp-pr-equals-' + idx">{{ t('portraitEqualsLabel') }}</label>
                    <select
                      v-if="fieldForRow(row)?.type === 'enum'"
                      :id="'ktrp-pr-equals-' + idx"
                      v-model="row.equalsText"
                      class="ktrp-select"
                      :data-testid="'kt-rp-portrait-equals-' + idx"
                    >
                      <option v-for="opt in fieldForRow(row).options" :key="opt" :value="opt">{{ opt }}</option>
                    </select>
                    <input
                      v-else-if="fieldForRow(row)?.type === 'number'"
                      :id="'ktrp-pr-equals-' + idx"
                      v-model="row.equalsText"
                      type="number"
                      step="any"
                      class="ktrp-input"
                      :data-testid="'kt-rp-portrait-equals-' + idx"
                    />
                    <input
                      v-else
                      :id="'ktrp-pr-equals-' + idx"
                      v-model="row.equalsText"
                      type="text"
                      class="ktrp-input"
                      :data-testid="'kt-rp-portrait-equals-' + idx"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>
    </div>
  `,
};
