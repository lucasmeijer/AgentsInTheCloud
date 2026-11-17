export function normalizeCarriageReturns(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/^.*\r/gm, "");
}

export const terminalOutputDisplayBytes = 200_000;

export function tailTerminalOutput(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.byteLength <= maxBytes) return text;
  const tail = bytes.subarray(bytes.byteLength - maxBytes).toString();
  return `… output truncated to last ${maxBytes} bytes\n${tail.slice(tail.indexOf("\n") + 1)}`;
}

export function tailTerminalText(text: string, lines = 120): string {
  return text.replaceAll("\r", "").split("\n").slice(-lines).join("\n").trimEnd();
}

function isCsiParameter(code: number): boolean {
  return code >= 0x30 && code <= 0x3f;
}

function isIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x2f;
}

function isFinal(code: number): boolean {
  return code >= 0x30 && code <= 0x7e;
}

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

function consumeCsi(text: string, offset: number): number {
  let index = offset;
  while (index < text.length && isCsiParameter(text.charCodeAt(index))) index++;
  while (index < text.length && isIntermediate(text.charCodeAt(index))) index++;
  return index < text.length && isCsiFinal(text.charCodeAt(index)) ? index + 1 : index;
}

function consumeStringControl(text: string, offset: number): number {
  let index = offset;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x07) return index + 1;
    if (code === 0x9c) return index + 1;
    if (code === 0x1b && text[index + 1] === "\\") return index + 2;
    index++;
  }
  return index;
}

function consumeEscape(text: string, offset: number): number {
  const next = text.charCodeAt(offset + 1);
  if (Number.isNaN(next)) return offset + 1;
  if (next === 0x5b) return consumeCsi(text, offset + 2);
  if (next === 0x5d) return consumeStringControl(text, offset + 2);
  if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) return consumeStringControl(text, offset + 2);

  let index = offset + 1;
  while (index < text.length && isIntermediate(text.charCodeAt(index))) index++;
  return index < text.length && isFinal(text.charCodeAt(index)) ? index + 1 : index;
}

export function stripTerminalControls(text: string): string {
  const normalized = normalizeCarriageReturns(text);
  let output = "";
  for (let index = 0; index < normalized.length;) {
    const code = normalized.charCodeAt(index);
    if (code === 0x1b) {
      index = consumeEscape(normalized, index);
      continue;
    }
    if (code === 0x9b) {
      index = consumeCsi(normalized, index + 1);
      continue;
    }
    if (code === 0x9d || code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
      index = consumeStringControl(normalized, index + 1);
      continue;
    }
    if ((code < 0x20 && normalized[index] !== "\n" && normalized[index] !== "\t") || (code >= 0x80 && code <= 0x9f)) {
      index++;
      continue;
    }
    output += normalized[index];
    index++;
  }
  return output;
}
