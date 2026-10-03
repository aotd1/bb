import { and, eq, ne, or, isNull } from "drizzle-orm";
import {
  appendStoredThreadEventsInTransaction,
  classifyStoredProviderThreadClaim,
  externalThreadBindings,
  events,
  getStoredProviderSession,
  getHost,
  environments,
  threads,
} from "@bb/db";
import {
  experimentalBindExternalSessionRequestSchema,
  experimentalExternalSessionRequestSchema,
  externalThreadIdentitySchema,
  type ExperimentalBindExternalSessionRequest,
  type ExperimentalExternalSessionResponse,
  type ExperimentalFindExternalThreadRequest,
  type ExperimentalFindExternalThreadResponse,
  type ExperimentalReleaseExternalSessionRequest,
} from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import {
  requireEnvironment,
  requirePublicProject,
  requirePublicThread,
  requireReadyEnvironment,
} from "../lib/entity-lookup.js";
import { requireBridgeLaunchForProviderId } from "../system/provider-bridge-launch.js";
import {
  ensureThreadContextIsSettled,
  withThreadContextClearGuard,
} from "./thread-context-mutation-guard.js";
import { releaseIdleThreadRuntime } from "./thread-lifecycle.js";
import { isExternalHistoryThreadSettled } from "./external-history-state.js";

function conflict(message: string): never {
  throw new ApiError(409, "external_history_conflict", message);
}

function target(
  deps: Pick<AppDeps, "db" | "pendingInteractions">,
  input: ExperimentalReleaseExternalSessionRequest,
) {
  const thread = requirePublicThread(deps.db, input.threadId);
  const binding = deps.db
    .select()
    .from(externalThreadBindings)
    .where(eq(externalThreadBindings.threadId, thread.id))
    .get();
  if (!binding || binding.pluginId !== input.pluginId)
    throw new ApiError(
      404,
      "thread_not_found",
      "External thread not found for this plugin",
    );
  if (
    binding.generation !== input.expectedGeneration ||
    binding.sessionId !== input.expectedSessionId
  )
    conflict("External binding changed; refresh before binding or releasing");
  if (
    thread.archivedAt !== null ||
    !isExternalHistoryThreadSettled(deps.db, thread) ||
    deps.pendingInteractions.hasTurnBoundPendingThreadInteraction(thread.id)
  )
    conflict(
      "External session changes require an idle, unarchived thread without queued work or interactions",
    );
  return { thread, binding };
}

export function findExternalThread(
  deps: Pick<AppDeps, "db">,
  input: ExperimentalFindExternalThreadRequest,
): ExperimentalFindExternalThreadResponse {
  const parsed = externalThreadIdentitySchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(400, "invalid_request", parsed.error.message);
  const key = parsed.data;
  requirePublicProject(deps.db, key.projectId);
  const binding = deps.db
    .select()
    .from(externalThreadBindings)
    .where(
      and(
        eq(externalThreadBindings.projectId, key.projectId),
        eq(externalThreadBindings.pluginId, key.pluginId),
        eq(externalThreadBindings.sourceId, key.sourceId),
        eq(externalThreadBindings.conversationId, key.conversationId),
      ),
    )
    .get();
  if (!binding) return { binding: null };
  const thread = requirePublicThread(deps.db, binding.threadId);
  return {
    binding: {
      threadId: thread.id,
      providerId: binding.providerId,
      sessionId: binding.sessionId,
      generation: binding.generation,
      lastOrder: binding.lastOrder,
      mode:
        thread.providerId === "external-history" ? "passive" : "interactive",
      runtimeProviderId: thread.providerId,
      runtimeProviderThreadId: binding.runtimeSessionId,
      environmentId: thread.environmentId,
      archived: thread.archivedAt !== null,
    },
  };
}

export function bindExternalSession(
  deps: Pick<
    AppDeps,
    | "db"
    | "hub"
    | "providerRegistry"
    | "pluginHostArtifacts"
    | "pendingInteractions"
  >,
  input: ExperimentalBindExternalSessionRequest,
): ExperimentalExternalSessionResponse {
  const parsed = experimentalBindExternalSessionRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(400, "invalid_request", parsed.error.message);
  const args = parsed.data;
  ensureThreadContextIsSettled(args.threadId);
  requireBridgeLaunchForProviderId(deps, args.providerId);
  const result = deps.db.transaction(
    (tx) => {
      const { thread, binding } = target(deps, args);
      const environment = requireReadyEnvironment(deps.db, args.environmentId);
      const host = getHost(tx, environment.hostId);
      if (
        !host ||
        host.phase !== "active" ||
        environment.teardownStatus !== null ||
        environment.projectId !== thread.projectId ||
        (environment.ownerThreadId !== null &&
          environment.ownerThreadId !== thread.id)
      )
        conflict("Environment must belong to this project and an active host");
      if (thread.providerId !== "external-history") {
        const session = getStoredProviderSession(tx, thread.id);
        if (
          thread.providerId === args.providerId &&
          thread.environmentId === args.environmentId &&
          session.kind === "owned" &&
          session.providerThreadId === args.providerThreadId &&
          binding.runtimeProviderId === args.providerId &&
          binding.runtimeSessionId === args.providerThreadId
        )
          return {
            threadId: thread.id,
            changed: false,
            mode: "interactive" as const,
          };
        conflict("Release the existing interactive session before rebinding");
      }
      if (thread.environmentId !== null)
        conflict("Passive thread unexpectedly has an environment");
      const otherClaim = tx
        .select({ threadId: threads.id })
        .from(events)
        .innerJoin(threads, eq(threads.id, events.threadId))
        .leftJoin(environments, eq(environments.id, threads.environmentId))
        .where(
          and(
            eq(events.type, "thread/identity"),
            eq(events.providerThreadId, args.providerThreadId),
            eq(threads.providerId, args.providerId),
            ne(threads.id, thread.id),
            or(
              eq(environments.hostId, environment.hostId),
              isNull(environments.hostId),
            ),
          ),
        )
        .limit(1)
        .get();
      if (otherClaim)
        conflict(
          "Provider session is already claimed by another thread on this host",
        );
      tx.update(threads)
        .set({ providerId: args.providerId, environmentId: environment.id })
        .where(eq(threads.id, thread.id))
        .run();
      tx.update(environments)
        .set({ retireAt: null })
        .where(eq(environments.id, environment.id))
        .run();
      const claim = classifyStoredProviderThreadClaim(tx, {
        threadId: thread.id,
        providerThreadId: args.providerThreadId,
      });
      if (claim === "foreign" || claim === "ambiguous")
        conflict(
          "Provider session is already claimed by another thread on this host",
        );
      tx.update(externalThreadBindings)
        .set({
          runtimeProviderId: args.providerId,
          runtimeSessionId: args.providerThreadId,
        })
        .where(eq(externalThreadBindings.threadId, thread.id))
        .run();
      appendStoredThreadEventsInTransaction(tx, [
        {
          threadId: thread.id,
          environmentId: environment.id,
          providerThreadId: args.providerThreadId,
          scope: { kind: "thread" },
          type: "thread/identity",
          data: { providerThreadId: args.providerThreadId },
        },
      ]);
      return {
        threadId: thread.id,
        changed: true,
        mode: "interactive" as const,
      };
    },
    { behavior: "immediate" },
  );
  if (result.changed) {
    deps.hub.notifyThread(
      result.threadId,
      ["events-appended", "status-changed", "environment-changed"],
      {
        projectId: requirePublicThread(deps.db, result.threadId).projectId,
        eventTypes: ["thread/identity"],
      },
    );
    deps.hub.notifyEnvironment(args.environmentId, ["metadata-changed"]);
    deps.hub.notifyProject(
      requirePublicThread(deps.db, result.threadId).projectId,
      ["threads-changed"],
    );
  }
  return result;
}

export async function releaseExternalSession(
  deps: AppDeps,
  input: ExperimentalReleaseExternalSessionRequest,
): Promise<ExperimentalExternalSessionResponse> {
  const parsed = experimentalExternalSessionRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(400, "invalid_request", parsed.error.message);
  const args = parsed.data;
  return withThreadContextClearGuard(args.threadId, async () => {
    const { thread } = target(deps, args);
    if (thread.providerId === "external-history")
      return { threadId: thread.id, changed: false, mode: "passive" };
    if (thread.environmentId === null)
      conflict("Interactive thread has no environment");
    const environment = requireEnvironment(deps.db, thread.environmentId);
    await releaseIdleThreadRuntime(deps, thread, environment);
    deps.db.transaction(
      (tx) => {
        const current = target(deps, args).thread;
        if (
          current.providerId !== thread.providerId ||
          current.environmentId !== thread.environmentId
        )
          conflict("Thread binding changed while releasing its runtime");
        tx.update(externalThreadBindings)
          .set({ runtimeProviderId: null, runtimeSessionId: null })
          .where(eq(externalThreadBindings.threadId, thread.id))
          .run();
        tx.update(threads)
          .set({
            providerId: "external-history",
            environmentId: null,
            status: "idle",
          })
          .where(eq(threads.id, thread.id))
          .run();
      },
      { behavior: "immediate" },
    );
    deps.hub.notifyThread(
      thread.id,
      ["status-changed", "environment-changed"],
      { projectId: thread.projectId },
    );
    deps.hub.notifyProject(thread.projectId, ["threads-changed"]);
    return { threadId: thread.id, changed: true, mode: "passive" };
  });
}
