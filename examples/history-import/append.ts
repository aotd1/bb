import type { BbPluginApi } from "@get-bb/plugin-sdk";

interface FinalizedExternalMessage {
  id: string;
  order: number;
  role: "user" | "assistant";
  text: string;
  createdAt: number;
}

export async function appendFinalizedConversation(
  bb: BbPluginApi,
  args: {
    projectId: string;
    gatewayIdentity: string;
    conversationKey: string;
    sessionId: string;
    generation: number;
    messages: FinalizedExternalMessage[];
    backfill: boolean;
  },
) {
  return bb.sdk.threads.experimental_importHistory({
    projectId: args.projectId,
    sourceId: args.gatewayIdentity,
    conversationId: args.conversationKey,
    providerId: "openclaw",
    sessionId: args.sessionId,
    generation: args.generation,
    initialTitle: "Mr Dooffin",
    initialPluginMetadata: { agentId: "dooffin" },
    messages: args.messages,
    attention: args.backfill ? "preserve" : "unread",
  });
}
