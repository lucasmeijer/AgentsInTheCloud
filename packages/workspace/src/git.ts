import { execWorkspaceCommandBuffer } from "./index.ts";
import { createWorkspaceRepository, type Repository } from "./git-repository.ts";

export { parseGitStatus, parseGitNumstat } from "./git-output.ts";
export type { GitStatusEntry, GitNumstat } from "./git-output.ts";
export { git, repositoryPaths, readRepositoryBlob } from "./git-repository.ts";
export type { Repository, RepositoryContent, WorkingFileRevision } from "./git-repository.ts";

/** Repository operations execute only inside the workspace, as its regular user.
 * Reuse an instance and issue independent operations together to share one exec.
 */
export function workspaceRepository(workspaceId: string, relativePath = ""): Repository {
  return createWorkspaceRepository(workspaceId, relativePath, execWorkspaceCommandBuffer);
}
