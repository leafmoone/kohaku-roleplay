import { ref } from "vue";

let hostSeq = 0;

export const novelReaderOverlayOpen = ref(false);
export const novelReaderTargetSessionId = ref("");
export const novelReaderTargetCreatureId = ref("");
export const mountedOverlayHosts = ref([]);
export const preferredOverlayHostId = ref("");

/**
 * Allocate a unique host instance identifier for NovelReaderModalHost deduplication.
 */
export function allocateOverlayHostId() {
  hostSeq += 1;
  return `ktrp-reader-host-${hostSeq}`;
}

/**
 * Register a mounted modal host so only one Teleport overlay renders into document.body at a time.
 */
export function registerOverlayHost(hostId) {
  if (!hostId) return;
  if (!mountedOverlayHosts.value.includes(hostId)) {
    mountedOverlayHosts.value = [...mountedOverlayHosts.value, hostId];
  }
}

/**
 * Remove an unmounted modal host from the active overlay host list.
 */
export function unregisterOverlayHost(hostId) {
  if (!hostId) return;
  mountedOverlayHosts.value = mountedOverlayHosts.value.filter((id) => id !== hostId);
  if (preferredOverlayHostId.value === hostId) {
    preferredOverlayHostId.value = "";
  }
}

/**
 * Open the full-window Teleport Novel Reader overlay, optionally targeting a session and root creature.
 */
export function openNovelReaderModal(sessionId, creatureId, hostId) {
  const nextSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
  const nextCreatureId = typeof creatureId === "string" ? creatureId.trim() : "";
  const sessionChanged = Boolean(
    nextSessionId && nextSessionId !== novelReaderTargetSessionId.value,
  );
  if (nextSessionId) {
    novelReaderTargetSessionId.value = nextSessionId;
  }
  if (nextCreatureId) {
    novelReaderTargetCreatureId.value = nextCreatureId;
  } else if (sessionChanged) {
    novelReaderTargetCreatureId.value = "";
  }
  if (typeof hostId === "string" && hostId.trim()) {
    preferredOverlayHostId.value = hostId.trim();
  }
  novelReaderOverlayOpen.value = true;
}

/**
 * Close the full-window Novel Reader overlay and return to the underlying chat/session view.
 */
export function closeNovelReaderModal() {
  novelReaderOverlayOpen.value = false;
}
