import { defineExtension } from "@kohakuterrarium/ui-sdk";

import { CardLibraryView } from "./src/CardLibraryView.js";
import { ChoiceBlock } from "./src/ChoiceBlock.js";
import { RoleplayDockPanel } from "./src/RoleplayDockPanel.js";
import { RoleplayHeaderSummary } from "./src/RoleplayHeaderSummary.js";
import { WorldbookLibraryView } from "./src/WorldbookLibraryView.js";

const SettingsLibrary = {
  name: "RoleplaySettingsLibrary",
  components: { CardLibraryView },
  template: `<CardLibraryView mode="settings" />`,
};

const StudioLibraryTab = {
  name: "RoleplayStudioTab",
  components: { CardLibraryView },
  template: `<div class="ktrp-tab-shell"><CardLibraryView mode="tab" /></div>`,
};

const WorldbookLibraryTab = {
  name: "RoleplayWorldbooksTab",
  components: { WorldbookLibraryView },
  template: `<div class="ktrp-tab-shell"><WorldbookLibraryView /></div>`,
};

export const RoleplaySurface = {
  name: "RoleplaySurface",
  components: { RoleplayDockPanel, RoleplayHeaderSummary },
  props: {
    surface: { type: String, default: "dock" },
  },
  template: `
    <RoleplayHeaderSummary v-if="surface === 'session-header'" />
    <RoleplayDockPanel v-else />
  `,
};

export default defineExtension((kt) => {
  kt.registerSettingsSection("library", SettingsLibrary);
  kt.registerTab("studio", StudioLibraryTab);
  kt.registerTab("worldbooks", WorldbookLibraryTab);
  kt.registerPanel("roleplay", RoleplaySurface);
  kt.registerMessageRenderer("choices", ChoiceBlock);
});
