import { computed, ref, unref, watch } from "vue";
import { useCreature, useOwner, useSession } from "@kohakuterrarium/ui-sdk";

import { normalizeMediaIssues, normalizeMediaList } from "./helpers.js";
import { useRoleplayText } from "./strings.js";

const MEDIA_ISSUE_KEYS = {
  external_asset: "mediaIssueExternalAsset",
  missing_asset: "mediaIssueMissingAsset",
  unsupported_asset: "mediaIssueUnsupportedAsset",
  invalid_asset: "mediaIssueInvalidAsset",
};

/**
 * Read-only local CHARX media gallery.
 * Loads static PNG data URLs strictly via `owner.call('media', { id: cardId, key })`
 * without remote fetches or chat emission.
 */
export const CardMediaGallery = {
  name: "RoleplayCardMediaGallery",
  props: {
    cardId: { type: String, default: "" },
    media: { type: Array, default: () => [] },
    mediaIssues: { type: Object, default: null },
    revision: { type: Number, default: 0 },
    compact: { type: Boolean, default: false },
    testIdPrefix: { type: String, default: "kt-rp-media" },
  },
  setup(props) {
    const owner = useOwner();
    const session = useSession();
    const creature = useCreature();
    const t = useRoleplayText();

    const selectedKey = ref("");
    const previewUrl = ref("");
    const loading = ref(false);
    const loadError = ref("");

    const items = computed(() => normalizeMediaList(props.media));
    const issues = computed(() => normalizeMediaIssues(props.mediaIssues));
    const hasContent = computed(() => items.value.length > 0 || issues.value.length > 0);
    const selectedItem = computed(
      () => items.value.find((item) => item.key === selectedKey.value) || null,
    );

    watch(
      () => [props.cardId, items.value.map((it) => it.key).join("\u0000")],
      () => {
        if (!items.value.length) {
          selectedKey.value = "";
          previewUrl.value = "";
          loadError.value = "";
          return;
        }
        if (!items.value.some((it) => it.key === selectedKey.value)) {
          selectedKey.value = items.value[0].key;
        }
      },
      { immediate: true },
    );

    const requestContext = () => [
      props.cardId,
      selectedKey.value,
      props.revision,
      owner.status.value,
      unref(owner.owner),
      session.value?.id,
      creature.value?.name,
    ];
    let loadSeq = 0;
    watch(
      requestContext,
      async (context, _, onCleanup) => {
        const [cardId, key, , status] = context;
        let stale = false;
        onCleanup(() => {
          stale = true;
        });
        const seq = ++loadSeq;
        const isCurrent = () => !stale && seq === loadSeq
          && requestContext().every((value, i) => Object.is(value, context[i]));
        loading.value = false;
        loadError.value = "";
        previewUrl.value = "";
        if (!cardId || !key || status !== "ready") return;
        loading.value = true;
        try {
          const result = await owner.call("media", { id: cardId, key });
          if (!isCurrent()) return;
          const url = result?.url;
          if (typeof url === "string" && url.startsWith("data:image/png;base64,")) {
            previewUrl.value = url;
          } else {
            loadError.value = t("mediaLoadFailed");
          }
        } catch (err) {
          if (isCurrent()) {
            loadError.value = err?.message || String(err);
          }
        } finally {
          if (isCurrent()) {
            loading.value = false;
          }
        }
      },
      { immediate: true },
    );

    function selectMedia(key) {
      selectedKey.value = key;
    }

    function issueLabel(issue) {
      const i18nKey = MEDIA_ISSUE_KEYS[issue?.code];
      if (i18nKey) return t(i18nKey, { count: issue.count });
      return t("mediaIssueUnknown", { code: issue?.code || "unknown", count: issue?.count || 0 });
    }

    return {
      t,
      items,
      issues,
      hasContent,
      selectedKey,
      selectedItem,
      previewUrl,
      loading,
      loadError,
      selectMedia,
      issueLabel,
    };
  },
  template: `
    <div
      v-if="hasContent"
      class="ktrp-card-box ktrp-media-section"
      :class="{ 'ktrp-media-section--compact': compact }"
      :data-testid="testIdPrefix + '-section'"
    >
      <div class="ktrp-row-between">
        <div class="ktrp-box-head">{{ t('mediaSectionTitle') }}</div>
        <span v-if="items.length" class="ktrp-chip" :data-testid="testIdPrefix + '-count'">
          {{ t('mediaCountBadge', { count: items.length }) }}
        </span>
      </div>

      <div v-if="issues.length" class="ktrp-tag-list" :data-testid="testIdPrefix + '-issues'">
        <span
          v-for="issue in issues"
          :key="issue.code"
          class="ktrp-chip"
          :data-testid="testIdPrefix + '-issue-' + issue.code"
        >
          {{ issueLabel(issue) }}
        </span>
      </div>

      <template v-if="items.length">
        <div class="ktrp-media-strip" role="listbox" :aria-label="t('mediaSectionTitle')" :data-testid="testIdPrefix + '-list'">
          <button
            v-for="item in items"
            :key="item.key"
            type="button"
            class="ktrp-media-chip"
            role="option"
            :aria-selected="item.key === selectedKey"
            :data-testid="testIdPrefix + '-item-' + item.key"
            @click="selectMedia(item.key)"
          >
            <span class="ktrp-media-chip-name">{{ item.name }}</span>
            <span v-if="item.kind" class="ktrp-media-chip-kind">{{ item.kind }}</span>
          </button>
        </div>

        <div class="ktrp-media-stage" :data-testid="testIdPrefix + '-preview'">
          <p v-if="loading" class="ktrp-muted" role="status">{{ t('loading') }}</p>
          <p v-else-if="loadError" class="ktrp-error-inline" role="alert" :data-testid="testIdPrefix + '-error'">
            {{ loadError }}
          </p>
          <figure v-else-if="previewUrl" class="ktrp-media-figure">
            <img
              :src="previewUrl"
              :alt="selectedItem?.name || selectedKey"
              class="ktrp-media-img"
              :data-testid="testIdPrefix + '-img'"
              @error="loadError = t('mediaLoadFailed'); previewUrl = ''"
            />
            <figcaption class="ktrp-muted ktrp-media-caption">
              {{ selectedItem?.name }}<template v-if="selectedItem?.kind"> · {{ selectedItem.kind }}</template>
            </figcaption>
          </figure>
        </div>
      </template>
    </div>
  `,
};
