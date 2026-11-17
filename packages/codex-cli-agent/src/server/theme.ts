import { syntaxSlot, transcriptSlot } from "@agents-in-the-cloud/cli-agent/server";

export const codexThemeName = "agents-in-the-cloud";

// bat/syntect encoding that Codex honors: alpha 00 makes red the palette index,
// alpha 01 means the terminal default. Palette colors follow the viewer's theme.
const slot = (index: number) => `#${index.toString(16).padStart(2, "0")}000000`;
const terminalDefault = "#00000001";

const scopes: [scope: string, index: number][] = [
  ["markup.inline.raw.string.markdown, markup.raw.inline.markdown", transcriptSlot.accent],
  ["entity.name.type, support.type, entity.name.class", syntaxSlot.type],
  ["comment, punctuation.definition.comment", syntaxSlot.comment],
  ["keyword, storage", syntaxSlot.keyword],
  ["entity.name.function, support.function", syntaxSlot.function],
  ["string, punctuation.definition.string", syntaxSlot.string],
  ["constant.numeric, constant.language", syntaxSlot.number],
  ["variable.parameter", syntaxSlot.variable],
];

export function codexAgentsInTheCloudTmTheme(): string {
  const entry = (scope: string, foreground: string) =>
    `<dict><key>scope</key><string>${scope}</string><key>settings</key><dict><key>foreground</key><string>${foreground}</string></dict></dict>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>name</key><string>AgentsInTheCloud</string><key>settings</key><array>
<dict><key>settings</key><dict><key>foreground</key><string>${terminalDefault}</string><key>background</key><string>${terminalDefault}</string></dict></dict>
${scopes.map(([scope, index]) => entry(scope, slot(index))).join("\n")}
</array></dict></plist>
`;
}
