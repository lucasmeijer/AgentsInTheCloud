import { agentsInTheCloudName, escapeHtml, type WorkspaceModule } from "@agents-in-the-cloud/shared";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { readThemeSetting } from "@agents-in-the-cloud/shared/theme";
import { pageBodyStimulusHtml } from "@agents-in-the-cloud/design-system/page-body";
import { parseAssetManifest, type AssetManifest } from "./asset-manifest.ts";
import { themeRegionHtml, themeRegionId } from "./settings/theme.ts";

export function createPageLayout(options: { devReload?: boolean; workspaceModules: readonly WorkspaceModule[] }): (body: string) => string {
  let cachedAssetManifest: AssetManifest | undefined;

  function loadAssetManifest(): AssetManifest {
    const manifestUrl = new URL("../../public/assets-manifest.json", import.meta.url);
    return existsSync(manifestUrl) ? parseAssetManifest(readFileSync(manifestUrl, "utf8")) : {};
  }

  function publicAssetExists(path: string): boolean {
    return existsSync(new URL(`../../public/${path.replace(/^\//, "")}`, import.meta.url));
  }

  function assetPath(logicalPath: string): string {
    cachedAssetManifest ??= loadAssetManifest();
    let resolved = cachedAssetManifest[logicalPath] ?? logicalPath;
    if (resolved.startsWith("/assets/") && !publicAssetExists(resolved)) {
      cachedAssetManifest = loadAssetManifest();
      resolved = cachedAssetManifest[logicalPath] ?? logicalPath;
    }
    return resolved;
  }

  function moduleStylesHtml(): string {
    const styles = new Set<string>();
    for (const module of options.workspaceModules) {
      for (const [path, entry] of Object.entries(module.staticFiles ?? {})) {
        if (path.endsWith(".css") && entry.contentType.toLowerCase().startsWith("text/css")) styles.add(path);
      }
    }
    return [...styles].map((path) => `<link rel="stylesheet" href="${assetPath(path)}">`).join("\n");
  }

  return (body) => {
    if (options.devReload) cachedAssetManifest = loadAssetManifest();
    const pageId = randomUUID();
    const theme = readThemeSetting();
    return `<!DOCTYPE html>
<html lang="en" data-theme="${theme}" data-agents-in-the-cloud-page-id="${escapeHtml(pageId)}">
<head>
<meta charset="utf-8">
<style>
html { background: #f3f5f9; color-scheme: light; }
html[data-theme="cappuccino"] { background: #2b2018; color-scheme: dark; }
html[data-theme="tokyo-night"] { background: #1a1b26; color-scheme: dark; }
html[data-theme="midnight"] { background: #0d1117; color-scheme: dark; }
html[data-theme="nord"] { background: #2e3440; color-scheme: dark; }
${options.devReload ? `
/* Keep the previous page painted while a rebuilt development page loads. */
@view-transition { navigation: auto; }
::view-transition-old(root), ::view-transition-new(root) { animation-duration: 120ms; }
` : ""}</style>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="turbo-cache-control" content="no-cache">
<title>${escapeHtml(agentsInTheCloudName)}</title>
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<meta name="theme-color" content="#eadcc6">
<link rel="stylesheet" href="${assetPath("/design-system.css")}">
<link rel="stylesheet" href="${assetPath("/style.css")}">
<link rel="stylesheet" href="${assetPath("/provisioning.css")}">
${moduleStylesHtml()}
<script type="module" src="${assetPath("/workspace.js")}"></script>
</head>
<body id="body"${pageBodyStimulusHtml(["navigation-origin", "cable-shell", options.devReload ? "dev-reload" : undefined])}${options.devReload ? ` data-dev-reload-url-value="/__agents-in-the-cloud_dev_reload"` : ""}><div id="live-connection-status" role="status" class="live-connection-status"><span class="status-spinner" aria-hidden="true"></span> Reconnecting… Updates are paused.</div><div id="${themeRegionId}" hidden>${themeRegionHtml(theme)}</div>${body}
</body>
</html>`;
  };
}
