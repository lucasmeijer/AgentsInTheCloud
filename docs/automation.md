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

Admin bindings provide a separate, JSON-only management API for host-local or LAN automation without Tailscale. They are disabled by default. Every request, including `GET /openapi.json`, requires `Authorization: Bearer <token>`. No browser `Origin` header is required on these listeners. The existing UI ingress and its Origin policy are unchanged.

Bootstrap locally with `bun apps/web/scripts/admin-bindings.ts`:

```sh
# Set a private umask before creating input files or capturing an issued token.
umask 077
# bindings.json: {"bindings":[{"host":"127.0.0.1","port":3443}]}
bun apps/web/scripts/admin-bindings.ts configure --file /secure/bindings.json
# token-input.json: {"name":"automation","scopes":["configuration","secrets","workspaces","host:read","security"]}
bun apps/web/scripts/admin-bindings.ts issue --file /secure/token-input.json > /secure/issued-token.json
```

The CLI uses the normal application data directory; `--data-dir PATH` overrides it for offline/local administration. Configuration lives in `admin-bindings.json`, with private permissions and only token hashes. The bearer secret is returned once. Token metadata can be listed with `show`; `revoke TOKEN_ID` takes effect on subsequent requests without restarting. Optional `expiresAt` sets token expiry.

Bindings take effect on **app startup**. Change them and restart the app, not individual workspaces. An empty `bindings` array disables all admin listeners on the next startup. Local CLI configuration remains available for lockout recovery.

Non-loopback bindings require TLS. Certificate/key paths must be absolute and readable by the app:

```json
{"bindings":[{"host":"0.0.0.0","port":3443,"tls":{"cert":"/data/app/admin-tls/cert.pem","key":"/data/app/admin-tls/key.pem"}}]}
```

For System installations, configure the app's persisted `/data/app` directory using the CLI **inside the app container as UID/GID 1000:1000** (for example, `docker exec --user 1000:1000 agents-in-the-cloud bun /app/apps/web/scripts/admin-bindings.ts ...`), and put TLS material there with matching ownership and private key permissions. Docker port publication is separate: install/update with `--admin-publish 192.168.1.10:3443:3443` for LAN access, or `--admin-publish 127.0.0.1:3443:3443` for host-only access. In both cases the container listener should use `0.0.0.0` with TLS. The option accepts explicit IPv4 `HOST_IP:HOST_PORT:ADMIN_PORT`, is repeatable, and existing publications are retained on updates unless replacements are supplied. No LAN ports are published by default. Never publish the UI or supervisor ports as admin ports. Applying installation updates interrupts running workspaces; do not update a live installation just to experiment with bindings.

Send `Content-Type: application/json` for mutations, including `{}` for operations without fields. Responses are JSON, and `/openapi.json` on the admin listener documents only its allowlisted operations and bearer authentication. UI routes, previews, arbitrary commands, agent prompting and terminal WebSockets are not exposed. SSH public-key responses are wrapped as `{ "publicKey": "..." }`.

Scopes:

| Scope | Operations |
| --- | --- |
| `configuration` | Template creation/update/deletion, environment variables, preload images |
| `secrets` | Template secret creation/update/deletion |
| `workspaces` | List/inspect/create/rename/park/unpark/delete, provisioning recovery, warning dismissal |
| `workspaces:force-delete` | Additional permission for explicit forced deletion; also requires `workspaces` |
| `host:read` | Host availability, bounded diagnostic samples and System status; no terminals or raw supervisor logs |
| `security` | Privileged mode, credential seeding, Dockerfiles, SSH keys/trust, System access mode, admin binding/token management |

Template discovery/configuration reads are shared by `configuration`, `secrets`, `security` and `workspaces` tokens. These reads include template environment values, but never plaintext secret or private-key values. `security` is administrative power: it can issue tokens with any scope and enable privileged containers. Scope separation does not sandbox repository setup or privileged Dockerfiles.

Additional management endpoints are `GET/PUT /admin/bindings`, `GET/POST /admin/tokens`, `DELETE /admin/tokens/{tokenId}`, `GET /host/status`, and `GET/POST /settings/access`. Binding updates return `restartRequired: true`; token issuance returns `{ token, secret }` once. Revocation requires a JSON `{}` body. Access changes require System; unsupported standalone instances return `503`. Diagnostic collection uses existing read-only, bounded probes, although diagnostic output can contain operational details and must be treated as sensitive.

`admin-audit.jsonl` records token ID, peer, operation template, method and status, without payloads, raw URLs, credentials or diagnostic output. Audit-file retention is operator-managed. Mutations accept at most 1 MiB of JSON. Template environment variables still apply to new containers; existing secret placeholders resolve to rotated credentials on subsequent proxied requests.

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
