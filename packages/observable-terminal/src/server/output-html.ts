import { escapeHtml } from "@agents-in-the-cloud/shared";

const ansi16 = [
  "var(--panel)", "var(--danger)", "var(--success)", "var(--warning)", "var(--accent)", "var(--decorative)", "var(--accent)", "var(--text-bright)",
  "var(--line-strong)", "var(--danger)", "var(--success)", "var(--warning)", "var(--accent)", "var(--decorative)", "var(--accent)", "var(--text-bright)",
];

function ansi256(index: number): string | undefined {
  if (index >= 0 && index < 16) return ansi16[index];
  if (index >= 16 && index <= 231) {
    const n = index - 16;
    const r = Math.floor(n / 36);
    const g = Math.floor((n % 36) / 6);
    const b = n % 6;
    const level = (v: number) => v === 0 ? 0 : 55 + v * 40;
    return `rgb(${level(r)},${level(g)},${level(b)})`;
  }
  if (index >= 232 && index <= 255) {
    const v = 8 + (index - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  return undefined;
}

interface AnsiStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fg?: string;
  bg?: string;
}

function styleAttr(style: AnsiStyle): string {
  const rules: string[] = [];
  if (style.bold) rules.push("font-weight:700");
  if (style.italic) rules.push("font-style:italic");
  if (style.underline) rules.push("text-decoration:underline");
  if (style.fg) rules.push(`color:${style.fg}`);
  if (style.bg) rules.push(`background-color:${style.bg}`);
  return rules.length ? ` style="${escapeHtml(rules.join(";"))}"` : "";
}

function ansiToHtml(text: string): string {
  let html = "";
  let style: AnsiStyle = {};
  let open = false;
  const close = () => {
    if (open) html += "</span>";
    open = false;
  };
  const openSpan = () => {
    const attr = styleAttr(style);
    if (attr) {
      html += `<span${attr}>`;
      open = true;
    }
  };
  const setStyle = (next: typeof style) => {
    close();
    style = next;
    openSpan();
  };
  for (let i = 0; i < text.length;) {
    if (text[i] === "\x1b" && text[i + 1] === "]") {
      const rest = text.slice(i + 2);
      const bel = rest.indexOf("\x07");
      const st = rest.indexOf("\x1b\\");
      const end = bel >= 0 && (st < 0 || bel < st) ? bel + 3 : st >= 0 ? st + 4 : -1;
      if (end >= 0) {
        i += end;
        continue;
      }
    }
    if (text[i] === "\x1b" && /[=>78]/.test(text[i + 1] ?? "")) {
      i += 2;
      continue;
    }
    if (text[i] === "\x1b" && text[i + 1] === "[") {
      const end = text.slice(i + 2).search(/[A-Za-z]/);
      if (end >= 0) {
        const final = text[i + 2 + end];
        const raw = text.slice(i + 2, i + 2 + end);
        i += end + 3;
        if (final !== "m") continue;
        const codes = raw === "" ? [0] : raw.split(";").map((part) => part === "" ? 0 : Number(part));
        let next = { ...style };
        for (let c = 0; c < codes.length; c++) {
          const code = Number.isFinite(codes[c]) ? codes[c] : 0;
          if (code === 0) next = {};
          else if (code === 1) next.bold = true;
          else if (code === 3) next.italic = true;
          else if (code === 4) next.underline = true;
          else if (code === 22) next.bold = false;
          else if (code === 23) next.italic = false;
          else if (code === 24) next.underline = false;
          else if (code === 39) next.fg = undefined;
          else if (code === 49) next.bg = undefined;
          else if (code >= 30 && code <= 37) next.fg = ansi16[code - 30];
          else if (code >= 90 && code <= 97) next.fg = ansi16[8 + code - 90];
          else if (code >= 40 && code <= 47) next.bg = ansi16[code - 40];
          else if (code >= 100 && code <= 107) next.bg = ansi16[8 + code - 100];
          else if ((code === 38 || code === 48) && codes[c + 1] === 5) {
            const color = ansi256(codes[c + 2]);
            if (color && code === 38) next.fg = color;
            if (color && code === 48) next.bg = color;
            c += 2;
          } else if ((code === 38 || code === 48) && codes[c + 1] === 2) {
            const r = codes[c + 2], g = codes[c + 3], b = codes[c + 4];
            if ([r, g, b].every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) {
              const color = `rgb(${r},${g},${b})`;
              if (code === 38) next.fg = color;
              else next.bg = color;
            }
            c += 4;
          }
        }
        setStyle(next);
        continue;
      }
    }
    if (text.charCodeAt(i) < 32 && text[i] !== "\n" && text[i] !== "\t") {
      i++;
      continue;
    }
    html += escapeHtml(text[i]);
    i++;
  }
  close();
  return html;
}

function hasAnsiSgr(text: string): boolean {
  return /\x1b\[[0-9;?]*m/.test(text);
}

function colorizePlainBuildOutput(text: string): string {
  const lines = text.split("\n");
  return lines.map((line) => {
    const cmake = line.match(/^(\[\s*\d+%\])(\s*)((?:Built|Building|Linking|Generating|Scanning|Consolidate)\b[^:]*)(.*)$/);
    if (cmake) {
      return `<span style="color:var(--accent)">${escapeHtml(cmake[1])}</span>${escapeHtml(cmake[2])}<span style="color:var(--success)">${escapeHtml(cmake[3])}</span>${escapeHtml(cmake[4])}`;
    }
    const diagnostic = line.match(/^(.*?)(warning|error|fatal error|failed|FAILED)(:?.*)$/i);
    if (diagnostic) {
      const color = /warn/i.test(diagnostic[2]) ? "var(--warning)" : "var(--danger)";
      return `${escapeHtml(diagnostic[1])}<span style="color:${color};font-weight:700">${escapeHtml(diagnostic[2])}</span>${escapeHtml(diagnostic[3])}`;
    }
    return escapeHtml(line);
  }).join("\n");
}

export function terminalOutputHtml(text: string): string {
  if (hasAnsiSgr(text)) return ansiToHtml(text);
  return colorizePlainBuildOutput(text);
}
