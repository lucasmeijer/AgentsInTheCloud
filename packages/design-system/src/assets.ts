import type { StaticFileContribution } from "@agents-in-the-cloud/shared";

export const designSystemStaticFiles = {
  "/scrollbar.css": { url: new URL("./scrollbar/scrollbar.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/builtin-agent.png": { url: new URL("./icons/builtin-agent.png", import.meta.url), contentType: "image/png" },
  "/agents-in-the-cloud-brand.png": { url: new URL("./icons/agents-in-the-cloud-brand.png", import.meta.url), contentType: "image/png" },
  "/tab-strip.css": { url: new URL("./tab-strip/tab-strip.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/warning-banner.css": { url: new URL("./warning-banner/warning-banner.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/text-entry.css": {
    url: new URL("./text-entry/text-entry.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/managed-list.css": {
    url: new URL("./managed-list/managed-list.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/markdown.css": {
    url: new URL("./markdown/markdown.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/status.css": {
    url: new URL("./status/status.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/design-system-catalogue.css": {
    url: new URL("../catalogue/catalogue.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/design-system.css": {
    url: new URL("./design-system.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/disclosure.css": { url: new URL("./disclosure/disclosure.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/content-row.css": {
    url: new URL("./content-row/content-row.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/autocomplete.css": {
    url: new URL("./autocomplete/autocomplete.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/activity-button.css": {
    url: new URL("./activity-button/activity-button.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/comparison-ring.css": {
    url: new URL("./comparison-ring/comparison-ring.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/button.css": {
    url: new URL("./button/button.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/button-group.css": {
    url: new URL("./button-group/button-group.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/button-confirmation.css": { url: new URL("./button-confirmation/button-confirmation.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/copy-button.css": {
    url: new URL("./copy-button/copy-button.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/destructive-confirmation.css": {
    url: new URL(
      "./destructive-confirmation/destructive-confirmation.css",
      import.meta.url,
    ),
    contentType: "text/css; charset=utf-8",
  },
  "/dialog.css": {
    url: new URL("./dialog/dialog.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/floating-surface.css": {
    url: new URL("./floating-surface/floating-surface.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/icons.css": {
    url: new URL("./icons/icons.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/surface-lighting.css": {
    url: new URL("./surface-lighting.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/page-slide.css": { url: new URL("./page-slide/page-slide.css", import.meta.url), contentType: "text/css; charset=utf-8" },
  "/panel.css": {
    url: new URL("./panel/panel.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/popup.css": {
    url: new URL("./popup/popup.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/perimeter-button.css": {
    url: new URL("./perimeter-button/perimeter-button.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/progress-button.css": {
    url: new URL("./progress-button/progress-button.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/transient-feedback.css": {
    url: new URL(
      "./transient-feedback/transient-feedback.css",
      import.meta.url,
    ),
    contentType: "text/css; charset=utf-8",
  },
  "/qr-code.css": {
    url: new URL("./qr-code/qr-code.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/add-badge.css": {
    url: new URL("./add-badge/add-badge.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/help-tip.css": {
    url: new URL("./help-tip/help-tip.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/toggle.css": {
    url: new URL("./toggle/toggle.css", import.meta.url),
    contentType: "text/css; charset=utf-8",
  },
  "/fonts/jetbrains-mono-latin-400-normal.woff2": {
    url: new URL(
      import.meta
        .resolve("@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2"),
    ),
    contentType: "font/woff2",
  },
} satisfies Record<string, StaticFileContribution>;
