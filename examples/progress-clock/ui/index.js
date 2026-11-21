import { computed, onUnmounted, ref, shallowRef, watch } from "vue";
import {
  ActionButton,
  defineExtension,
  useCreature,
  useExtension,
  useOwner,
  useSession,
} from "@kohakuterrarium/ui-sdk";

const ABSENT_CODES = new Set([
  "owner_not_loaded",
  "owner_disabled",
  "owner_has_no_ui",
  "owner_unsupported",
]);

function readScopeToken(raw) {
  return raw && typeof raw === "object" && typeof raw.scope === "string" && raw.scope
    ? raw.scope
    : null;
}

function toClock(raw) {
  if (!raw || typeof raw !== "object" || raw.active !== true) return null;
  const scope = readScopeToken(raw);
  const label = typeof raw.label === "string" ? raw.label.trim() : "";
  const segments = Number.isInteger(raw.segments) && raw.segments >= 1 ? raw.segments : 0;
  if (!scope || !label || !segments) return null;
  const filled = Number.isInteger(raw.filled) ? Math.max(0, Math.min(segments, raw.filled)) : 0;
  return { scope, label, segments, filled, complete: filled >= segments };
}

export const ProgressClockPanel = {
  name: "ProgressClockPanel",
  components: { ActionButton },
  setup() {
    const kt = useExtension();
    const owner = useOwner();
    const session = useSession();
    const creature = useCreature();

    const scopeEpoch = ref(0);
    const verified = shallowRef(null);
    const pending = ref(false);
    const error = ref("");
    let readToken = 0;
    let unmounted = false;

    // Match KT 2.2.2 useOwnerScope: graph_id/id + focused creature (or sole-creature fallback).
    const scopeKey = computed(() => {
      const s = session.value;
      const sessionId = s?.instance?.graph_id || s?.instance?.id || s?.id || "";
      const sole = s?.creatures?.length === 1 ? s.creatures[0]?.name || "" : "";
      const creatureId = creature.value?.name || sole;
      return `${sessionId}\0${creatureId}`;
    });

    function isCurrent(epoch) {
      return !unmounted && epoch === scopeEpoch.value;
    }

    async function readScope(epoch = scopeEpoch.value, { keepError = false } = {}) {
      const token = ++readToken;
      if (!keepError) error.value = "";
      try {
        const next = await owner.call("read", {});
        if (!isCurrent(epoch) || token !== readToken) return;
        if (next && typeof next === "object") {
          verified.value = { epoch, scope: readScopeToken(next), view: next };
        }
      } catch (err) {
        if (!isCurrent(epoch) || token !== readToken) return;
        if (!ABSENT_CODES.has(err?.code)) {
          error.value = err?.message || kt.t("loadFailed");
        }
      }
    }

    watch(
      scopeKey,
      () => {
        scopeEpoch.value += 1;
        readToken += 1;
        verified.value = null;
        pending.value = false;
        error.value = "";
      },
      { flush: "sync" },
    );

    watch(
      [scopeKey, () => owner.status.value],
      ([, status]) => {
        if (status === "ready") {
          readScope(scopeEpoch.value);
        }
      },
      { immediate: true },
    );

    // Accept live owner.state pushes only when they carry the verified scope token for this epoch.
    watch(
      () => owner.state.value,
      (next) => {
        const current = verified.value;
        if (!current || current.epoch !== scopeEpoch.value || !current.scope) return;
        if (!next || typeof next !== "object") return;
        if (readScopeToken(next) !== current.scope) return;
        verified.value = { epoch: scopeEpoch.value, scope: current.scope, view: next };
      },
    );

    onUnmounted(() => {
      unmounted = true;
      scopeEpoch.value += 1;
      readToken += 1;
    });

    const view = computed(() =>
      verified.value?.epoch === scopeEpoch.value ? verified.value.view : null,
    );
    const clock = computed(() => toClock(view.value));
    const isOwnerError = computed(
      () => owner.status.value === "error" || owner.status.value === "absent",
    );
    const isLoading = computed(() => !isOwnerError.value && !view.value && !error.value);
    const advanceDisabled = computed(
      () => pending.value || owner.status.value !== "ready" || !clock.value || clock.value.complete,
    );
    const advanceLabel = computed(() => {
      if (pending.value) return kt.t("advancing");
      if (clock.value?.complete) return kt.t("complete");
      return kt.t("advance");
    });

    async function refresh() {
      const epoch = scopeEpoch.value;
      error.value = "";
      if (isOwnerError.value) {
        try {
          await owner.refresh();
        } catch (err) {
          if (isCurrent(epoch)) error.value = err?.message || kt.t("loadFailed");
        }
        return;
      }
      if (isCurrent(epoch) && owner.status.value === "ready") {
        await readScope(epoch);
      }
    }

    async function advance() {
      const current = clock.value;
      if (advanceDisabled.value || !current) return;
      const epoch = scopeEpoch.value;
      const verifiedScope = current.scope;
      const expectedFilled = current.filled;
      readToken += 1;
      pending.value = true;
      error.value = "";
      try {
        const next = await owner.call("advance", { scope: verifiedScope, expectedFilled });
        if (!isCurrent(epoch) || !next || typeof next !== "object") return;
        const nextScope = readScopeToken(next);
        const matchesScope =
          next.active === false
            ? nextScope === null || nextScope === verifiedScope
            : nextScope === verifiedScope;
        if (!matchesScope) return;
        const cur = verified.value?.epoch === epoch ? verified.value.view : null;
        const notRegressing =
          next.active === false ||
          !cur?.active ||
          !Number.isInteger(cur.filled) ||
          next.filled >= cur.filled;
        if (notRegressing) {
          verified.value = { epoch, scope: nextScope || verifiedScope, view: next };
        }
      } catch (err) {
        if (!isCurrent(epoch)) return;
        error.value = err?.message || kt.t("advanceFailed");
        await readScope(epoch, { keepError: true });
      } finally {
        if (isCurrent(epoch)) pending.value = false;
      }
    }

    return {
      kt,
      owner,
      view,
      clock,
      isOwnerError,
      isLoading,
      pending,
      error,
      advanceDisabled,
      advanceLabel,
      advance,
      refresh,
    };
  },
  template: `
    <div class="ktpc-panel" data-testid="kt-clock-panel">
      <div v-if="isOwnerError" class="ktpc-error" role="alert" data-testid="kt-clock-error">
        <span>{{ owner.error.value || kt.t('loadFailed') }}</span>
        <ActionButton size="sm" data-testid="kt-clock-refresh" @click="refresh">{{ kt.t('retry') }}</ActionButton>
      </div>

      <template v-else>
        <div v-if="error" class="ktpc-error" role="alert" data-testid="kt-clock-error">
          <span>{{ error }}</span>
          <ActionButton size="sm" data-testid="kt-clock-refresh" @click="refresh">{{ kt.t('refresh') }}</ActionButton>
        </div>

        <p v-if="isLoading" class="ktpc-muted" role="status" data-testid="kt-clock-loading">
          {{ kt.t('loading') }}
        </p>

        <div v-else-if="view && !clock" class="ktpc-inactive" data-testid="kt-clock-inactive">
          <p class="ktpc-muted">{{ kt.t('inactive') }}</p>
          <ActionButton size="sm" variant="ghost" data-testid="kt-clock-refresh" @click="refresh">{{ kt.t('refresh') }}</ActionButton>
        </div>

        <div v-else-if="clock" class="ktpc-body">
          <div class="ktpc-head">
            <span class="ktpc-label" data-testid="kt-clock-label">{{ clock.label }}</span>
            <span class="ktpc-fraction" data-testid="kt-clock-fraction">{{ clock.filled }}/{{ clock.segments }}</span>
          </div>

          <div
            class="ktpc-segments"
            :style="{ '--ktpc-segments': String(clock.segments) }"
            role="progressbar"
            :aria-label="clock.label"
            :aria-valuemin="0"
            :aria-valuemax="clock.segments"
            :aria-valuenow="clock.filled"
            :aria-valuetext="kt.t('progressText', { filled: clock.filled, segments: clock.segments })"
            data-testid="kt-clock-progress"
          >
            <span
              v-for="idx in clock.segments"
              :key="idx"
              class="ktpc-segment"
              :class="{ 'ktpc-segment--filled': idx <= clock.filled, 'ktpc-segment--complete': clock.complete }"
              :data-filled="String(idx <= clock.filled)"
              :data-testid="'kt-clock-segment-' + idx"
              aria-hidden="true"
            />
          </div>

          <div class="ktpc-footer">
            <span v-if="clock.complete" class="ktpc-complete" role="status" data-testid="kt-clock-complete">
              {{ kt.t('complete') }}
            </span>
            <span v-else />
            <ActionButton
              variant="primary"
              size="sm"
              :disabled="advanceDisabled"
              :aria-busy="String(pending)"
              data-testid="kt-clock-advance"
              @click="advance"
            >
              {{ advanceLabel }}
            </ActionButton>
          </div>
        </div>
      </template>
    </div>
  `,
};

export default defineExtension((kt) => {
  kt.registerPanel("clock", ProgressClockPanel);
});
