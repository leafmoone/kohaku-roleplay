import { defineExtension } from "@kohakuterrarium/ui-sdk";

import { CardLibraryView } from "./src/CardLibraryView.js";
import { ChoiceBlock } from "./src/ChoiceBlock.js";
import { RoleplayDockPanel } from "./src/RoleplayDockPanel.js";

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

export default defineExtension((kt) => {
  kt.registerSettingsSection("library", SettingsLibrary);
  kt.registerTab("studio", StudioLibraryTab);
  kt.registerPanel("roleplay", RoleplayDockPanel);
  kt.registerMessageRenderer("choices", ChoiceBlock);
});
