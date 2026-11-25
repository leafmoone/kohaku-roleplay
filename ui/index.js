import { defineExtension } from "@kohakuterrarium/ui-sdk";

import { CardLibraryView } from "./src/CardLibraryView.js";
import { ChoiceBlock } from "./src/ChoiceBlock.js";
import { NovelBookPanel } from "./src/NovelBookPanel.js";
import { NovelReaderView } from "./src/NovelReaderView.js";
import { RoleplayDockPanel } from "./src/RoleplayDockPanel.js";
import { RoleplayMiniPanel } from "./src/RoleplayMiniPanel.js";
import { WorldbookLibraryView } from "./src/WorldbookLibraryView.js";

const SettingsLibrary = {
  name: "RoleplaySettingsLibrary",
  components: { CardLibraryView },
  template: `
    <div class="ktrp-stack">
      <CardLibraryView mode="settings" />
      <p class="ktrp-muted" data-testid="kt-rp-kt-attribution">
        Built for <a href="https://github.com/Kohaku-Lab/KohakuTerrarium" target="_blank" rel="noopener noreferrer">KohakuTerrarium</a>
      </p>
    </div>
  `,
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

const NovelReaderTab = {
  name: "RoleplayNovelReaderTab",
  components: { NovelReaderView },
  template: `<div class="ktrp-tab-shell ktrp-tab-shell--reader"><NovelReaderView /></div>`,
};

export const NovelBookSurface = {
  name: "RoleplayNovelBookSurface",
  components: { NovelBookPanel },
  template: `<NovelBookPanel />`,
};

export const RoleplaySurface = {
  name: "RoleplaySurface",
  components: { RoleplayDockPanel },
  template: `<RoleplayDockPanel />`,
};

export const RoleplayMiniSurface = {
  name: "RoleplayMiniSurface",
  components: { RoleplayMiniPanel },
  template: `<RoleplayMiniPanel />`,
};

export default defineExtension((kt) => {
  kt.registerSettingsSection("library", SettingsLibrary);
  kt.registerTab("studio", StudioLibraryTab);
  kt.registerTab("worldbooks", WorldbookLibraryTab);
  kt.registerTab("novel-reader", NovelReaderTab);
  kt.registerPanel("novel-book", NovelBookSurface);
  kt.registerPanel("roleplay", RoleplaySurface);
  kt.registerPanel("gameplay", RoleplayMiniSurface);
  kt.registerMessageRenderer("choices", ChoiceBlock);
});
