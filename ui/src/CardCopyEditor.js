import { computed, ref, watch } from "vue";
import { ActionButton, useOwner } from "@kohakuterrarium/ui-sdk";

import {
  areStateDefinitionsEqual,
  buildStateDefinitionsPayload,
  cloneEditableFields,
  cloneStateDefinitionsToForm,
  diffCardFields,
} from "./helpers.js";
import { useRoleplayText } from "./strings.js";

/**
 * Interactive card copy editor for the Card Library (both Settings and Studio Tab).
 * Loads via `edit_draft { id }`, edits CardFields & interactive StateField[] rows,
 * and saves strictly via `save_copy` to create a new library entry without mutating the original card or live sessions.
 */
export const CardCopyEditor = {
  name: "RoleplayCardCopyEditor",
  components: { ActionButton },
  props: {
    cardId: { type: String, required: true },
    cardName: { type: String, default: "" },
  },
  emits: ["cancel", "saved"],
  setup(props, { emit }) {
    const owner = useOwner();
    const t = useRoleplayText();

    const loading = ref(false);
    const saving = ref(false);
    const loadError = ref("");
    const saveError = ref("");

    const originalFields = ref({});
    const originalStateDefs = ref([]);
    const draftFields = ref(cloneEditableFields({}));
    const stateRows = ref([]);

    const newTagText = ref("");
    const newListItemText = ref({});
    const newEnumOptionText = ref({});

    let loadSeq = 0;
    async function loadDraft(cardId) {
      const seq = ++loadSeq;
      loadError.value = "";
      saveError.value = "";
      if (!cardId || owner.status.value !== "ready") return;
      loading.value = true;
      try {
        const draft = await owner.call("edit_draft", { id: cardId });
        if (seq !== loadSeq) return;
        const rawFields = draft?.fields || {};
        const rawDefs = Array.isArray(draft?.stateDefinitions) ? draft.stateDefinitions : [];
        originalFields.value = cloneEditableFields(rawFields);
        originalStateDefs.value = rawDefs;
        draftFields.value = cloneEditableFields(rawFields);
        stateRows.value = cloneStateDefinitionsToForm(rawDefs);
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

    const isDirty = computed(() => {
      const patch = diffCardFields(originalFields.value, draftFields.value);
      if (Object.keys(patch).length > 0) return true;
      const built = buildStateDefinitionsPayload(stateRows.value);
      if (!built.ok) return true;
      return !areStateDefinitionsEqual(originalStateDefs.value, built.definitions);
    });

    function addAlternateGreeting() {
      draftFields.value.alternate_greetings.push("");
    }

    function removeAlternateGreeting(idx) {
      draftFields.value.alternate_greetings.splice(idx, 1);
    }

    function addTag() {
      const val = newTagText.value.trim();
      if (!val) return;
      if (!draftFields.value.tags.includes(val)) {
        draftFields.value.tags.push(val);
      }
      newTagText.value = "";
    }

    function removeTag(idx) {
      draftFields.value.tags.splice(idx, 1);
    }

    function addStateField() {
      stateRows.value.push({
        key: "",
        label: "",
        type: "text",
        visibility: "public",
        initialText: "",
        minText: "",
        maxText: "",
        options: [],
        listItems: [],
      });
    }

    function removeStateField(idx) {
      stateRows.value.splice(idx, 1);
      delete newListItemText.value[idx];
      delete newEnumOptionText.value[idx];
    }

    function onStateTypeChange(row) {
      if (row.type === "number") {
        if (!row.initialText || !Number.isFinite(Number(row.initialText))) {
          row.initialText = "0";
        }
      } else if (row.type === "enum") {
        if (!Array.isArray(row.options)) row.options = [];
        if (!row.options.includes(row.initialText)) {
          row.initialText = row.options[0] || "";
        }
      } else if (row.type === "list") {
        if (!Array.isArray(row.listItems)) row.listItems = [];
      } else {
        row.initialText = String(row.initialText ?? "");
      }
    }

    function addEnumOption(idx) {
      const row = stateRows.value[idx];
      const val = String(newEnumOptionText.value[idx] ?? "").trim();
      if (!row || !val) return;
      if (!row.options.includes(val)) {
        row.options.push(val);
      }
      if (!row.options.includes(row.initialText)) {
        row.initialText = row.options[0] || "";
      }
      newEnumOptionText.value[idx] = "";
    }

    function removeEnumOption(rowIdx, optIdx) {
      const row = stateRows.value[rowIdx];
      if (!row) return;
      const removed = row.options[optIdx];
      row.options.splice(optIdx, 1);
      if (row.initialText === removed) {
        row.initialText = row.options[0] || "";
      }
    }

    function addListItem(idx) {
      const row = stateRows.value[idx];
      const val = String(newListItemText.value[idx] ?? "").trim();
      if (!row || !val) return;
      row.listItems.push(val);
      newListItemText.value[idx] = "";
    }

    function removeListItem(rowIdx, itemIdx) {
      const row = stateRows.value[rowIdx];
      if (!row) return;
      row.listItems.splice(itemIdx, 1);
    }

    function formatValidationError(err) {
      const n = (err.index ?? 0) + 1;
      const key = err.key || `#${n}`;
      switch (err.code) {
        case "key":
          return t("editorStateErrKey", { index: n });
        case "duplicateKey":
          return t("editorStateErrDuplicateKey", { key });
        case "label":
          return t("editorStateErrLabel", { index: n, key });
        case "numberInitial":
          return t("editorStateErrNumberInitial", { key });
        case "numberBounds":
          return t("editorStateErrNumberBounds", { key });
        case "numberRangeOrder":
          return t("editorStateErrNumberRange", { key });
        case "numberOutOfBounds":
          return t("editorStateErrNumberOutOfBounds", { key });
        case "enumOptions":
          return t("editorStateErrEnumOptions", { key });
        case "enumInitial":
          return t("editorStateErrEnumInitial", { key });
        default:
          return t("actionFailed");
      }
    }

    async function saveCopy() {
      if (saving.value || loading.value) return;
      saveError.value = "";

      if (!draftFields.value.name.trim()) {
        saveError.value = t("editorNameRequired");
        return;
      }

      const builtState = buildStateDefinitionsPayload(stateRows.value);
      if (!builtState.ok) {
        saveError.value = formatValidationError(builtState);
        return;
      }

      const fieldsPatch = diffCardFields(originalFields.value, draftFields.value);
      const stateChanged = !areStateDefinitionsEqual(originalStateDefs.value, builtState.definitions);

      const payload = {
        id: props.cardId,
        fields: fieldsPatch,
      };
      if (stateChanged) {
        payload.stateDefinitions = builtState.definitions;
      }

      saving.value = true;
      try {
        const created = await owner.call("save_copy", payload);
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
      t,
      props,
      loading,
      saving,
      loadError,
      saveError,
      draftFields,
      stateRows,
      newTagText,
      newListItemText,
      newEnumOptionText,
      isDirty,
      loadDraft,
      addAlternateGreeting,
      removeAlternateGreeting,
      addTag,
      removeTag,
      addStateField,
      removeStateField,
      onStateTypeChange,
      addEnumOption,
      removeEnumOption,
      addListItem,
      removeListItem,
      saveCopy,
      cancelEdit,
    };
  },
  template: `
    <div class="ktrp-editor" data-testid="kt-rp-card-editor">
      <div class="ktrp-row-between">
        <div>
          <h3>{{ t('editorTitle', { name: props.cardName || draftFields.name }) }}</h3>
          <p class="ktrp-muted">{{ t('editorImmutabilityNotice') }}</p>
        </div>
        <div class="ktrp-row-end">
          <ActionButton
            size="sm"
            variant="ghost"
            :disabled="saving"
            data-testid="kt-rp-editor-cancel-btn"
            @click="cancelEdit"
          >
            {{ t('editorCancelBtn') }}
          </ActionButton>
          <ActionButton
            size="sm"
            variant="primary"
            :disabled="loading || saving"
            data-testid="kt-rp-editor-save-copy-btn"
            @click="saveCopy"
          >
            {{ saving ? t('editorSaving') : t('editorSaveCopyBtn') }}
          </ActionButton>
        </div>
      </div>

      <div v-if="loading" class="ktrp-empty" role="status" data-testid="kt-rp-editor-loading">
        {{ t('loading') }}
      </div>
      <div v-else-if="loadError" class="ktrp-banner ktrp-banner--error" role="alert" data-testid="kt-rp-editor-load-error">
        <span>{{ loadError }}</span>
        <ActionButton size="sm" @click="loadDraft(props.cardId)">{{ t('retry') }}</ActionButton>
      </div>

      <template v-else>
        <div v-if="saveError" class="ktrp-banner ktrp-banner--error" role="alert" data-testid="kt-rp-editor-error">
          <span>{{ saveError }}</span>
        </div>

        <!-- Core CardFields -->
        <div class="ktrp-card-box">
          <div class="ktrp-box-head">{{ t('editorProfileSection') }}</div>

          <div class="ktrp-field-block">
            <label class="ktrp-label" for="ktrp-edit-name">{{ t('editorFieldName') }}</label>
            <input
              id="ktrp-edit-name"
              v-model="draftFields.name"
              type="text"
              class="ktrp-input"
              data-testid="kt-rp-edit-name"
            />
          </div>

          <div class="ktrp-field-block">
            <label class="ktrp-label" for="ktrp-edit-creator">{{ t('creatorLabel') }}</label>
            <input
              id="ktrp-edit-creator"
              v-model="draftFields.creator"
              type="text"
              class="ktrp-input"
              data-testid="kt-rp-edit-creator"
            />
          </div>

          <div class="ktrp-field-block">
            <label class="ktrp-label" for="ktrp-edit-description">{{ t('descriptionLabel') }}</label>
            <textarea
              id="ktrp-edit-description"
              v-model="draftFields.description"
              rows="4"
              class="ktrp-textarea"
              data-testid="kt-rp-edit-description"
            />
          </div>

          <div class="ktrp-field-block">
            <label class="ktrp-label" for="ktrp-edit-personality">{{ t('personalityLabel') }}</label>
            <textarea
              id="ktrp-edit-personality"
              v-model="draftFields.personality"
              rows="3"
              class="ktrp-textarea"
              data-testid="kt-rp-edit-personality"
            />
          </div>

          <div class="ktrp-field-block">
            <label class="ktrp-label" for="ktrp-edit-scenario">{{ t('scenarioLabel') }}</label>
            <textarea
              id="ktrp-edit-scenario"
              v-model="draftFields.scenario"
              rows="3"
              class="ktrp-textarea"
              data-testid="kt-rp-edit-scenario"
            />
          </div>

          <div class="ktrp-field-block">
            <label class="ktrp-label" for="ktrp-edit-examples">{{ t('examplesLabel') }}</label>
            <textarea
              id="ktrp-edit-examples"
              v-model="draftFields.mes_example"
              rows="3"
              class="ktrp-textarea"
              data-testid="kt-rp-edit-examples"
            />
          </div>

          <div class="ktrp-field-block">
            <label class="ktrp-label" for="ktrp-edit-system-prompt">{{ t('systemPromptLabel') }}</label>
            <textarea
              id="ktrp-edit-system-prompt"
              v-model="draftFields.system_prompt"
              rows="2"
              class="ktrp-textarea"
              data-testid="kt-rp-edit-system-prompt"
            />
          </div>

          <div class="ktrp-field-block">
            <label class="ktrp-label" for="ktrp-edit-post-history">{{ t('postHistoryLabel') }}</label>
            <textarea
              id="ktrp-edit-post-history"
              v-model="draftFields.post_history_instructions"
              rows="2"
              class="ktrp-textarea"
              data-testid="kt-rp-edit-post-history"
            />
          </div>

          <div class="ktrp-field-block">
            <label class="ktrp-label" for="ktrp-edit-creator-notes">{{ t('creatorNotesLabel') }}</label>
            <textarea
              id="ktrp-edit-creator-notes"
              v-model="draftFields.creator_notes"
              rows="2"
              class="ktrp-textarea"
              data-testid="kt-rp-edit-creator-notes"
            />
          </div>

          <!-- Tags -->
          <div class="ktrp-field-block">
            <label class="ktrp-label" for="ktrp-edit-tag-input">{{ t('tagsLabel') }}</label>
            <div v-if="draftFields.tags.length" class="ktrp-tag-list" data-testid="kt-rp-edit-tags-list">
              <span v-for="(tag, idx) in draftFields.tags" :key="tag + '-' + idx" class="ktrp-tag ktrp-tag--editable">
                <span>{{ tag }}</span>
                <button
                  type="button"
                  class="ktrp-chip-x"
                  :aria-label="t('editorRemoveItem')"
                  :data-testid="'kt-rp-edit-tag-remove-' + idx"
                  @click="removeTag(idx)"
                >
                  ×
                </button>
              </span>
            </div>
            <div class="ktrp-inline-add">
              <input
                id="ktrp-edit-tag-input"
                v-model="newTagText"
                type="text"
                class="ktrp-input"
                :placeholder="t('editorAddTagPlaceholder')"
                data-testid="kt-rp-edit-tag-input"
                @keydown.enter.prevent="addTag"
              />
              <ActionButton size="sm" data-testid="kt-rp-edit-tag-add-btn" @click="addTag">
                {{ t('editorAddBtn') }}
              </ActionButton>
            </div>
          </div>
        </div>

        <!-- Openings: first_mes + alternate_greetings -->
        <div class="ktrp-card-box">
          <div class="ktrp-row-between">
            <div class="ktrp-box-head">{{ t('editorOpeningsSection') }}</div>
            <ActionButton size="sm" data-testid="kt-rp-edit-add-alt-btn" @click="addAlternateGreeting">
              {{ t('editorAddAltGreeting') }}
            </ActionButton>
          </div>

          <div class="ktrp-field-block">
            <label class="ktrp-label" for="ktrp-edit-first-mes">{{ t('greetingPrimary') }}</label>
            <textarea
              id="ktrp-edit-first-mes"
              v-model="draftFields.first_mes"
              rows="4"
              class="ktrp-textarea"
              data-testid="kt-rp-edit-first-mes"
            />
          </div>

          <div
            v-for="(_, idx) in draftFields.alternate_greetings"
            :key="idx"
            class="ktrp-field-block ktrp-sub-card"
            :data-testid="'kt-rp-edit-alt-row-' + idx"
          >
            <div class="ktrp-row-between">
              <label class="ktrp-label" :for="'ktrp-edit-alt-' + idx">
                {{ t('greetingAlternate', { index: idx + 2 }) }}
              </label>
              <ActionButton
                size="sm"
                variant="danger"
                :data-testid="'kt-rp-edit-alt-remove-' + idx"
                @click="removeAlternateGreeting(idx)"
              >
                {{ t('editorRemoveItem') }}
              </ActionButton>
            </div>
            <textarea
              :id="'ktrp-edit-alt-' + idx"
              v-model="draftFields.alternate_greetings[idx]"
              rows="3"
              class="ktrp-textarea"
              :data-testid="'kt-rp-edit-alt-input-' + idx"
            />
          </div>
        </div>

        <!-- Interactive StateField[] definitions -->
        <div class="ktrp-card-box" data-testid="kt-rp-edit-state-section">
          <div class="ktrp-row-between">
            <div>
              <div class="ktrp-box-head">{{ t('editorStateSection') }}</div>
              <p class="ktrp-muted">{{ t('editorStateHint') }}</p>
            </div>
            <ActionButton size="sm" data-testid="kt-rp-edit-state-add-btn" @click="addStateField">
              {{ t('editorAddStateField') }}
            </ActionButton>
          </div>

          <div v-if="!stateRows.length" class="ktrp-empty" data-testid="kt-rp-edit-state-empty">
            {{ t('editorNoStateFields') }}
          </div>

          <div
            v-for="(row, idx) in stateRows"
            :key="idx"
            class="ktrp-sub-card"
            :data-testid="'kt-rp-edit-state-row-' + idx"
          >
            <div class="ktrp-row-between">
              <strong class="ktrp-muted">{{ t('editorStateRowTitle', { index: idx + 1 }) }}</strong>
              <ActionButton
                size="sm"
                variant="danger"
                :data-testid="'kt-rp-edit-state-remove-' + idx"
                @click="removeStateField(idx)"
              >
                {{ t('editorRemoveItem') }}
              </ActionButton>
            </div>

            <div class="ktrp-form-grid">
              <div class="ktrp-field-block">
                <label class="ktrp-label" :for="'ktrp-sf-key-' + idx">{{ t('editorStateKey') }}</label>
                <input
                  :id="'ktrp-sf-key-' + idx"
                  v-model="row.key"
                  type="text"
                  class="ktrp-input"
                  :placeholder="t('editorStateKeyPlaceholder')"
                  :data-testid="'kt-rp-edit-state-key-' + idx"
                />
              </div>

              <div class="ktrp-field-block">
                <label class="ktrp-label" :for="'ktrp-sf-label-' + idx">{{ t('editorStateLabel') }}</label>
                <input
                  :id="'ktrp-sf-label-' + idx"
                  v-model="row.label"
                  type="text"
                  class="ktrp-input"
                  :data-testid="'kt-rp-edit-state-label-' + idx"
                />
              </div>

              <div class="ktrp-field-block">
                <label class="ktrp-label" :for="'ktrp-sf-type-' + idx">{{ t('editorStateType') }}</label>
                <select
                  :id="'ktrp-sf-type-' + idx"
                  v-model="row.type"
                  class="ktrp-select"
                  :data-testid="'kt-rp-edit-state-type-' + idx"
                  @change="onStateTypeChange(row)"
                >
                  <option value="text">{{ t('editorTypeText') }}</option>
                  <option value="number">{{ t('editorTypeNumber') }}</option>
                  <option value="enum">{{ t('editorTypeEnum') }}</option>
                  <option value="list">{{ t('editorTypeList') }}</option>
                </select>
              </div>

              <div class="ktrp-field-block">
                <label class="ktrp-label" :for="'ktrp-sf-vis-' + idx">{{ t('editorStateVisibility') }}</label>
                <select
                  :id="'ktrp-sf-vis-' + idx"
                  v-model="row.visibility"
                  class="ktrp-select"
                  :data-testid="'kt-rp-edit-state-visibility-' + idx"
                >
                  <option value="public">{{ t('editorVisPublic') }}</option>
                  <option value="private">{{ t('editorVisPrivate') }}</option>
                </select>
              </div>
            </div>

            <!-- Type-specific initial & constraints -->
            <div v-if="row.type === 'text'" class="ktrp-field-block">
              <label class="ktrp-label" :for="'ktrp-sf-init-text-' + idx">{{ t('editorStateInitial') }}</label>
              <input
                :id="'ktrp-sf-init-text-' + idx"
                v-model="row.initialText"
                type="text"
                class="ktrp-input"
                :data-testid="'kt-rp-edit-state-initial-' + idx"
              />
            </div>

            <div v-else-if="row.type === 'number'" class="ktrp-form-grid-3">
              <div class="ktrp-field-block">
                <label class="ktrp-label" :for="'ktrp-sf-init-num-' + idx">{{ t('editorStateInitial') }}</label>
                <input
                  :id="'ktrp-sf-init-num-' + idx"
                  v-model="row.initialText"
                  type="number"
                  step="any"
                  class="ktrp-input"
                  :data-testid="'kt-rp-edit-state-initial-' + idx"
                />
              </div>
              <div class="ktrp-field-block">
                <label class="ktrp-label" :for="'ktrp-sf-min-' + idx">{{ t('editorStateMin') }}</label>
                <input
                  :id="'ktrp-sf-min-' + idx"
                  v-model="row.minText"
                  type="number"
                  step="any"
                  class="ktrp-input"
                  :data-testid="'kt-rp-edit-state-min-' + idx"
                />
              </div>
              <div class="ktrp-field-block">
                <label class="ktrp-label" :for="'ktrp-sf-max-' + idx">{{ t('editorStateMax') }}</label>
                <input
                  :id="'ktrp-sf-max-' + idx"
                  v-model="row.maxText"
                  type="number"
                  step="any"
                  class="ktrp-input"
                  :data-testid="'kt-rp-edit-state-max-' + idx"
                />
              </div>
            </div>

            <div v-else-if="row.type === 'enum'" class="ktrp-stack">
              <div class="ktrp-field-block">
                <label class="ktrp-label" :for="'ktrp-sf-enum-opt-' + idx">{{ t('editorStateEnumOptions') }}</label>
                <div v-if="row.options.length" class="ktrp-tag-list">
                  <span v-for="(opt, optIdx) in row.options" :key="opt + '-' + optIdx" class="ktrp-tag ktrp-tag--editable">
                    <span>{{ opt }}</span>
                    <button
                      type="button"
                      class="ktrp-chip-x"
                      :aria-label="t('editorRemoveItem')"
                      :data-testid="'kt-rp-edit-state-opt-remove-' + idx + '-' + optIdx"
                      @click="removeEnumOption(idx, optIdx)"
                    >
                      ×
                    </button>
                  </span>
                </div>
                <div class="ktrp-inline-add">
                  <input
                    :id="'ktrp-sf-enum-opt-' + idx"
                    v-model="newEnumOptionText[idx]"
                    type="text"
                    class="ktrp-input"
                    :placeholder="t('editorAddOptionPlaceholder')"
                    :data-testid="'kt-rp-edit-state-opt-input-' + idx"
                    @keydown.enter.prevent="addEnumOption(idx)"
                  />
                  <ActionButton
                    size="sm"
                    :data-testid="'kt-rp-edit-state-opt-add-' + idx"
                    @click="addEnumOption(idx)"
                  >
                    {{ t('editorAddBtn') }}
                  </ActionButton>
                </div>
              </div>
              <div class="ktrp-field-block">
                <label class="ktrp-label" :for="'ktrp-sf-init-enum-' + idx">{{ t('editorStateInitial') }}</label>
                <select
                  :id="'ktrp-sf-init-enum-' + idx"
                  v-model="row.initialText"
                  class="ktrp-select"
                  :data-testid="'kt-rp-edit-state-initial-' + idx"
                >
                  <option v-for="opt in row.options" :key="opt" :value="opt">{{ opt }}</option>
                </select>
              </div>
            </div>

            <div v-else-if="row.type === 'list'" class="ktrp-field-block">
              <label class="ktrp-label" :for="'ktrp-sf-list-init-' + idx">{{ t('editorStateInitialList') }}</label>
              <div v-if="row.listItems.length" class="ktrp-tag-list">
                <span v-for="(item, itemIdx) in row.listItems" :key="item + '-' + itemIdx" class="ktrp-tag ktrp-tag--editable">
                  <span>{{ item }}</span>
                  <button
                    type="button"
                    class="ktrp-chip-x"
                    :aria-label="t('editorRemoveItem')"
                    :data-testid="'kt-rp-edit-state-list-remove-' + idx + '-' + itemIdx"
                    @click="removeListItem(idx, itemIdx)"
                  >
                    ×
                  </button>
                </span>
              </div>
              <div class="ktrp-inline-add">
                <input
                  :id="'ktrp-sf-list-init-' + idx"
                  v-model="newListItemText[idx]"
                  type="text"
                  class="ktrp-input"
                  :placeholder="t('editorAddListItemPlaceholder')"
                  :data-testid="'kt-rp-edit-state-list-input-' + idx"
                  @keydown.enter.prevent="addListItem(idx)"
                />
                <ActionButton
                  size="sm"
                  :data-testid="'kt-rp-edit-state-list-add-' + idx"
                  @click="addListItem(idx)"
                >
                  {{ t('editorAddBtn') }}
                </ActionButton>
              </div>
            </div>
          </div>
        </div>

        <div class="ktrp-row-end">
          <ActionButton
            size="sm"
            variant="ghost"
            :disabled="saving"
            data-testid="kt-rp-editor-cancel-bottom-btn"
            @click="cancelEdit"
          >
            {{ t('editorCancelBtn') }}
          </ActionButton>
          <ActionButton
            size="sm"
            variant="primary"
            :disabled="loading || saving"
            data-testid="kt-rp-editor-save-copy-bottom-btn"
            @click="saveCopy"
          >
            {{ saving ? t('editorSaving') : t('editorSaveCopyBtn') }}
          </ActionButton>
        </div>
      </template>
    </div>
  `,
};
