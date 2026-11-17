import type { Theme } from "@pierre/highlights";

export const agentsInTheCloudThemeName = "agents-in-the-cloud";

/**
 * Highlights token types mapped onto the design system's `--syntax-*` roles, so
 * every color scheme styles code through CSS. Unlisted subtypes fall back to their
 * parent (`keyword.control` → `keyword`); unlisted types use the foreground.
 */
export const agentsInTheCloudTheme: Theme = {
  name: agentsInTheCloudThemeName,
  appearance: "dark",
  style: {
    foreground: "foreground",
    background: "background",
    players: [{ selection: "selection" }],
    syntax: {
      attribute: "attribute",
      boolean: "literal",
      comment: "comment",
      constant: "constant",
      "constant.builtin": "literal",
      constructor: "type",
      enum: "type",
      function: "function",
      keyword: "keyword",
      label: "attribute",
      link_uri: "link",
      namespace: "type",
      number: "number",
      operator: "punctuation",
      preproc: "keyword",
      "property.json_key": "attribute",
      punctuation: "punctuation",
      selector: "tag",
      "selector.class": "attribute",
      "selector.id": "attribute",
      "selector.pseudo": "attribute",
      string: "string",
      "string.escape": "string-expression",
      "string.special.symbol": "constant",
      "text.literal": "string",
      tag: "tag",
      title: "keyword",
      type: "type",
      variable: "variable",
      variant: "type",
    },
  },
  cssVariables: { prefix: "--syntax-", defaults: { foreground: "var(--text-bright)", background: "transparent", selection: "color-mix(in srgb, var(--accent) 32%, transparent)" } },
};
