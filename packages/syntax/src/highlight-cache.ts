import type { HighlightedCode } from "./highlight.ts";

export class HighlightCache {
  private readonly entries = new Map<string, { result: HighlightedCode; size: number }>();
  private retained = 0;

  constructor(private readonly maxCharacters: number, private readonly maxEntries: number) {}

  get(key: string): HighlightedCode | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.result;
  }

  set(key: string, result: HighlightedCode): void {
    const size = key.length + result.html.length;
    const previous = this.entries.get(key);
    if (previous) {
      this.retained -= previous.size;
      this.entries.delete(key);
    }
    if (size > this.maxCharacters) return;
    this.entries.set(key, { result, size });
    this.retained += size;
    while (this.retained > this.maxCharacters || this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value!;
      this.retained -= this.entries.get(oldest)!.size;
      this.entries.delete(oldest);
    }
  }
}
