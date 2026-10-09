import { AgentsInTheCloudCoreError } from "@agents-in-the-cloud/core";
import { jsonResponse } from "@agents-in-the-cloud/shared/http";

export function httpErrorStatus(error: Error): number {
  return error instanceof AgentsInTheCloudCoreError && ["invalid_arguments", "invalid_git_url", "terminal_invalid_cwd", "invalid_ssh_private_key"].includes(error.code) ? 400
    : error instanceof AgentsInTheCloudCoreError && ["repo_not_found", "workspace_template_not_found", "workspace_template_environment_variable_not_found", "workspace_template_secret_not_found", "workspace_template_ssh_key_not_found", "workspace_not_found", "command_not_found", "agent_not_found", "view_not_found", "terminal_not_found"].includes(error.code) ? 404
      : error instanceof AgentsInTheCloudCoreError && ["agent_setup_required", "last_agent", "workspace_not_ready", "workspace_template_secret_routing_changed", "workspace_template_settings_conflict"].includes(error.code) ? 409
        : 500;
}

export function problemJsonResponse(error: Error): Response {
  const status = httpErrorStatus(error);
  const code = error instanceof AgentsInTheCloudCoreError ? error.code : "internal_error";
  const details = error instanceof AgentsInTheCloudCoreError ? error.details : undefined;
  return jsonResponse({ error: { code, message: error.message, ...(details ?? {}) } }, { status });
}
