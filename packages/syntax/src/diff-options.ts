import { agentsInTheCloudThemeName } from "./theme.ts";

const changedLineCSS = `[data-line-type="change-addition"], [data-line-type="change-deletion"] { --mix-light: 80%; --mix-dark: 80%; }`;
export const wordDiffCSS = `[data-line-type="change-addition"] [data-diff-span] { background-color: color-mix(in srgb, var(--diffs-addition-base) 20%, transparent); } [data-line-type="change-deletion"] [data-diff-span] { background-color: color-mix(in srgb, var(--diffs-deletion-base) 20%, transparent); }`;
const changesLayoutCSS = `[data-code] { padding-block: 0; overflow-x: auto; }`;

export const pierreHighlightOptions = {
  preferredHighlighter: "highlights" as const,
  theme: agentsInTheCloudThemeName,
  themeType: "dark" as const,
};

function diffOptions(presentation: "changes" | "tool") {
  const changes = presentation === "changes";
  return {
    ...pierreHighlightOptions,
    diffStyle: "unified" as const,
    overflow: "wrap" as const,
    disableLineNumbers: true,
    disableFileHeader: true,
    hunkSeparators: changes ? "line-info" as const : "simple" as const,
    expansionLineCount: changes ? 40 : 3,
    collapsedContextThreshold: changes ? 6 : 0,
    lineDiffType: changes ? "none" as const : "word-alt" as const,
    stickyHeader: false,
    unsafeCSS: changes ? `${changedLineCSS} ${wordDiffCSS} ${changesLayoutCSS}` : changedLineCSS,
  };
}

export const changesDiffOptions = diffOptions("changes");
export const toolDiffOptions = diffOptions("tool");
