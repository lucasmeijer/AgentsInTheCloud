import { transcriptSlot } from "@agents-in-the-cloud/cli-agent/server";
import { themeAppearance, type AgentsInTheCloudTheme } from "@agents-in-the-cloud/shared/theme";

export const claudeThemeName = "agents-in-the-cloud";

const pinnedBackgrounds = {
  dark: {
    selectionBg: "rgb(38,79,120)",
    diffAdded: "rgb(34,92,43)",
    diffAddedDimmed: "rgb(71,88,74)",
    diffAddedWord: "rgb(56,166,96)",
    diffRemoved: "rgb(122,41,54)",
    diffRemovedDimmed: "rgb(105,72,77)",
    diffRemovedWord: "rgb(179,89,107)",
  },
  light: {
    selectionBg: "rgb(180,213,255)",
    diffAdded: "rgb(105,219,124)",
    diffAddedDimmed: "rgb(199,225,203)",
    diffAddedWord: "rgb(47,157,68)",
    diffRemoved: "rgb(255,168,180)",
    diffRemovedDimmed: "rgb(253,210,216)",
    diffRemovedWord: "rgb(209,69,75)",
  },
};

const slot = (index: number) => `ansi256(${index})`;

/**
 * Claude's markdown ignores overrides and reads the base theme, whose inline code
 * is bright blue: AgentsInTheCloud's accent. AgentsInTheCloud's palette assigns the same roles in
 * every theme, so dark-ansi also suits light themes; only pinned backgrounds differ.
 */
export function claudeAgentsInTheCloudTheme(theme: AgentsInTheCloudTheme) {
  const { muted, surface, text } = transcriptSlot;
  return {
    name: "AgentsInTheCloud",
    base: "dark-ansi",
    overrides: {
      subtle: slot(muted),
      inactive: slot(muted),
      inactiveShimmer: slot(text),
      promptBorder: slot(muted),
      promptBorderShimmer: slot(text),
      rate_limit_empty: slot(muted),
      userMessageBackground: slot(surface),
      memoryBackgroundColor: slot(surface),
      composerSidebarBackground: slot(surface),
      ...pinnedBackgrounds[themeAppearance(theme)],
    },
  };
}
