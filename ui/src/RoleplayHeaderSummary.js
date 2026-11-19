import { computed } from "vue";
import { useOwner } from "@kohakuterrarium/ui-sdk";

import { useRoleplayText } from "./strings.js";

function clampMeter(item) {
  const min = Number.isFinite(Number(item?.min)) ? Number(item.min) : 0;
  const max = Number.isFinite(Number(item?.max)) ? Number(item.max) : 100;
  const val = Number.isFinite(Number(item?.value)) ? Number(item.value) : min;
  return {
    min,
    max,
    value: Math.min(max, Math.max(min, val)),
  };
}

function formatCompactValue(item, t) {
  if (!item || typeof item !== "object") return "";
  const type = item.type;
  if (type === "meter") {
    const { min, max, value } = clampMeter(item);
    return `${item.value ?? value}/${max}`;
  }
  if (type === "inventory") {
    const list = Array.isArray(item.items) ? item.items : [];
    if (!list.length) return t("nativeInventoryEmpty");
    const preview = list
      .slice(0, 2)
      .map((entry) =>
        t("nativeInventoryItem", {
          label: entry?.label || "",
          quantity: entry?.quantity ?? 1,
        }),
      )
      .join(", ");
    return list.length > 2 ? `${preview} +${list.length - 2}` : preview;
  }
  if (type === "quest") {
    const done = Boolean(item.completed);
    const status = typeof item.status === "string" ? item.status.trim() : "";
    const badge = t(done ? "nativeCompleted" : "nativeNotCompleted");
    return status ? `${status} (${badge})` : badge;
  }
  if (type === "list") {
    const arr = Array.isArray(item.value) ? item.value.map((v) => String(v ?? "")) : [];
    if (!arr.length) return t("stateFieldEmpty");
    const joined = arr.slice(0, 3).join(", ");
    return arr.length > 3 ? `${joined} +${arr.length - 3}` : joined;
  }
  if (type === "number") {
    const hasMin = typeof item.min === "number" && Number.isFinite(item.min);
    const hasMax = typeof item.max === "number" && Number.isFinite(item.max);
    if (hasMin && hasMax) return `${item.value}/${item.max}`;
    return String(item.value ?? "");
  }
  if (type === "mvu") {
    const val = item.value;
    if (val !== null && typeof val === "object") {
      try {
        const raw = JSON.stringify(val);
        return raw.length > 48 ? `${raw.slice(0, 45)}…` : raw;
      } catch {
        return String(val);
      }
    }
    return String(val ?? "");
  }
  const str = String(item.value ?? "").trim();
  if (!str) return t("stateFieldEmpty");
  return str.length > 48 ? `${str.slice(0, 45)}…` : str;
}

/**
 * Read-only compact header summary bar for `plugin:roleplay`.
 * Mounted in desktop SessionBar and mobile PhoneHeader via
 * `<ExtensionContribution surface="session-header" />` using the same
 * scoped `plugin:roleplay` owner without opening a new socket or exposing private state.
 */
export const RoleplayHeaderSummary = {
  name: "RoleplayHeaderSummary",
  setup() {
    const owner = useOwner();
    const t = useRoleplayText();

    const state = computed(() => owner.state.value || {});
    const isActiveTavern = computed(
      () =>
        owner.status.value === "ready" &&
        state.value.mode === "tavern" &&
        Boolean(state.value.active),
    );
    const items = computed(() => {
      if (!isActiveTavern.value) return [];
      const raw = state.value.headerSummary?.items;
      if (!Array.isArray(raw)) return [];
      return raw
        .filter(
          (item) =>
            item &&
            typeof item === "object" &&
            typeof item.id === "string" &&
            item.id &&
            typeof item.label === "string" &&
            item.label,
        )
        .map((item) => {
          const hasMeter =
            item.type === "meter" ||
            (item.type === "number" &&
              typeof item.min === "number" &&
              typeof item.max === "number" &&
              item.max > item.min);
          let meterPercent = 0;
          if (hasMeter) {
            const { min, max, value } = clampMeter(item);
            meterPercent = max > min ? Math.round(((value - min) / (max - min)) * 100) : 0;
          }
          return {
            id: item.id,
            label: item.label,
            type: String(item.type || "text"),
            displayValue: formatCompactValue(item, t),
            hasMeter,
            meterPercent,
          };
        });
    });

    function itemTestId(id) {
      return `kt-rp-header-summary-item-${encodeURIComponent(id)}`;
    }

    return {
      t,
      isActiveTavern,
      items,
      itemTestId,
    };
  },
  template: `
    <div
      v-if="isActiveTavern && items.length"
      class="ktrp-header-summary"
      role="region"
      :aria-label="t('headerSummaryTitle')"
      data-testid="kt-rp-header-summary"
    >
      <div
        v-for="item in items"
        :key="item.id"
        class="ktrp-header-summary-pill"
        :data-summary-type="item.type"
        :data-testid="itemTestId(item.id)"
      >
        <span class="ktrp-header-summary-label" :data-testid="itemTestId(item.id) + '-label'">
          {{ item.label }}
        </span>
        <span class="ktrp-header-summary-value" :data-testid="itemTestId(item.id) + '-value'">
          {{ item.displayValue }}
        </span>
        <span
          v-if="item.hasMeter"
          class="ktrp-header-summary-meter"
          aria-hidden="true"
        >
          <span
            class="ktrp-header-summary-meter-fill"
            :style="{ width: item.meterPercent + '%' }"
          />
        </span>
      </div>
    </div>
  `,
};
