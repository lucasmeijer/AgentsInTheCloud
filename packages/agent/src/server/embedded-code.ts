import { format as formatJavaScript } from "@wasm-fmt/biome_fmt";
import { format as formatPython } from "@wasm-fmt/ruff_fmt";
import { format as formatShell } from "@wasm-fmt/shfmt";
import { highlightCodeHtmlForPath, javascriptLinesStartingInLiterals, languageFromPath } from "@agents-in-the-cloud/syntax";
import { escapeHtml } from "@agents-in-the-cloud/shared";

interface BashHeredoc {
  path: string;
  contentStart: number;
  contentEnd: number;
}

const bashHeredocOpening = /(?:^|[;&|]\s*|[({]\s*|\bthen\s+)(?:cat\s+>{1,2}\s*("[^"\n]+"|'[^'\n]+'|[^\s;|&]+)|(?:timeout\s+[^\s;&|<]+\s+)?(bun|node|python3?)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|[^\s;|&<]+))*)\s*<<(-?)\s*('[^'\n]+'|"[^"\n]+"|[A-Za-z_][\w-]*)/gm;

function unquoteShellWord(word: string): string {
  const quote = word[0];
  return quote && (quote === "'" || quote === '"') && word.at(-1) === quote ? word.slice(1, -1) : word;
}

function heredocProgramPath(program: string, delimiter: string): string {
  if (program.startsWith("python")) return "stdin.py";
  if (program === "bun" && /^(?:ts|typescript)$/i.test(delimiter)) return "stdin.ts";
  return "stdin.js";
}

function bashHeredocs(command: string): BashHeredoc[] {
  const heredocs: BashHeredoc[] = [];
  bashHeredocOpening.lastIndex = 0;
  for (;;) {
    const opening = bashHeredocOpening.exec(command);
    if (!opening) break;
    const openingLineEnd = command.indexOf("\n", opening.index + opening[0].length);
    if (openingLineEnd < 0) break;
    const delimiter = unquoteShellWord(opening[4]!);
    const stripsTabs = opening[3] === "-";
    let closingStart = openingLineEnd + 1;
    let closingEnd = closingStart;
    for (;;) {
      closingEnd = command.indexOf("\n", closingStart);
      if (closingEnd < 0) closingEnd = command.length;
      const line = command.slice(closingStart, closingEnd).replace(/\r$/, "");
      if ((stripsTabs ? line.replace(/^\t+/, "") : line) === delimiter) break;
      if (closingEnd === command.length) {
        closingStart = -1;
        break;
      }
      closingStart = closingEnd + 1;
    }
    if (closingStart < 0) continue;
    const contentStart = openingLineEnd + 1;
    const path = opening[1] ? unquoteShellWord(opening[1]) : heredocProgramPath(opening[2]!, delimiter);
    heredocs.push({ path, contentStart, contentEnd: Math.max(contentStart, closingStart - 1) });
    bashHeredocOpening.lastIndex = closingEnd;
  }
  return heredocs;
}

function displayFormattedFile(content: string, path: string): string | undefined {
  const language = languageFromPath(path);
  try {
    let formatted: string;
    switch (language) {
      case "javascript":
      case "typescript":
        formatted = formatJavaScript(content, path, { indentStyle: "space", indentWidth: 2 });
        break;
      case "python":
        formatted = formatPython(content, path, { indent_style: "space", indent_width: 4 });
        break;
      case "json":
        formatted = JSON.stringify(JSON.parse(content), null, 2);
        break;
      default:
        return undefined;
    }
    const trimmed = formatted.trimEnd();
    if (trimmed === content.trimEnd()) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

function shortBooleanRhs(command: string, operatorStart: number): boolean {
  const rhs = command.slice(operatorStart + 2);
  if (/^[ \t]*\r?\n/.test(rhs)) return false;
  const words = shellCommandWordGroups(rhs)[0];
  if (!words?.length) return false;
  return words.at(-1)!.end - words[0]!.start <= 10;
}

function splitBashOperators(command: string): string {
  let formatted = "";
  let quote: "'" | '"' | "`" | undefined;
  let inComment = false;

  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;

    if (inComment) {
      formatted += character;
      if (character === "\n") inComment = false;
      continue;
    }

    if (quote) {
      formatted += character;
      if (character === "\\" && quote !== "'" && index + 1 < command.length) {
        formatted += command[++index];
      } else if (character === quote) {
        quote = undefined;
      }
      continue;
    }

    if (character === "\\" && index + 1 < command.length) {
      formatted += character + command[++index];
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      formatted += character;
      continue;
    }
    if (character === "#" && (index === 0 || /[\s;&|()]/.test(command[index - 1]!))) {
      inComment = true;
      formatted += character;
      continue;
    }

    const isPipeline = character === "|" && command[index - 1] !== "|" && command[index + 1] !== "|";
    const isAnd = character === "&" && command[index + 1] === "&";
    const isOr = character === "|" && command[index + 1] === "|";
    if (!isPipeline && !isAnd && !isOr) {
      formatted += character;
      continue;
    }

    const operatorStart = index;
    formatted += character;
    if (isAnd || isOr || command[index + 1] === "&") formatted += command[++index];
    if (isOr && shortBooleanRhs(command, operatorStart)) continue;
    while (command[index + 1] === " " || command[index + 1] === "\t") index++;
    if (command[index + 1] === "\r" && command[index + 2] === "\n") index += 2;
    else if (command[index + 1] === "\n") index++;
    formatted += "\n";
  }

  return formatted;
}

function splitBashOperatorsOutsideHeredocs(command: string): string {
  const heredocs = bashHeredocs(command);
  if (!heredocs.length) return splitBashOperators(command);
  let formatted = "";
  let cursor = 0;
  for (const heredoc of heredocs) {
    formatted += splitBashOperators(command.slice(cursor, heredoc.contentStart));
    formatted += command.slice(heredoc.contentStart, heredoc.contentEnd);
    cursor = heredoc.contentEnd;
  }
  return formatted + splitBashOperators(command.slice(cursor));
}

export function formatBashCommandForDisplay(command: string): string {
  const withSplitOperators = splitBashOperatorsOutsideHeredocs(command);
  try {
    return formatShell(withSplitOperators, "command.sh", {
      indent: 2,
      binaryNextLine: false,
      switchCaseIndent: true,
      spaceRedirects: false,
      funcNextLine: false,
      minify: false,
      singleLine: false,
      simplify: false,
    }).trimEnd();
  } catch {
    return withSplitOperators;
  }
}

function bashBooleanOperatorHtml(highlighted: string): string {
  const protectedSpans: boolean[] = [];
  return highlighted.split(/(<\/?span(?:\s[^>]*)?>)/).map((part) => {
    if (part.startsWith("<span")) {
      protectedSpans.push((protectedSpans.at(-1) ?? false) || /syntax-(?:string|comment)/.test(part));
      return part;
    }
    if (part === "</span>") {
      protectedSpans.pop();
      return part;
    }
    if (protectedSpans.at(-1)) return part;
    return part.replaceAll("&amp;&amp;", '<span class="agent-bash-and">&amp;&amp;</span>').replaceAll("||", '<span class="agent-bash-or">||</span>');
  }).join("");
}

function highlightedBashShell(command: string): string {
  return bashBooleanOperatorHtml(highlightCodeHtmlForPath(command, "command.sh").html);
}

export function highlightedBashCommandHtml(command: string, className = "agent-tool-code"): string {
  return `<pre class="${className} language-bash"><code>${highlightedBashShell(command)}</code></pre>`;
}

interface ShellWord {
  value: string;
  start: number;
  end: number;
  contentStart?: number;
  contentEnd?: number;
}

interface EmbeddedShellLiteral {
  path: string;
  content: string;
  contentStart: number;
  contentEnd: number;
}

interface EmbeddedRegion extends EmbeddedShellLiteral {
  kind: "heredoc" | "shell-literal" | "regex";
}

interface RenderedEmbedded {
  html: string;
  differs: boolean;
}

interface RenderedEmbeddedRegion extends RenderedEmbedded {
  language?: string;
}

const embeddedLanguageDepthLimit = 4;

function staticQuotedWord(command: string, start: number, end: number): ShellWord | undefined {
  const quote = command[start];
  if ((quote !== "'" && quote !== '"') || command[end - 1] !== quote) return undefined;
  const raw = command.slice(start + 1, end - 1);
  if (quote === "'") return { value: raw, start, end, contentStart: start + 1, contentEnd: end - 1 };
  let value = "";
  for (let index = 0; index < raw.length; index++) {
    if (raw[index] === "$" || raw[index] === "`") return undefined;
    if (raw[index] !== "\\") {
      value += raw[index];
      continue;
    }
    const next = raw[index + 1];
    if (next === '"' || next === "\\" || next === "$" || next === "`") {
      value += next;
      index++;
    } else if (next === "\n") {
      index++;
    } else {
      value += "\\";
    }
  }
  return { value, start, end, contentStart: start + 1, contentEnd: end - 1 };
}

function shellCommandWordGroups(command: string): ShellWord[][] {
  const groups: ShellWord[][] = [];
  let words: ShellWord[] = [];
  const finish = (): void => {
    if (words.length) groups.push(words);
    words = [];
  };

  for (let index = 0; index < command.length;) {
    if (command[index] === "#") {
      finish();
      index = command.indexOf("\n", index);
      if (index < 0) break;
      continue;
    }
    if (/\s/.test(command[index]!)) {
      if (command[index] === "\n") finish();
      index++;
      continue;
    }
    if (/[;&|()]/.test(command[index]!)) {
      finish();
      index += command[index + 1] === command[index] ? 2 : 1;
      continue;
    }
    const start = index;
    let quote: "'" | '"' | undefined;
    while (index < command.length) {
      const character = command[index]!;
      if (quote) {
        if (character === "\\" && quote === '"' && index + 1 < command.length) index += 2;
        else {
          index++;
          if (character === quote) quote = undefined;
        }
        continue;
      }
      if (character === "'" || character === '"') {
        quote = character;
        index++;
        continue;
      }
      if (character === "\\" && index + 1 < command.length) {
        index += 2;
        continue;
      }
      if (/\s|[;&|()]/.test(character)) break;
      index++;
    }
    const quoted = staticQuotedWord(command, start, index);
    words.push(quoted ?? { value: command.slice(start, index), start, end: index });
  }
  finish();
  return groups;
}

function optionArgument(words: ShellWord[], switches: (word: string) => boolean): ShellWord | undefined {
  const index = words.findIndex((word, position) => position > 0 && switches(word.value));
  return index >= 0 ? words[index + 1] : undefined;
}

function embeddedLiteralInWords(words: ShellWord[]): EmbeddedShellLiteral | undefined {
  for (let index = 0; index < words.length; index++) {
    const invocation = words.slice(index);
    const executable = invocation[0]?.value.split("/").at(-1);
    let argument: ShellWord | undefined;
    let path: string | undefined;
    if (executable === "bun" || executable === "node") {
      argument = optionArgument(invocation, (word) => word === "-e" || word === "--eval");
      path = executable === "bun" ? "eval.ts" : "eval.js";
    } else if (executable === "python" || executable === "python3") {
      argument = optionArgument(invocation, (word) => word === "-c");
      path = "eval.py";
    } else if (executable === "bash" || executable === "sh") {
      argument = optionArgument(invocation, (word) => /^-[^-]*c/.test(word));
      path = "command.sh";
    } else if (executable === "tmux" && (invocation[1]?.value === "new-session" || invocation[1]?.value === "new")) {
      argument = invocation.at(-1);
      path = "command.sh";
    }
    if (path && argument?.contentStart !== undefined && argument.contentEnd !== undefined) {
      return { path, content: argument.value, contentStart: argument.contentStart, contentEnd: argument.contentEnd };
    }
  }
  return undefined;
}

function embeddedShellLiterals(command: string): EmbeddedShellLiteral[] {
  return shellCommandWordGroups(command).flatMap((words) => {
    const literal = embeddedLiteralInWords(words);
    return literal ? [literal] : [];
  });
}

const ripgrepOptionsWithArguments = new Set([
  "--after-context", "--before-context", "--color", "--colors", "--context", "--dfa-size-limit", "--encoding", "--engine", "--field-context-separator", "--field-match-separator", "--glob", "--iglob", "--max-columns", "--max-count", "--max-depth", "--path-separator", "--pre", "--pre-glob", "--regex-size-limit", "--replace", "--sort", "--sortr", "--threads", "--type", "--type-add", "--type-clear", "--type-not",
  "-A", "-B", "-C", "-E", "-f", "-g", "-j", "-m", "-r", "-t", "-T",
]);

function ripgrepPatterns(words: ShellWord[]): ShellWord[] {
  const executable = words[0]?.value.split("/").at(-1);
  if (executable !== "rg" && executable !== "ripgrep") return [];

  const explicit: ShellWord[] = [];
  let positional: ShellWord | undefined;
  for (let index = 1; index < words.length; index++) {
    const word = words[index]!;
    if (word.value === "-e" || word.value === "--regexp") {
      if (words[index + 1]) explicit.push(words[++index]!);
    } else if (!positional && word.value === "--") {
      positional = words[++index];
    } else if (!positional && ripgrepOptionsWithArguments.has(word.value)) {
      index++;
    } else if (!positional && !word.value.startsWith("-")) {
      positional = word;
    }
  }
  return explicit.length ? explicit : positional ? [positional] : [];
}

function ripgrepRegexLiterals(command: string): EmbeddedShellLiteral[] {
  return shellCommandWordGroups(command).flatMap(ripgrepPatterns).flatMap((pattern) => {
    if (pattern.contentStart === undefined || pattern.contentEnd === undefined) return [];
    if (command.slice(pattern.contentStart, pattern.contentEnd) !== pattern.value) return [];
    return [{ path: "pattern.regex", content: pattern.value, contentStart: pattern.contentStart, contentEnd: pattern.contentEnd }];
  });
}

function embeddedRegions(command: string, depth: number): EmbeddedRegion[] {
  const heredocs: EmbeddedRegion[] = bashHeredocs(command).map((heredoc) => ({
    ...heredoc,
    content: command.slice(heredoc.contentStart, heredoc.contentEnd),
    kind: "heredoc",
  }));
  const shellLiterals = depth >= embeddedLanguageDepthLimit ? [] : embeddedShellLiterals(command);
  const quoted: EmbeddedRegion[] = [
    ...shellLiterals.map((literal) => ({ ...literal, kind: "shell-literal" as const })),
    ...ripgrepRegexLiterals(command).map((literal) => ({ ...literal, kind: "regex" as const })),
  ].filter((literal) => !heredocs.some((heredoc) => literal.contentStart >= heredoc.contentStart && literal.contentEnd <= heredoc.contentEnd));
  return [...heredocs, ...quoted].sort((left, right) => left.contentStart - right.contentStart);
}

function renderEmbeddedRegion(region: EmbeddedRegion, depth: number): RenderedEmbeddedRegion {
  const formatted = region.path === "command.sh" ? formatBashCommandForDisplay(region.content) : displayFormattedFile(region.content, region.path);
  const displayed = formatted ?? region.content;
  const formatDiffers = formatted !== undefined && formatted !== region.content;
  if (region.path === "command.sh") {
    const nested = embeddedBashContent(displayed, depth + 1);
    return { html: nested?.html ?? highlightedBashShell(displayed), language: "bash", differs: region.kind === "shell-literal" || formatDiffers || (nested?.differs ?? false) };
  }
  const highlighted = highlightCodeHtmlForPath(displayed, region.path);
  return { html: highlighted.html, language: highlighted.language ?? languageFromPath(region.path), differs: region.kind === "shell-literal" || formatDiffers };
}

function embeddedBashContent(command: string, depth: number): RenderedEmbedded | undefined {
  const regions = embeddedRegions(command, depth);
  if (!regions.length) return undefined;

  let html = "";
  let cursor = 0;
  let differs = false;
  for (const region of regions) {
    const quoted = region.kind !== "heredoc";
    const regionStart = quoted ? region.contentStart - 1 : region.contentStart;
    const regionEnd = quoted ? region.contentEnd + 1 : region.contentEnd;
    if (regionStart < cursor) continue;
    html += highlightedBashShell(command.slice(cursor, regionStart));
    if (quoted) html += `<span class="syntax-string">${escapeHtml(command[regionStart]!)}</span>`;
    const rendered = renderEmbeddedRegion(region, depth);
    differs ||= rendered.differs;
    html += `<span${rendered.language ? ` class="language-${escapeHtml(rendered.language)}"` : ""}>${rendered.html}</span>`;
    if (quoted) html += `<span class="syntax-string">${escapeHtml(command[region.contentEnd]!)}</span>`;
    cursor = regionEnd;
  }
  html += highlightedBashShell(command.slice(cursor));
  return { html, differs };
}

export function embeddedBashCommand(command: string, formattedCommand?: string, className = "agent-tool-code"): RenderedEmbedded | undefined {
  formattedCommand ??= formatBashCommandForDisplay(command);
  const rendered = embeddedBashContent(formattedCommand, 0);
  if (!rendered) return undefined;
  return { html: `<pre class="${className} language-bash"><code>${rendered.html}</code></pre>`, differs: rendered.differs };
}

const codemodeOptionsLine = /^\/\/ @options:[^\n]*\n/;
const javascriptSyntax = new Bun.Transpiler({ loader: "js" });
/**
 * An async function body with top-level `await` and `return`, readably formatted inside a function and taken out
 * again. Undefined when it does not parse, for example while it streams in.
 */
function formatAsyncBodyForDisplay(body: string): string | undefined {
  const wrapped = `async function body() {\n${body}\n}`;
  try {
    javascriptSyntax.transformSync(wrapped);
  } catch {
    return undefined;
  }
  const formatted = formatJavaScript(wrapped, "script.js", { indentStyle: "space", indentWidth: 2 }).trimEnd();
  const lines = formatted.split("\n");
  const inLiteral = javascriptLinesStartingInLiterals(formatted);
  return lines.slice(1, -1).map((line, index) => inLiteral[index + 1] ? line : line.replace(/^ {2}/, "")).join("\n");
}

export function formatCodemodeScriptForDisplay(code: string): string | undefined {
  const optionsLine = code.match(codemodeOptionsLine)?.[0] ?? "";
  const inner = formatAsyncBodyForDisplay(code.slice(optionsLine.length));
  if (inner === undefined) return undefined;
  const result = `${optionsLine}${inner}`;
  return result === code.trimEnd() ? undefined : result;
}

export function formatWorkflowScriptForDisplay(code: string): string | undefined {
  const inner = formatAsyncBodyForDisplay(code.replace(/^export (?=const meta\b)/m, ""));
  if (inner === undefined) return undefined;
  const result = inner.replace(/^const meta\b/m, "export const meta");
  return result === code.trimEnd() ? undefined : result;
}
