import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import {
  acquireProjectAttachmentOwnership,
  appendStoredThreadEventsInTransaction,
  createThread,
  events,
  externalThreadBindings,
  externalThreadMessages,
  getStoredProviderSession,
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
import { ensureThreadContextIsSettled } from "./thread-context-mutation-guard.js";
import { isExternalHistoryThreadSettled } from "./external-history-state.js";
import {
  externalHistoryItem,
  stableExternalHistoryJson,
  validateExistingExternalItem,
} from "./external-history-items.js";

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
  const entries = [
    ...batch.messages.map((message) => ({
      id: message.id,
      order: message.order,
      createdAt: message.createdAt,
      completedAt: message.createdAt,
      status: "completed" as const,
      digest: createHash("sha256")
        .update(
          stableExternalHistoryJson(
            JSON.stringify([
              message.order,
              message.role,
              message.text,
              message.createdAt,
              ...(message.attachments?.length ? [message.attachments] : []),
            ]),
          ),
        )
        .digest("hex"),
      items: [
        {
          createdAt: message.createdAt,
          existingSequence: message.existingSequence,
          existingCreatedAt: message.existingCreatedAt,
          item: externalHistoryItem(
            message.role === "user"
              ? {
                  type: "user",
                  text: message.text,
                  ...(message.attachments === undefined
                    ? {}
                    : { attachments: message.attachments }),
                }
              : { type: "assistant", text: message.text },
          ),
        },
      ],
    })),
    ...(batch.turns ?? []).map((turn) => ({
      ...turn,
      digest: createHash("sha256")
        .update(
          stableExternalHistoryJson(
            JSON.stringify([
              "turn",
              turn.order,
              turn.createdAt,
              turn.completedAt,
              turn.status,
              turn.items.map(({ item, createdAt }) => ({ item, createdAt })),
            ]),
          ),
        )
        .digest("hex"),
      items: turn.items.map((entry) => ({
        ...entry,
        item: externalHistoryItem(entry.item),
      })),
    })),
  ].sort((a, b) => a.order - b.order);
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
      const existingThreadId = binding?.threadId ?? batch.adoptThreadId;
      if (
        batch.adoptThreadId &&
        binding &&
        batch.adoptThreadId !== binding.threadId
      )
        conflict("adoptThreadId differs from the bound thread");
      if (existingThreadId) {
        ensureThreadContextIsSettled(existingThreadId);
        const thread = requirePublicThread(deps.db, existingThreadId);
        if (
          thread.projectId !== batch.projectId ||
          (thread.archivedAt !== null &&
            !(
              batch.adoptThreadId === thread.id &&
              entries.every((entry) =>
                entry.items.every(
                  (item) => item.existingSequence !== undefined,
                ),
              )
            )) ||
          !isExternalHistoryThreadSettled(tx, thread)
        )
          conflict(
            "Import requires an idle, unarchived thread in this project",
          );
        if (!binding) {
          const other = tx
            .select()
            .from(externalThreadBindings)
            .where(eq(externalThreadBindings.threadId, thread.id))
            .get();
          const session = getStoredProviderSession(tx, thread.id);
          if (
            other ||
            thread.providerId !== batch.providerId ||
            session.kind !== "owned" ||
            session.providerThreadId !== batch.sessionId
          )
            conflict(
              "Adoption requires an unbound thread owning the exact provider session",
            );
          if (
            entries.some((entry) =>
              entry.items.some((item) => item.existingSequence === undefined),
            )
          )
            conflict("Adoption must reference existing events for every item");
        } else if (thread.providerId === "external-history") {
          if (thread.environmentId !== null)
            conflict("Passive external thread has an environment");
        } else {
          const session = getStoredProviderSession(tx, thread.id);
          if (
            thread.environmentId === null ||
            session.kind !== "owned" ||
            session.providerThreadId !== binding.runtimeSessionId ||
            thread.providerId !== binding.runtimeProviderId
          )
            conflict(
              "Interactive session differs from its external binding; release it before syncing",
            );
          if (batch.generation !== binding.generation)
            conflict(
              "Release the interactive session before importing a reset",
            );
        }
      } else if (
        entries.some((entry) =>
          entry.items.some((item) => item.existingSequence !== undefined),
        )
      )
        conflict("Existing sequences require an existing or adopted thread");
      const threadId =
        existingThreadId ??
        createThread(tx, noopNotifier, {
          projectId: batch.projectId,
          providerId: "external-history",
          status: "idle",
          title: batch.initialTitle ?? null,
          titleFallback: batch.initialSourceTitle ?? null,
          originPluginId: batch.pluginId,
          pluginMetadata:
            batch.initialPluginMetadata === undefined
              ? null
              : {
                  pluginId: batch.pluginId,
                  metadata: batch.initialPluginMetadata,
                },
        }).id;
      if (
        !existingThreadId &&
        (batch.initialCreatedAt !== undefined ||
          batch.initialUpdatedAt !== undefined)
      ) {
        const thread = requirePublicThread(deps.db, threadId);
        const createdAt = batch.initialCreatedAt ?? thread.createdAt;
        const updatedAt =
          batch.initialUpdatedAt ?? Math.max(createdAt, thread.updatedAt);
        if (updatedAt < createdAt)
          conflict("Initial activity cannot precede creation");
        tx.update(threads)
          .set({ createdAt, updatedAt })
          .where(eq(threads.id, threadId))
          .run();
      }
      let lastOrder =
        binding?.generation === batch.generation ? binding.lastOrder : null;
      const existing =
        entries.length === 0
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
                    entries.map((entry) => entry.id),
                  ),
                ),
              )
              .all();
      const byId = new Map(
        existing.map((message) => [message.externalId, message]),
      );
      const pending = entries.filter((entry) => {
        const old = byId.get(entry.id);
        if (old) {
          if (old.digest !== entry.digest || old.sessionId !== batch.sessionId)
            conflict(`Message ${entry.id} changed; edits are unsupported`);
          if (entry.items.some((item) => item.existingSequence !== undefined)) {
            if (
              entry.items[0]?.existingSequence !== old.sourceSequence ||
              entry.items.some((item) => item.existingSequence === undefined)
            )
              conflict("Replay must reference the original existing sequences");
            for (const item of entry.items) {
              const row = tx
                .select()
                .from(events)
                .where(
                  and(
                    eq(events.threadId, threadId),
                    eq(events.sequence, item.existingSequence!),
                  ),
                )
                .get();
              validateExistingExternalItem(
                row,
                item.item,
                item.existingCreatedAt ?? item.createdAt,
              );
            }
          }
          return false;
        }
        if (lastOrder !== null && entry.order <= lastOrder)
          conflict(`Message ${entry.id} precedes the import cursor`);
        lastOrder = entry.order;
        return true;
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
            runtimeProviderId: batch.adoptThreadId
              ? requirePublicThread(deps.db, threadId).providerId
              : null,
            runtimeSessionId: batch.adoptThreadId ? batch.sessionId : null,
            lastOrder: null,
          })
          .run();
      let appended = 0;
      for (const entry of pending) {
        const paths = entry.items.flatMap(({ item }) =>
          item.type === "userMessage"
            ? item.content.flatMap((part) =>
                part.type === "localFile" || part.type === "localImage"
                  ? [part.path]
                  : [],
              )
            : [],
        );
        acquireProjectAttachmentOwnership(tx, threadId, paths);
        let sourceSequence: number;
        if (entry.items.every((item) => item.existingSequence !== undefined)) {
          for (const item of entry.items) {
            const row = tx
              .select()
              .from(events)
              .where(
                and(
                  eq(events.threadId, threadId),
                  eq(events.sequence, item.existingSequence!),
                ),
              )
              .get();
            validateExistingExternalItem(
              row,
              item.item,
              item.existingCreatedAt ?? item.createdAt,
            );
          }
          sourceSequence = entry.items[0]!.existingSequence!;
        } else {
          if (entry.items.some((item) => item.existingSequence !== undefined))
            conflict("A completed turn cannot mix existing and new items");
          const scope = {
            kind: "turn" as const,
            turnId: `external_${randomUUID()}`,
          };
          const common = { threadId, scope, providerThreadId: batch.sessionId };
          const stored: AppendStoredThreadEventArgs[] = [
            {
              ...common,
              createdAt: entry.createdAt,
              type: "turn/started",
              data: { providerThreadId: batch.sessionId },
            },
            ...entry.items.map(
              ({ item, createdAt }): AppendStoredThreadEventArgs => ({
                ...common,
                createdAt,
                type: "item/completed",
                data: { providerThreadId: batch.sessionId, item },
              }),
            ),
            {
              ...common,
              createdAt: entry.completedAt,
              type: "turn/completed",
              data: { providerThreadId: batch.sessionId, status: entry.status },
            },
          ];
          const sequences = appendStoredThreadEventsInTransaction(tx, stored);
          if (sequences[1] === undefined)
            throw new Error("Missing imported message sequence");
          sourceSequence = sequences[1];
          appended++;
        }
        tx.insert(externalThreadMessages)
          .values({
            threadId,
            generation: batch.generation,
            externalId: entry.id,
            sourceOrder: entry.order,
            digest: entry.digest,
            sessionId: batch.sessionId,
            sourceSequence,
          })
          .run();
      }
      if (
        !binding ||
        pending.length > 0 ||
        batch.generation > binding.generation
      )
        tx.update(externalThreadBindings)
          .set({
            generation: batch.generation,
            sessionId: batch.sessionId,
            lastOrder,
          })
          .where(eq(externalThreadBindings.threadId, threadId))
          .run();
      const importedThread = requirePublicThread(deps.db, threadId);
      if (
        batch.activityAt !== undefined &&
        batch.activityAt < importedThread.createdAt
      )
        conflict("Source activity cannot precede thread creation");
      if (appended > 0)
        tx.update(threads)
          .set({
            updatedAt:
              batch.activityAt === undefined
                ? !existingThreadId && batch.initialUpdatedAt !== undefined
                  ? batch.initialUpdatedAt
                  : Date.now()
                : Math.max(importedThread.updatedAt, batch.activityAt),
            ...(batch.attention === "unread"
              ? { latestAttentionAt: Date.now(), lastReadAt: null }
              : {}),
          })
          .where(eq(threads.id, threadId))
          .run();
      return {
        threadId,
        created: !existingThreadId,
        inserted: pending.length,
        skipped: entries.length - pending.length,
        generation: batch.generation,
        lastOrder,
        appended,
      };
    },
    { behavior: "immediate" },
  );
  if (result.created)
    emitPluginThreadCreated(requirePublicThread(deps.db, result.threadId));
  if (result.created || result.appended > 0) {
    deps.hub.notifyThread(
      result.threadId,
      [
        ...(result.created ? ["thread-created" as const] : []),
        ...(result.appended > 0 ? ["events-appended" as const] : []),
        ...(result.appended > 0 && batch.attention === "unread"
          ? ["read-state-changed" as const]
          : []),
      ],
      {
        projectId: batch.projectId,
        eventTypes:
          result.appended > 0
            ? ["turn/started", "item/completed", "turn/completed"]
            : [],
      },
    );
    deps.hub.notifyProject(batch.projectId, ["threads-changed"]);
  }
  const { appended: _appended, ...response } = result;
  return response;
}
