import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  appendStoredThreadEventsInTransaction,
  createConnection,
  createThread,
  events,
  externalThreadBindings,
  externalThreadMessages,
  getThread,
  getThreadPluginMetadata,
  migrate,
  noopNotifier,
  projects,
  searchThreadsWithPendingInteractionState,
  threads,
} from "@bb/db";
import { createNodeBbSdk } from "@bb/sdk/node";
import type { ExperimentalImportHistoryRequest } from "@bb/server-contract";
import { importExternalHistory } from "../../src/services/threads/external-history.js";
import { ensureThreadIsWritable } from "../../src/services/threads/thread-send.js";
import { seedHostSession, seedProjectWithSource } from "../helpers/seed.js";
import { listQueuedThreadCommands } from "../helpers/commands.js";
import { withTestHarness } from "../helpers/test-app.js";

function memoryStore() {
  const db = createConnection(":memory:");
  migrate(db);
  db.insert(projects)
    .values({
      id: "proj_import",
      name: "External",
      kind: "standard",
      createdAt: 1,
      updatedAt: 1,
    })
    .run();
  const hub = {
    ...noopNotifier,
    notifyThread: vi.fn(),
    notifyProject: vi.fn(),
  };
  const batch: ExperimentalImportHistoryRequest = {
    projectId: "proj_import",
    pluginId: "dooffin-sync",
    sourceId: "gateway-a",
    conversationId: "topic-a",
    providerId: "openclaw",
    sessionId: "session-a",
    generation: 0,
    initialTitle: "Dooffin",
    initialPluginMetadata: { agentId: "dooffin" },
    messages: [
      {
        id: "m1",
        order: 10,
        role: "user",
        text: "usersearchterm",
        createdAt: 2000,
      },
      {
        id: "m2",
        order: 20,
        role: "assistant",
        text: "assistantsearchterm",
        createdAt: 1000,
      },
    ],
  };
  return { db, hub, batch, close: () => db.$client.close() };
}

describe("external history import", () => {
  it("retries atomically, preserves source order/time, indexes both roles, and stays passive", () => {
    const store = memoryStore();
    try {
      const result = importExternalHistory(store, store.batch);
      expect(result).toMatchObject({
        created: true,
        inserted: 2,
        skipped: 0,
        lastOrder: 20,
      });
      const thread = getThread(store.db, result.threadId)!;
      expect(thread).toMatchObject({
        providerId: "external-history",
        environmentId: null,
        status: "idle",
      });
      expect(thread.lastReadAt).toBe(thread.latestAttentionAt);
      expect(
        getThreadPluginMetadata(store.db, thread.id, "dooffin-sync").metadata,
      ).toEqual({ agentId: "dooffin" });
      expect(() => ensureThreadIsWritable(thread)).toThrow("cannot run turns");
      const messageEvents = store.db
        .select()
        .from(events)
        .where(
          and(
            eq(events.threadId, thread.id),
            eq(events.type, "item/completed"),
          ),
        )
        .orderBy(events.sequence)
        .all();
      expect(
        messageEvents.map((event) => [event.createdAt, event.itemKind]),
      ).toEqual([
        [2000, "userMessage"],
        [1000, "agentMessage"],
      ]);
      for (const query of ["usersearchterm", "assistantsearchterm"]) {
        expect(
          searchThreadsWithPendingInteractionState(store.db, {
            query,
            limitPerGroup: 10,
          }).active.total,
        ).toBe(1);
      }
      store.hub.notifyThread.mockClear();
      store.hub.notifyProject.mockClear();
      const replay = importExternalHistory(store, {
        ...store.batch,
        attention: "unread",
      });
      expect(replay).toMatchObject({
        threadId: thread.id,
        created: false,
        inserted: 0,
        skipped: 2,
      });
      expect(store.hub.notifyThread).not.toHaveBeenCalled();
      expect(store.hub.notifyProject).not.toHaveBeenCalled();
      expect(getThread(store.db, thread.id)).toEqual(thread);
      expect(store.db.select().from(events).all()).toHaveLength(6);
    } finally {
      store.close();
    }
  });

  it("continues overlapping batches, raises unread once, and retains history across source resets", () => {
    const store = memoryStore();
    try {
      const first = importExternalHistory(store, store.batch);
      const next = {
        ...store.batch,
        messages: [
          store.batch.messages[1]!,
          {
            id: "m3",
            order: 30,
            role: "assistant" as const,
            text: "new reply",
            createdAt: 3000,
          },
        ],
        attention: "unread" as const,
      };
      expect(importExternalHistory(store, next)).toMatchObject({
        inserted: 1,
        skipped: 1,
        lastOrder: 30,
      });
      const thread = getThread(store.db, first.threadId)!;
      expect(thread.lastReadAt).toBeNull();
      expect(thread.latestAttentionAt).toBeGreaterThan(3000);
      expect(store.hub.notifyThread).toHaveBeenLastCalledWith(
        thread.id,
        ["events-appended", "read-state-changed"],
        expect.objectContaining({ projectId: thread.projectId }),
      );
      expect(
        importExternalHistory(store, {
          ...store.batch,
          generation: 1,
          sessionId: "session-b",
          messages: [
            {
              id: "m1",
              order: 0,
              role: "user",
              text: "reset conversation",
              createdAt: 4000,
            },
          ],
        }),
      ).toMatchObject({
        threadId: thread.id,
        inserted: 1,
        generation: 1,
        lastOrder: 0,
      });
      expect(store.db.select().from(externalThreadMessages).all()).toHaveLength(
        4,
      );
      expect(store.db.select().from(events).all()).toHaveLength(12);
      expect(() => importExternalHistory(store, store.batch)).toThrow(
        "Stale source generation",
      );
    } finally {
      store.close();
    }
  });

  it("rejects conflicts and invalid batches without partial writes or notifications", () => {
    const store = memoryStore();
    try {
      expect(() =>
        importExternalHistory(store, {
          ...store.batch,
          messages: [store.batch.messages[1]!, store.batch.messages[0]!],
        }),
      ).toThrow("strictly increasing");
      expect(store.db.select().from(threads).all()).toHaveLength(0);
      expect(store.db.select().from(externalThreadBindings).all()).toHaveLength(
        0,
      );
      const first = importExternalHistory(store, store.batch);
      const thread = getThread(store.db, first.threadId);
      store.hub.notifyThread.mockClear();
      const conflicts: ExperimentalImportHistoryRequest[] = [
        {
          ...store.batch,
          messages: [
            {
              id: "m3",
              order: 30,
              role: "user",
              text: "valid prefix",
              createdAt: 3000,
            },
            { ...store.batch.messages[1]!, order: 40 },
          ],
        },
        {
          ...store.batch,
          messages: [
            { ...store.batch.messages[0]!, text: "changed" },
            {
              id: "m3",
              order: 30,
              role: "assistant",
              text: "should not persist",
              createdAt: 3000,
            },
          ],
        },
        {
          ...store.batch,
          messages: [
            {
              id: "late",
              order: 15,
              role: "user",
              text: "backfill",
              createdAt: 1,
            },
          ],
        },
        { ...store.batch, sessionId: "new-session" },
        { ...store.batch, providerId: "different-provider" },
        { ...store.batch, threadId: "unrelated" },
      ];
      for (const batch of conflicts)
        expect(() => importExternalHistory(store, batch)).toThrow();
      expect(store.db.select().from(events).all()).toHaveLength(6);
      expect(getThread(store.db, first.threadId)).toEqual(thread);
      expect(store.hub.notifyThread).not.toHaveBeenCalled();
      expect(() =>
        importExternalHistory(store, {
          ...store.batch,
          conversationId: "new",
          messages: Array.from({ length: 501 }, (_, order) => ({
            id: String(order),
            order,
            role: "user",
            text: "x",
            createdAt: 1,
          })),
        }),
      ).toThrow();
    } finally {
      store.close();
    }
  });

  it("rejects active canonical turns even when thread status says idle", () => {
    const store = memoryStore();
    try {
      const result = importExternalHistory(store, store.batch);
      store.db.transaction((tx) =>
        appendStoredThreadEventsInTransaction(tx, [
          {
            threadId: result.threadId,
            type: "turn/started",
            scope: { kind: "turn", turnId: "live" },
            providerThreadId: "live-session",
            data: { providerThreadId: "live-session" },
          },
        ]),
      );
      expect(() =>
        importExternalHistory(store, { ...store.batch, messages: [] }),
      ).toThrow("passive idle");
      store.db
        .update(threads)
        .set({ status: "active" })
        .where(eq(threads.id, result.threadId))
        .run();
      expect(() =>
        importExternalHistory(store, { ...store.batch, messages: [] }),
      ).toThrow("passive idle");
    } finally {
      store.close();
    }
  });

  it("cannot bind ordinary threads, bypass origin checks, import attachments, or start a model through SDK/HTTP", async () => {
    await withTestHarness(async (harness) => {
      const { host } = seedHostSession(harness.deps);
      const { project } = seedProjectWithSource(harness.deps, {
        hostId: host.id,
      });
      const sdk = createNodeBbSdk({
        baseUrl: "http://test",
        fetch: async (request, init) => harness.app.request(request, init),
      });
      const store = memoryStore();
      const batch = { ...store.batch, projectId: project.id };
      store.close();
      const result = await sdk.threads.experimental_importHistory(batch);
      const timeline = await sdk.threads.timeline({
        threadId: result.threadId,
      });
      expect(JSON.stringify(timeline)).toContain("usersearchterm");
      expect(JSON.stringify(timeline)).toContain("assistantsearchterm");
      expect(
        timeline.rows
          .filter((row) => row.kind === "conversation")
          .map((row) => row.createdAt),
      ).toEqual([2000, 1000]);
      const continued = await sdk.threads.experimental_importHistory({
        ...batch,
        messages: [
          {
            id: "m3",
            order: 30,
            role: "assistant",
            text: "live update",
            createdAt: 3000,
          },
        ],
        attention: "unread",
      });
      expect(continued).toMatchObject({
        threadId: result.threadId,
        inserted: 1,
        lastOrder: 30,
      });
      expect(
        await sdk.threads.timeline({ threadId: result.threadId }),
      ).toMatchObject({ maxSeq: 9 });
      expect(
        JSON.stringify(
          await sdk.threads.timeline({ threadId: result.threadId }),
        ),
      ).toContain("live update");
      expect(
        listQueuedThreadCommands(harness, "thread.start", result.threadId),
      ).toHaveLength(0);
      expect(
        listQueuedThreadCommands(harness, "turn.submit", result.threadId),
      ).toHaveLength(0);
      const post = (body: unknown, headers: Record<string, string> = {}) =>
        harness.app.request("/api/v1/threads/experimental-import-history", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        });
      const normal = createThread(harness.db, noopNotifier, {
        projectId: project.id,
        providerId: "codex",
        status: "idle",
      });
      expect(
        (await post({ ...batch, conversationId: "new", threadId: normal.id }))
          .status,
      ).toBe(409);
      expect(
        (
          await post({
            ...batch,
            messages: [{ ...batch.messages[0], attachments: ["/tmp/file"] }],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await post({
            ...batch,
            messages: [{ ...batch.messages[0], role: "tool" }],
          })
        ).status,
      ).toBe(400);
      expect(
        (await post(batch, { origin: "https://untrusted.invalid" })).status,
      ).toBe(403);
      expect((await post({ ...batch, projectId: "missing" })).status).toBe(404);
      expect(
        (await post({ ...batch, initialTitle: "x".repeat(1024 * 1024) }))
          .status,
      ).toBe(413);
      const send = await harness.app.request(
        `/api/v1/threads/${result.threadId}/send`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            mode: "start",
            input: [{ type: "text", text: "send" }],
          }),
        },
      );
      expect(send.status).toBe(409);
      expect(
        listQueuedThreadCommands(harness, "thread.start", result.threadId),
      ).toHaveLength(0);
    });
  });
});
