import { computed, ref, watch } from "vue";
import { ActionButton } from "@kohakuterrarium/ui-sdk";

import {
  DEFAULT_MAX_NOVEL_MEDIA_BYTES,
  normalizeActorMemory,
  normalizeSheet,
  normalizeStateFields,
  readFileAsImageDataUrl,
  validateMediaImageFile,
} from "./helpers.js";
import { PortraitFrame } from "./PortraitFrame.js";
import { StateFieldsView } from "./StateFieldsView.js";
import { useRoleplayText } from "./strings.js";

function sheetHasContent(sheet) {
  return sheet.meters.length > 0 || sheet.entries.length > 0 || sheet.lists.length > 0;
}

function meterPercent(meter) {
  if (typeof meter.max !== "number" || !Number.isFinite(meter.max) || meter.max <= 0) {
    return 0;
  }
  const ratio = (meter.current / meter.max) * 100;
  return Math.max(0, Math.min(100, Math.round(ratio * 10) / 10));
}

function formatMeterValue(meter) {
  const unitSuffix = meter.unit ? ` ${meter.unit}` : "";
  if (typeof meter.max === "number" && Number.isFinite(meter.max) && meter.max > 0) {
    return `${meter.current} / ${meter.max}${unitSuffix}`;
  }
  return `${meter.current}${unitSuffix}`;
}

/**
 * Dynamic character sheet & perspective memory renderer shared by Novel Play mini panel,
 * NPC Play sheet, and Novel Reader cast views.
 */
export const CharacterSheetView = {
  name: "RoleplayCharacterSheetView",
  components: {
    ActionButton,
    PortraitFrame,
    StateFieldsView,
  },
  props: {
    actor: { type: Object, required: true },
    showPrivate: { type: Boolean, default: false },
    showMemory: { type: Boolean, default: false },
    allowUploadPortrait: { type: Boolean, default: false },
    allowSaveToLibrary: { type: Boolean, default: false },
    showHeader: { type: Boolean, default: true },
    compact: { type: Boolean, default: false },
    busy: { type: Boolean, default: false },
    onUploadPortrait: { type: Function, default: null },
    onSaveToLibrary: { type: Function, default: null },
    testIdPrefix: { type: String, default: "kt-rp-sheet" },
  },
  setup(props) {
    const t = useRoleplayText();
    const fileInput = ref(null);
    const uploading = ref(false);
    const savingToLibrary = ref(false);
    const localError = ref("");

    const actorId = computed(() => String(props.actor?.actor || ""));
    const actorName = computed(() => String(props.actor?.name || actorId.value || ""));
    const isEphemeral = computed(
      () => Boolean(props.actor?.ephemeral) && !props.actor?.cardId,
    );

    const publicSheet = computed(() => normalizeSheet(props.actor?.sheet));
    const privateSheet = computed(() => normalizeSheet(props.actor?.privateSheet));
    const memory = computed(() => normalizeActorMemory(props.actor?.memory));

    const existingSheetKeys = computed(() => {
      const keys = new Set();
      for (const sheet of [publicSheet.value, privateSheet.value]) {
        for (const item of sheet.meters) keys.add(item.key);
        for (const item of sheet.entries) keys.add(item.key);
        for (const item of sheet.lists) keys.add(item.key);
      }
      return keys;
    });

    const fallbackStateFields = computed(() =>
      normalizeStateFields(props.actor?.stateFields).filter(
        (field) => !existingSheetKeys.value.has(field.key),
      ),
    );

    const fallbackVisibleStatus = computed(() => {
      const raw = props.actor?.visibleStatus;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
      const stateKeySet = new Set(fallbackStateFields.value.map((f) => f.key));
      const out = [];
      for (const [k, v] of Object.entries(raw)) {
        if (existingSheetKeys.value.has(k) || stateKeySet.has(k)) continue;
        if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
          out.push({ key: k, value: String(v) });
        }
      }
      return out;
    });

    const hasPublicContent = computed(
      () =>
        sheetHasContent(publicSheet.value) ||
        fallbackStateFields.value.length > 0 ||
        fallbackVisibleStatus.value.length > 0,
    );

    const hasPrivateSheetContent = computed(() => sheetHasContent(privateSheet.value));
    const impressionRows = computed(() =>
      Object.entries(memory.value.impressions).map(([target, note]) => ({ target, note })),
    );
    const hasMemoryContent = computed(
      () =>
        Boolean(memory.value.summary) ||
        impressionRows.value.length > 0 ||
        memory.value.facts_witnessed.length > 0 ||
        memory.value.beliefs.length > 0,
    );

    const maxMediaMiB = computed(
      () => Math.round((DEFAULT_MAX_NOVEL_MEDIA_BYTES / (1024 * 1024)) * 10) / 10,
    );

    watch(actorId, () => {
      localError.value = "";
    });

    function triggerPortraitUpload() {
      if (props.busy || uploading.value || !props.allowUploadPortrait) return;
      localError.value = "";
      fileInput.value?.click();
    }

    async function handlePortraitFileChange(event) {
      const file = event.target?.files?.[0];
      if (event.target) event.target.value = "";
      if (!file || props.busy || uploading.value || typeof props.onUploadPortrait !== "function") {
        return;
      }
      const check = validateMediaImageFile(file, DEFAULT_MAX_NOVEL_MEDIA_BYTES);
      if (!check.ok) {
        localError.value = t("sheetInvalidImageError", { mb: maxMediaMiB.value });
        return;
      }
      uploading.value = true;
      localError.value = "";
      try {
        const dataUrl = await readFileAsImageDataUrl(file, DEFAULT_MAX_NOVEL_MEDIA_BYTES);
        await props.onUploadPortrait({
          actor: actorId.value,
          dataUrl,
          name: file.name || "portrait",
        });
      } catch (err) {
        localError.value = err?.message || String(err);
      } finally {
        uploading.value = false;
      }
    }

    async function saveToLibrary() {
      if (
        props.busy ||
        savingToLibrary.value ||
        !props.allowSaveToLibrary ||
        !isEphemeral.value ||
        typeof props.onSaveToLibrary !== "function"
      ) {
        return;
      }
      savingToLibrary.value = true;
      localError.value = "";
      try {
        await props.onSaveToLibrary(actorId.value);
      } catch (err) {
        localError.value = err?.message || String(err);
      } finally {
        savingToLibrary.value = false;
      }
    }

    return {
      props,
      t,
      fileInput,
      uploading,
      savingToLibrary,
      localError,
      actorId,
      actorName,
      isEphemeral,
      publicSheet,
      privateSheet,
      memory,
      fallbackStateFields,
      fallbackVisibleStatus,
      hasPublicContent,
      hasPrivateSheetContent,
      impressionRows,
      hasMemoryContent,
      sheetHasContent,
      meterPercent,
      formatMeterValue,
      triggerPortraitUpload,
      handlePortraitFileChange,
      saveToLibrary,
    };
  },
  template: `
    <div
      class="ktrp-sheet"
      :class="{ 'ktrp-sheet--compact': props.compact }"
      :data-actor="actorId"
      :data-testid="props.testIdPrefix"
    >
      <div v-if="props.showHeader" class="ktrp-sheet-header">
        <PortraitFrame
          :card-id="props.actor?.cardId || ''"
          :name="actorName"
          :has-portrait="Boolean(props.actor?.hasPortrait)"
          :variant="props.actor?.portraitKey || ''"
          :custom-portrait-url="props.actor?.customPortraitUrl || ''"
          arg-key="id"
          :size="props.compact ? 'sm' : 'md'"
        />
        <div class="ktrp-sheet-identity">
          <div class="ktrp-cast-head">
            <strong :data-testid="props.testIdPrefix + '-name'">{{ actorName }}</strong>
            <span
              v-if="isEphemeral"
              class="ktrp-chip"
              :data-testid="props.testIdPrefix + '-ephemeral-badge'"
            >
              {{ t('sheetEphemeralBadge') }}
            </span>
          </div>
          <p v-if="props.actor?.persona" class="ktrp-muted ktrp-pre" :data-testid="props.testIdPrefix + '-persona'">
            {{ props.actor.persona }}
          </p>
          <div
            v-if="props.allowUploadPortrait || (props.allowSaveToLibrary && isEphemeral)"
            class="ktrp-inline-actions"
          >
            <ActionButton
              v-if="props.allowUploadPortrait"
              size="sm"
              :disabled="props.busy || uploading"
              :data-testid="props.testIdPrefix + '-upload-portrait-btn'"
              @click="triggerPortraitUpload"
            >
              {{ uploading ? t('sheetUploadingPortrait') : t('sheetUploadPortraitBtn') }}
            </ActionButton>
            <input
              v-if="props.allowUploadPortrait"
              ref="fileInput"
              type="file"
              accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
              hidden
              tabindex="-1"
              :disabled="props.busy || uploading"
              :data-testid="props.testIdPrefix + '-portrait-input'"
              @change="handlePortraitFileChange"
            />
            <ActionButton
              v-if="props.allowSaveToLibrary && isEphemeral"
              size="sm"
              variant="primary"
              :disabled="props.busy || savingToLibrary"
              :data-testid="props.testIdPrefix + '-save-library-btn'"
              @click="saveToLibrary"
            >
              {{ savingToLibrary ? t('sheetSavingToLibrary') : t('sheetSaveToLibraryBtn') }}
            </ActionButton>
          </div>
        </div>
      </div>

      <div
        v-if="localError"
        class="ktrp-banner ktrp-banner--error"
        role="alert"
        :data-testid="props.testIdPrefix + '-error'"
      >
        <span>{{ localError }}</span>
      </div>

      <!-- Public Character Sheet -->
      <div
        v-if="sheetHasContent(publicSheet)"
        class="ktrp-sheet-section"
        :data-testid="props.testIdPrefix + '-public'"
      >
        <div v-if="publicSheet.meters.length" class="ktrp-state-list ktrp-state-list--compact">
          <div
            v-for="meter in publicSheet.meters"
            :key="meter.key"
            class="ktrp-state-item"
            :data-testid="props.testIdPrefix + '-meter-' + meter.key"
          >
            <div class="ktrp-state-head">
              <span class="ktrp-state-label">{{ meter.label }}</span>
              <strong class="ktrp-state-num">{{ formatMeterValue(meter) }}</strong>
            </div>
            <div
              v-if="typeof meter.max === 'number' && meter.max > 0"
              class="ktrp-state-meter"
              role="progressbar"
              :aria-label="meter.label"
              :aria-valuemin="0"
              :aria-valuemax="meter.max"
              :aria-valuenow="meter.current"
            >
              <div class="ktrp-state-meter-fill" :style="{ width: meterPercent(meter) + '%' }" />
            </div>
          </div>
        </div>

        <div v-if="publicSheet.entries.length" class="ktrp-sheet-entries-grid">
          <div
            v-for="entry in publicSheet.entries"
            :key="entry.key"
            class="ktrp-sheet-entry"
            :data-testid="props.testIdPrefix + '-entry-' + entry.key"
          >
            <span class="ktrp-state-label">{{ entry.label }}</span>
            <span class="ktrp-state-text ktrp-pre">{{ entry.value || t('stateFieldEmpty') }}</span>
          </div>
        </div>

        <div v-if="publicSheet.lists.length" class="ktrp-state-list ktrp-state-list--compact">
          <div
            v-for="list in publicSheet.lists"
            :key="list.key"
            class="ktrp-state-item"
            :data-testid="props.testIdPrefix + '-list-' + list.key"
          >
            <span class="ktrp-state-label">{{ list.label }}</span>
            <div class="ktrp-tag-list">
              <span v-if="!list.items.length" class="ktrp-muted">{{ t('stateFieldEmpty') }}</span>
              <span v-for="(item, idx) in list.items" :key="idx" class="ktrp-tag">{{ item }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Optional non-duplicated legacy stateFields & visibleStatus fallback -->
      <StateFieldsView
        v-if="fallbackStateFields.length"
        :fields="fallbackStateFields"
        compact
        :test-id="props.testIdPrefix + '-legacy-fields'"
      />
      <div
        v-if="fallbackVisibleStatus.length"
        class="ktrp-chip-row"
        :data-testid="props.testIdPrefix + '-legacy-status'"
      >
        <span
          v-for="item in fallbackVisibleStatus"
          :key="item.key"
          class="ktrp-chip"
        >
          {{ item.key }}: {{ item.value }}
        </span>
      </div>

      <p
        v-if="!hasPublicContent && !props.showPrivate && !props.showMemory"
        class="ktrp-muted"
        :data-testid="props.testIdPrefix + '-empty'"
      >
        {{ t('sheetEmpty') }}
      </p>

      <!-- Private Sheet (when explicitly revealed or in NPC view) -->
      <div
        v-if="props.showPrivate && hasPrivateSheetContent"
        class="ktrp-sheet-section ktrp-sheet-section--private"
        :data-testid="props.testIdPrefix + '-private'"
      >
        <span class="ktrp-label">{{ t('sheetPrivateSectionTitle') }}</span>

        <div v-if="privateSheet.meters.length" class="ktrp-state-list ktrp-state-list--compact">
          <div
            v-for="meter in privateSheet.meters"
            :key="meter.key"
            class="ktrp-state-item"
            :data-testid="props.testIdPrefix + '-private-meter-' + meter.key"
          >
            <div class="ktrp-state-head">
              <span class="ktrp-state-label">{{ meter.label }}</span>
              <strong class="ktrp-state-num">{{ formatMeterValue(meter) }}</strong>
            </div>
            <div
              v-if="typeof meter.max === 'number' && meter.max > 0"
              class="ktrp-state-meter"
              role="progressbar"
              :aria-label="meter.label"
              :aria-valuemin="0"
              :aria-valuemax="meter.max"
              :aria-valuenow="meter.current"
            >
              <div class="ktrp-state-meter-fill" :style="{ width: meterPercent(meter) + '%' }" />
            </div>
          </div>
        </div>

        <div v-if="privateSheet.entries.length" class="ktrp-sheet-entries-grid">
          <div
            v-for="entry in privateSheet.entries"
            :key="entry.key"
            class="ktrp-sheet-entry"
            :data-testid="props.testIdPrefix + '-private-entry-' + entry.key"
          >
            <span class="ktrp-state-label">{{ entry.label }}</span>
            <span class="ktrp-state-text ktrp-pre">{{ entry.value || t('stateFieldEmpty') }}</span>
          </div>
        </div>

        <div v-if="privateSheet.lists.length" class="ktrp-state-list ktrp-state-list--compact">
          <div
            v-for="list in privateSheet.lists"
            :key="list.key"
            class="ktrp-state-item"
            :data-testid="props.testIdPrefix + '-private-list-' + list.key"
          >
            <span class="ktrp-state-label">{{ list.label }}</span>
            <div class="ktrp-tag-list">
              <span v-if="!list.items.length" class="ktrp-muted">{{ t('stateFieldEmpty') }}</span>
              <span v-for="(item, idx) in list.items" :key="idx" class="ktrp-tag">{{ item }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Layered Perspective Memory (impressions, facts_witnessed, beliefs, summary) -->
      <div
        v-if="props.showMemory"
        class="ktrp-sheet-section ktrp-sheet-section--memory"
        :data-testid="props.testIdPrefix + '-memory'"
      >
        <span class="ktrp-label">{{ t('sheetMemoryTitle') }}</span>

        <p
          v-if="!hasMemoryContent"
          class="ktrp-muted"
          :data-testid="props.testIdPrefix + '-memory-empty'"
        >
          {{ t('sheetMemoryEmpty') }}
        </p>

        <template v-else>
          <div
            v-if="memory.summary"
            class="ktrp-sub-card"
            :data-testid="props.testIdPrefix + '-memory-summary'"
          >
            <span class="ktrp-state-label">{{ t('sheetMemorySummaryLabel') }}</span>
            <p class="ktrp-state-text ktrp-pre">{{ memory.summary }}</p>
          </div>

          <div
            v-if="impressionRows.length"
            class="ktrp-sub-card"
            :data-testid="props.testIdPrefix + '-memory-impressions'"
          >
            <span class="ktrp-state-label">{{ t('sheetMemoryImpressionsLabel') }}</span>
            <div class="ktrp-sheet-entries-grid">
              <div
                v-for="imp in impressionRows"
                :key="imp.target"
                class="ktrp-sheet-entry"
                :data-testid="props.testIdPrefix + '-memory-impression-' + imp.target"
              >
                <span class="ktrp-state-label">{{ imp.target }}</span>
                <span class="ktrp-state-text ktrp-pre">{{ imp.note }}</span>
              </div>
            </div>
          </div>

          <div
            v-if="memory.facts_witnessed.length"
            class="ktrp-sub-card"
            :data-testid="props.testIdPrefix + '-memory-facts'"
          >
            <span class="ktrp-state-label">{{ t('sheetMemoryFactsLabel') }}</span>
            <ul class="ktrp-fact-list">
              <li v-for="(fact, idx) in memory.facts_witnessed" :key="idx">{{ fact }}</li>
            </ul>
          </div>

          <div
            v-if="memory.beliefs.length"
            class="ktrp-sub-card"
            :data-testid="props.testIdPrefix + '-memory-beliefs'"
          >
            <span class="ktrp-state-label">{{ t('sheetMemoryBeliefsLabel') }}</span>
            <ul class="ktrp-fact-list">
              <li v-for="(belief, idx) in memory.beliefs" :key="idx">{{ belief }}</li>
            </ul>
          </div>
        </template>
      </div>
    </div>
  `,
};
