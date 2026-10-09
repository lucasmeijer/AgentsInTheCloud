# Automating AgentsInTheCloud

AgentsInTheCloud's web UI operations also provide compact JSON representations for agents and scripts. They are the same operations used by the Turbo UI, not a separate REST implementation.

## Discovery

The authoritative contract for the running instance is:

```http
GET /openapi.json
```

Discover available Agent types with `GET /agent-types`; the response contains `agentTypes` and `defaultAgentTypeId`. Agent summaries identify their implementation with `agentTypeId`.

Inspect it without loading the whole document into context:

```sh
curl -s http://localhost:3000/openapi.json | jq -r '.paths | keys[]'
curl -s http://localhost:3000/openapi.json | jq '.paths["/workspaces/{id}/commands/{commandId}"]'
```

Send these headers for JSON operations:

```http
Accept: application/json
Content-Type: application/json
Origin: http://localhost:3000
```

Mutations and WebSocket upgrades require `Origin` to match the destination's public origin (scheme, hostname, and port). Use `http://localhost:3000` when accessing localhost, or your actual Tailscale URL, such as `https://machine.tailnet.ts.net`. Origins are resolved per request; no allowlist is needed. Missing, foreign, and `null` origins return a plain-text `403` before dispatch. Other application errors use `{ "error": { "code": "...", "message": "..." } }`.

The check uses the request URL's hostname and port, not forwarded-host/public-origin metadata. Only loopback connections may supply `X-Forwarded-Proto` (`http` or `https`) for TLS termination. Nested ingress translates same-origin requests and preserves foreign-origin denials.

This is CSRF protection, not authentication. Keep management unreachable from untrusted containers and untrusted HTML on separate origins or opaque-origin sandboxes. Token-authenticated agent MCP and turn-boundary endpoints retain their separate policy.

## Optional authenticated admin bindings

Admin bindings are a separate JSON-only management API for host-local or LAN automation without Tailscale. They are disabled by default. Every request, including `GET /openapi.json`, requires `Authorization: Bearer <token>`. These listeners do not use browser `Origin` authentication; the existing UI ingress retains its CSRF policy.

### Direct host process

Run the CLI as the **same OS user and with the same data directory as the app**:

```sh
umask 077
# /secure/bindings.json: {"bindings":[{"host":"127.0.0.1","port":3443}]}
bun apps/web/scripts/admin-bindings.ts configure --file /secure/bindings.json
# /secure/token-input.json: {"name":"automation","scopes":["configuration","secrets","workspaces","host:read","security"]}
bun apps/web/scripts/admin-bindings.ts issue --file /secure/token-input.json > /secure/issued-token.json
```

`--data-dir PATH` selects another app data directory. `admin-bindings.json` contains listener configuration and only token hashes, with mode `0600`. `show` lists metadata; `revoke TOKEN_ID` applies to subsequent requests without restarting. The issued bearer secret is returned once: capture it privately, never put it in a URL or commit it. Optional expiry must be a future UTC ISO timestamp such as `2030-01-01T00:00:00Z` or `2030-01-01T00:00:00.000Z`. Other date formats, timezone offsets and impossible dates are rejected.

Direct process loopback listeners may use HTTP. Every non-loopback listener requires TLS. Use a certificate whose SAN matches the hostname/IP clients use, issued by a CA those clients trust. For a private/self-signed CA, use the client's explicit CA trust option (e.g. curl `--cacert`), not disabled certificate verification.

### System installation: nested Docker and TLS

The app container is managed by **System's inner Docker daemon**, not the host daemon. From the installation host, use:

```sh
docker exec agents-in-the-cloud-system docker exec --user 1000:1000 \
  agents-in-the-cloud bun /app/apps/web/scripts/admin-bindings.ts show
```

Place input JSON and TLS files under the app's persisted `/data/app`. On the host, that directory is inside System's `agents-in-the-cloud-system` volume. Commands executed in System can access `/data/app` directly. Files should belong to UID/GID `1000:1000`; use `0700` for the TLS directory and `0600` for the private key and configuration. The CLI refuses a different UID in the managed app container. Listener startup also rejects private keys readable by group/others. Certificate files must be readable by the app; `0600` is suitable. Do not print key contents.

A container binding for either host-only or LAN publication is:

```json
{"bindings":[{"host":"0.0.0.0","port":3443,"tls":{"cert":"/data/app/admin-tls/cert.pem","key":"/data/app/admin-tls/key.pem"}}]}
```

Host-only and LAN publication are separate from that inner binding:

- **Host-only:** `--admin-publish 127.0.0.1:3443:3443`
- **LAN:** `--admin-publish 192.168.1.10:3443:3443` (replace with the host's LAN IP)

Use those repeatable options with the installer **only for `--action install` or `--action update`**. The format is explicit IPv4 `HOST_IP:HOST_PORT:ADMIN_PORT`. Updates preserve existing publications from Docker's persistent `HostConfig.PortBindings`, even if System is stopped. Supply replacement mappings to replace the set, or `--no-admin-publish` to remove all admin publications. Removal and replacement cannot be combined. `open`/`connect` reject publication options rather than silently ignoring them.

Both System publication modes require TLS: the inner listener is non-loopback within **System's** network namespace even when the host publishes only on loopback. This differs from direct-process localhost HTTP. There is no plaintext exception for Docker publication.

**Exposure warning:** Docker publications can bypass host firewall policies such as ufw. Bind to a specific trusted interface and enforce network filtering; do not rely solely on an ordinary host firewall rule. Publishing to `0.0.0.0` covers every host IPv4 interface, possibly including public interfaces, and requires `--allow-admin-all-interfaces`. No admin port is published by default. Reserved UI, supervisor and preview ports cannot be published through this option.

### Restart, certificate renewal and recovery

Binding changes return `restartRequired: true` and apply on the next app startup. An empty bindings array disables the API then. Certificates are read at startup; renewal also requires an app restart. **In System, restart only the inner app**:

```sh
docker exec agents-in-the-cloud-system docker restart --time 30 agents-in-the-cloud
```

This interrupts UI/API connections and in-flight management/provisioning work; it does not replace workspace containers. Check active operations first. Restarting/updating **System** is broader and interrupts running workspaces too. Docker publication changes need System container replacement through installation/update, not merely an app restart. Do not update a live installation to experiment.

Invalid configuration, missing/unreadable TLS files, bad certificates or bind failures disable the admin listener set and produce a local error, while leaving normal UI startup available. Correct configuration through the local CLI and restart the app. If an older/root-owned or corrupt configuration cannot be read, back it up locally without displaying it, correct ownership/mode (`1000:1000`, `0600` in System), or move the corrupt file aside and bootstrap fresh. Fresh configuration invalidates previous tokens. If the app is stopped, start it without usable admin configuration so the UI is available, then use the CLI; the CLI is not an API dependency. Keep local Docker/OS administration available as the recovery path.

### Contracts and permissions

Send `Content-Type: application/json` for all mutations, including `{}` for operations without fields. Unknown fields and invalid nested payloads are rejected before dispatch. `/openapi.json` documents the same runtime body schemas and scopes. UI routes, previews, arbitrary commands, agent prompting and terminal WebSockets are excluded. SSH public-key responses are `{ "publicKey": "..." }`.

| Scope | Operations |
| --- | --- |
| `configuration` | Template creation/update/deletion, environment variables, preload images |
| `secrets` | Template secret creation/update/deletion |
| `workspaces` | List/inspect/create/rename/park/unpark/delete, provisioning recovery, warning dismissal |
| `workspaces:force-delete` | Additional permission for explicit forced deletion; also requires `workspaces` |
| `host:read` | Host availability, bounded diagnostic samples and System status; no terminals or raw supervisor logs |
| `security` | Privileged mode, credential seeding, Dockerfiles, SSH keys/trust, System access mode, admin binding/token management |

Template configuration reads are shared by `configuration`, `secrets`, `security` and `workspaces` tokens and include environment values, never plaintext managed secrets/private keys. Changing an existing configured secret's environment name, placeholder, host destination or path policy requires a nonempty `secretValue` to be supplied again, atomically replacing the value; otherwise the operation returns `409 workspace_template_secret_routing_changed` without altering storage. Annotation-only edits and rotation at the same destination do not require knowledge of the old value. These restrictions also apply to the normal UI's secret edits. A supplied replacement may differ from the old value: this prevents rerouting an unknown existing credential, not authorized replacement of it.

`security` remains administrative power: it can mint any scopes and enable privileged containers. Scope separation does not sandbox repository setup, Dockerfiles or code run during workspace creation. Do not give lifecycle/configuration tokens to parties who must not launch repository code.

Additional operations: `GET/PUT /admin/bindings`, `GET/POST /admin/tokens`, `DELETE /admin/tokens/{tokenId}`, `GET /host/status`, `GET/POST /settings/access`. Token issuance returns `{ token, secret }` once; revocation requires `{}`. System access reads/changes require `security` and return `authUrl` when Tailscale sign-in is needed. Treat that URL as sensitive; open it manually and poll access status to complete login. `host:read` status never returns it or raw logs. Standalone instances return `503` for System-only operations. Diagnostic probes are read-only and bounded, but their output is operationally sensitive.

### Audit and request limits

`admin-audit.jsonl` uses admission/completion records joined by `requestId`. It records token ID, **transportPeer** (the socket peer, possibly Docker's proxy rather than the original client), method, route template and status. Forwarded client headers are never trusted. Payloads, raw URLs, bearer secrets, sign-in URLs and diagnostic output are omitted.

Audit storage is bounded to about 1 MiB plus one 1 MiB `.1` backup; rotation serializes concurrent writes. Rejections are aggregated per status, at most once a minute (suppression counts are included when the next sample is written). Requests are limited to 120/minute per transport peer and 600/minute per process, with a bounded peer map; `429` includes `Retry-After: 60`. A Docker proxy can cause clients to share one peer budget. These are application resource bounds, not protection against network-level denial of service.

If admission logging fails, the API returns `503 audit_unavailable` **without executing the operation**. If completion logging fails after execution, the original response is preserved with `X-Admin-Audit-Warning: completion-record-unavailable` and a local error is reported: do not retry a successful mutation merely because of this warning. Server errors retain their machine-readable code while replacing sensitive diagnostic messages. Mutations accept at most 1 MiB of JSON.

For reproducible integration verification on a development machine with Docker, build local app/System/workspace images, then run `bun scripts/verify-admin-bindings-system.ts --app APP_IMAGE --system SYSTEM_IMAGE --workspace WORKSPACE_IMAGE`. It creates a uniquely named disposable System, tests a separate client container, nested CLI, TLS, real System endpoints, startup isolation and stopped-container port persistence, then removes its containers/volume. It never targets an existing installation. It needs several GiB of free disk for the inner image store. This verifies Docker network access, not reachability or firewall policy from a separate physical LAN machine; verify that deployment-specific boundary separately.

Template environment changes still apply to new containers. Existing secret placeholders resolve to rotated credentials on subsequent proxied requests; existing connections may need reconnecting.

## Present a workspace

Workspace, Agent, and Work-view destinations are browser-navigable surfaces:

```text
/workspaces/:workspaceId
/workspaces/:workspaceId?agent=:agentId
/workspaces/:workspaceId?workView=:key
```

The `agent` and `workView` parameters may be combined to choose both sides of the desktop workspace. Use `GET /workspaces/:workspaceId` with `Accept: application/json` to discover the available Agent IDs and the `key` of each Work view.

## Present workspace template settings

Workspace template settings has a browser-navigable surface that agents can pass directly to their presentation tool:

```text
/workspace-templates/:workspaceTemplateId/settings
/workspace-templates/:workspaceTemplateId/settings?section=environment
```

Supported sections are `index`, `general`, `secrets`, `ssh`, `environment`, and `container`. The index lists the five settings sections; each section opens a focused page in the complete AgentsInTheCloud shell. Use `editor=new` or a record ID for Secrets, SSH keys, or Environment Variables, and `editor=docker`, `images`, or `dockerfile` for Container. Legacy section links (`repository`, `ssh-keys`, `privileged`, `dockerfile`, `preload-images`, and `danger`) still resolve to their corresponding pages.

**Secrets** manages protected credential entries shared with a template's Workspaces. Agents receive placeholders; real values are substituted into requests to allowed hosts. Secret changes apply to existing Workspaces, while Environment Variables only apply to new containers. Secret summaries never return real values.

**Global workspace settings** hold Secrets, SSH keys, trusted SSH servers and Environment variables for every new workspace, including empty ones. They use the same endpoints under `/global-workspace-settings` instead of `/workspace-templates/:workspaceTemplateId`; `GET /global-workspace-settings` with `Accept: application/json` lists them. A template's own Secret or Environment variable with the same name overrides the global one. Present them with `/settings?section=global-workspace-settings`, or inside a template's settings with `section=global-secrets`, `global-ssh` or `global-environment`. Global summaries have no `workspaceTemplateId`.

Use `GET /workspace-templates` with `Accept: application/json` to discover the template ID before constructing the presentation URL. Template environment-variable, secret, and SSH-key summaries identify their template with `workspaceTemplateId`. Existing storage filenames and serialized formats are unchanged; their older `project` spellings remain at storage boundaries.

Other browser-navigable surfaces are:

```text
/workspaces/new                                           # Launch composer for an empty workspace
/workspace-templates/:workspaceTemplateId/workspaces/new  # Launch composer for a workspace from a template
/workspace-templates/new                                  # Add a template
/models                                 # Models: Model providers, their usage, and enabled models
/settings                               # Settings: app-level preferences and shared configuration
/settings?section=models                # A specific settings section
/settings/developer-tools               # Developer tools: app-level maintenance and design-system inspection
/host                                   # Host: System diagnostics and privileged terminals
/design-system-catalogue.html           # Live component catalogue (HTML)
```

Host targets AgentsInTheCloud System, outside individual Workspaces, rather than necessarily the physical machine running Docker. `GET /host` with `Accept: application/json` reports availability and the access boundary; it does not create a terminal.

**Developer tools** is the app-level maintenance and design-system inspection page, separate from Workspace template configuration. The existing `/settings/development` URL remains valid.

**Theme** is an app-wide setting shared across open pages, not a per-Workspace or per-browser preference. Its settings section is `theme`.

Settings shows the **AgentsInTheCloud URL** for the current browser connection, with copy and QR-code actions. It is not necessarily reachable from other devices; a local-only address must be opened on the Installation computer.

The `access` section controls **Connection mode** in a System-managed installation: **Installation computer only** or **Devices on your Tailscale network**. The existing access API spelling is unchanged.

**Commit identity** uses section `commit-identity` and POST `/settings/commit-identity` with `commitAuthorName` and `commitAuthorEmail`. Existing `git-identity` section links and POST `/settings/git-identity` remain valid.

The `update-channel` section is **Update channel**, with **Stable** and **Latest** choices. Its POST endpoint is `/settings/update-channel` with form field `channel=stable` or `channel=latest`. The image tags and saved settings format are unchanged.

The `update` section is **Updates**, the feature for managing AgentsInTheCloud installation Updates. It is separate from Workspace package and agent CLI updates.

Settings is app-level, not configuration for the selected Workspace, a Workspace template, or an individual Agent. The GitHub connection is shared across Workspaces; its GitHub token is distinct from the Commit identity used to author commits. The settings section is a registered settings contribution ID, such as `theme`, `commit-identity`, `github`, `models`, `dictation`, or `update`.

## Create and wait for a workspace

Creation is asynchronous and returns `202 Accepted` immediately. The response’s
`workspace.url` and `Location` header are origin-relative paths, like workspace
detail URLs. Resolve them against the public request URL to preserve HTTPS
when AgentsInTheCloud runs behind a TLS-terminating proxy:

```sh
created=$(curl -sS -X POST http://localhost:3000/workspaces \
  -H 'Origin: http://localhost:3000' \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"source":{"type":"empty"},"title":"Evaluation"}')
id=$(jq -r '.workspace.id' <<<"$created")
```

`source` may be `{ "type": "empty" }` or `{ "type": "workspace-template", "workspaceTemplate": "name-or-id" }`. Optional `agent` fields are `agentTypeId` (Builtin, Claude Code, Codex, Codex CLI, or Pi: `builtin`, `claude`, `codex`, `codex-cli`, or `pi`), `initialPrompt`, `model`, `thinkingLevel`, and `attachmentDraft`.

Poll the same UI URL with JSON content negotiation:

```sh
while :; do
  workspace=$(curl -sS -H 'Accept: application/json' "http://localhost:3000/workspaces/$id")
  phase=$(jq -r '.workspace.phase.kind' <<<"$workspace")
  [ "$phase" = runningPhase ] && break
  [ "$(jq -r '.workspace.phase.status' <<<"$workspace")" = failed ] && { jq . <<<"$workspace"; exit 1; }
  sleep .2
done
```

Existing workspaces are discovered before the server starts listening. Each active
workspace then runs its startup checklist in the background with phase `provisioningPhase`.
Readiness checks the ingress and egress gateways, parent sockets, and the workspace's
saved image preload list. Failure retains the container for repair and presents
**Retry** and **Continue anyway**. Use
`POST /workspaces/:id/provisioning/continue?action=retry` to retry runtime preparation,
or omit the query parameter to explicitly bypass the failure. Bypassing makes the
workspace enter `runningPhase` while retaining its preparation warning. Until startup completes,
the workspace shows its checklist instead of its Agents or Work views. AgentsInTheCloud and
other workspaces remain available throughout.

The list and detail responses include optional `issues` entries with `kind` and
`message`. Image inspection runs independently at AgentsInTheCloud startup. Readiness checks
run again when a workspace resumes or AgentsInTheCloud restarts; bypassing a failure does not
permanently disable checks. Existing workspaces keep their saved preload references
when template settings change.

A running-phase response advertises its `agents`, typed `workViews`, and available `commands` with their `inputSchema`.

## Stage Agents and Work views

**Close Agent** uses `POST /workspaces/:id/agents/:agentId/close`. The transcript is retained, but the closed Agent cannot be reopened or resumed. Starting a fresh Agent session is different: it keeps the same Agent.

Execute commands using their advertised schema:

```sh
curl -sS -X POST "http://localhost:3000/workspaces/$id/commands/terminal.create" \
  -H 'Origin: http://localhost:3000' \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"title":"Tests","cwd":"/work","command":"bun test"}'

curl -sS -X POST "http://localhost:3000/workspaces/$id/commands/browser.create" \
  -H 'Origin: http://localhost:3000' \
  -H 'Accept: application/json' -H 'Content-Type: application/json' \
  -d '{"url":"http://localhost:3000/"}'

curl -sS -X POST "http://localhost:3000/workspaces/$id/commands/agent.create" \
  -H 'Origin: http://localhost:3000' \
  -H 'Accept: application/json' -H 'Content-Type: application/json' -d '{}'
```

Navigate an existing Browser view with `POST /workspaces/:id/browser/:browserId/navigate` and `{ "url": "..." }`.

## Arrange Work views

Changes uses **Diff endpoints**: a `base` and `target`, with an optional implicit base for a single chosen commit. Existing comparison HTTP fields remain `start` (base) and `end` (target); their behavior is unchanged.

- `POST /workspaces/:id/work-views/reorder` with `key` and `index`
- `POST /workspaces/:id/work-views/close` with a typed `reference`
- `POST /workspaces/:id/work-views/:key/attention/request` to request attention for a Work view without selecting it

Open Work-view identity and order are server-persistent. Workspace, agent, and view `requestingAttention` states are independent and server-persistent; each clears only when that destination becomes visible. Workspace `phase` is an object with `kind` and `busy`, plus phase-specific substates. Agent summaries include `busy` and `requestingAttention`. Active destinations, pane visibility, and Work-pane width are browser-local.

The Agent `/park` message responds with a `307` redirect to the workspace park operation.
Follow same-origin redirects while preserving the POST method, Accept, and Origin headers (for example, `curl -L`).
Confirmation is returned only to that requester; JSON clients receive `409` when confirmation is needed.

Rename with `POST /workspaces/:id/sidebar-title` and `{ "title": "..." }`. Park, unpark, and delete use the corresponding existing workspace UI routes with `Accept: application/json` and a matching `Origin` header.

## Control an agent

- `POST /workspaces/:id/agents/:agentId/model` with `{ "model": "provider::model" }`
- `POST /workspaces/:id/agents/:agentId/thinking-level` with `{ "thinkingLevel": "medium" }`
- `POST /workspaces/:id/agents/:agentId/messages` with `{ "text": "...", "mode": "send" }`
- `POST /workspaces/:id/agents/:agentId/abort`

Message submission returns `202 Accepted`; it does not wait for inference to finish.

## Present the result

After staging the desired Work view, use the agent's `present` tool with:

```text
http://localhost:3000/workspaces/<id>
```

## Inspect Model provider usage

`GET /usage` with `Accept: application/json` returns all connected providers with
implemented subscription-usage support (OpenAI Codex and Anthropic). Refresh an
individual provider with `GET /usage/providers/openai-codex` or
`GET /usage/providers/anthropic` and the same header. Anthropic requires subscription
OAuth sign-in, not an API key. Its five-hour, weekly, and available model/feature
windows use the same pacing reference. Buckets with no reset timestamp retain
their reported usage, with null reset and timing values and timing state `unknown`.
Null buckets are omitted; monetary extra usage is not a paced allowance. Anthropic
does not report a plan name or account-wide allowed/limit-reached flags, so these
are null.
In the app, each provider’s usage shows on its card in the Models dialog; the
workspace Usage button opens that dialog with its provider expanded.

Each result includes provider-reported windows, their durations and resets,
and pacing relative to elapsed time. Provider failures populate `error`.
The Usage feature does not record or persist installation-wide token totals.

A provider card groups provider-reported 0% windows under **Unused limits**
(collapsed when there are used limits, expanded when all limits are unused)
and renders reset countdowns such as `3d 12h`. The workspace Usage button traces
Time and Usage for the subscription whose active allowance has the shortest Estimated time to hit limit
among subscriptions used for successful inference in the 30 minutes ending at the
last recorded inference. Limits are checked at display time, not frozen at the time
of that inference. Built-in Agent inference and connected-subscription CLI traffic
through workspace egress contribute activity; API-key traffic does not. Activity is
kept in memory and cleared on credential changes. The button refreshes every minute
while visible, on focus, and whenever a provider card loads fresh limits. No recorded activity or no
available active limits means no comparison ring. Both arcs start at twelve
o’clock and run clockwise on the same circle. Their shared portion is neutral;
Time beyond Usage is green, and Usage beyond Time is red. A dim full-circle
track preserves the button outline beneath the arcs.
Among active windows with nonzero usage, the button selects the shortest
Estimated time to hit limit; ties prefer higher Usage. When all active windows are
unused, the main allowance takes precedence over feature-specific allowances.
Expired/not-started windows and windows with unknown reset timing are excluded.
`GET /usage/button` returns the server-rendered button frame
(or a Turbo Stream with `Accept: text/vnd.turbo-stream.html`).
Each window also includes `timing`: the inferred start (`reset − duration`),
elapsed-time percentage, and usage-minus-time difference in percentage points.
`paceDifferenceSeconds` converts that difference to distance along the allowance
schedule (`paceDifferencePoints / 100 × durationSeconds`). Provider cards and the button
label show compact durations such as `30m ahead of pace` or `1d 4h behind pace`.
Positive means consumption is ahead; negative means behind. This is not time
until exhaustion. Both difference fields are null outside an active window.
**Estimated time to hit limit** is a separate forecast based on average consumption since the window began. It stops at the next reset; **Not before reset** means no hit is projected before then. An unavailable estimate is shown as a dash. Unlike **Resets in**, this is not an actual countdown.

Each provider card shows Time and Usage percentages above one comparison bar per allowance.
Both grow from the left: overlap is neutral, Time beyond Usage is green, and Usage
beyond Time is red. Outside an active window the bar stays neutral. This is a linear pacing
reference, not a billing forecast; pacing is omitted before a window starts or
once its reset is due.

Usage is contributed by the Agent module, including these OpenAPI paths. Its
header action and directly navigable dialog use the generic
[module-owned workspace-pane action interface](workspace-pane-actions.md).
