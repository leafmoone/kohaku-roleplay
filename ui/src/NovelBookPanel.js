import { computed, onMounted, ref, watch } from "vue";
import { ActionButton, useOwner, useSession } from "@kohakuterrarium/ui-sdk";

import { findPrivilegedRootCreature, projectNovelView } from "./helpers.js";
import { NovelReaderModalHost } from "./NovelReaderModalHost.js";
import { allocateOverlayHostId, openNovelReaderModal } from "./readerState.js";
import { useRoleplayText } from "./strings.js";

/**
 * Session-docked panel (`ext:kohaku-roleplay/novel-book`) that auto-opens the full-window
 * Novel Reader overlay on novel or NPC creatures and provides a quick re-open card when minimized.
 */
export const NovelBookPanel = {
  name: "RoleplayNovelBookPanel",
  components: {
    ActionButton,
    NovelReaderModalHost,
  },
  setup() {
    const owner = useOwner();
    const session = useSession();
    const t = useRoleplayText();
    const overlayHostId = allocateOverlayHostId();
    const lastAutoOpenedScope = ref("");

    const state = computed(() => owner.state.value || {});
    const mode = computed(() => {
      if (
        state.value.mode === "tavern" ||
        state.value.mode === "novel" ||
        state.value.mode === "npc"
      ) {
        return state.value.mode;
      }
      return "persona";
    });
    const isNovelContext = computed(
      () =>
        owner.status.value === "ready" &&
        Boolean(state.value.active) &&
        (mode.value === "novel" || mode.value === "npc"),
    );
    const novelView = computed(() => projectNovelView(mode.value === "novel" ? state.value : null));

    const resolvedTarget = computed(() => {
      const sid = session.value?.id || "";
      const rawCreatures =
        session.value?.instance?.creatures || session.value?.creatures || [];
      const privileged = findPrivilegedRootCreature(rawCreatures);
      const rootCid =
        (typeof state.value.rootCreatureId === "string" && state.value.rootCreatureId) ||
        privileged.creatureId ||
        "";
      return { sessionId: sid, creatureId: rootCid };
    });

    function openReader() {
      const { sessionId, creatureId } = resolvedTarget.value;
      openNovelReaderModal(sessionId, creatureId, overlayHostId);
    }

    function maybeAutoOpen() {
      if (!isNovelContext.value) return;
      const scopeKey = `${resolvedTarget.value.sessionId}|${mode.value}|${state.value.actor || "root"}`;
      if (lastAutoOpenedScope.value === scopeKey) return;
      lastAutoOpenedScope.value = scopeKey;
      openReader();
    }

    onMounted(() => {
      maybeAutoOpen();
    });

    watch(
      () => [isNovelContext.value, resolvedTarget.value.sessionId, mode.value, state.value.actor],
      () => {
        maybeAutoOpen();
      },
    );

    return {
      owner,
      t,
      overlayHostId,
      mode,
      state,
      isNovelContext,
      novelView,
      openReader,
    };
  },
  template: `
    <div class="ktrp-panel ktrp-novel-book-dock" data-testid="kt-rp-novel-book-panel">
      <div
        v-if="owner.status.value === 'error' || owner.status.value === 'absent'"
        class="ktrp-banner ktrp-banner--error"
        role="alert"
      >
        <span>{{ t('loadFailed') }}</span>
        <ActionButton size="sm" @click="owner.refresh()">{{ t('retry') }}</ActionButton>
      </div>

      <p v-else-if="owner.status.value !== 'ready'" class="ktrp-muted" role="status">
        {{ t('loading') }}
      </p>

      <div v-else-if="isNovelContext" class="ktrp-card-box">
        <div class="ktrp-row-between">
          <strong>{{ novelView.title || state.name || t('novelBookPanelTitle') }}</strong>
          <span v-if="mode === 'novel'" class="ktrp-chip">
            {{ t('novelReaderChaptersBadge', { count: novelView.chapters.length }) }}
          </span>
        </div>
        <p class="ktrp-muted">{{ t('novelProjectionNotice') }}</p>
        <div class="ktrp-row-end">
          <ActionButton
            variant="primary"
            size="sm"
            icon="i-carbon-book"
            data-testid="kt-rp-novel-book-open-btn"
            @click="openReader"
          >
            {{ t('novelBookOpenBtn') }}
          </ActionButton>
        </div>
      </div>

      <div v-else class="ktrp-empty" data-testid="kt-rp-novel-book-inactive">
        {{ t('novelBookInactiveHint') }}
      </div>

      <NovelReaderModalHost :host-id="overlayHostId" />
    </div>
  `,
};
