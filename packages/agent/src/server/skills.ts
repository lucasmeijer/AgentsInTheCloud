import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { execWorkspaceCommand, workspaceRoot } from "@agents-in-the-cloud/workspace";
import { escapeHtml } from "@agents-in-the-cloud/shared";
import {
  createSyntheticSourceInfo,
  loadSkills,
  stripFrontmatter,
  type ResourceDiagnostic,
  type Skill,
} from "@earendil-works/pi-coding-agent";

interface WorkspaceSkill extends Skill {
  body: string;
}

interface WorkspaceSkillFile {
  path: string;
  content: string;
}

const skillRoots = [
  `${workspaceRoot}/.agents-in-the-cloud/skills`,
  `${workspaceRoot}/.agents/skills`,
  `${workspaceRoot}/.pi/skills`,
] as const;

function skillRoot(path: string): (typeof skillRoots)[number] {
  const root = skillRoots.find((candidate) => path.startsWith(`${candidate}/`));
  if (!root) throw new Error(`skill is outside a supported root: ${path}`);
  return root;
}

function orderedSkillFiles(files: WorkspaceSkillFile[]): WorkspaceSkillFile[] {
  return [...files].sort((left, right) => {
    const rootOrder = skillRoots.indexOf(skillRoot(left.path)) - skillRoots.indexOf(skillRoot(right.path));
    return rootOrder || left.path.localeCompare(right.path);
  });
}

function workspacePath(snapshotRoot: string, path: string): string {
  const prefix = join(snapshotRoot, workspaceRoot.slice(1));
  if (!path.startsWith(`${prefix}/`)) throw new Error(`skill snapshot path is outside the workspace: ${path}`);
  return path.slice(snapshotRoot.length);
}

function workspaceDiagnostic(snapshotRoot: string, diagnostic: ResourceDiagnostic): ResourceDiagnostic {
  return {
    ...diagnostic,
    path: diagnostic.path ? workspacePath(snapshotRoot, diagnostic.path) : undefined,
    collision: diagnostic.collision ? {
      ...diagnostic.collision,
      winnerPath: workspacePath(snapshotRoot, diagnostic.collision.winnerPath),
      loserPath: workspacePath(snapshotRoot, diagnostic.collision.loserPath),
    } : undefined,
  };
}

export async function workspaceSkillsFromFiles(files: WorkspaceSkillFile[]): Promise<{ skills: WorkspaceSkill[]; diagnostics: ResourceDiagnostic[] }> {
  const contents = new Map(files.map((file) => [file.path, file.content]));
  const snapshotRoot = await mkdtemp(join(tmpdir(), "agents-in-the-cloud-skills-"));
  try {
    const paths: string[] = [];
    for (const file of orderedSkillFiles(files)) {
      const path = join(snapshotRoot, file.path.slice(1));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.content);
      paths.push(path);
    }
    const result = loadSkills({
      cwd: join(snapshotRoot, workspaceRoot.slice(1)),
      agentDir: join(snapshotRoot, "agent"),
      skillPaths: paths,
      includeDefaults: false,
    });
    return {
      skills: result.skills.map((skill) => {
        const filePath = workspacePath(snapshotRoot, skill.filePath);
        const baseDir = posix.dirname(filePath);
        return {
          ...skill,
          body: stripFrontmatter(contents.get(filePath)!).trim(),
          filePath,
          baseDir,
          sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", scope: "project", baseDir }),
        };
      }),
      diagnostics: result.diagnostics.map((diagnostic) => workspaceDiagnostic(snapshotRoot, diagnostic)),
    };
  } finally {
    await rm(snapshotRoot, { recursive: true, force: true });
  }
}

export async function loadWorkspaceSkills(workspaceId: string): Promise<{ skills: WorkspaceSkill[]; diagnostics: ResourceDiagnostic[] }> {
  const script = `set -eu
for root in ${skillRoots.map((root) => `'${root}'`).join(" ")}; do
  test -d "$root" || continue
  find -L "$root" -mindepth 2 -type f -name SKILL.md -not -path '*/node_modules/*' \
    -exec sh -c 'set -eu; for path do printf "%s\\0" "$path"; base64 "$path" | tr -d "\\n"; printf "\\0"; done' sh {} +
done`;
  const result = await execWorkspaceCommand(workspaceId, ["sh", "-c", script], { workdir: workspaceRoot });
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || "could not load workspace skills");
  const fields = result.stdout.split("\0");
  fields.pop();
  if (fields.length % 2 !== 0) throw new Error("invalid workspace skill discovery output");
  const files: WorkspaceSkillFile[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    files.push({ path: fields[index], content: Buffer.from(fields[index + 1], "base64").toString("utf8") });
  }
  return workspaceSkillsFromFiles(files);
}

export async function expandWorkspaceSkillCommand(
  workspaceId: string,
  text: string,
  load: typeof loadWorkspaceSkills = loadWorkspaceSkills,
): Promise<string> {
  const match = text.trim().match(/^\/skill:(\S*)(?:\s+([\s\S]*))?$/);
  if (!match) return text;
  const name = match[1];
  const { skills } = await load(workspaceId);
  const skill = skills.find((candidate) => candidate.name === name);
  if (!skill) throw new Error(`Unknown or invalid workspace skill: ${name || "(missing name)"}`);
  const block = `<skill name="${escapeHtml(skill.name)}" location="${escapeHtml(skill.filePath)}">\nReferences are relative to ${skill.baseDir}.\n\n${skill.body}\n</skill>`;
  const args = match[2]?.trim();
  return args ? `${block}\n\n${args}` : block;
}
