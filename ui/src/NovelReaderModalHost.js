import { computed, onBeforeUnmount, onMounted } from "vue";

import { NovelReaderView } from "./NovelReaderView.js";
import {
  closeNovelReaderModal,
  mountedOverlayHosts,
  novelReaderOverlayOpen,
  novelReaderTargetCreatureId,
  novelReaderTargetSessionId,
  preferredOverlayHostId,
  registerOverlayHost,
  unregisterOverlayHost,
} from "./readerState.js";
import { useRoleplayText } from "./strings.js";

/**
 * Singleton-coordinated Teleport host that renders the full-window Novel Reader
 * into document.body whenever opened from any entry surface (Dock, Play, or Library).
 */
export const NovelReaderModalHost = {
  name: "RoleplayNovelReaderModalHost",
  components: { NovelReaderView },
  props: {
    hostId: { type: String, required: true },
  },
  setup(props) {
    const t = useRoleplayText();

    const isPrimaryHost = computed(() => {
      const hosts = mountedOverlayHosts.value;
      if (!hosts.length) return false;
      if (preferredOverlayHostId.value && hosts.includes(preferredOverlayHostId.value)) {
        return preferredOverlayHostId.value === props.hostId;
      }
      return hosts[0] === props.hostId;
    });

    onMounted(() => {
      registerOverlayHost(props.hostId);
    });

    onBeforeUnmount(() => {
      unregisterOverlayHost(props.hostId);
    });

    return {
      t,
      isPrimaryHost,
      novelReaderOverlayOpen,
      novelReaderTargetSessionId,
      novelReaderTargetCreatureId,
      closeNovelReaderModal,
    };
  },
  template: `
    <Teleport to="body">
      <div
        v-if="isPrimaryHost && novelReaderOverlayOpen"
        class="ktrp-reader-fullscreen"
        role="dialog"
        aria-modal="true"
        :aria-label="t('novelReaderTitle')"
        data-testid="kt-rp-reader-fullscreen"
      >
        <NovelReaderView
          fullscreen
          :initial-session-id="novelReaderTargetSessionId"
          :initial-creature-id="novelReaderTargetCreatureId"
          @close-fullscreen="closeNovelReaderModal"
        />
      </div>
    </Teleport>
  `,
};
