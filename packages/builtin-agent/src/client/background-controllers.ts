import { CableTopics, isWorkspacePaneVisible, type CableSubscription, type WorkspaceClientControllerConstructor } from "@agents-in-the-cloud/shared";
import { Type } from "typebox";
import { Value } from "typebox/value";

export function createBackgroundController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    static values = { workspaceId: String, agentId: String };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly agentIdValue: string;
    private subscription?: CableSubscription;

    connect(): void { this.sync(); }
    disconnect(): void { this.stop(); }
    sync(): void {
      if (document.hidden || !isWorkspacePaneVisible(this.element)) { this.stop(); return; }
      this.subscription ??= window.AgentsInTheCloudCable!.subscribe(CableTopics.module("agent-background", this.workspaceIdValue, { agentId: this.agentIdValue }), {});
    }
    private stop(): void {
      this.subscription?.unsubscribe();
      this.subscription = undefined;
    }
  };
}

const revealedMessages = new Set<string>();

export function createChildTranscriptController(Controller: WorkspaceClientControllerConstructor) {
  return class extends Controller {
    static values = { workspaceId: String, agentId: String };
    declare readonly element: HTMLElement;
    declare readonly workspaceIdValue: string;
    declare readonly agentIdValue: string;
    private subscription?: CableSubscription;

    connect(): void { this.sync(); }
    disconnect(): void { this.stop(); }
    sync(): void {
      if (document.hidden || !this.element.checkVisibility()) { this.stop(); return; }
      this.subscription ??= window.AgentsInTheCloudCable!.subscribe(CableTopics.agent(this.workspaceIdValue, this.agentIdValue), { onReady: () => this.revealFromUrl() });
    }
    private stop(): void {
      this.subscription?.unsubscribe();
      this.subscription = undefined;
    }
    private revealFromUrl(): void {
      const params = new URL(location.href).searchParams;
      const message = params.get("background") === this.agentIdValue ? params.get("message") : null;
      if (!message || revealedMessages.has(`${this.agentIdValue}:${message}`)) return;
      revealedMessages.add(`${this.agentIdValue}:${message}`);
      void this.reveal(message);
    }
    follow(event: Event): void {
      const link = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-action~="agent-pane#reveal"]') : null;
      if (link?.dataset.agentPaneAgentParam !== this.agentIdValue) return;
      event.preventDefault();
      void this.reveal(link.dataset.agentPaneItemParam!);
    }

    private async reveal(target: string): Promise<void> {
      const response = await fetch(`/workspaces/${encodeURIComponent(this.workspaceIdValue)}/agents/${encodeURIComponent(this.agentIdValue)}/reveal/${encodeURIComponent(target)}`);
      if (!response.ok) throw new Error(`Could not resolve transcript target: ${response.status}`);
      const { turnId } = Value.Parse(Type.Object({ turnId: Type.Union([Type.String(), Type.Null()]) }), await response.json());
      const turn = turnId === null ? null : this.element.querySelector<HTMLDetailsElement>(`[data-agent-turn-turn-id-value="${CSS.escape(turnId)}"]`);
      if (turn) { turn.dataset.agentTurnRevealValue = target; turn.open = true; return; }
      const value = CSS.escape(target);
      this.element.querySelector(`[data-transcript-anchor="${value}"], [data-transcript-key="${value}"], [data-tool-call-id="${value}"]`)?.scrollIntoView({ block: "center" });
    }
  };
}
