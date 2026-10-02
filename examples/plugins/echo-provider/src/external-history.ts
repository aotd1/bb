import type { BbPluginApi } from "@get-bb/plugin-sdk";

export async function importAndBindConversation(
  bb: BbPluginApi,
  target: {
    projectId: string;
    environmentId: string;
    sourceId: string;
    conversationId: string;
    sourceSessionId: string;
    runtimeProviderId: string;
    runtimeSessionHandle: string;
  },
  messages: {
    id: string;
    order: number;
    role: "user" | "assistant";
    text: string;
    createdAt: number;
  }[],
) {
  const key = {
    projectId: target.projectId,
    sourceId: target.sourceId,
    conversationId: target.conversationId,
  };
  const found = await bb.sdk.threads.experimental_findExternalThread(key);
  const generation = found.binding?.generation ?? 0;
  if (found.binding && found.binding.sessionId !== target.sourceSessionId)
    throw new Error(
      "Confirmed source reset requires release, higher generation import, then rebind",
    );
  let threadId = found.binding?.threadId;
  for (
    let offset = 0;
    offset < messages.length || threadId === undefined;
    offset += 100
  ) {
    const batch = await bb.sdk.threads.experimental_importHistory({
      ...key,
      providerId: target.runtimeProviderId,
      sessionId: target.sourceSessionId,
      generation,
      messages: messages.slice(offset, offset + 100),
      attention: "preserve",
      initialTitle: "Imported conversation",
    });
    threadId = batch.threadId;
    if (messages.length === 0) break;
  }
  if (threadId === undefined)
    throw new Error("Missing imported thread identity");
  await bb.sdk.threads.experimental_bindExternalSession({
    threadId,
    expectedGeneration: generation,
    expectedSessionId: target.sourceSessionId,
    providerId: target.runtimeProviderId,
    providerThreadId: target.runtimeSessionHandle,
    environmentId: target.environmentId,
  });
  return threadId;
}
