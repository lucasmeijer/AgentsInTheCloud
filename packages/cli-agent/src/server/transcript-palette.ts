/**
 * AgentsInTheCloud's opinion on how agent transcripts are drawn, as ANSI palette slots.
 * The terminal maps each slot to the viewer's theme (observable-terminal), so
 * CLI agents recolor live on theme changes. The built-in agent's markdown CSS
 * uses the same design tokens directly.
 */
export const transcriptSlot = {
  surface: 0,
  danger: 1,
  success: 2,
  warning: 3,
  decorative: 5,
  text: 7,
  muted: 8,
  accent: 12,
  bright: 15,
} as const;

export const syntaxSlot = {
  comment: transcriptSlot.muted,
  keyword: transcriptSlot.accent,
  function: transcriptSlot.accent,
  type: transcriptSlot.accent,
  string: transcriptSlot.success,
  number: transcriptSlot.decorative,
  variable: transcriptSlot.warning,
} as const;
