export interface GitStatusEntry {
  code: string;
  path: string;
  previousPath?: string;
}

export function parseGitStatus(output: Buffer): GitStatusEntry[] {
  const fields = output.toString("utf8").split("\0");
  const entries: GitStatusEntry[] = [];
  for (let index = 0; index < fields.length;) {
    const field = fields[index++];
    if (!field) continue;
    const code = field.slice(0, 2);
    const path = field.slice(3);
    if (code.includes("R") || code.includes("C")) {
      const previousPath = fields[index++];
      const entry: GitStatusEntry = { code, path };
      if (previousPath) entry.previousPath = previousPath;
      entries.push(entry);
    } else {
      entries.push({ code, path });
    }
  }
  return entries;
}

export interface GitNumstat { additions: number; deletions: number; binary?: true }

export function parseGitNumstat(output: Buffer): Map<string, GitNumstat> {
  const fields = output.toString("utf8").split("\0");
  const stats = new Map<string, GitNumstat>();
  for (let index = 0; index < fields.length;) {
    const field = fields[index++];
    if (!field) continue;
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(field);
    if (!match) throw new Error("Invalid Git numstat response");
    const [, additionsValue, deletionsValue, pathValue] = match;
    let path = pathValue!;
    if (!path) {
      index += 1;
      path = fields[index++]!;
      if (!path) throw new Error("Missing renamed path in Git numstat response");
    }
    const counts: GitNumstat = {
      additions: additionsValue === "-" ? 0 : Number(additionsValue),
      deletions: deletionsValue === "-" ? 0 : Number(deletionsValue),
    };
    if (additionsValue === "-") counts.binary = true;
    stats.set(path, counts);
  }
  return stats;
}

