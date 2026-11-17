import { escapeHtml, isCommitHash, shortCommit, type CommitLinkTarget } from "@agents-in-the-cloud/shared";
import { git, type Repository } from "@agents-in-the-cloud/workspace/git";
import { refreshChanges } from "./refresh.ts";
import { captureChanges, captureHistory, loadHistoryThrough, stagedChanges, workingTree, type ChangesHistory, type ChangesSnapshot, type DiffEndpoints } from "./snapshot.ts";

class CommitLinkError extends Error {}

async function commitId(root: Repository, hash: string): Promise<string | undefined> {
  return (await git(root, ["rev-parse", "--verify", "--quiet", `${hash}^{commit}`], true)).toString().trim() || undefined;
}

async function snapshotId(root: Repository, history: ChangesHistory, endpoint: string): Promise<string> {
  if (endpoint === "working") return workingTree;
  if (endpoint === "staged") {
    if (history.hasStaged) return stagedChanges;
    if (!history.head) throw new CommitLinkError("Nothing is staged right now.");
    return history.head;
  }
  const id = await commitId(root, endpoint);
  if (!id) throw new CommitLinkError(`Commit ${shortCommit(endpoint)} isn’t in this repository.`);
  if (!history.topology.some(commit => commit.id === id)) throw new CommitLinkError(`Commit ${shortCommit(endpoint)} isn’t on any local branch.`);
  return id;
}

async function linkEndpoints(root: Repository, history: ChangesHistory, link: CommitLinkTarget): Promise<DiffEndpoints> {
  const [base, target] = await Promise.all([link.base && snapshotId(root, history, link.base), snapshotId(root, history, link.target)]);
  const endpoints: DiffEndpoints = base !== undefined ? { base, target } : isCommitHash(link.target) ? { target } : { target, base: history.head ?? null };
  if (endpoints.base === target) throw new CommitLinkError(link.base === "staged" || link.target === "staged" ? "Nothing is staged right now." : "Both ends of this link are the same commit.");
  return endpoints;
}

export async function openCommitLink(root: Repository, previous: ChangesSnapshot, link: CommitLinkTarget): Promise<ChangesSnapshot> {
  const history = await captureHistory(root);
  try {
    const endpoints = await linkEndpoints(root, history, link);
    await loadHistoryThrough(root, history, [endpoints.target, endpoints.base]);
    return await captureChanges(root, endpoints, history);
  } catch (error) {
    if (!(error instanceof CommitLinkError)) throw error;
    const snapshot = await refreshChanges(root, previous);
    snapshot.notice = error.message;
    return snapshot;
  }
}

export async function commitLinkLabel(root: Repository, link: CommitLinkTarget): Promise<string | undefined> {
  if (link.base === undefined) {
    const output = await git(root, ["show", "--no-patch", "--format=%s", `${link.target}^{commit}`, "--"], true);
    return output.length ? escapeHtml(output.toString("utf8").trim()) : undefined;
  }
  const [base, target] = await Promise.all([commitId(root, link.base), commitId(root, link.target)]);
  if (!base || !target) return undefined;
  const count = async (from: string, to: string) => Number((await git(root, ["rev-list", "--count", "--ancestry-path", `${from}..${to}`, "--"])).toString().trim());
  const commits = await count(base, target) || await count(target, base);
  return commits ? `· ${commits} ${commits === 1 ? "commit" : "commits"}` : "";
}
