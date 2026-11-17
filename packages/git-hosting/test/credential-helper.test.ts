import { describe, expect, test } from "bun:test";
import { gitCredentialHelperShellBody, gitHostingShorthandUrl } from "../src/index.ts";

async function runCredentialHelper(input: string, env: Record<string, string> = { GH_TOKEN: "github-secret", GITLAB_TOKEN: "gitlab-secret", BITBUCKET_API_TOKEN: "bitbucket-secret" }): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", gitCredentialHelperShellBody, "agents-in-the-cloud-git-credential", "get"], {
    env: { PATH: process.env.PATH ?? "", ...env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(input);
  proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}

describe("git credential helper", () => {
  test("offers each token only to its own HTTPS host", async () => {
    expect(await runCredentialHelper("protocol=https\nhost=github.com\n\n")).toBe("username=x-access-token\npassword=github-secret\n");
    expect(await runCredentialHelper("protocol=https\nhost=github.com:443\n\n")).toBe("username=x-access-token\npassword=github-secret\n");
    expect(await runCredentialHelper("protocol=https\nhost=gitlab.com\n\n")).toBe("username=oauth2\npassword=gitlab-secret\n");
    expect(await runCredentialHelper("protocol=https\nhost=bitbucket.org\n\n")).toBe("username=x-bitbucket-api-token-auth\npassword=bitbucket-secret\n");
    expect(await runCredentialHelper("protocol=https\nhost=example.com\n\n")).toBe("");
    expect(await runCredentialHelper("protocol=https\nhost=gitlab.com.evil.test\n\n")).toBe("");
    expect(await runCredentialHelper("protocol=ssh\nhost=github.com\n\n")).toBe("");
  });

  test("stays quiet for hosts whose provider is not connected", async () => {
    expect(await runCredentialHelper("protocol=https\nhost=gitlab.com\n\n", { GH_TOKEN: "github-secret" })).toBe("");
  });

  test("ignores store and erase requests", async () => {
    const proc = Bun.spawn(["sh", "-c", gitCredentialHelperShellBody, "agents-in-the-cloud-git-credential", "store"], { env: { GH_TOKEN: "github-secret" }, stdin: new Blob(["protocol=https\nhost=github.com\n\n"]), stdout: "pipe" });
    expect(await new Response(proc.stdout).text()).toBe("");
    expect(await proc.exited).toBe(0);
  });
});

test("expands provider shorthand to HTTPS URLs", () => {
  expect(gitHostingShorthandUrl("github.com/org/repo")).toBe("https://github.com/org/repo");
  expect(gitHostingShorthandUrl("GitLab.com/group/sub/project")).toBe("https://GitLab.com/group/sub/project");
  expect(gitHostingShorthandUrl("bitbucket.org/workspace/repo#main")).toBe("https://bitbucket.org/workspace/repo#main");
  expect(gitHostingShorthandUrl("example.com/org/repo")).toBeUndefined();
});
