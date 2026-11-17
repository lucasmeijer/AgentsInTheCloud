import { collectChangesStats, type ChangesFileSummary } from "./diff.ts";
import { git, parseGitNumstat, type Repository } from "@agents-in-the-cloud/workspace/git";
import type { ChangesNodeStats } from "../history.ts";

function totals(stats: ReturnType<typeof parseGitNumstat>): ChangesNodeStats {
  const totals = { files: stats.size, additions: 0, deletions: 0 };
  for (const file of stats.values()) {
    totals.additions += file.additions;
    totals.deletions += file.deletions;
  }
  return totals;
}

export async function captureSyntheticStats(root: Repository, headTree: string, indexTree: string, files: ChangesFileSummary[]): Promise<{ staged: ChangesNodeStats; working: ChangesNodeStats }> {
  const [staged, working, untracked] = await Promise.all([
    git(root, ["diff", "--numstat", "-z", "-M", headTree, indexTree, "--"]),
    git(root, ["diff", "--numstat", "-z", "-M", indexTree, "--"]),
    collectChangesStats(root, { phase: "ready", files: files.filter(file => file.untracked) }),
  ]);
  const workingStats = parseGitNumstat(working);
  const captured = totals(workingStats);
  for (const file of untracked) {
    if (workingStats.has(file.path)) continue;
    captured.files++;
    captured.additions += file.additions;
    captured.deletions += file.deletions;
  }
  return { staged: totals(parseGitNumstat(staged)), working: captured };
}
