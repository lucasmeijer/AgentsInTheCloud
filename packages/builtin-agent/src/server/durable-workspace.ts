import { Type } from "typebox";
import { Value } from "typebox/value";
import { mkdir } from "node:fs/promises";
import { lock } from "proper-lockfile";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  configure,
  defineDoc,
  Harness,
  type AgentChange,
  type ConversationId,
  type HarnessOptions,
} from "@earendil-works/pi-durable";
import { markGatedDurableWork, WorkspaceAdmission } from "./durable-lifecycle.ts";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

export type DurableAgentRecord = {
  agentId: string;
  durableId: ConversationId;
  label: string;
  title: string;
  readOnly?: boolean;
  parentId?: string;
  rootId?: string;
  taskName?: string;
  oneShotCallId?: string;
  branches?: ConversationId[];
};

export function isOneShotAgent(record: Pick<DurableAgentRecord, "oneShotCallId">): boolean {
  return record.oneShotCallId !== undefined;
}

const previousWorkspaceAgentsSchema = Type.Object({
  workspaceId: Type.String(),
  conversations: Type.Array(Type.Object({
    conversationId: Type.String(), durableId: Type.Number(), label: Type.String(), title: Type.String(),
    readOnly: Type.Optional(Type.Boolean()), parentId: Type.Optional(Type.String()), rootId: Type.Optional(Type.String()),
    taskName: Type.Optional(Type.String()), branches: Type.Optional(Type.Array(Type.Number())),
  })),
});

type WorkspaceAgentCatalog = { workspaceId: string; agents: DurableAgentRecord[] };

export const WorkspaceAgents = defineDoc<WorkspaceAgentCatalog>({
  kind: "agents-in-the-cloud.workspace",
  version: 2,
  scope: "session",
  initial: () => ({ workspaceId: "", agents: [] }),
  checkpointWhen: () => false,
  migrate(value, fromVersion) {
    if (fromVersion !== 1) throw new Error(`Unsupported workspace catalog version: ${fromVersion}`);
    Value.Assert(previousWorkspaceAgentsSchema, value);
    // SAFETY: The previous catalog is validated above; its storage-local numeric IDs retain their native brands.
    return {
      workspaceId: value.workspaceId,
      agents: value.conversations.map(({ conversationId, ...record }) => ({ ...record, agentId: conversationId })),
    } as WorkspaceAgentCatalog;
  },
});

/**
 * One journal and scheduler per workspace, outside the disposable execution container.
 * Opening is passive: the host must make the workspace ready before resume or submit.
 * Closing suspends work; it is not the user's Stop action.
 */
export async function openDurableWorkspace(directory: string, workspaceId: string, options: HarnessOptions) {
  await mkdir(directory, { recursive: true });
  // Pi's JSONL backend has no writer exclusion. A compromised lease is fatal (the
  // lock library's default), rather than allowing two writers to corrupt history.
  // An immediate host restart must allow the previous writer's heartbeat to
  // expire. Wait a bounded 12 seconds (past the 10-second lease plus timestamp
  // rounding), but never remove a fresh lock or admit a concurrent writer.
  const release = await lock(directory, {
    stale: 10_000,
    update: 5_000,
    retries: { retries: 24, factor: 1, minTimeout: 500, maxTimeout: 500, randomize: false },
  });
  try {
    const storage = await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT, { fsync: true });
    let harness: Harness;
    try {
      harness = await Harness.open(storage, options, BACKGROUND_CONTEXT);
    } catch (error) {
      await storage.close(BACKGROUND_CONTEXT);
      throw error;
    }
    try {
      await harness.commit(async (tx) => {
        const workspace = await tx.doc(WorkspaceAgents);
        if (workspace.workspaceId && workspace.workspaceId !== workspaceId) {
          throw new Error(`Journal belongs to workspace ${workspace.workspaceId}, not ${workspaceId}`);
        }
        workspace.workspaceId = workspaceId;
      }, BACKGROUND_CONTEXT);
      await markGatedDurableWork(harness);
    } catch (error) {
      await harness.close(BACKGROUND_CONTEXT);
      throw error;
    }
    let closing: Promise<void> | undefined;
    return {
      harness,
      async agent(record: Omit<DurableAgentRecord, "durableId">, agent: AgentChange = {}) {
        const id = await harness.commit(async (tx) => {
          const workspace = await tx.doc(WorkspaceAgents);
          const existing = workspace.agents.find((item) => item.agentId === record.agentId);
          if (existing) return existing.durableId;
          if ((await tx.doc(WorkspaceAdmission)).deleted) throw new Error("Durable workspace is deleted");
          const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
          await configure(tx, created.id, agent);
          workspace.agents.push({ ...record, durableId: created.id });
          return created.id;
        }, BACKGROUND_CONTEXT);
        return (await harness.conversation(id, BACKGROUND_CONTEXT))!;
      },
      close(): Promise<void> {
        return closing ??= (async () => {
          await harness.close(BACKGROUND_CONTEXT);
          await release();
        })();
      },
    };
  } catch (error) {
    await release();
    throw error;
  }
}

export type DurableWorkspace = Awaited<ReturnType<typeof openDurableWorkspace>>;
