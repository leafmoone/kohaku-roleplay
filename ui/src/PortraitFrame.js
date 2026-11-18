import { computed, ref, watch } from "vue";
import { useOwner } from "@kohakuterrarium/ui-sdk";

const portraitCache = new Map();

export const PortraitFrame = {
  name: "RoleplayPortraitFrame",
  props: {
    cardId: { type: String, default: "" },
    name: { type: String, default: "" },
    hasPortrait: { type: Boolean, default: false },
    argKey: { type: String, default: "id" },
    size: { type: String, default: "md" },
    revision: { type: Number, default: 0 },
  },
  setup(props) {
    const owner = useOwner();
    const url = ref("");
    const loading = ref(false);

    const monogram = computed(() => {
      const trimmed = String(props.name || "").trim();
      return trimmed ? trimmed.slice(0, 1).toUpperCase() : "?";
    });

    const sizeClass = computed(() => `ktrp-portrait--${props.size}`);

    watch(
      () => [props.cardId, props.hasPortrait, props.argKey, props.revision, owner.status.value],
      async (_, __, onCleanup) => {
        let stale = false;
        onCleanup(() => {
          stale = true;
        });
        url.value = "";
        if (!props.cardId || !props.hasPortrait || owner.status.value !== "ready") return;
        const cacheKey = `${owner.owner}|${props.cardId}|${props.revision}`;
        if (portraitCache.has(cacheKey)) {
          url.value = portraitCache.get(cacheKey) || "";
          return;
        }
        loading.value = true;
        try {
          const payload = props.argKey === "cardId" ? { cardId: props.cardId } : { id: props.cardId };
          const result = await owner.call("portrait", payload);
          const resolved = typeof result === "string" ? result : result?.url || "";
          if (!stale) {
            portraitCache.set(cacheKey, resolved);
            url.value = resolved;
          }
        } catch {
          if (!stale) url.value = "";
        } finally {
          if (!stale) loading.value = false;
        }
      },
      { immediate: true },
    );

    return { url, loading, monogram, sizeClass };
  },
  template: `
    <div class="ktrp-portrait" :class="sizeClass" :data-has-image="Boolean(url)">
      <img v-if="url" :src="url" :alt="name || 'Character portrait'" class="ktrp-portrait-img" @error="url = ''" />
      <span v-else class="ktrp-portrait-monogram" aria-hidden="true">{{ monogram }}</span>
    </div>
  `,
};
