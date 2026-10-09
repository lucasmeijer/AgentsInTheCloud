import { actionLinkHtml } from "@agents-in-the-cloud/design-system/action-link";
import { contentRowHtml } from "@agents-in-the-cloud/design-system/content-row";
import { disclosureHtml, type DisclosureSummary } from "@agents-in-the-cloud/design-system/disclosure";
import { buttonHtml } from "@agents-in-the-cloud/design-system/button";
import { dialogHtml } from "@agents-in-the-cloud/design-system/dialog";
import { Icons } from "@agents-in-the-cloud/design-system/icons";
import { escapeHtml } from "@agents-in-the-cloud/shared";
import { agentPath } from "@agents-in-the-cloud/agent/server/render-context";
import type { CodexCommandResult } from "./commands.ts";
import type { CodexRuntime } from "./runtime.ts";
import { renderContext } from "./render.ts";

export function renderCommandDialog(runtime: CodexRuntime, result: Exclude<CodexCommandResult, { kind: "done" }>): string {
  const action = agentPath(renderContext(runtime), "/commands");
  const form = (command: string, content: string, extra = "") => `<form class="form-section" method="post" action="${escapeHtml(action)}"><input type="hidden" name="text" value="${escapeHtml(command)}">${extra}${content}</form>`;
  const button = (caption: string, disabled = false) => buttonHtml({ type: "submit", variant: "secondary", disabled, content: { kind: "caption", caption } });
  const row = (label: string, description: string, actions = "") => `<div class="managed-list__item"><div class="managed-list__content"><div class="managed-list__label">${escapeHtml(label)}</div><div class="managed-list__description" title="${escapeHtml(description)}">${escapeHtml(description)}</div></div>${actions ? `<div class="managed-list__actions">${actions}</div>` : ""}</div>`;
  const summary = (label: string, description: string): DisclosureSummary => ({ kind: "multiline", label: { kind: "text", text: label }, description });
  const list = (rows: string[], empty: string) => rows.length ? `<div class="managed-list" data-controller="managed-list"><div class="managed-list__items">${rows.join("")}</div></div>` : `<p>${escapeHtml(empty)}</p>`;
  const errors = (entries: readonly { path: string; message: string }[]) => entries.map(error => `<p role="alert">${escapeHtml(error.path)}: ${escapeHtml(error.message)}</p>`).join("");
  let title: string;
  let body: string;
  switch (result.kind) {
    case "review":
      title = "Review with Codex";
      body = form("/review changes", button("Review uncommitted changes"))
        + form("/review branch", `<label>Base branch<input class="text-field" name="argument" required placeholder="main"></label>${button("Review against branch")}`)
        + form("/review commit", `<label>Commit SHA<input class="text-field" name="argument" required></label>${button("Review commit")}`)
        + form("/review", `<label>Review instructions<textarea class="textarea" name="argument" required rows="3"></textarea></label>${button("Start custom review")}`);
      break;
    case "resume":
      title = "Resume a conversation";
      body = `<p>Saved conversations for this Codex agent. Your current conversation stays saved.</p>` + list(result.threads.data.map(thread => form(`/resume ${thread.id}`, contentRowHtml({ kind: "multiline", label: { kind: "text", text: thread.name || thread.preview || thread.id }, description: new Date(thread.updatedAt * 1000).toLocaleString(), element: { tag: "button", attributesHtml: 'type="submit"' } }))), "No saved conversations yet.");
      if (result.threads.nextCursor) body += form("/resume", button("More conversations"), `<input type="hidden" name="cursor" value="${escapeHtml(result.threads.nextCursor)}">`);
      break;
    case "goal": {
      title = "Codex goal";
      const goal = result.goal;
      body = goal ? `<p>${escapeHtml(goal.objective)}</p><p>Status: ${escapeHtml(goal.status)} · ${goal.tokensUsed.toLocaleString()} tokens${goal.tokenBudget === null ? "" : ` of ${goal.tokenBudget.toLocaleString()}`}</p>` : `<p>No goal set for this conversation.</p>`;
      body += form("/goal", `<label>Objective<textarea class="textarea" name="argument" required rows="3">${escapeHtml(goal?.objective ?? "")}</textarea></label>${button(goal ? "Update goal" : "Set goal")}`);
      if (goal) body += form(goal.status === "paused" ? "/goal resume" : "/goal pause", button(goal.status === "paused" ? "Resume goal" : "Pause goal")) + form("/goal clear", button("Clear goal"));
      break;
    }
    case "skills":
      title = "Codex skills";
      body = list(result.skills.data.flatMap(entry => entry.skills.map(skill => {
        const selectedPath = `<input type="hidden" name="skillPath" value="${escapeHtml(skill.path)}">`;
        const actions = form(`/skills ${skill.name}`, button("Use skill", !skill.enabled), selectedPath)
          + form(`/skills ${skill.enabled ? "disable" : "enable"} ${skill.name}`, button(skill.enabled ? "Disable" : "Enable"), selectedPath);
        return row(skill.name, `${skill.enabled ? "" : "Disabled · "}${skill.description}`, actions);
      })), "No skills found.") + errors(result.skills.data.flatMap(entry => entry.errors));
      break;
    case "mcp":
      title = "Codex MCP servers";
      body = result.servers.length ? result.servers.map(server => {
        const tools = Object.entries(server.tools).map(([name, tool]) => row(name, tool!.description ?? ""));
        const overview = summary(server.name, `${server.runtimeStatus ?? "Status unavailable"} · ${Object.keys(server.tools).length} tools · ${server.authStatus}`);
        const details = list(tools, "No tools reported.") + (result.verbose ? `<pre>${escapeHtml(JSON.stringify({ resources: server.resources, resourceTemplates: server.resourceTemplates, capabilities: server.serverCapabilities }, null, 2))}</pre>` : "");
        return disclosureHtml({ summary: overview, open: result.verbose, bodyHtml: `${details}${server.toolsError ? `<p role="alert">${escapeHtml(server.toolsError)}</p>` : ""}` });
      }).join("") : `<p>No MCP servers configured.</p>`;
      break;
    case "hooks":
      title = "Codex hooks";
      body = result.hooks.data.map(entry => list(entry.hooks.map(hook => {
        const detail = hook.handlerType === "command" ? hook.command : hook.handlerType === "mcpTool" ? `${hook.server}/${hook.tool}` : hook.handlerType;
        return disclosureHtml({ summary: summary(hook.eventName, `${hook.enabled ? "Enabled" : "Disabled"} · ${hook.trustStatus} · ${hook.matcher ?? "All matches"}`), bodyHtml: `<p>${escapeHtml(hook.sourcePath)}</p><pre>${escapeHtml(detail)}</pre><p>Timeout: ${String(hook.timeoutSec)} seconds</p>` });
      }), "No hooks configured.") + entry.warnings.map(warning => `<p role="alert">${escapeHtml(warning)}</p>`).join("") + errors(entry.errors)).join("") || "<p>No hooks configured.</p>";
      break;
    case "plugins":
      title = "Codex plugins";
      body = (result.notice ? `<p role="status">${escapeHtml(result.notice)}</p>` : "") + list(result.plugins.marketplaces.flatMap(marketplace => marketplace.plugins.map(plugin => {
        const action = plugin.installed ? form(`/plugins uninstall ${plugin.id}`, button("Uninstall")) : `<p>Installing adds this plugin’s skills and tools to Codex. They may run commands in this workspace.</p>${form(`/plugins install ${plugin.id}`, button("Install", plugin.installPolicy === "NOT_AVAILABLE" || plugin.availability !== "AVAILABLE"))}`;
        return disclosureHtml({ summary: summary(plugin.interface?.displayName ?? plugin.name, `${marketplace.name} · ${plugin.installed ? plugin.enabled ? "Installed and enabled" : "Installed, disabled" : "Not installed"}`), bodyHtml: `<p>${escapeHtml(plugin.interface?.longDescription ?? plugin.interface?.shortDescription ?? "No description provided.")}</p><p>Plugin ID: ${escapeHtml(plugin.id)}</p><p>Availability: ${escapeHtml(plugin.availability)}</p>${action}` });
      })), "No plugins available.") + errors(result.plugins.marketplaceLoadErrors.map(error => ({ path: error.marketplacePath, message: error.message })));
      break;
    case "apps":
      title = "Codex apps";
      body = (result.notice ? `<p role="status">${escapeHtml(result.notice)}</p>` : "") + list(result.apps.map(app => {
        let installLink = "";
        if (app.installUrl) {
          const url = URL.parse(app.installUrl);
          if (url && url.protocol === "https:") installLink = actionLinkHtml({ href: url.href, variant: "secondary", content: { kind: "caption", caption: "Connect" }, attributesHtml: 'target="_blank" rel="noopener noreferrer"' });
        }
        return row(app.name, `${app.isAccessible ? "Connected" : "Not connected"} · ${app.isEnabled ? "Enabled" : "Disabled"}${app.description ? ` · ${app.description}` : ""}`, (app.isAccessible ? "" : installLink) + form(`/apps ${app.isEnabled ? "disable" : "enable"} ${app.id}`, button(app.isEnabled ? "Disable" : "Enable")));
      }), "No apps available for this account.");
      break;
  }
  return dialogHtml({ element: { id: "codex_command_dialog", attributesHtml: "data-dialog-auto-show" }, titleCaption: title, iconHtml: Icons.Code, bodyHtml: `<div class="form-stack">${body}</div>` });
}
