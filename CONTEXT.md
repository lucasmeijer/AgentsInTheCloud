# AgentsInTheCloud

AgentsInTheCloud is a workspace interface for collaborating with coding agents while inspecting and operating on the work they produce.

## Language

**Onboarding**:
The guided flow for getting started with AgentsInTheCloud by connecting GitHub and Model providers. Onboarding is app-level, distinct from preparing an individual Workspace.
_Avoid_: Initial setup (as the feature name), Workspace setup

**Settings**:
The app-level surface for AgentsInTheCloud preferences and shared configuration, such as Connection mode, theme, Commit identity, GitHub connection, and Model providers. Settings is distinct from Workspace template configuration and an individual Agent’s choices.
_Avoid_: Preferences, app settings, global settings (as feature names), workspace settings (for this surface)

**Developer tools**:
The app-level page for maintenance actions and design-system inspection, including resetting stored settings and opening the design system catalogue. Some actions are only available in development builds. It is distinct from Workspace template configuration.
_Avoid_: Development settings, Developer settings (for this app-level page)

**Theme**:
The app-wide choice of AgentsInTheCloud’s visual appearance, shared across open pages. Theme is not selected independently for each Workspace or browser.
_Avoid_: Workspace theme, browser theme (for this setting)

**Connection mode**:
The installation-wide choice of where AgentsInTheCloud and Workspace previews can be used: Installation computer only, or Devices on your Tailscale network. The selected mode determines generated preview addresses; Tailscale mode includes the installation computer.
_Avoid_: App access, Local / Remote (as mode labels)

**AgentsInTheCloud URL**:
The address shown in Settings for opening the current AgentsInTheCloud installation through the browser's connection. It can be copied or shown as a QR code. Its reachability from another device depends on the address and Connection mode; it is not necessarily a public Internet address or usable on a phone.
_Avoid_: External URL, Instance URL (as the feature label)

**Installation computer**:
The computer where AgentsInTheCloud is installed, which may differ from the device running the user's browser.
_Avoid_: This computer (when the installation computer is meant), System container (as the computer's identity)

**GitHub connection**:
The app-wide connection that lets AgentsInTheCloud and Agents access GitHub repositories using a GitHub token. It is shared across Workspaces, not configured separately for each Workspace. It is distinct from Commit identity, which determines the author name and email on commits.
_Avoid_: GitHub setup (as the feature name), Workspace GitHub connection

**Commit identity**:
The app-level author name and email used to configure commits in new Workspaces. It is distinct from the GitHub connection and its access credential; choosing a Commit identity does not authenticate with GitHub.
_Avoid_: Git identity, GitHub identity (for commit authorship)

**GitHub token**:
The credential used by the GitHub connection. AgentsInTheCloud keeps the token outside Agent sandboxes and supplies repository access without exposing the token to Agents.
_Avoid_: Workspace GitHub token

**Host**:
The feature for inspecting AgentsInTheCloud System diagnostics and using privileged terminals outside individual Workspaces. Host access targets the System environment, not necessarily the physical machine running Docker.
_Avoid_: System panel (as the feature name), Workspace terminal (for Host access), physical host (as an implicit access boundary)

**Updates**:
The feature for checking for AgentsInTheCloud releases and managing Update operations. Updates is separate from managing packages or agent CLIs inside a Workspace.
_Avoid_: Upgrades, software updater (as feature names)

**Usage**:
The app-level feature for inspecting Model provider usage, limits, and reported balances. Usage reflects provider accounts rather than an individual Workspace’s token totals.

**Estimated time to hit limit**:
The estimated time until a provider usage limit is reached, based on the average consumption rate so far in its current window. The estimate does not project beyond the next reset. It is distinct from the reset countdown and from Pace.
_Avoid_: Runway, time to limit (without indicating that it is an estimate)

**Pace**:
How usage compares with consuming an allowance evenly over its time window. Ahead means faster consumption and behind means slower consumption; Pace is not an estimate of when the limit will be reached.

**Update channel**:
The published image track followed by Updates. Stable follows the image promoted to the stable track; Latest follows the most recently published image on the latest track. An Update channel selects which Updates to receive, not when to apply them.
_Avoid_: Release channel (for the app setting)

**Update**:
An installation operation that prepares an AgentsInTheCloud release and applies it by restarting the System-managed installation.
_Avoid_: Upgrade (as the operation name), Workspace package update

**Workspace template**:
What a new workspace is seeded with: a repository to clone plus configuration such as environment variables, a Dockerfile, secrets and SSH keys. Called "template" in the app. Secrets and SSH keys stay live in workspaces created from it; everything else applies only to new workspaces.
_Avoid_: Project, workspace folder, repository

**Global workspace settings**:
Secrets, SSH keys, trusted SSH servers and Environment variables that apply to every new workspace, including Empty workspaces. They are edited in Settings and in each Workspace template's settings. A template's own Secret or Environment variable with the same name overrides the global one; SSH keys and trusted SSH servers from both apply.
_Avoid_: Shared secrets, default template settings

**Atelier-in-Atelier seeding**:
A fringe Workspace template permission for copying Model provider credentials and saved Workspace template configuration into new Workspaces, primarily to prepare a nested installation. Unlike Secrets, this can put real credentials inside the Workspace, so it is only appropriate for trusted repositories and Agents.

**Secrets**:
The Workspace template page for managing Secrets shared with its Workspaces. Changes also apply to existing Workspaces, unlike Environment Variables, which only apply to new containers.

**Secret**:
A Workspace template credential entry that gives Agents a placeholder and permits substitution of its real value into requests to allowed hosts. Real values stay outside Agent sandboxes. A Secret can be saved without a value and filled in later.
_Avoid_: Project secret, environment variable (when the protected credential entry is meant)

**Environment Variables**:
The Workspace template page for managing environment variables added to new Workspace containers. Passwords and API keys belong in Secrets; changes do not affect existing containers.
_Avoid_: Environment (as the page name)

**Template icon**:
The marker that identifies a workspace's template in the Workspace pane. By default it is a **swatch**: a colored square derived from the template id.
_Avoid_: Chip, badge, avatar

**Workspace**:
An isolated environment in which a user collaborates with agents and inspects or operates on their work. A workspace may be created from a Workspace template or with nothing.
_Avoid_: Task, chat

**Empty workspace**:
A workspace seeded with nothing, and therefore without a template's repository or configuration.
_Avoid_: Projectless workspace, empty template

**Parked workspace**:
A retained Workspace set aside from active use while remaining associated with its Workspace template. Activity requiring user attention automatically unparks it.
_Avoid_: Archived workspace, inactive workspace

**Workspace pane**:
The collapsible navigation region for finding and switching between workspaces.
_Avoid_: Left sidebar, workspace tab

**Agent**:
A named coding collaborator within a Workspace, with its own Agent session. Agents added directly by the user have an AgentPaneComposer, with one active in the Agent pane at a time; starting a fresh session does not create another Agent.
_Avoid_: Agent conversation, Agent view, agent tab, chat, thread

**Close Agent**:
The operation that ends an Agent’s active lifecycle and removes it from the Agent list. Its transcript is retained, but the closed Agent cannot be reopened or resumed. This is distinct from starting a fresh Agent session, which keeps the same Agent.
_Avoid_: Archive Agent, Delete Agent (for this operation)

**Subagent**:
A coding collaborator created by an Agent to carry out delegated work within the same Workspace. A Subagent may delegate further work to its own Subagents; it is distinct from an Agent added directly by the user.
_Avoid_: Sub-agent, child agent, delegated agent (as the name)

**Subagents**:
The feature for inspecting the active Agent’s Subagents, their activity, and their messages in a contextual Work view.
_Avoid_: Delegation dashboard, child-agent view

**Agent type**:
The coding-agent implementation an Agent uses: Builtin, Claude Code, Codex, or Pi. An Agent type is distinct from the Model provider supplying its models.
_Avoid_: Agent provider, agent backend

**Model provider**:
A service that supplies models, such as OpenAI or Anthropic. The Model providers available to an Agent depend on its Agent type and connected credentials.
_Avoid_: Agent provider

**Enabled model**:
A model included in the saved list used for an Agent’s composer model choices. Models may be enabled automatically when connecting a Model provider or by the user; being enabled does not guarantee availability through the Agent type, account access, or current credentials.
_Avoid_: Favorite model, configured model, your models, model shortlist

**Thinking level**:
A model-specific setting requesting how much reasoning effort an Agent’s model uses for subsequent work. Supported levels depend on the model and Agent type; a Thinking level is a configuration choice, not the reasoning text produced by the model.
_Avoid_: Reasoning effort, effort, thinking mode

**Agent pane**:
The primary region for collaborating with the active Agent in a Workspace.
_Avoid_: Left tab, chat tab

**AgentPaneComposer**:
The composer in an Agent pane for collaborating with its active Agent and selecting the model and thinking level used for subsequent Agent work.
_Avoid_: Agent composer, in-pane composer, prompt box, chat input

**LaunchComposer**:
The composer used before a Workspace exists to provide its Agent’s initial prompt and select the model and thinking level with which the Workspace starts.
_Avoid_: Launch form, launch prompt, new-workspace composer

**Inline content**:
HTML-based explanatory content shown as part of an Agent’s answer using AgentsInTheCloud’s supplied styling and controls. Inline content is distinct from independently styled, standalone outputs.

**Dictation**:
The feature for turning microphone speech into editable text in an AgentPaneComposer or LaunchComposer. Dictation inserts text into the draft without sending it; it is not a voice conversation with an Agent.
_Avoid_: Transcription (as the app feature name), voice chat

**Slash command**:
An invocation beginning with `/` in an Agent’s composer. Slash commands may perform a built-in action, expand a Prompt template, or explicitly invoke a Skill; not every Slash command is a Prompt template.

**Prompt template**:
A named, reusable prompt for an Agent, optionally expanded with arguments. It can be invoked by its slash command and may have a Keyboard shortcut or Prompt template button.

**Skill**:
A named bundle of reusable, task-specific instructions and optional supporting files that an Agent can load when relevant or when explicitly invoked. Unlike a Prompt template, a Skill supplies guidance for performing a task rather than a reusable prompt to insert or send.
_Avoid_: Agent skill (as an app term)

**Prompt template button**:
An optional button in the AgentPaneComposer that inserts a Prompt template into the draft for review and editing without sending it. Buttons are shown while the composer is empty and are independent of Keyboard shortcuts.
_Avoid_: Quick launch, quick insert

**Keyboard shortcut**:
A key combination that invokes an AgentsInTheCloud command, shortened to “Shortcut” when the context is clear. A Prompt template’s shortcut sends it directly to the active Agent rather than inserting it into a draft.
_Avoid_: Hotkey

**Agent session**:
An Agent's replaceable interaction history. Starting a fresh Agent session resets the active context while keeping the same Agent, its settings, and its searchable history.
_Avoid_: Agent, Agent conversation

**Work pane**:
The contextual region that slides in when needed to show files, terminals, browsers, editors, and other working views.
_Avoid_: Right tab, preview tab

**Work view**:
A closable, reorderable destination inside the Work pane, such as a Terminal, Browser, or Files view. Only one Work view is active and visible at a time; Work views are not split into additional layout groups.
_Avoid_: Workspace group, preview group

**Resource Work view**:
A Work view representing an independently open resource or running session, such as a Browser, Desktop, Terminal, or VS Code view.
_Avoid_: Document view, permanent view

**Contextual Work view**:
A workspace-level utility Work view, such as Files or Changes.
_Avoid_: Permanent view, special view

**Changes**:
The Workspace-level feature for inspecting Git history and diffs between repository states, including commits, staged changes, and the working tree.

**Diff endpoints**:
The base and target repository states whose difference is shown in Changes. Both may be chosen explicitly, or the base may be implicit; choosing a single commit uses its first parent as the base, or the empty tree if it has no parent. Endpoints describe two states, not an inclusive range of commits.
_Avoid_: Changes range, Comparison selection (for the endpoint pair)

**Browser**:
The feature for opening webpages in a Workspace, including apps running in that Workspace. It is distinct from the remote graphical environment shown by Desktop.
_Avoid_: Preview browser, browser preview

**Browser view**:
A Resource Work view displaying a webpage through Browser, with its own address and navigation. A Workspace may contain multiple Browser views.
_Avoid_: Browser tab, preview view, Browser Work view

**Desktop**:
A Workspace’s remote graphical environment for interacting with graphical apps, including its visible Chromium browser. It is distinct from Browser, which opens webpages directly in a Browser view.
_Avoid_: VNC view (as a feature name)

**Desktop view**:
A Resource Work view for viewing and controlling a Workspace’s Desktop. A Workspace has at most one Desktop view; closing it does not stop Desktop.
_Avoid_: Desktop tab, VNC view

**VS Code**:
The feature for using browser-based Visual Studio Code inside a Workspace, including its editor tools and extensions.
_Avoid_: Code server (as the feature name)

**VS Code view**:
A Resource Work view displaying a Workspace’s VS Code editor. The view is an app destination, distinct from the underlying VS Code server or native window.
_Avoid_: VS Code pane, VS Code session (for the app destination), VS Code tab, VS Code Work view

**Side-by-side**:
The diff layout that places deletions and additions in separate columns next to each other.
_Avoid_: Split diff, split layout

**Mobile destination**:
A top-level phone navigation target for the Workspace pane, an Agent, or a Work view configured for direct mobile access. Every Agent is directly reachable. Open Browser and Terminal views are directly reachable; Files and VS Code views are found through More.
_Avoid_: Mobile tab, mobile Work pane

**AgentsInTheCloud bar**:
The phone-only bottom navigation bar for controls whose scope is AgentsInTheCloud rather than the selected Workspace. It is visible while the Workspace pane is visible, occupies the full bottom edge, and replaces the Workspace bar. When hidden, only the Workspace pane button remains visible at the bottom-left.
_Avoid_: Application bar, global bar, Workspace pane bar

**Workspace pane button**:
The phone control that remains at the bottom-left while the AgentsInTheCloud bar is hidden. Activating it opens the Workspace pane and reveals the AgentsInTheCloud bar.
_Avoid_: AgentsInTheCloud button, open button

**Workspace bar**:
The phone-only bottom navigation bar containing Mobile destinations within the selected Workspace, such as Agents, Browser, Changes, and More. It is visible while the Workspace pane is hidden and is replaced by the AgentsInTheCloud bar when the Workspace pane opens.
_Avoid_: Current Workspace toolbar, resident bar

**Next attention**:
An AgentsInTheCloud navigation action that opens the Workspace that has been requesting attention longest, regardless of whether it is busy or preloaded.
_Avoid_: Next unread, next Agent

**More**:
The user-facing phone destination that opens a bottom sheet with separate sections for Work views not configured for direct mobile access and launchers that create or reveal Work views. Work-view launchers such as Files remain available when their live Work views are closed. Selecting a Work view from More leaves the stable bottom destination bar unchanged, and More remains highlighted while a secondary Work view is visible. “Work” remains domain language and is not exposed as the name of this mobile affordance.
_Avoid_: Work, overflow

**Work view reference**:
A stable, type-bearing identity for one Work view. Generic Work pane actions accept any Work view reference, while type-specific actions accept only references of their own kind.
_Avoid_: Tab key, untyped view ID

**Unavailable Work view**:
A persistent Work view whose referenced resource cannot currently be loaded. It remains visible as an explicit unavailable state until its resource returns or the user closes it.
_Avoid_: Broken tab, missing tab

**Terminal**:
The feature for command-line access inside a Workspace. Terminal is distinct from Host’s privileged terminals in AgentsInTheCloud System.
_Avoid_: Shell (as the feature name), Host terminal (for Workspace command-line access)

**Terminal view**:
A Resource Work view connected to a terminal session through Terminal. It either owns a session created specifically for it or attaches to an independently existing session.
_Avoid_: Terminal tab, Terminal pane, Terminal Work view

**Owned terminal session**:
A terminal session created specifically for one Terminal view and governed by that view's lifecycle.
_Avoid_: Attached session

**Attached terminal session**:
A pre-existing terminal session surfaced through a Terminal view while retaining a lifecycle independent of that view.
_Avoid_: Owned session

**Workspace phase**:
The single active part of a Workspace's lifecycle: Provisioning phase, Running phase, or Deleting phase. A failure or a pending decision is a state within its phase, not another phase.

**Provisioning phase**:
The phase that prepares a Workspace for use. It is busy while progressing, not busy while waiting for a user decision or after failure. A decision or failure requests attention for the Workspace.

**Running phase**:
The phase in which a Workspace's Agents and Work views are available. It is busy if any Agent is busy. When an Agent or Work view starts requesting attention, this phase requests attention for the Workspace.

**Deleting phase**:
The phase that reviews and removes a Workspace. It is busy while progressing, not busy while waiting for a user decision or after failure. A decision or failure requests attention for the Workspace.

**Busy**:
An independent yes/no state of an Agent or Workspace phase. A Workspace is busy exactly when its active phase is busy. Work views do not contribute busy state.

**Requesting attention**:
An independent yes/no state of a Workspace, Agent, or Work view. It remains set until that particular destination becomes visible. A visible destination never starts requesting attention. Repeated requests do not change its place in the oldest-first order.
_Avoid_: Unread, Agent ready

**Attention request**:
An event asking the user to inspect a destination. A phase's request sets its Workspace's requesting-attention state only while that Workspace is not visible. Workspace visibility clears only Workspace attention, not the attention of hidden Agents or Work views. Attention does not itself change the visible destination.

**Workspace selection**:
Opening a Workspace makes its oldest requesting-attention Agent visible and, on desktop, its oldest requesting-attention Work view visible. An Agent presentation also makes its presented Work view visible on desktop; on mobile it only requests attention.

**Preload state**:
A browser-local state indicating whether a Workspace is preloaded, preloading, or neither. It does not affect busy or requesting-attention state. Workspace attention indicators are dimmed until preloading finishes.

**Files**:
The feature for navigating Workspace files and viewing or editing a selected file. Files combines file navigation and editing rather than creating a separate Work view for each file.
_Avoid_: File browser, file explorer

**Files view**:
A Work view combining file navigation with viewing or editing its selected file. A Workspace may have multiple Files views with independent selections, including multiple views of the same file.
_Avoid_: File view, file tab, Files Work view

**File draft**:
A file’s working text and save state, shared by Files views showing that file in the same browser page. Changes are saved automatically, while unsaved edits are retained when saving fails or encounters a conflict.

**Markdown display mode**:
The choice of how a Markdown file is displayed within a Files view: Source or Rendered. The mode does not determine whether the file is writable.

**Source**:
The Markdown display mode showing the file’s Markdown text, editable when the file is writable.
_Avoid_: Edit mode, raw mode

**Rendered**:
The Markdown display mode showing the formatted presentation of the file’s current text.
_Avoid_: Preview mode

**Files navigator**:
The collapsible file-navigation region within a Files view, containing its file tree, filter, and upload controls. It is part of that Files view, not a separate Work view or the surrounding Work pane.
_Avoid_: Files pane, Files side view

**Persistent Work view state**:
The server-restorable identity, order, and type-specific resource state of an open Work view. Its durability follows the view type rather than whether the user or agent created it, and remains until the view is explicitly closed.
_Avoid_: Published workspace state, saved layout

**Personal navigation state**:
A browser-local record of the user's choices while navigating persistent Work views, such as the selected destination, pane and drawer visibility, Work-pane width, and scroll position. It may be restored by that browser but is not server-authoritative workspace state.
_Avoid_: Workspace state
