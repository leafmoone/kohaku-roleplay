import { computed, ref, unref, watch } from "vue";
import { useCreature, useOwner, useSession } from "@kohakuterrarium/ui-sdk";

import { normalizeMediaIssues, normalizeMediaList } from "./helpers.js";
import { useRoleplayText } from "./strings.js";

const MEDIA_ISSUE_KEYS = {
  external_asset: "mediaIssueExternalAsset",
  missing_asset: "mediaIssueMissingAsset",
  unsupported_asset: "mediaIssueUnsupportedAsset",
  invalid_asset: "mediaIssueInvalidAsset",
  invalid_scene_rule: "mediaIssueInvalidSceneRule",
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
    sceneMediaKey: { type: String, default: undefined },
    revision: { type: Number, default: 0 },
    compact: { type: Boolean, default: false },
    testIdPrefix: { type: String, default: "kt-rp-media" },
  },
  setup(props) {
    const owner = useOwner();
    const session = useSession();
    const creature = useCreature();
    const t = useRoleplayText();

    const galleryKey = ref("");
    const manualSceneKey = ref("");
    const previewUrl = ref("");
    const loading = ref(false);
    const loadError = ref("");

    const items = computed(() => normalizeMediaList(props.media));
    const issues = computed(() => normalizeMediaIssues(props.mediaIssues));
    // Undefined is a legacy gallery; null is an explicit scene with no automatic image.
    const sceneEnabled = computed(() => props.sceneMediaKey !== undefined);
    const followingScene = computed(() => sceneEnabled.value && !manualSceneKey.value);
    const selectedKey = computed(() => sceneEnabled.value
      ? manualSceneKey.value || props.sceneMediaKey || ""
      : galleryKey.value);
    const hasContent = computed(() => sceneEnabled.value || items.value.length > 0 || issues.value.length > 0);
    const selectedItem = computed(
      () => items.value.find((item) => item.key === selectedKey.value) || null,
    );

    watch(
      () => [props.cardId, items.value.map((it) => it.key).join("\u0000")],
      () => {
        if (!items.value.some((it) => it.key === galleryKey.value)) {
          galleryKey.value = items.value[0]?.key || "";
        }
        if (manualSceneKey.value && !items.value.some((it) => it.key === manualSceneKey.value)) {
          manualSceneKey.value = "";
        }
      },
      { immediate: true },
    );

    watch(
      [() => props.cardId, () => session.value?.id, () => creature.value?.name, sceneEnabled],
      () => { manualSceneKey.value = ""; },
    );

    const requestSources = [
      () => props.cardId,
      () => selectedKey.value,
      () => props.revision,
      () => owner.status.value,
      () => unref(owner.owner),
      () => session.value?.id,
      () => creature.value?.name,
    ];
    let loadSeq = 0;
    watch(
      requestSources,
      async (context, _, onCleanup) => {
        const [cardId, key, , status] = context;
        let stale = false;
        onCleanup(() => {
          stale = true;
        });
        const seq = ++loadSeq;
        const isCurrent = () => !stale && seq === loadSeq
          && requestSources.every((read, i) => Object.is(read(), context[i]));
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
      if (sceneEnabled.value) manualSceneKey.value = key;
      else galleryKey.value = key;
    }

    function resumeScene() {
      manualSceneKey.value = "";
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
      sceneEnabled,
      followingScene,
      selectedKey,
      selectedItem,
      previewUrl,
      loading,
      loadError,
      selectMedia,
      resumeScene,
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

      <div v-if="sceneEnabled" class="ktrp-row-between">
        <span
          class="ktrp-chip"
          :data-mode="followingScene ? 'auto' : 'manual'"
          :data-testid="testIdPrefix + '-scene-mode'"
        >{{ t(followingScene ? 'mediaSceneAuto' : 'mediaSceneManual') }}</span>
        <button
          v-if="!followingScene"
          type="button"
          class="ktrp-media-chip"
          :data-testid="testIdPrefix + '-scene-auto'"
          @click="resumeScene"
        >{{ t('mediaSceneResume') }}</button>
      </div>

      <div v-if="items.length" class="ktrp-media-strip" role="listbox" :aria-label="t('mediaSectionTitle')" :data-testid="testIdPrefix + '-list'">
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

      <div
        v-if="items.length || sceneEnabled"
        class="ktrp-media-stage"
        :data-media-key="selectedKey || undefined"
        :data-testid="testIdPrefix + '-preview'"
      >
        <p v-if="followingScene && !selectedKey" class="ktrp-muted" :data-testid="testIdPrefix + '-scene-empty'">
          {{ t('mediaSceneNone') }}
        </p>
        <p v-else-if="loading" class="ktrp-muted" role="status">{{ t('loading') }}</p>
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
            {{ selectedItem?.name }}<template v-if="followingScene && selectedItem?.kind === 'icon'"> ·
              <span :data-testid="testIdPrefix + '-scene-cover'">{{ t('mediaSceneCover') }}</span>
            </template><template v-else-if="selectedItem?.kind"> · {{ selectedItem.kind }}</template>
          </figcaption>
        </figure>
      </div>
    </div>
  `,
};
