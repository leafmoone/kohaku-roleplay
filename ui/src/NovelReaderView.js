import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import {
  ActionButton,
  notify,
  openTab,
  useExtension,
  useOwner,
} from "@kohakuterrarium/ui-sdk";

import {
  DEFAULT_MAX_NOVEL_MEDIA_BYTES,
  buildOffsetParagraphs,
  exportNovelMarkdown,
  normalizeWorldbookDiagnostics,
  normalizeWorldbookEntries,
  projectNovelView,
  readFileAsImageDataUrl,
  sanitizeDownloadFilename,
  splitParagraphSegments,
  utf16OffsetToCodePoint,
  validateMediaImageFile,
} from "./helpers.js";
import { PortraitFrame } from "./PortraitFrame.js";
import { SelectionStudioPanel } from "./SelectionStudioPanel.js";
import { useRoleplayText } from "./strings.js";

const PREF_STORAGE_KEY = "novel-reader-prefs-v1";
const POLL_INTERVAL_MS = 2500;
const MIN_FONT_SIZE = 14;
const MAX_FONT_SIZE = 24;

function clampFontSize(raw) {
  const num = Number(raw);
  if (!Number.isFinite(num)) return 17;
  return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(num)));
}

function readStoredPrefs(kt) {
  if (!kt?.storage || typeof kt.storage.get !== "function") {
    return { viewMode: "single", paperTheme: "parchment", fontFamily: "serif", fontSize: 17 };
  }
  const saved = kt.storage.get(PREF_STORAGE_KEY, null);
  const src = saved && typeof saved === "object" ? saved : {};
  return {
    viewMode: src.viewMode === "continuous" ? "continuous" : "single",
    paperTheme:
      src.paperTheme === "paper" || src.paperTheme === "night" ? src.paperTheme : "parchment",
    fontFamily: src.fontFamily === "sans" ? "sans" : "serif",
    fontSize: clampFontSize(src.fontSize),
  };
}

function resolveParaDomPoint(paraEl, targetContainer, targetOffset) {
  const baseStart = Number(paraEl.getAttribute("data-para-start")) || 0;
  let cursor = baseStart;
  let resolved = null;

  function walk(node) {
    if (resolved !== null) return;
    if (node.nodeType === 3) {
      const len = node.nodeValue ? node.nodeValue.length : 0;
      const previewMark =
        typeof node.parentElement?.closest === "function"
          ? node.parentElement.closest("mark.is-preview[data-orig-start][data-orig-end]")
          : null;
      if (node === targetContainer) {
        if (previewMark) {
          const origStart = Number(previewMark.getAttribute("data-orig-start")) || cursor;
          const origEnd = Number(previewMark.getAttribute("data-orig-end")) || origStart;
          const ratio = len > 0 ? Math.max(0, Math.min(1, targetOffset / len)) : 0;
          resolved = Math.round(origStart + (origEnd - origStart) * ratio);
        } else {
          resolved = cursor + Math.max(0, Math.min(len, targetOffset));
        }
        return;
      }
      if (!previewMark) {
        cursor += len;
      }
      return;
    }

    if (node.nodeType === 1) {
      const isPreviewMark =
        typeof node.matches === "function" &&
        node.matches("mark.is-preview[data-orig-start][data-orig-end]");
      if (node === targetContainer) {
        const children = node.childNodes;
        const clamped = Math.max(0, Math.min(children.length, targetOffset));
        for (let i = 0; i < clamped; i += 1) {
          walk(children[i]);
          if (resolved !== null) return;
        }
        resolved = cursor;
        return;
      }
      for (let i = 0; i < node.childNodes.length; i += 1) {
        walk(node.childNodes[i]);
        if (resolved !== null) return;
      }
      if (isPreviewMark) {
        const origEnd = Number(node.getAttribute("data-orig-end"));
        if (Number.isFinite(origEnd)) {
          cursor = origEnd;
        }
      }
    }
  }

  walk(paraEl);
  return resolved !== null ? resolved : cursor;
}

/**
 * Standalone literary Novel Reader workspace tab (`ext:kohaku-roleplay/novel-reader`).
 * Supports both direct `plugin:roleplay` owner binding (scoped/test harnesses)
 * and package-tab live session bridging across active novel terrarium graphs.
 */
export const NovelReaderView = {
  name: "RoleplayNovelReaderView",
  components: {
    ActionButton,
    PortraitFrame,
    SelectionStudioPanel,
  },
  setup() {
    const owner = useOwner("plugin:roleplay");
    const t = useRoleplayText();
    let kt = null;
    try {
      kt = useExtension();
    } catch {
      kt = null;
    }

    const initialPrefs = readStoredPrefs(kt);
    const tocOpen = ref(true);
    const viewMode = ref(initialPrefs.viewMode);
    const paperTheme = ref(initialPrefs.paperTheme);
    const fontFamily = ref(initialPrefs.fontFamily);
    const fontSize = ref(initialPrefs.fontSize);

    // Live session bridge state when mounted as a package-owned workspace tab.
    const discoveredSessions = ref([]);
    const activeSessionId = ref("");
    const bridgedState = ref(null);
    const discovering = ref(false);
    const bridgeError = ref("");

    // Chapter navigation & composer state.
    const selectedChapterNumber = ref(null);
    const composerDraft = ref("");
    const sendingInput = ref(false);
    const resumingScene = ref(false);
    const uploadingCg = ref(false);
    const actionError = ref("");
    const cgInput = ref(null);
    const uploadTargetChapter = ref(null);
    const stageEl = ref(null);

    // Worldbook snapshot detail drawer state.
    const inspectedWorldbook = ref(null);
    const worldbookLoading = ref(false);
    const worldbookError = ref("");

    // Mode 1 Selection Studio & Latest-Scene Rewrite/Variant state.
    const selectionLock = ref(null);
    const selectionPreviewText = ref(null);
    const rewriteDrawerOpen = ref(false);
    const rewriteMode = ref("director_only");
    const rewriteInstruction = ref("");
    const rewritePlayerInput = ref("");
    const mutatingRevision = ref(false);
    const rewriteError = ref("");

    let unmounted = false;
    let discoverSeq = 0;
    let stateFetchSeq = 0;
    let actionSeq = 0;
    let worldbookSeq = 0;
    let revisionSeq = 0;
    let ownerSocket = null;
    let pollTimer = null;

    const isDirectNovelOwner = computed(() => owner.state.value?.mode === "novel");
    const isPackageOwner = computed(
      () =>
        !isDirectNovelOwner.value &&
        (String(owner.owner || "").startsWith("package:") ||
          Array.isArray(owner.state.value?.cards)),
    );

    const activeRawState = computed(() => {
      if (isDirectNovelOwner.value) return owner.state.value;
      if (bridgedState.value?.mode === "novel") return bridgedState.value;
      return null;
    });

    const novelView = computed(() => projectNovelView(activeRawState.value));
    const chapters = computed(() => novelView.value.chapters);
    const revision = computed(() => novelView.value.revision);
    const latestChapter = computed(() =>
      chapters.value.length ? chapters.value[chapters.value.length - 1] : null,
    );

    const activeChapterNumber = computed(() => {
      if (!chapters.value.length) return null;
      if (
        selectedChapterNumber.value !== null &&
        chapters.value.some((ch) => ch.number === selectedChapterNumber.value)
      ) {
        return selectedChapterNumber.value;
      }
      return chapters.value[chapters.value.length - 1].number;
    });

    const activeChapterIndex = computed(() => {
      if (activeChapterNumber.value === null) return -1;
      return chapters.value.findIndex((ch) => ch.number === activeChapterNumber.value);
    });

    const activeChapter = computed(() =>
      activeChapterIndex.value >= 0 ? chapters.value[activeChapterIndex.value] : null,
    );

    const displayedChapters = computed(() => {
      if (viewMode.value === "continuous") return chapters.value;
      return activeChapter.value ? [activeChapter.value] : [];
    });

    const actorNameMap = computed(() => {
      const map = new Map();
      if (novelView.value.player) {
        map.set(novelView.value.player.actor, novelView.value.player.name);
      }
      for (const actor of novelView.value.cast) {
        map.set(actor.actor, actor.name);
      }
      return map;
    });

    const latestChoices = computed(() => latestChapter.value?.choices || null);
    const composerLocked = computed(
      () =>
        Boolean(novelView.value.isProcessing) ||
        Boolean(novelView.value.pendingScene),
    );
    const composerPlaceholder = computed(() => {
      if (novelView.value.playerMode === "director") {
        return t("novelReaderInputDirectorPlaceholder");
      }
      return t("novelReaderInputProtagonistPlaceholder", {
        name: novelView.value.player?.name || "Player",
      });
    });

    const maxMediaMiB = computed(
      () => Math.round((DEFAULT_MAX_NOVEL_MEDIA_BYTES / (1024 * 1024)) * 10) / 10,
    );

    const inspectedEntries = computed(() =>
      normalizeWorldbookEntries(inspectedWorldbook.value?.entries),
    );
    const inspectedDiagnostics = computed(() =>
      normalizeWorldbookDiagnostics(inspectedWorldbook.value?.diagnostics),
    );

    function persistPrefs() {
      if (!kt?.storage || typeof kt.storage.set !== "function") return;
      kt.storage.set(PREF_STORAGE_KEY, {
        viewMode: viewMode.value,
        paperTheme: paperTheme.value,
        fontFamily: fontFamily.value,
        fontSize: fontSize.value,
      });
    }

    watch([viewMode, paperTheme, fontFamily, fontSize], persistPrefs);

    watch(
      () => chapters.value.map((ch) => ch.number).join(","),
      (nextList, prevList) => {
        if (!chapters.value.length) {
          selectedChapterNumber.value = null;
          return;
        }
        const prevNumbers = prevList ? prevList.split(",").map(Number) : [];
        const prevLast = prevNumbers.length ? prevNumbers[prevNumbers.length - 1] : null;
        const latest = chapters.value[chapters.value.length - 1].number;
        if (selectedChapterNumber.value === null || selectedChapterNumber.value === prevLast) {
          selectedChapterNumber.value = latest;
        } else if (!chapters.value.some((ch) => ch.number === selectedChapterNumber.value)) {
          selectedChapterNumber.value = latest;
        }
      },
      { immediate: true },
    );

    watch(
      () => chapters.value.map((c) => `${c.number}:${c.cleanProse || c.prose}`).join("\u0000"),
      () => {
        const lock = selectionLock.value;
        if (!lock) return;
        const target = chapters.value.find((c) => c.number === lock.number);
        const clean = target ? target.cleanProse || target.prose || "" : "";
        if (!target || clean.slice(lock.start, lock.end) !== lock.selectedText) {
          selectionLock.value = null;
          selectionPreviewText.value = null;
        }
      },
    );

    watch(
      () => revision.value?.sceneNumber || null,
      () => {
        rewriteDrawerOpen.value = false;
        rewriteError.value = "";
      },
    );

    watch(rewriteMode, (nextMode) => {
      if (nextMode === "full_rerun" && !rewritePlayerInput.value && revision.value?.lastPlayerInput) {
        rewritePlayerInput.value = revision.value.lastPlayerInput;
      }
    });

    function chapterParagraphs(chapter) {
      return buildOffsetParagraphs(chapter.cleanProse || chapter.prose || "");
    }

    function firstTouchedParaStart(paragraphs, lock, chapterNumber) {
      if (!lock || lock.number !== chapterNumber) return -1;
      const found = paragraphs.find((p) => p.end > lock.start && p.start < lock.end);
      return found ? found.start : -1;
    }

    function paragraphSegments(chapter, paragraph) {
      const paragraphs = chapterParagraphs(chapter);
      const firstStart = firstTouchedParaStart(paragraphs, selectionLock.value, chapter.number);
      return splitParagraphSegments(
        paragraph,
        selectionLock.value,
        selectionPreviewText.value,
        chapter.number,
        firstStart,
      );
    }

    function isRevisionChapter(chapter) {
      const rev = revision.value;
      return Boolean(rev && chapter.number === rev.sceneNumber && chapter.number >= 1);
    }

    function activeVariantLabel(rev) {
      if (!rev) return "";
      const active = rev.variants.find((v) => v.index === rev.activeIndex);
      const mode = active?.mode || "initial";
      if (mode === "director_rewrite") return t("variantModeDirectorRewrite");
      if (mode === "full_rerun") return t("variantModeFullRerun");
      return t("variantModeInitial");
    }

    function lockSelectionSpan(chapterNumber, start, end) {
      if (composerLocked.value) return false;
      const chapter = chapters.value.find((c) => c.number === chapterNumber);
      if (!chapter) return false;
      const cleanProse = chapter.cleanProse || chapter.prose || "";
      const lo = Math.max(0, Math.min(start, end));
      const hi = Math.min(cleanProse.length, Math.max(start, end));
      const selectedText = cleanProse.slice(lo, hi);
      if (hi - lo < 2 || selectedText.trim().length < 2) return false;
      selectionLock.value = {
        number: chapterNumber,
        start: lo,
        end: hi,
        cpStart: utf16OffsetToCodePoint(cleanProse, lo),
        cpEnd: utf16OffsetToCodePoint(cleanProse, hi),
        selectedText,
      };
      selectionPreviewText.value = null;
      return true;
    }

    function handleStageSelection() {
      if (composerLocked.value || !stageEl.value) return;
      const sel =
        typeof window !== "undefined" && typeof window.getSelection === "function"
          ? window.getSelection()
          : null;
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      if (!stageEl.value.contains(range.commonAncestorContainer)) return;

      const startEl =
        range.startContainer.nodeType === 1
          ? range.startContainer
          : range.startContainer.parentElement;
      const endEl =
        range.endContainer.nodeType === 1
          ? range.endContainer
          : range.endContainer.parentElement;
      const startParaEl = startEl?.closest?.("[data-para-start][data-chapter-number]");
      const endParaEl = endEl?.closest?.("[data-para-start][data-chapter-number]");
      if (!startParaEl || !endParaEl) return;

      const chNum = Number(startParaEl.getAttribute("data-chapter-number"));
      if (!Number.isInteger(chNum) || Number(endParaEl.getAttribute("data-chapter-number")) !== chNum) {
        return;
      }
      const rawStart = resolveParaDomPoint(startParaEl, range.startContainer, range.startOffset);
      const rawEnd = resolveParaDomPoint(endParaEl, range.endContainer, range.endOffset);
      lockSelectionSpan(chNum, rawStart, rawEnd);
    }

    function clearSelectionStudio() {
      selectionLock.value = null;
      selectionPreviewText.value = null;
    }

    function updateSelectionPreview(nextText) {
      selectionPreviewText.value = typeof nextText === "string" ? nextText : null;
    }

    async function handleSuggestSpan(payload) {
      return await callNovelOwner("suggest_span_rewrite", payload);
    }

    async function handleApplySpanEdit(payload) {
      await callNovelOwner("apply_span_edit", payload);
      clearSelectionStudio();
      notify(t("selectionStudioAppliedToast"), "success");
    }

    function toggleRewriteDrawer() {
      const rev = revision.value;
      if (!rev || composerLocked.value || mutatingRevision.value) return;
      if (!rewriteDrawerOpen.value) {
        rewriteError.value = "";
        rewriteMode.value = rev.canDirectorRewrite ? "director_only" : "full_rerun";
        rewritePlayerInput.value = rev.lastPlayerInput || "";
        rewriteInstruction.value = "";
      }
      rewriteDrawerOpen.value = !rewriteDrawerOpen.value;
    }

    async function selectSceneVariant(index) {
      const rev = revision.value;
      if (
        unmounted ||
        !rev ||
        composerLocked.value ||
        mutatingRevision.value ||
        index < 0 ||
        index >= rev.variantCount ||
        index === rev.activeIndex
      ) {
        return;
      }
      const seq = ++revisionSeq;
      mutatingRevision.value = true;
      rewriteError.value = "";
      actionError.value = "";
      try {
        await callNovelOwner("select_scene_variant", { index });
        if (!unmounted && seq === revisionSeq) {
          clearSelectionStudio();
          if (rewriteDrawerOpen.value && revision.value) {
            rewritePlayerInput.value = revision.value.lastPlayerInput || "";
          }
        }
      } catch (err) {
        if (!unmounted && seq === revisionSeq) {
          rewriteError.value = err?.response?.data?.detail?.message || err?.message || String(err);
        }
      } finally {
        if (!unmounted && seq === revisionSeq) {
          mutatingRevision.value = false;
        }
      }
    }

    async function submitSceneRewrite() {
      const rev = revision.value;
      if (unmounted || !rev || composerLocked.value || mutatingRevision.value) return;
      const modeVal = rewriteMode.value === "full_rerun" ? "full_rerun" : "director_only";
      const seq = ++revisionSeq;
      mutatingRevision.value = true;
      rewriteError.value = "";
      actionError.value = "";
      try {
        await callNovelOwner("rewrite_latest_scene", {
          mode: modeVal,
          instruction: rewriteInstruction.value.trim(),
          playerInput: modeVal === "full_rerun" ? rewritePlayerInput.value.trim() : "",
        });
        if (!unmounted && seq === revisionSeq) {
          rewriteDrawerOpen.value = false;
          clearSelectionStudio();
          notify(t("sceneRewriteSubmittedToast"), "success");
        }
      } catch (err) {
        if (!unmounted && seq === revisionSeq) {
          rewriteError.value = err?.response?.data?.detail?.message || err?.message || String(err);
        }
      } finally {
        if (!unmounted && seq === revisionSeq) {
          mutatingRevision.value = false;
        }
      }
    }

    function actorDisplayName(actorId) {
      return actorNameMap.value.get(actorId) || actorId;
    }

    function formatActorsList(actorIds) {
      return (Array.isArray(actorIds) ? actorIds : []).map(actorDisplayName).join(", ");
    }

    function chapterHeadingLabel(chapter) {
      if (chapter.title) return chapter.title;
      if (chapter.number === 0) return t("novelReaderPrologueLabel");
      return t("novelReaderChapterLabel", { number: chapter.number });
    }

    function selectChapter(number) {
      selectedChapterNumber.value = number;
      if (viewMode.value === "continuous" && stageEl.value) {
        nextTick(() => {
          const target = stageEl.value?.querySelector(`[data-chapter-number="${number}"]`);
          if (target && typeof target.scrollIntoView === "function") {
            target.scrollIntoView({ behavior: "smooth", block: "start" });
          }
        });
      }
    }

    function stepChapter(delta) {
      const idx = activeChapterIndex.value;
      if (idx < 0) return;
      const target = chapters.value[idx + delta];
      if (target) selectChapter(target.number);
    }

    function adjustFontSize(delta) {
      fontSize.value = clampFontSize(fontSize.value + delta);
    }

    function closeSocket() {
      if (ownerSocket) {
        try {
          ownerSocket.close();
        } catch {
          // Ignore close errors.
        }
        ownerSocket = null;
      }
    }

    function stopPolling() {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }

    async function fetchBridgedRootState(sessionId) {
      if (!kt?.api?.request || !sessionId) return null;
      const resp = await kt.api.request({
        method: "POST",
        url: "../../extensions/owner/state",
        data: {
          owner: "plugin:roleplay",
          session_id: sessionId,
          creature_id: "root",
        },
      });
      return resp?.data?.state || null;
    }

    async function refreshBridgedState() {
      const sid = activeSessionId.value;
      if (unmounted || !sid || isDirectNovelOwner.value || !kt?.api?.request) return;
      const seq = ++stateFetchSeq;
      try {
        const nextState = await fetchBridgedRootState(sid);
        if (unmounted || seq !== stateFetchSeq || activeSessionId.value !== sid) return;
        if (nextState?.mode === "novel") {
          bridgedState.value = nextState;
          bridgeError.value = "";
        }
      } catch (err) {
        if (!unmounted && seq === stateFetchSeq && activeSessionId.value === sid) {
          bridgeError.value = err?.response?.data?.detail?.message || err?.message || String(err);
        }
      }
    }

    function connectOwnerSocket(sessionId) {
      closeSocket();
      if (
        unmounted ||
        !sessionId ||
        isDirectNovelOwner.value ||
        typeof WebSocket !== "function" ||
        typeof window === "undefined" ||
        !window.location?.host
      ) {
        return;
      }
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      let ws;
      try {
        ws = new WebSocket(`${scheme}//${window.location.host}/ws/extensions/owner`);
      } catch {
        return;
      }
      ownerSocket = ws;
      ws.onopen = () => {
        if (ownerSocket !== ws || unmounted || activeSessionId.value !== sessionId) return;
        try {
          ws.send(
            JSON.stringify({
              op: "subscribe",
              id: "kt-rp-reader",
              owner: "plugin:roleplay",
              session_id: sessionId,
              creature_id: "root",
            }),
          );
        } catch {
          // Ignore send errors; polling covers fallback.
        }
      };
      ws.onmessage = (ev) => {
        if (ownerSocket !== ws || unmounted || activeSessionId.value !== sessionId) return;
        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg?.type === "event" && msg.event === "state" && msg.data?.mode === "novel") {
          bridgedState.value = msg.data;
          bridgeError.value = "";
        } else if (msg?.type === "overflow") {
          void refreshBridgedState();
        }
      };
      ws.onclose = () => {
        if (ownerSocket === ws) ownerSocket = null;
      };
    }

    async function discoverNovelSessions() {
      if (unmounted || isDirectNovelOwner.value || !kt?.api?.request) return;
      const seq = ++discoverSeq;
      discovering.value = true;
      bridgeError.value = "";
      try {
        const resp = await kt.api.request({
          method: "GET",
          url: "../../sessions/active",
        });
        if (unmounted || seq !== discoverSeq) return;
        const rows = Array.isArray(resp?.data) ? resp.data : [];
        const candidates = rows.filter((sess) => {
          if (!sess || typeof sess !== "object" || !sess.session_id) return false;
          if (sess.has_root) return true;
          const creatures = Array.isArray(sess.creatures) ? sess.creatures : [];
          return creatures.some((c) => c?.name === "root" || c?.creature_id === "root");
        });

        const probed = await Promise.all(
          candidates.map(async (sess) => {
            try {
              const st = await fetchBridgedRootState(sess.session_id);
              if (st?.mode === "novel" && st?.active) {
                return {
                  sessionId: sess.session_id,
                  label: st.title || sess.name || sess.session_id,
                  state: st,
                };
              }
            } catch {
              // Ignore non-novel or unloaded root creatures.
            }
            return null;
          }),
        );
        if (unmounted || seq !== discoverSeq) return;
        const novelList = probed.filter(Boolean);
        discoveredSessions.value = novelList;

        const existing = novelList.find((item) => item.sessionId === activeSessionId.value);
        const chosen = existing || novelList[0] || null;
        if (chosen) {
          const changed = activeSessionId.value !== chosen.sessionId;
          activeSessionId.value = chosen.sessionId;
          bridgedState.value = chosen.state;
          if (changed || !ownerSocket) {
            connectOwnerSocket(chosen.sessionId);
          }
        } else {
          activeSessionId.value = "";
          bridgedState.value = null;
          closeSocket();
        }
      } catch (err) {
        if (!unmounted && seq === discoverSeq) {
          bridgeError.value = err?.response?.data?.detail?.message || err?.message || String(err);
        }
      } finally {
        if (!unmounted && seq === discoverSeq) {
          discovering.value = false;
        }
      }
    }

    function onSessionSelectChange(event) {
      const nextId = String(event?.target?.value || "");
      if (!nextId) return;
      activeSessionId.value = nextId;
      const hit = discoveredSessions.value.find((item) => item.sessionId === nextId);
      if (hit) {
        bridgedState.value = hit.state;
      }
      inspectedWorldbook.value = null;
      worldbookError.value = "";
      selectionLock.value = null;
      selectionPreviewText.value = null;
      rewriteDrawerOpen.value = false;
      rewriteError.value = "";
      connectOwnerSocket(nextId);
      void refreshBridgedState();
    }

    async function callNovelOwner(action, args) {
      if (isDirectNovelOwner.value) {
        const res = await owner.call(action, args);
        if (res && typeof res === "object" && res.mode === "novel") {
          owner.state.value = res;
        }
        return res;
      }
      const sid = activeSessionId.value;
      if (!kt?.api?.request || !sid) {
        throw new Error(t("novelPendingIntegration"));
      }
      const resp = await kt.api.request({
        method: "POST",
        url: "../../extensions/owner/call",
        data: {
          owner: "plugin:roleplay",
          session_id: sid,
          creature_id: "root",
          action,
          args,
        },
      });
      const result = resp?.data?.result ?? null;
      if (result && typeof result === "object" && result.mode === "novel") {
        bridgedState.value = result;
      }
      return result;
    }

    watch(
      () => [isDirectNovelOwner.value, owner.status.value],
      ([direct, status]) => {
        if (direct) {
          closeSocket();
          stopPolling();
          return;
        }
        if (status === "ready" || isPackageOwner.value) {
          void discoverNovelSessions();
        }
      },
      { immediate: true },
    );

    watch(
      () =>
        Boolean(
          !isDirectNovelOwner.value &&
            activeSessionId.value &&
            novelView.value.active &&
            (novelView.value.isProcessing || novelView.value.pendingScene),
        ),
      (shouldPoll) => {
        stopPolling();
        if (shouldPoll) {
          pollTimer = setInterval(() => {
            void refreshBridgedState();
          }, POLL_INTERVAL_MS);
        }
      },
      { immediate: true },
    );

    function onVisibilityFocus() {
      if (typeof document !== "undefined" && document.hidden) return;
      if (!isDirectNovelOwner.value && activeSessionId.value) {
        void refreshBridgedState();
      }
    }

    if (typeof window !== "undefined") {
      window.addEventListener("focus", onVisibilityFocus);
    }

    onUnmounted(() => {
      unmounted = true;
      closeSocket();
      stopPolling();
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", onVisibilityFocus);
      }
    });

    async function submitNovelText(rawText) {
      const text = String(rawText ?? "").trim();
      if (unmounted || !text || sendingInput.value || composerLocked.value) return;
      const seq = ++actionSeq;
      const clearedComposer = text === composerDraft.value.trim();
      sendingInput.value = true;
      actionError.value = "";
      try {
        await callNovelOwner("submit_novel_input", { text });
        if (unmounted || seq !== actionSeq) return;
        if (clearedComposer) {
          composerDraft.value = "";
        }
      } catch (err) {
        if (!unmounted && seq === actionSeq) {
          actionError.value = err?.response?.data?.detail?.message || err?.message || String(err);
        }
      } finally {
        if (!unmounted && seq === actionSeq) {
          sendingInput.value = false;
        }
      }
    }

    async function chooseOption(option) {
      if (!option?.text) return;
      await submitNovelText(option.text);
    }

    async function resumePendingScene() {
      const pending = novelView.value.pendingScene;
      if (unmounted || !pending || resumingScene.value) return;
      const sceneNum = pending.number;
      const seq = ++actionSeq;
      resumingScene.value = true;
      actionError.value = "";
      try {
        await callNovelOwner("resume_scene", { scene: sceneNum });
        if (unmounted || seq !== actionSeq) return;
        notify(t("novelResumeSentToast", { number: sceneNum }), "info");
      } catch (err) {
        if (!unmounted && seq === actionSeq) {
          actionError.value = err?.response?.data?.detail?.message || err?.message || String(err);
        }
      } finally {
        if (!unmounted && seq === actionSeq) {
          resumingScene.value = false;
        }
      }
    }

    function triggerChapterCgUpload(chapterNumber) {
      if (uploadingCg.value || sendingInput.value) return;
      actionError.value = "";
      uploadTargetChapter.value = chapterNumber;
      cgInput.value?.click();
    }

    async function handleCgFileChange(event) {
      const file = event.target?.files?.[0];
      if (event.target) event.target.value = "";
      const targetNum = uploadTargetChapter.value;
      uploadTargetChapter.value = null;
      if (!file || targetNum === null || uploadingCg.value) return;

      const check = validateMediaImageFile(file, DEFAULT_MAX_NOVEL_MEDIA_BYTES);
      if (!check.ok) {
        actionError.value = t("sheetInvalidImageError", { mb: maxMediaMiB.value });
        return;
      }
      const seq = ++actionSeq;
      uploadingCg.value = true;
      actionError.value = "";
      try {
        const dataUrl = await readFileAsImageDataUrl(file, DEFAULT_MAX_NOVEL_MEDIA_BYTES);
        await callNovelOwner("upload_novel_media", {
          target: "chapter",
          number: targetNum,
          dataUrl,
          name: file.name || `chapter-${targetNum}`,
        });
        if (unmounted || seq !== actionSeq) return;
        notify(t("novelReaderCgUploadedToast"), "success");
      } catch (err) {
        if (!unmounted && seq === actionSeq) {
          actionError.value = err?.response?.data?.detail?.message || err?.message || String(err);
        }
      } finally {
        if (!unmounted && seq === actionSeq) {
          uploadingCg.value = false;
        }
      }
    }

    async function inspectWorldbook(index) {
      if (worldbookLoading.value) return;
      const seq = ++worldbookSeq;
      worldbookLoading.value = true;
      worldbookError.value = "";
      try {
        const res = await callNovelOwner("novel_worldbook_detail", { index });
        if (unmounted || seq !== worldbookSeq) return;
        inspectedWorldbook.value = res || null;
      } catch (err) {
        if (!unmounted && seq === worldbookSeq) {
          worldbookError.value = err?.response?.data?.detail?.message || err?.message || String(err);
        }
      } finally {
        if (!unmounted && seq === worldbookSeq) {
          worldbookLoading.value = false;
        }
      }
    }

    function closeWorldbookInspector() {
      worldbookSeq += 1;
      inspectedWorldbook.value = null;
      worldbookError.value = "";
      worldbookLoading.value = false;
    }

    function exportMarkdown() {
      const md = exportNovelMarkdown(novelView.value, {
        defaultTitle: t("novelDefaultTitle"),
        prologueLabel: t("novelReaderPrologueLabel"),
        chapterPrefix: t("novelReaderTitle"),
      });
      const baseName = sanitizeDownloadFilename(
        novelView.value.title || t("novelDefaultTitle"),
        "json",
      ).replace(/\.json$/i, ".md");
      const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = baseName;
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      notify(t("novelReaderExportedToast", { filename: baseName }), "success");
    }

    function openLibraryTab() {
      try {
        openTab("kohaku-roleplay/studio");
      } catch {
        // Ignore when tab navigation is unavailable.
      }
    }

    function refreshAll() {
      if (isDirectNovelOwner.value) {
        void owner.refresh();
      } else {
        void discoverNovelSessions();
      }
    }

    return {
      owner,
      t,
      tocOpen,
      viewMode,
      paperTheme,
      fontFamily,
      fontSize,
      minFontSize: MIN_FONT_SIZE,
      maxFontSize: MAX_FONT_SIZE,
      discoveredSessions,
      activeSessionId,
      discovering,
      bridgeError,
      isDirectNovelOwner,
      isPackageOwner,
      novelView,
      chapters,
      activeChapterNumber,
      activeChapterIndex,
      displayedChapters,
      latestChoices,
      composerLocked,
      composerDraft,
      composerPlaceholder,
      sendingInput,
      resumingScene,
      uploadingCg,
      actionError,
      cgInput,
      stageEl,
      inspectedWorldbook,
      inspectedEntries,
      inspectedDiagnostics,
      worldbookLoading,
      worldbookError,
      revision,
      selectionLock,
      selectionPreviewText,
      rewriteDrawerOpen,
      rewriteMode,
      rewriteInstruction,
      rewritePlayerInput,
      mutatingRevision,
      rewriteError,
      chapterParagraphs,
      paragraphSegments,
      isRevisionChapter,
      activeVariantLabel,
      lockSelectionSpan,
      handleStageSelection,
      clearSelectionStudio,
      updateSelectionPreview,
      handleSuggestSpan,
      handleApplySpanEdit,
      toggleRewriteDrawer,
      selectSceneVariant,
      submitSceneRewrite,
      actorDisplayName,
      formatActorsList,
      chapterHeadingLabel,
      selectChapter,
      stepChapter,
      adjustFontSize,
      onSessionSelectChange,
      submitNovelText,
      chooseOption,
      resumePendingScene,
      triggerChapterCgUpload,
      handleCgFileChange,
      inspectWorldbook,
      closeWorldbookInspector,
      exportMarkdown,
      openLibraryTab,
      refreshAll,
    };
  },
  template: `
    <section
      class="ktrp-reader-root"
      :data-theme="paperTheme"
      :data-font="fontFamily"
      :data-view-mode="viewMode"
      data-testid="kt-rp-novel-reader"
    >
      <!-- Literary Reader Toolbar -->
      <header class="ktrp-reader-toolbar" data-testid="kt-rp-reader-toolbar">
        <div class="ktrp-reader-toolbar-left">
          <ActionButton
            size="sm"
            variant="ghost"
            :aria-expanded="String(tocOpen)"
            data-testid="kt-rp-reader-toc-toggle"
            @click="tocOpen = !tocOpen"
          >
            {{ t('novelReaderTocToggle') }}
          </ActionButton>

          <strong class="ktrp-reader-book-title" data-testid="kt-rp-reader-title">
            {{ novelView.title || t('novelReaderTitle') }}
          </strong>

          <select
            v-if="discoveredSessions.length > 1"
            :value="activeSessionId"
            class="ktrp-select ktrp-reader-session-select"
            :aria-label="t('novelReaderSessionLabel')"
            data-testid="kt-rp-reader-session-select"
            @change="onSessionSelectChange"
          >
            <option
              v-for="sess in discoveredSessions"
              :key="sess.sessionId"
              :value="sess.sessionId"
            >
              {{ sess.label }}
            </option>
          </select>
        </div>

        <div class="ktrp-reader-toolbar-controls">
          <div class="ktrp-reader-seg" role="group" data-testid="kt-rp-reader-view-mode">
            <button
              type="button"
              class="ktrp-reader-seg-btn"
              :class="{ 'is-active': viewMode === 'single' }"
              :aria-pressed="viewMode === 'single'"
              data-testid="kt-rp-reader-view-single"
              @click="viewMode = 'single'"
            >
              {{ t('novelReaderViewSingle') }}
            </button>
            <button
              type="button"
              class="ktrp-reader-seg-btn"
              :class="{ 'is-active': viewMode === 'continuous' }"
              :aria-pressed="viewMode === 'continuous'"
              data-testid="kt-rp-reader-view-continuous"
              @click="viewMode = 'continuous'"
            >
              {{ t('novelReaderViewContinuous') }}
            </button>
          </div>

          <div class="ktrp-reader-seg" role="group" data-testid="kt-rp-reader-theme">
            <button
              type="button"
              class="ktrp-reader-seg-btn"
              :class="{ 'is-active': paperTheme === 'parchment' }"
              :aria-pressed="paperTheme === 'parchment'"
              data-testid="kt-rp-reader-theme-parchment"
              @click="paperTheme = 'parchment'"
            >
              {{ t('novelReaderThemeParchment') }}
            </button>
            <button
              type="button"
              class="ktrp-reader-seg-btn"
              :class="{ 'is-active': paperTheme === 'paper' }"
              :aria-pressed="paperTheme === 'paper'"
              data-testid="kt-rp-reader-theme-paper"
              @click="paperTheme = 'paper'"
            >
              {{ t('novelReaderThemePaper') }}
            </button>
            <button
              type="button"
              class="ktrp-reader-seg-btn"
              :class="{ 'is-active': paperTheme === 'night' }"
              :aria-pressed="paperTheme === 'night'"
              data-testid="kt-rp-reader-theme-night"
              @click="paperTheme = 'night'"
            >
              {{ t('novelReaderThemeNight') }}
            </button>
          </div>

          <div class="ktrp-reader-seg" role="group" data-testid="kt-rp-reader-font-family">
            <button
              type="button"
              class="ktrp-reader-seg-btn"
              :class="{ 'is-active': fontFamily === 'serif' }"
              :aria-pressed="fontFamily === 'serif'"
              data-testid="kt-rp-reader-font-serif"
              @click="fontFamily = 'serif'"
            >
              {{ t('novelReaderFontSerif') }}
            </button>
            <button
              type="button"
              class="ktrp-reader-seg-btn"
              :class="{ 'is-active': fontFamily === 'sans' }"
              :aria-pressed="fontFamily === 'sans'"
              data-testid="kt-rp-reader-font-sans"
              @click="fontFamily = 'sans'"
            >
              {{ t('novelReaderFontSans') }}
            </button>
          </div>

          <div class="ktrp-reader-seg" role="group" data-testid="kt-rp-reader-font-size">
            <button
              type="button"
              class="ktrp-reader-seg-btn"
              :disabled="fontSize <= minFontSize"
              data-testid="kt-rp-reader-font-dec"
              @click="adjustFontSize(-1)"
            >
              {{ t('novelReaderFontDec') }}
            </button>
            <span class="ktrp-reader-font-readout" data-testid="kt-rp-reader-font-readout">
              {{ fontSize }}px
            </span>
            <button
              type="button"
              class="ktrp-reader-seg-btn"
              :disabled="fontSize >= maxFontSize"
              data-testid="kt-rp-reader-font-inc"
              @click="adjustFontSize(1)"
            >
              {{ t('novelReaderFontInc') }}
            </button>
          </div>

          <ActionButton
            size="sm"
            variant="ghost"
            icon="i-carbon-renew"
            :disabled="discovering"
            data-testid="kt-rp-reader-refresh-btn"
            @click="refreshAll"
          >
            {{ t('refresh') }}
          </ActionButton>

          <ActionButton
            size="sm"
            :disabled="!novelView.active || !chapters.length"
            data-testid="kt-rp-reader-export-md"
            @click="exportMarkdown"
          >
            {{ t('novelReaderExportMd') }}
          </ActionButton>
        </div>
      </header>

      <!-- Connection / Loading States -->
      <div
        v-if="!isDirectNovelOwner && !isPackageOwner && (owner.status.value === 'error' || owner.status.value === 'absent')"
        class="ktrp-banner ktrp-banner--error"
        role="alert"
        data-testid="kt-rp-reader-error"
      >
        <span>{{ t('loadFailed') }} <small v-if="owner.error.value">{{ owner.error.value }}</small></span>
        <ActionButton size="sm" @click="refreshAll">{{ t('retry') }}</ActionButton>
      </div>

      <div
        v-else-if="bridgeError"
        class="ktrp-banner ktrp-banner--error"
        role="alert"
        data-testid="kt-rp-reader-bridge-error"
      >
        <span>{{ bridgeError }}</span>
        <ActionButton size="sm" @click="refreshAll">{{ t('retry') }}</ActionButton>
      </div>

      <p
        v-else-if="!novelView.active && (discovering || (!isPackageOwner && owner.status.value !== 'ready'))"
        class="ktrp-muted ktrp-reader-status-msg"
        role="status"
        data-testid="kt-rp-reader-loading"
      >
        {{ t('loading') }}
      </p>

      <div
        v-else-if="!novelView.active"
        class="ktrp-empty ktrp-reader-empty-state"
        data-testid="kt-rp-reader-empty"
      >
        <p>{{ t('novelReaderNoActiveSessions') }}</p>
        <div class="ktrp-inline-actions" style="justify-content: center; margin-top: 0.5rem;">
          <ActionButton size="sm" variant="primary" @click="openLibraryTab">
            {{ t('openCardLibraryBtn') }}
          </ActionButton>
          <ActionButton size="sm" @click="refreshAll">
            {{ t('refresh') }}
          </ActionButton>
        </div>
      </div>

      <!-- Active Novel Reader Body -->
      <div v-else class="ktrp-reader-workspace">
        <!-- Collapsible TOC Sidebar -->
        <aside
          v-show="tocOpen"
          class="ktrp-reader-toc"
          data-testid="kt-rp-reader-toc"
        >
          <div class="ktrp-reader-toc-section">
            <div class="ktrp-box-head">{{ t('novelReaderChaptersTitle', { count: chapters.length }) }}</div>
            <div v-if="!chapters.length" class="ktrp-muted">{{ t('novelNoFacts') }}</div>
            <nav v-else class="ktrp-reader-toc-list" :aria-label="t('novelReaderChaptersTitle', { count: chapters.length })">
              <button
                v-for="ch in chapters"
                :key="ch.number"
                type="button"
                class="ktrp-reader-toc-item"
                :class="{ 'is-active': ch.number === activeChapterNumber }"
                :aria-current="ch.number === activeChapterNumber ? 'page' : undefined"
                :data-testid="'kt-rp-reader-toc-chapter-' + ch.number"
                @click="selectChapter(ch.number)"
              >
                <span class="ktrp-reader-toc-num">#{{ ch.number }}</span>
                <span class="ktrp-reader-toc-name">{{ chapterHeadingLabel(ch) }}</span>
              </button>
            </nav>
          </div>

          <div v-if="novelView.premise || novelView.narrator || novelView.style || novelView.sheetHint" class="ktrp-reader-toc-section" data-testid="kt-rp-reader-premise">
            <div class="ktrp-box-head">{{ t('novelPremiseTitle') }}</div>
            <div class="ktrp-chip-row">
              <span class="ktrp-chip">
                {{
                  novelView.playerMode === 'director'
                    ? t('novelModeDirectorBadge')
                    : t('novelModeProtagonistBadge')
                }}
              </span>
              <span v-if="novelView.narrator" class="ktrp-chip ktrp-chip--accent" data-testid="kt-rp-reader-narrator-badge">
                <img
                  v-if="novelView.narrator.portraitUrl"
                  :src="novelView.narrator.portraitUrl"
                  :alt="novelView.narrator.name"
                  class="ktrp-chip-avatar"
                />
                <span>
                  {{
                    novelView.narrator.isDefault
                      ? t('novelDefaultNarratorBadge', { name: novelView.narrator.name })
                      : t('novelNarratorBadge', { name: novelView.narrator.name })
                  }}
                </span>
              </span>
              <span v-else class="ktrp-chip" data-testid="kt-rp-reader-narrator-badge">
                {{ t('novelNoNarratorBadge') }}
              </span>
              <span v-if="novelView.style" class="ktrp-chip ktrp-chip--accent" data-testid="kt-rp-reader-style-badge">
                {{ t('novelStyleCardBadge', { name: novelView.style.name }) }}
              </span>
            </div>
            <p v-if="novelView.premise" class="ktrp-muted ktrp-pre">{{ novelView.premise }}</p>
            <p v-if="novelView.sheetHint" class="ktrp-muted ktrp-pre">{{ novelView.sheetHint }}</p>
          </div>

          <div class="ktrp-reader-toc-section" data-testid="kt-rp-reader-worldbooks">
            <div class="ktrp-box-head">
              {{ t('novelWorldbooksTitle', { count: novelView.worldbooks.length }) }}
            </div>
            <p v-if="!novelView.worldbooks.length" class="ktrp-muted">{{ t('novelNoWorldbooks') }}</p>
            <div v-else class="ktrp-reader-toc-list">
              <button
                v-for="(wb, wbIdx) in novelView.worldbooks"
                :key="wb.id"
                type="button"
                class="ktrp-reader-toc-item"
                :data-testid="'kt-rp-reader-toc-worldbook-' + wbIdx"
                @click="inspectWorldbook(wbIdx)"
              >
                <span class="ktrp-reader-toc-name">{{ wb.name }}</span>
                <span class="ktrp-chip">{{ wb.entries }}</span>
              </button>
            </div>
          </div>

          <div v-if="novelView.cast.length" class="ktrp-reader-toc-section" data-testid="kt-rp-reader-toc-cast">
            <div class="ktrp-box-head">
              {{ t('novelReaderCastTitle', { count: novelView.cast.length }) }}
            </div>
            <div class="ktrp-reader-cast-chips">
              <div
                v-for="actor in novelView.cast"
                :key="actor.actor"
                class="ktrp-reader-cast-pill"
                :data-testid="'kt-rp-reader-cast-' + actor.actor"
              >
                <PortraitFrame
                  :card-id="actor.cardId"
                  :name="actor.name"
                  :has-portrait="actor.hasPortrait"
                  :variant="actor.portraitKey"
                  :custom-portrait-url="actor.customPortraitUrl"
                  arg-key="id"
                  size="sm"
                />
                <span>{{ actor.name }}</span>
              </div>
            </div>
          </div>
        </aside>

        <!-- Book Reading Stage + Interactive Bar -->
        <div class="ktrp-reader-main">
          <!-- Optional Read-Only Worldbook Inspector Banner -->
          <div
            v-if="worldbookLoading || worldbookError || inspectedWorldbook"
            class="ktrp-card-box ktrp-reader-wb-drawer"
            data-testid="kt-rp-reader-worldbook-drawer"
          >
            <div class="ktrp-row-between">
              <strong>
                {{
                  inspectedWorldbook
                    ? t('novelReaderWorldbookInspectTitle', { name: inspectedWorldbook.name })
                    : t('loading')
                }}
              </strong>
              <ActionButton
                size="sm"
                variant="ghost"
                data-testid="kt-rp-reader-worldbook-close-btn"
                @click="closeWorldbookInspector"
              >
                {{ t('novelReaderCloseWorldbookBtn') }}
              </ActionButton>
            </div>
            <p v-if="worldbookLoading" class="ktrp-muted">{{ t('loading') }}</p>
            <p v-else-if="worldbookError" class="ktrp-error-inline">{{ worldbookError }}</p>
            <div v-else-if="inspectedWorldbook" class="ktrp-stack">
              <span v-if="inspectedDiagnostics" class="ktrp-muted">
                {{
                  t('worldbookDiagSummary', {
                    supported: inspectedDiagnostics.supportedEntries,
                    total: inspectedDiagnostics.totalEntries,
                    skipped: inspectedDiagnostics.skippedEntries,
                  })
                }}
              </span>
              <div class="ktrp-reader-wb-entries">
                <div
                  v-for="entry in inspectedEntries"
                  :key="entry.index"
                  class="ktrp-sub-card"
                >
                  <strong>{{ entry.name || t('worldbookEntryUntitled', { index: entry.index + 1 }) }}</strong>
                  <p class="ktrp-muted ktrp-pre">{{ entry.content || t('worldbookEntryEmptyContent') }}</p>
                </div>
              </div>
            </div>
          </div>

          <input
            ref="cgInput"
            type="file"
            accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
            hidden
            tabindex="-1"
            :disabled="uploadingCg"
            data-testid="kt-rp-reader-upload-cg-input"
            @change="handleCgFileChange"
          />

          <div
            ref="stageEl"
            class="ktrp-reader-stage"
            :style="{ '--ktrp-reader-font-size': fontSize + 'px' }"
            data-testid="kt-rp-reader-stage"
            @mouseup="handleStageSelection"
            @keyup="handleStageSelection"
          >
            <div class="ktrp-reader-page">
              <div
                v-if="!displayedChapters.length"
                class="ktrp-empty ktrp-reader-no-chapters"
                data-testid="kt-rp-reader-no-chapters"
              >
                {{ t('novelReaderNoChapters') }}
              </div>

              <article
                v-for="ch in displayedChapters"
                :key="ch.number"
                class="ktrp-reader-chapter"
                :data-chapter-number="ch.number"
                :data-testid="'kt-rp-reader-chapter-' + ch.number"
              >
                <header class="ktrp-reader-chapter-head">
                  <div class="ktrp-row-between">
                    <div>
                      <span class="ktrp-reader-chapter-eyebrow">
                        {{
                          ch.number === 0
                            ? t('novelReaderPrologueLabel')
                            : t('novelReaderChapterLabel', { number: ch.number })
                        }}
                      </span>
                      <h2 class="ktrp-reader-chapter-title">{{ chapterHeadingLabel(ch) }}</h2>
                    </div>
                    <div class="ktrp-inline-actions">
                      <div
                        v-if="isRevisionChapter(ch) && revision.variantCount > 1"
                        class="ktrp-reader-variant-switcher"
                        data-testid="kt-rp-variant-switcher"
                      >
                        <button
                          type="button"
                          class="ktrp-reader-seg-btn"
                          :aria-label="t('variantPrevLabel')"
                          :disabled="composerLocked || mutatingRevision || revision.activeIndex <= 0"
                          data-testid="kt-rp-variant-prev"
                          @click="selectSceneVariant(revision.activeIndex - 1)"
                        >
                          &lt;
                        </button>
                        <span class="ktrp-reader-variant-status">
                          {{ revision.activeIndex + 1 }} / {{ revision.variantCount }}
                          <span class="ktrp-chip">{{ activeVariantLabel(revision) }}</span>
                        </span>
                        <button
                          type="button"
                          class="ktrp-reader-seg-btn"
                          :aria-label="t('variantNextLabel')"
                          :disabled="composerLocked || mutatingRevision || revision.activeIndex >= revision.variantCount - 1"
                          data-testid="kt-rp-variant-next"
                          @click="selectSceneVariant(revision.activeIndex + 1)"
                        >
                          &gt;
                        </button>
                      </div>

                      <ActionButton
                        v-if="isRevisionChapter(ch)"
                        size="sm"
                        :variant="rewriteDrawerOpen ? 'primary' : 'ghost'"
                        :disabled="composerLocked || mutatingRevision || (!revision.canDirectorRewrite && !revision.canFullRerun)"
                        data-testid="kt-rp-scene-rewrite-toggle"
                        @click="toggleRewriteDrawer"
                      >
                        {{ rewriteDrawerOpen ? t('sceneRewriteCloseBtn') : t('sceneRewriteToggleBtn') }}
                      </ActionButton>

                      <ActionButton
                        size="sm"
                        variant="ghost"
                        :disabled="uploadingCg || sendingInput"
                        :data-testid="
                          ch.number === activeChapterNumber
                            ? 'kt-rp-reader-upload-cg'
                            : 'kt-rp-reader-upload-cg-' + ch.number
                        "
                        @click="triggerChapterCgUpload(ch.number)"
                      >
                        {{ uploadingCg ? t('novelReaderUploadingCg') : t('novelReaderUploadCgBtn') }}
                      </ActionButton>
                    </div>
                  </div>

                  <div
                    v-if="isRevisionChapter(ch) && rewriteDrawerOpen"
                    class="ktrp-card-box ktrp-reader-rewrite-drawer"
                    data-testid="kt-rp-scene-rewrite-panel"
                  >
                    <div class="ktrp-field-block">
                      <label class="ktrp-label" for="ktrp-rewrite-mode">{{ t('sceneRewriteModeLabel') }}</label>
                      <select
                        id="ktrp-rewrite-mode"
                        v-model="rewriteMode"
                        class="ktrp-select"
                        :disabled="mutatingRevision"
                        data-testid="kt-rp-rewrite-mode"
                      >
                        <option value="director_only" :disabled="!revision.canDirectorRewrite">
                          {{ t('sceneRewriteDirectorOnly') }}
                        </option>
                        <option value="full_rerun" :disabled="!revision.canFullRerun">
                          {{ t('sceneRewriteFullRerun') }}
                        </option>
                      </select>
                    </div>

                    <div v-if="rewriteMode === 'director_only'" class="ktrp-inline-actions">
                      <span class="ktrp-muted">{{ t('sceneRewriteDirectorNote') }}</span>
                      <span v-if="revision.hasCachedReports" class="ktrp-chip ktrp-chip--accent">
                        {{ t('sceneRewriteCachedReportsBadge') }}
                      </span>
                    </div>
                    <p v-else class="ktrp-muted">{{ t('sceneRewriteFullRerunNote') }}</p>

                    <div v-if="rewriteMode === 'full_rerun'" class="ktrp-field-block">
                      <label class="ktrp-label" for="ktrp-rewrite-player-input">
                        {{ t('sceneRewritePlayerInputLabel') }}
                      </label>
                      <textarea
                        id="ktrp-rewrite-player-input"
                        v-model="rewritePlayerInput"
                        rows="2"
                        class="ktrp-textarea"
                        :disabled="mutatingRevision"
                        :placeholder="t('sceneRewritePlayerInputPlaceholder')"
                        data-testid="kt-rp-rewrite-player-input"
                      />
                    </div>

                    <div class="ktrp-field-block">
                      <label class="ktrp-label" for="ktrp-rewrite-instruction">
                        {{ t('sceneRewriteInstructionLabel') }}
                      </label>
                      <textarea
                        id="ktrp-rewrite-instruction"
                        v-model="rewriteInstruction"
                        rows="2"
                        class="ktrp-textarea"
                        :disabled="mutatingRevision"
                        :placeholder="t('sceneRewriteInstructionPlaceholder')"
                        data-testid="kt-rp-rewrite-instruction"
                      />
                    </div>

                    <div
                      v-if="rewriteError"
                      class="ktrp-banner ktrp-banner--error"
                      role="alert"
                      data-testid="kt-rp-rewrite-error"
                    >
                      <span>{{ rewriteError }}</span>
                    </div>

                    <div class="ktrp-row-end">
                      <ActionButton
                        size="sm"
                        variant="primary"
                        :disabled="composerLocked || mutatingRevision"
                        data-testid="kt-rp-rewrite-submit"
                        @click="submitSceneRewrite"
                      >
                        {{ mutatingRevision ? t('sceneRewriteSubmittingBtn') : t('sceneRewriteSubmitBtn') }}
                      </ActionButton>
                    </div>
                  </div>

                  <div v-if="ch.actors.length" class="ktrp-chip-row" data-testid="kt-rp-reader-chapter-actors">
                    <span
                      v-for="actorId in ch.actors"
                      :key="actorId"
                      class="ktrp-chip"
                    >
                      {{ actorDisplayName(actorId) }}
                    </span>
                  </div>
                </header>

                <figure
                  v-if="ch.imageUrl"
                  class="ktrp-reader-figure"
                  :data-testid="'kt-rp-reader-chapter-image-' + ch.number"
                >
                  <img
                    :src="ch.imageUrl"
                    :alt="ch.imageCaption || chapterHeadingLabel(ch)"
                    class="ktrp-reader-cg"
                  />
                  <figcaption v-if="ch.imageCaption" class="ktrp-reader-caption">
                    {{ ch.imageCaption }}
                  </figcaption>
                </figure>

                <div class="ktrp-reader-prose">
                  <p
                    v-for="(para, pIdx) in chapterParagraphs(ch)"
                    :key="ch.number + '-' + para.start + '-' + pIdx"
                    class="ktrp-reader-paragraph"
                    :data-chapter-number="ch.number"
                    :data-para-start="para.start"
                    :data-para-end="para.end"
                  ><template v-for="(seg, sIdx) in paragraphSegments(ch, para)" :key="sIdx"><mark
                    v-if="seg.kind === 'mark'"
                    class="ktrp-reader-selection-mark"
                    :class="{ 'is-preview': seg.isPreview }"
                    :data-orig-start="seg.origStart"
                    :data-orig-end="seg.origEnd"
                    data-testid="kt-rp-reader-selection-mark"
                  >{{ seg.text }}</mark><template v-else>{{ seg.text }}</template></template></p>
                </div>
              </article>

              <!-- Single-chapter pagination controls -->
              <div
                v-if="viewMode === 'single' && chapters.length > 1"
                class="ktrp-reader-pagination"
                data-testid="kt-rp-reader-pagination"
              >
                <ActionButton
                  size="sm"
                  variant="ghost"
                  :disabled="activeChapterIndex <= 0"
                  data-testid="kt-rp-reader-prev-btn"
                  @click="stepChapter(-1)"
                >
                  {{ t('novelReaderPrevChapter') }}
                </ActionButton>
                <span class="ktrp-muted">
                  {{ activeChapterIndex + 1 }} / {{ chapters.length }}
                </span>
                <ActionButton
                  size="sm"
                  variant="ghost"
                  :disabled="activeChapterIndex < 0 || activeChapterIndex >= chapters.length - 1"
                  data-testid="kt-rp-reader-next-btn"
                  @click="stepChapter(1)"
                >
                  {{ t('novelReaderNextChapter') }}
                </ActionButton>
              </div>

              <!-- Live Rehearsal Footer -->
              <div
                v-if="novelView.pendingScene || novelView.isProcessing"
                class="ktrp-reader-rehearsal"
                role="status"
                data-testid="kt-rp-reader-rehearsal-footer"
              >
                <div class="ktrp-row-between">
                  <div class="ktrp-inline-actions">
                    <strong v-if="novelView.isProcessing">
                      {{ t('novelReaderRehearsalProcessing') }}
                    </strong>
                    <span v-if="novelView.pendingScene" class="ktrp-chip ktrp-chip--accent">
                      {{ t('novelScenePending', { number: novelView.pendingScene.number }) }}
                    </span>
                  </div>
                  <ActionButton
                    v-if="novelView.pendingScene"
                    size="sm"
                    :disabled="resumingScene || novelView.isProcessing"
                    data-testid="kt-rp-reader-resume-btn"
                    @click="resumePendingScene"
                  >
                    {{ resumingScene ? t('novelResumingBtn') : t('novelResumeBtn') }}
                  </ActionButton>
                </div>
                <div v-if="novelView.pendingScene" class="ktrp-chip-row">
                  <span v-if="novelView.pendingScene.waiting.length" class="ktrp-chip">
                    {{ t('novelWaitingActors', { actors: formatActorsList(novelView.pendingScene.waiting) }) }}
                  </span>
                  <span v-if="novelView.pendingScene.reported.length" class="ktrp-chip">
                    {{ t('novelReportedActors', { actors: formatActorsList(novelView.pendingScene.reported) }) }}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- Bottom Interactive Bar -->
          <footer class="ktrp-reader-composer" data-testid="kt-rp-reader-composer">
            <div
              v-if="actionError"
              class="ktrp-banner ktrp-banner--error"
              role="alert"
              data-testid="kt-rp-reader-action-error"
            >
              <span>{{ actionError }}</span>
            </div>

            <div
              v-if="latestChoices && latestChoices.options.length"
              class="ktrp-reader-choices"
              data-testid="kt-rp-reader-choices"
            >
              <span class="ktrp-choices-prompt">
                {{ latestChoices.prompt || t('choicesPromptDefault') }}
              </span>
              <div class="ktrp-choices-list">
                <ActionButton
                  v-for="(opt, idx) in latestChoices.options"
                  :key="idx"
                  size="sm"
                  :disabled="sendingInput || composerLocked"
                  data-testid="kt-rp-reader-choice-btn"
                  :data-choice-index="idx"
                  @click="chooseOption(opt)"
                >
                  {{ opt.label }}
                </ActionButton>
              </div>
            </div>

            <div class="ktrp-reader-input-row">
              <textarea
                v-model="composerDraft"
                rows="2"
                class="ktrp-textarea ktrp-reader-textarea"
                :disabled="sendingInput || composerLocked"
                :placeholder="composerPlaceholder"
                data-testid="kt-rp-reader-input"
                @keydown.ctrl.enter.prevent="submitNovelText(composerDraft)"
                @keydown.meta.enter.prevent="submitNovelText(composerDraft)"
              />
              <ActionButton
                variant="primary"
                :disabled="sendingInput || composerLocked || !composerDraft.trim()"
                data-testid="kt-rp-reader-send-btn"
                @click="submitNovelText(composerDraft)"
              >
                {{ sendingInput ? t('novelReaderSendingBtn') : t('novelReaderSendBtn') }}
              </ActionButton>
            </div>
          </footer>
        </div>

        <!-- Mode 1 Docked Selection Studio Side/Bottom Panel -->
        <SelectionStudioPanel
          v-if="selectionLock"
          :selection-lock="selectionLock"
          :locked="composerLocked || mutatingRevision"
          :on-suggest="handleSuggestSpan"
          :on-apply="handleApplySpanEdit"
          @preview="updateSelectionPreview"
          @close="clearSelectionStudio"
        />
      </div>
    </section>
  `,
};
