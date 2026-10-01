import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  appendStoredThreadEventsInTransaction,
  createThread,
  externalThreadBindings,
  externalThreadMessages,
  getActiveStoredTurnId,
  noopNotifier,
  threads,
  type DbConnection,
  type DbNotifier,
  type AppendStoredThreadEventArgs,
} from "@bb/db";
import {
  experimentalImportHistoryRequestSchema,
  type ExperimentalImportHistoryRequest,
  type ExperimentalImportHistoryResponse,
} from "@bb/server-contract";
import {
  requirePublicProject,
  requirePublicThread,
} from "../lib/entity-lookup.js";
import { ApiError } from "../../errors.js";
import { emitPluginThreadCreated } from "../plugins/plugin-thread-events.js";

function conflict(message: string): never {
  throw new ApiError(409, "external_history_conflict", message);
}

export function importExternalHistory(
  deps: { db: DbConnection; hub: DbNotifier },
  input: ExperimentalImportHistoryRequest,
): ExperimentalImportHistoryResponse {
  const parsed = experimentalImportHistoryRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(400, "invalid_request", parsed.error.message);
  const batch = parsed.data;
  const result = deps.db.transaction(
    (tx) => {
      requirePublicProject(deps.db, batch.projectId);
      const binding = tx
        .select()
        .from(externalThreadBindings)
        .where(
          and(
            eq(externalThreadBindings.projectId, batch.projectId),
            eq(externalThreadBindings.pluginId, batch.pluginId),
            eq(externalThreadBindings.sourceId, batch.sourceId),
            eq(externalThreadBindings.conversationId, batch.conversationId),
          ),
        )
        .get();
      if (batch.threadId !== undefined && batch.threadId !== binding?.threadId)
        conflict("threadId must match an existing external binding");
      if (binding && binding.providerId !== batch.providerId)
        conflict("External provider identity is immutable");
      if (binding && batch.generation < binding.generation)
        conflict("Stale source generation");
      if (
        binding &&
        batch.generation === binding.generation &&
        batch.sessionId !== binding.sessionId
      )
        conflict("Session replacement requires a higher generation");
      if (binding) {
        const thread = requirePublicThread(deps.db, binding.threadId);
        if (
          thread.archivedAt !== null ||
          thread.status !== "idle" ||
          thread.environmentId !== null ||
          getActiveStoredTurnId(tx, thread.id) !== null
        )
          conflict("Import requires a passive idle, unarchived thread");
        if (thread.providerId !== "external-history")
          conflict("External thread is no longer passive");
      }
      const threadId =
        binding?.threadId ??
        createThread(tx, noopNotifier, {
          projectId: batch.projectId,
          providerId: "external-history",
          status: "idle",
          title: batch.initialTitle ?? null,
          originPluginId: batch.pluginId,
          pluginMetadata:
            batch.initialPluginMetadata === undefined
              ? null
              : {
                  pluginId: batch.pluginId,
                  metadata: batch.initialPluginMetadata,
                },
        }).id;
      const previousOrder =
        binding?.generation === batch.generation ? binding.lastOrder : null;
      let lastOrder = previousOrder;
      const existing =
        batch.messages.length === 0
          ? []
          : tx
              .select()
              .from(externalThreadMessages)
              .where(
                and(
                  eq(externalThreadMessages.threadId, threadId),
                  eq(externalThreadMessages.generation, batch.generation),
                  inArray(
                    externalThreadMessages.externalId,
                    batch.messages.map((message) => message.id),
                  ),
                ),
              )
              .all();
      const byId = new Map(
        existing.map((message) => [message.externalId, message]),
      );
      const pending = batch.messages.flatMap((message) => {
        const digest = createHash("sha256")
          .update(
            JSON.stringify([
              message.order,
              message.role,
              message.text,
              message.createdAt,
            ]),
          )
          .digest("hex");
        const old = byId.get(message.id);
        if (old) {
          if (old.digest !== digest || old.sessionId !== batch.sessionId)
            conflict(`Message ${message.id} changed; edits are unsupported`);
          return [];
        }
        if (lastOrder !== null && message.order <= lastOrder)
          conflict(`Message ${message.id} precedes the import cursor`);
        lastOrder = message.order;
        return [{ message, digest }];
      });
      if (!binding)
        tx.insert(externalThreadBindings)
          .values({
            threadId,
            projectId: batch.projectId,
            pluginId: batch.pluginId,
            sourceId: batch.sourceId,
            conversationId: batch.conversationId,
            providerId: batch.providerId,
            sessionId: batch.sessionId,
            generation: batch.generation,
            lastOrder: null,
          })
          .run();
      for (const { message, digest } of pending) {
        const scope = {
          kind: "turn" as const,
          turnId: `external_${randomUUID()}`,
        };
        const itemId = `external_${randomUUID()}`;
        const common = {
          threadId,
          scope,
          providerThreadId: batch.sessionId,
          createdAt: message.createdAt,
        };
        const events: AppendStoredThreadEventArgs[] = [
          {
            ...common,
            type: "turn/started",
            data: { providerThreadId: batch.sessionId },
          },
          {
            ...common,
            type: "item/completed",
            data: {
              providerThreadId: batch.sessionId,
              item:
                message.role === "user"
                  ? {
                      type: "userMessage",
                      id: itemId,
                      experimental_externalHistory: true,
                      content: [{ type: "text", text: message.text }],
                    }
                  : { type: "agentMessage", id: itemId, text: message.text },
            },
          },
          {
            ...common,
            type: "turn/completed",
            data: { providerThreadId: batch.sessionId, status: "completed" },
          },
        ];
        const sequences = appendStoredThreadEventsInTransaction(tx, events);
        const sourceSequence = sequences[1];
        if (sourceSequence === undefined)
          throw new Error("Missing imported message sequence");
        tx.insert(externalThreadMessages)
          .values({
            threadId,
            generation: batch.generation,
            externalId: message.id,
            sourceOrder: message.order,
            digest,
            sessionId: batch.sessionId,
            sourceSequence,
          })
          .run();
      }
      const generationChanged =
        binding !== undefined && batch.generation > binding.generation;
      if (!binding || pending.length > 0 || generationChanged) {
        tx.update(externalThreadBindings)
          .set({
            generation: batch.generation,
            sessionId: batch.sessionId,
            lastOrder,
          })
          .where(eq(externalThreadBindings.threadId, threadId))
          .run();
      }
      if (pending.length > 0) {
        const now = Date.now();
        tx.update(threads)
          .set({
            updatedAt: now,
            ...(batch.attention === "unread"
              ? { latestAttentionAt: now, lastReadAt: null }
              : {}),
          })
          .where(eq(threads.id, threadId))
          .run();
      }
      return {
        threadId,
        created: !binding,
        inserted: pending.length,
        skipped: batch.messages.length - pending.length,
        generation: batch.generation,
        lastOrder,
      };
    },
    { behavior: "immediate" },
  );
  if (result.created)
    emitPluginThreadCreated(requirePublicThread(deps.db, result.threadId));
  if (result.created || result.inserted > 0) {
    deps.hub.notifyThread(
      result.threadId,
      [
        ...(result.created ? ["thread-created" as const] : []),
        ...(result.inserted > 0 ? ["events-appended" as const] : []),
        ...(result.inserted > 0 && batch.attention === "unread"
          ? ["read-state-changed" as const]
          : []),
      ],
      {
        projectId: batch.projectId,
        eventTypes:
          result.inserted > 0
            ? ["turn/started", "item/completed", "turn/completed"]
            : [],
      },
    );
    deps.hub.notifyProject(batch.projectId, ["threads-changed"]);
  }
  return result;
}
