// Renders a triage report.json into a self-contained report.html (and report.md).
// Usage: bun .agents/skills/feedback-triage/render.ts <path/to/report.json>
//
// The page uses AgentsInTheCloud's own design system (inlined CSS, Disclosure rows)
// and Pierre diffs rendered server-side. Images and videos are inlined as data: URIs.
import MarkdownIt from "../../../packages/markdown/node_modules/markdown-it/index.mjs";
import { disclosureHtml } from "../../../packages/design-system/src/disclosure/disclosure-html.ts";
import { inlineDesignSystemCss } from "../../../packages/design-system/src/inline-styles.ts";
import { buttonHtml } from "../../../packages/design-system/src/button/button-html.ts";
import { renderMarkdownDiff } from "../../../packages/syntax/src/markdown-diff.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

// ---- The report contract. Every string marked (md) is Markdown; everything else is plain text. ----

export interface Report {
  source: { url: string; label: string };              // e.g. "GitHub issue #37"
  reporter: { name: string; avatarUrl: string };       // name/login + avatar only
  classification:
    | { type: "bug"; reproduced: boolean }
    | { type: "feature"; inSpirit: "yes" | "partly" | "no"; designHeavy: "no" | "some" | "yes" }
    | { type: "docs" }
    | { type: "noise" };
  /** First person, in the reporter's voice: "I want to …". One or two sentences. */
  goal: string;
  /** First person, what the reporter suggested: "I suggested …". One sentence. Omit if they didn't. */
  proposal?: string;
  recommendation: {
    action: string;                                   // short: "Merge the smaller version"
    confidence: "high" | "medium" | "low";
    why: string;                                      // (md) one or two sentences
  };
  /** Each change pushed to a branch for evaluation. Rendered as one collapsible row each. */
  experiments: Array<{
    title: string;                                    // "Allow exact private hosts per template"
    branch: string;                                   // "triage/gh-37"
    confidence: "high" | "medium" | "low";
    /** (md) What it does, how it was verified, what couldn't be shown. Media go here:
     *  ![alt](media/x.png), <video src="media/x.webm" controls></video>. Keep it short. */
    body: string;
    /** Files whose diff (main...branch) is rendered with Pierre. Omit to show every changed file. */
    diffPaths?: string[];
  }>;
  claims: Array<{ claim: string; verdict: "true" | "false" | "partly" | "unverified"; evidence: string /* (md) */ }>;
  openQuestions?: Array<{ question: string; recommendation: string /* (md) */ }>;
  /** (md) Investigation notes, dead ends, alternatives. Collapsed. */
  notes?: string;
  /** One reply per realistic decision, ready to paste. */
  replies: Array<{ decision: string /* "If you merge it" */; text: string /* (md) */ }>;
  /** Plain sentence(s): what you could not verify or show. */
  unverified?: string;
}

const reportPath = process.argv[2];
if (!reportPath) throw new Error("usage: render.ts <report.json>");
const baseDir = dirname(resolve(reportPath));
const report = JSON.parse(readFileSync(reportPath, "utf8")) as Report;

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const md = new MarkdownIt({ html: true, linkify: true });
md.linkify.set({ fuzzyLink: false });
md.renderer.rules.fence = (tokens, i) => {
  const token = tokens[i]!;
  const lang = token.info.trim().split(/\s+/)[0];
  if (lang === "diff") return `<div class="markdown-diff">${pierre(renderMarkdownDiff(token.content.replace(/\n$/, "")))}</div>`;
  return `<pre><code>${esc(token.content)}</code></pre>`;
};
md.renderer.rules.table_open = () => '<div class="table-scroll"><table>';
md.renderer.rules.table_close = () => "</table></div>";
const mdHtml = (s: string) => `<div class="markdown">${md.render(s)}</div>`;
const mdInline = (s: string) => md.renderInline(s);

// The app mounts Pierre's shadow DOM with a Stimulus controller; a static page uses declarative shadow DOM.
const pierre = (html: string) =>
  html.replaceAll('<diffs-container data-controller="markdown-diff"><template data-markdown-diff-content>', '<diffs-container><template shadowrootmode="open">');

function branchDiff(branch: string, paths?: string[]): string {
  const result = Bun.spawnSync(["git", "diff", "--no-color", `main...${branch}`, "--", ...(paths ?? [])]);
  if (result.exitCode !== 0) throw new Error(`git diff main...${branch} failed: ${result.stderr.toString()}`);
  const patch = result.stdout.toString().replace(/\n$/, "");
  if (!patch) throw new Error(`git diff main...${branch} is empty`);
  return `<div class="markdown-diff">${pierre(renderMarkdownDiff(patch))}</div>`;
}

const LABEL = { high: "High", medium: "Medium", low: "Low" } as const;
const VERDICT = { true: "✅", false: "❌", partly: "⚠️", unverified: "❓" } as const;
const repoUrl = report.source.url.match(/^https:\/\/github\.com\/[^/]+\/[^/]+/)?.[0];

function chips(): string[] {
  const c = report.classification;
  const list: string[] = [];
  if (c.type === "bug") list.push("🐛 Bug", c.reproduced ? "Reproduced" : "Not reproduced");
  if (c.type === "feature") list.push("✨ Feature", `In spirit: ${c.inSpirit}`, `Design-heavy: ${c.designHeavy}`);
  if (c.type === "docs") list.push("📖 Docs gap");
  if (c.type === "noise") list.push("💬 Noise");
  return list;
}

const disclosure = (label: string, description: string | undefined, bodyHtml: string, trailing?: string) =>
  disclosureHtml({
    summary: description
      ? { kind: "multiline", width: "fill", label: { kind: "text", text: label }, description, trailingHtml: trailing }
      : { kind: "compact", width: "fill", label: { kind: "text", text: label }, trailingHtml: trailing },
    bodyHtml,
  });

const copyButton = (caption: string, attributes: string) =>
  buttonHtml({ type: "button", variant: "secondary", content: { kind: "caption", caption }, attributesHtml: attributes });

const r = report;

// Prompts for follow-up agents in other workspaces. They can't see this page, so each is self-contained.
type Experiment = Report["experiments"][number];
const playPrompt = (e: Experiment) => `Fetch and check out the branch \`${e.branch}\` from origin. It's a triage prototype ("${e.title}") for ${r.source.url}. The user's goal: "${r.goal}"

Read the branch's commits (\`git log main..${e.branch}\`, \`git diff main...${e.branch}\`) to understand the change. If it's behind origin/main, rebase it locally. Then run AgentsInTheCloud with \`bun run web\`, stage it (see docs/automation.md) so the change can be tried right away, and present it to me in the preview browser. Don't push anything; I want to play around with it myself first.`;
const mergePrompt = (e: Experiment) => `Land the branch \`${e.branch}\` on main. It's a triage change ("${e.title}") for ${r.source.url}.

1. \`git fetch origin\`, check out \`${e.branch}\`, and rebase it onto origin/main. Resolve conflicts if needed.
2. Review the diff against main. Remove anything that was only scaffolding for the triage and doesn't belong in the product.
3. Run \`bun run check\` and the relevant tests, and fix any failures.
4. Fast-forward main to the branch and push main to origin. Mention ${r.source.url} in the last commit's message.
5. Delete \`${e.branch}\` locally and on origin.

Stop and ask me before pushing if anything in steps 1–3 needed judgement calls.`;
const promptButtons = (e: Experiment) => `<div class="prompts">${copyButton("Copy prompt: play with it", `data-copy="${esc(playPrompt(e))}"`)}${copyButton("Copy prompt: merge to main", `data-copy="${esc(mergePrompt(e))}"`)}</div>`;
const claimCounts = (["true", "false", "partly", "unverified"] as const)
  .map((v) => [v, r.claims.filter((c) => c.verdict === v).length] as const)
  .filter(([, n]) => n).map(([v, n]) => `${VERDICT[v]} ${n}`).join("  ");

const body = `
<header class="reporter">
  <img class="avatar" src="${esc(r.reporter.avatarUrl)}" alt="">
  <span class="name">${esc(r.reporter.name)}</span>
  <a class="source" href="${esc(r.source.url)}">${esc(r.source.label)}</a>
  <span class="copy-md">${copyButton("Copy as Markdown", "data-copy-markdown")}</span>
</header>

<blockquote class="goal">
  <p class="goal-text">“${esc(r.goal)}”</p>
  ${r.proposal ? `<p class="proposal">“${esc(r.proposal)}”</p>` : ""}
</blockquote>

<div class="chips">${chips().map((c) => `<span class="chip">${esc(c)}</span>`).join("")}</div>

<section class="recommendation">
  <div class="rec-line"><span class="rec-action">${esc(r.recommendation.action)}</span><span class="confidence confidence--${r.recommendation.confidence}">${LABEL[r.recommendation.confidence]} confidence</span></div>
  <div class="markdown rec-why">${mdInline(r.recommendation.why)}</div>
  ${r.unverified ? `<p class="unverified">Not verified: ${esc(r.unverified)}</p>` : ""}
</section>

<section class="rows">
${r.experiments.map((e) => disclosure(
  e.title,
  `${e.branch} · ${LABEL[e.confidence]} confidence`,
  `${repoUrl ? `<p class="branch-link"><a href="${repoUrl}/compare/main...${esc(e.branch)}">Compare ${esc(e.branch)} on GitHub</a></p>` : ""}${promptButtons(e)}${mdHtml(e.body)}${branchDiff(e.branch, e.diffPaths)}`,
)).join("\n")}
${r.openQuestions?.length ? disclosure("Open design questions", undefined,
  `<ol class="markdown">${r.openQuestions.map((q) => `<li><strong>${esc(q.question)}</strong><br>➡️ ${mdInline(q.recommendation)}</li>`).join("")}</ol>`,
  `<span class="count">${r.openQuestions.length}</span>`) : ""}
${disclosure("Claims checked", undefined,
  `<div class="markdown"><div class="table-scroll"><table><thead><tr><th></th><th>Claim</th><th>Evidence</th></tr></thead><tbody>${r.claims.map((c) => `<tr><td>${VERDICT[c.verdict]}</td><td>${esc(c.claim)}</td><td>${mdInline(c.evidence)}</td></tr>`).join("")}</tbody></table></div></div>`,
  `<span class="count">${claimCounts}</span>`)}
${r.notes ? disclosure("Investigation notes", undefined, mdHtml(r.notes)) : ""}
</section>

<h2 class="section-title">Draft replies</h2>
<section class="rows">
${r.replies.map((reply) => disclosure(reply.decision, undefined, `${mdHtml(reply.text)}<div>${copyButton("Copy reply", `data-copy="${esc(reply.text)}"`)}</div>`)).join("\n")}
</section>
`;

// ---- Markdown export (the "Copy as Markdown" button) ----
const markdown = [
  `**${r.reporter.name}** · [${r.source.label}](${r.source.url})`,
  `> “${r.goal}”${r.proposal ? `\n>\n> “${r.proposal}”` : ""}`,
  chips().join(" · "),
  `**${r.recommendation.action}** (${r.recommendation.confidence} confidence): ${r.recommendation.why}`,
  r.unverified ? `_Not verified: ${r.unverified}_` : "",
  ...r.experiments.map((e) => `### ${e.title}\n\`${e.branch}\` · ${e.confidence} confidence${repoUrl ? ` · [compare](${repoUrl}/compare/main...${e.branch})` : ""}\n\n${e.body}\n\n<details><summary>Prompt: play with it</summary>\n\n\`\`\`text\n${playPrompt(e)}\n\`\`\`\n\n</details>\n\n<details><summary>Prompt: merge to main</summary>\n\n\`\`\`text\n${mergePrompt(e)}\n\`\`\`\n\n</details>`),
  r.openQuestions?.length ? `### Open design questions\n\n${r.openQuestions.map((q, i) => `${i + 1}. **${q.question}**\n   ➡️ ${q.recommendation}`).join("\n")}` : "",
  `### Claims checked\n\n| | Claim | Evidence |\n|---|---|---|\n${r.claims.map((c) => `| ${VERDICT[c.verdict]} | ${c.claim} | ${c.evidence} |`).join("\n")}`,
  r.notes ? `### Investigation notes\n\n${r.notes}` : "",
  `### Draft replies\n\n${r.replies.map((x) => `**${x.decision}**\n\n${x.text}`).join("\n\n")}`,
].filter(Boolean).join("\n\n");

// ---- Inline media ----
const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".webm": "video/webm", ".mp4": "video/mp4",
};
async function inline(src: string): Promise<string> {
  if (src.startsWith("data:")) return src;
  if (/^https?:\/\//.test(src)) {
    const res = await fetch(src);
    if (!res.ok) throw new Error(`fetch ${src}: ${res.status}`);
    return `data:${res.headers.get("content-type")};base64,${Buffer.from(await res.arrayBuffer()).toString("base64")}`;
  }
  const file = resolve(baseDir, decodeURI(src));
  const type = MIME[extname(file).toLowerCase()];
  if (!type) throw new Error(`unknown media type for ${src}`);
  return `data:${type};base64,${readFileSync(file).toString("base64")}`;
}
let page = body;
for (const m of [...body.matchAll(/(<(?:img|video|source)\b[^>]*?\bsrc=")([^"]+)(")/g)]) {
  page = page.replace(m[0], m[1] + (await inline(m[2].replaceAll("&amp;", "&"))) + m[3]);
}

const designSystemCss = await inlineDesignSystemCss();
const template = readFileSync(new URL("./template.html", import.meta.url), "utf8");
const html = template
  .replace("{{design-system-css}}", () => designSystemCss)
  .replace("{{template-css}}", () => readFileSync(new URL("./template.css", import.meta.url), "utf8"))
  .replace("{{title}}", () => esc(`${r.source.label} · ${r.recommendation.action}`))
  .replace("{{body}}", () => page)
  .replace("{{markdown-json}}", () => JSON.stringify(markdown).replace(/</g, "\\u003c"));

writeFileSync(resolve(baseDir, "report.md"), markdown + "\n");
writeFileSync(resolve(baseDir, "report.html"), html);
console.log(resolve(baseDir, "report.html"));
