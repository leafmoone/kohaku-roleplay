import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const DESKTOP_WIDGET_SELECTOR = 'section[data-test="v2-widget-ext:kohaku-roleplay/gameplay"]';
const PHONE_SHEET_SELECTOR = '[data-test="phone-widget-ext:kohaku-roleplay/gameplay"]';

const MIN_WIDTH = 280;
const MIN_HEIGHT = 200;
const MAXIMIZED_TARGET_WIDTH = 760;
const EDGE_GAP = 8;
const DOCK_RESERVE_BOTTOM = 52;

const CUSTOM_STYLE_PROPS = [
  "position",
  "left",
  "top",
  "right",
  "bottom",
  "width",
  "height",
  "max-width",
  "max-height",
];

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

/**
 * Manages desktop floating window geometry (move, corner resize, maximize/restore, viewport clamping)
 * and phone drawer height toggle (half-height ~55dvh default vs full 92dvh expanded)
 * directly on the host widget container without remounting or reloading the panel or iframe.
 */
export function usePlayWindow(rootElRef) {
  const isPhone = ref(false);
  const isExpanded = ref(false);
  const isInteracting = ref(false);
  const hasCustomGeometry = ref(false);

  let hostSection = null;
  let phoneSheet = null;
  let boundsContainer = null;
  let preMaximizeRect = null;
  let activeDrag = null;
  let resizeObserver = null;

  function resolveHostContainers() {
    const el = rootElRef.value;
    if (!el || typeof el.closest !== "function") return;
    hostSection = el.closest(DESKTOP_WIDGET_SELECTOR);
    phoneSheet = el.closest(PHONE_SHEET_SELECTOR);
    isPhone.value = Boolean(phoneSheet && !hostSection);
    if (hostSection) {
      const floatAnchor = hostSection.parentElement?.parentElement;
      boundsContainer =
        floatAnchor?.parentElement ||
        hostSection.closest('[data-test="v2-chat-tab"]') ||
        document.documentElement;
    }
  }

  function getBoundsRect() {
    if (boundsContainer && typeof boundsContainer.getBoundingClientRect === "function") {
      const rect = boundsContainer.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        return rect;
      }
    }
    return {
      left: 0,
      top: 0,
      right: window.innerWidth,
      bottom: window.innerHeight,
      width: window.innerWidth,
      height: window.innerHeight,
    };
  }

  function getDockReserve(bounds) {
    if (!boundsContainer) return DOCK_RESERVE_BOTTOM;
    const dockEl = boundsContainer.querySelector('[data-test="v2-dock"]');
    if (!dockEl) return DOCK_RESERVE_BOTTOM;
    const dockRect = dockEl.getBoundingClientRect();
    if (dockRect.height <= 0) return DOCK_RESERVE_BOTTOM;
    return Math.max(DOCK_RESERVE_BOTTOM, Math.ceil(bounds.bottom - dockRect.top + EDGE_GAP));
  }

  function getAvailableSpace(bounds, dockReserve) {
    const availW = Math.max(0, Math.floor(bounds.width - EDGE_GAP * 2));
    const availH = Math.max(0, Math.floor(bounds.height - EDGE_GAP - dockReserve));
    const minW = Math.min(MIN_WIDTH, availW);
    const minH = Math.min(MIN_HEIGHT, availH);
    return { availW, availH, minW, minH };
  }

  function clampGeometry(raw) {
    const bounds = getBoundsRect();
    const dockReserve = getDockReserve(bounds);
    const { availW, availH, minW, minH } = getAvailableSpace(bounds, dockReserve);
    const width = clamp(Math.round(raw.width), minW, availW);
    const height = clamp(Math.round(raw.height), minH, availH);
    const maxLeft = Math.max(EDGE_GAP, Math.floor(bounds.width - width - EDGE_GAP));
    const maxTop = Math.max(EDGE_GAP, Math.floor(bounds.height - height - dockReserve));
    const left = clamp(Math.round(raw.left), EDGE_GAP, maxLeft);
    const top = clamp(Math.round(raw.top), EDGE_GAP, maxTop);
    return { left, top, width, height };
  }

  function computeMaximizedGeometry(anchorRect) {
    const bounds = getBoundsRect();
    const dockReserve = getDockReserve(bounds);
    const { availW, availH, minW, minH } = getAvailableSpace(bounds, dockReserve);
    const targetW = clamp(Math.min(MAXIMIZED_TARGET_WIDTH, availW), minW, availW);
    const targetH = clamp(availH - EDGE_GAP, minH, availH);
    const baseLeft = anchorRect
      ? anchorRect.left + anchorRect.width - targetW
      : bounds.width - targetW - EDGE_GAP;
    const baseTop = anchorRect ? anchorRect.top : EDGE_GAP;
    return {
      left: baseLeft,
      top: baseTop,
      width: targetW,
      height: targetH,
    };
  }

  function readCurrentSectionGeometry() {
    if (!hostSection) return null;
    const bounds = getBoundsRect();
    const rect = hostSection.getBoundingClientRect();
    return {
      left: rect.left - bounds.left,
      top: rect.top - bounds.top,
      width: rect.width,
      height: rect.height,
    };
  }

  function clearCustomDesktopStyles() {
    if (!hostSection) return;
    if (hasCustomGeometry.value || hostSection.dataset.ktrpCustomGeom) {
      for (const prop of CUSTOM_STYLE_PROPS) {
        hostSection.style.removeProperty(prop);
      }
    }
    delete hostSection.dataset.ktrpCustomGeom;
    hasCustomGeometry.value = false;
  }

  function applyDesktopGeometry(geom) {
    if (!hostSection || !geom) return null;
    const clamped = clampGeometry(geom);
    hasCustomGeometry.value = true;
    hostSection.dataset.ktrpCustomGeom = "true";
    const bounds = getBoundsRect();
    const absLeft = Math.round(bounds.left + clamped.left);
    const absTop = Math.round(bounds.top + clamped.top);
    hostSection.style.setProperty("position", "fixed", "important");
    hostSection.style.setProperty("left", `${absLeft}px`, "important");
    hostSection.style.setProperty("top", `${absTop}px`, "important");
    hostSection.style.setProperty("right", "auto", "important");
    hostSection.style.setProperty("bottom", "auto", "important");
    hostSection.style.setProperty("width", `${clamped.width}px`, "important");
    hostSection.style.setProperty("height", `${clamped.height}px`, "important");
    hostSection.style.setProperty("max-width", `${clamped.width}px`, "important");
    hostSection.style.setProperty("max-height", `${clamped.height}px`, "important");
    return clamped;
  }

  function syncExpansionAttributes() {
    if (hostSection) {
      hostSection.dataset.ktrpExpanded = String(isExpanded.value);
    }
    if (phoneSheet) {
      phoneSheet.dataset.ktrpExpanded = String(isExpanded.value);
    }
  }

  function setInteracting(flag) {
    isInteracting.value = flag;
    if (hostSection) {
      if (flag) {
        hostSection.dataset.ktrpInteracting = "true";
      } else {
        delete hostSection.dataset.ktrpInteracting;
      }
    }
  }

  function clampExistingOnViewportChange() {
    resolveHostContainers();
    if (isPhone.value || !hostSection) return;
    if (isExpanded.value) {
      const cur = readCurrentSectionGeometry();
      applyDesktopGeometry(computeMaximizedGeometry(cur));
      return;
    }
    if (hasCustomGeometry.value) {
      const cur = readCurrentSectionGeometry();
      if (cur) {
        applyDesktopGeometry(cur);
      }
    }
  }

  function toggleWindowExpand() {
    resolveHostContainers();
    if (isPhone.value) {
      isExpanded.value = !isExpanded.value;
      syncExpansionAttributes();
      return;
    }
    if (!hostSection) return;
    if (!isExpanded.value) {
      const hadCustomBeforeMax = hasCustomGeometry.value;
      const currentRect = readCurrentSectionGeometry();
      preMaximizeRect = currentRect
        ? { ...currentRect, hadCustomBeforeMax }
        : null;
      isExpanded.value = true;
      syncExpansionAttributes();
      applyDesktopGeometry(computeMaximizedGeometry(currentRect));
    } else {
      isExpanded.value = false;
      syncExpansionAttributes();
      if (preMaximizeRect) {
        if (preMaximizeRect.hadCustomBeforeMax) {
          applyDesktopGeometry(preMaximizeRect);
        } else {
          clearCustomDesktopStyles();
        }
        preMaximizeRect = null;
      } else {
        clearCustomDesktopStyles();
      }
    }
  }

  function startPointerInteraction(mode, event) {
    resolveHostContainers();
    if (isPhone.value || !hostSection) return;
    if (activeDrag) return;
    if (typeof event.button === "number" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const startGeom = readCurrentSectionGeometry();
    if (!startGeom) return;

    const targetEl = event.currentTarget;
    const pointerId = event.pointerId;
    if (targetEl && typeof targetEl.setPointerCapture === "function" && pointerId !== undefined) {
      try {
        targetEl.setPointerCapture(pointerId);
      } catch {
        // Ignore capture errors on synthetic events
      }
    }

    setInteracting(true);
    applyDesktopGeometry(startGeom);

    activeDrag = {
      mode,
      pointerId,
      targetEl,
      startX: event.clientX,
      startY: event.clientY,
      startGeom,
    };

    if (targetEl && typeof targetEl.addEventListener === "function") {
      targetEl.addEventListener("lostpointercapture", onLostPointerCapture);
    }
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    window.addEventListener("blur", stopActiveDrag);
  }

  function onPointerMove(event) {
    if (!activeDrag || !hostSection) return;
    if (
      activeDrag.pointerId !== undefined &&
      event.pointerId !== undefined &&
      event.pointerId !== activeDrag.pointerId
    ) {
      return;
    }
    if (typeof event.buttons === "number" && event.buttons === 0) {
      stopActiveDrag();
      return;
    }
    event.preventDefault();
    const dx = event.clientX - activeDrag.startX;
    const dy = event.clientY - activeDrag.startY;
    const g = activeDrag.startGeom;

    if (activeDrag.mode === "move") {
      applyDesktopGeometry({
        left: g.left + dx,
        top: g.top + dy,
        width: g.width,
        height: g.height,
      });
    } else if (activeDrag.mode === "resize") {
      if (isExpanded.value) {
        isExpanded.value = false;
        syncExpansionAttributes();
      }
      applyDesktopGeometry({
        left: g.left,
        top: g.top,
        width: g.width + dx,
        height: g.height + dy,
      });
    }
  }

  function onLostPointerCapture(event) {
    if (!activeDrag) return;
    if (
      activeDrag.pointerId !== undefined &&
      event?.pointerId !== undefined &&
      event.pointerId !== activeDrag.pointerId
    ) {
      return;
    }
    stopActiveDrag();
  }

  function stopActiveDrag() {
    if (!activeDrag) return;
    const { targetEl, pointerId } = activeDrag;
    activeDrag = null;
    if (targetEl && typeof targetEl.removeEventListener === "function") {
      targetEl.removeEventListener("lostpointercapture", onLostPointerCapture);
    }
    if (
      targetEl &&
      pointerId !== undefined &&
      typeof targetEl.releasePointerCapture === "function"
    ) {
      try {
        if (targetEl.hasPointerCapture?.(pointerId)) {
          targetEl.releasePointerCapture(pointerId);
        }
      } catch {
        // Ignore
      }
    }
    setInteracting(false);
    window.removeEventListener("pointermove", onPointerMove, true);
    window.removeEventListener("pointerup", onPointerUp, true);
    window.removeEventListener("pointercancel", onPointerUp, true);
    window.removeEventListener("blur", stopActiveDrag);
  }

  function onPointerUp(event) {
    if (!activeDrag) return;
    if (
      activeDrag.pointerId !== undefined &&
      event?.pointerId !== undefined &&
      event.pointerId !== activeDrag.pointerId
    ) {
      return;
    }
    stopActiveDrag();
  }

  function startMove(event) {
    startPointerInteraction("move", event);
  }

  function startResize(event) {
    startPointerInteraction("resize", event);
  }

  function resetGeometry() {
    stopActiveDrag();
    preMaximizeRect = null;
    isExpanded.value = false;
    clearCustomDesktopStyles();
    syncExpansionAttributes();
  }

  onMounted(() => {
    resolveHostContainers();
    syncExpansionAttributes();
    window.addEventListener("resize", clampExistingOnViewportChange);
    if (typeof ResizeObserver === "function" && boundsContainer) {
      resizeObserver = new ResizeObserver(() => {
        clampExistingOnViewportChange();
      });
      resizeObserver.observe(boundsContainer);
    }
  });

  onBeforeUnmount(() => {
    stopActiveDrag();
    window.removeEventListener("resize", clampExistingOnViewportChange);
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    clearCustomDesktopStyles();
    if (hostSection) {
      delete hostSection.dataset.ktrpExpanded;
      delete hostSection.dataset.ktrpInteracting;
    }
    if (phoneSheet) {
      delete phoneSheet.dataset.ktrpExpanded;
    }
  });

  return {
    isPhone: computed(() => isPhone.value),
    isExpanded: computed(() => isExpanded.value),
    isInteracting: computed(() => isInteracting.value),
    hasCustomGeometry: computed(() => hasCustomGeometry.value),
    toggleWindowExpand,
    startMove,
    startResize,
    resetGeometry,
  };
}
