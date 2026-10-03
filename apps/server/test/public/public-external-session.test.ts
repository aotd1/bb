import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  appendStoredThreadEventsInTransaction,
  createPendingInteraction,
  events,
  externalThreadBindings,
  externalThreadMessages,
  getStoredProviderSession,
  getThread,
  projectAttachmentThreads,
  recordProjectAttachment,
  searchThreadsWithPendingInteractionState,
  threads,
} from "@bb/db";
import type { ExperimentalImportHistoryRequest } from "@bb/server-contract";
import {
  bindExternalSession,
  findExternalThread,
} from "../../src/services/threads/external-session.js";
import { importExternalHistory } from "../../src/services/threads/external-history.js";
import { withThreadSendGuard } from "../../src/services/threads/thread-context-mutation-guard.js";
import {
  listQueuedThreadCommands,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
  seedQueuedMessage,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";
import { createCommandApprovalPayload } from "../helpers/pending-interactions.js";

function fixture(harness: TestAppHarness, providerId = "codex") {
  if (providerId !== "codex") {
    const registration = harness.deps.providerRegistry.get("codex")!;
    harness.deps.providerRegistry.register({
      ...registration,
      info: {
        ...registration.info,
        id: providerId,
        displayName: "Mr Dooffin test",
      },
      pluginId: "test-dooffin-provider",
      deriveProviderOptions(context): Record<string, string> {
        const external = context.experimental_externalSession;
        return external === undefined
          ? {}
          : {
              expectedSourceSessionId: external.sessionId,
              sessionKey: external.providerThreadId,
            };
      },
    });
    harness.deps.pluginHostArtifacts.set(
      "test-dooffin-provider",
      harness.deps.pluginHostArtifacts.get(registration.pluginId)!,
    );
  }
  const { host } = seedHostSession(harness.deps);
  const { project } = seedProjectWithSource(harness.deps, { hostId: host.id });
  const environment = seedEnvironment(harness.deps, {
    hostId: host.id,
    projectId: project.id,
  });
  const batch: ExperimentalImportHistoryRequest = {
    projectId: project.id,
    pluginId: "sync",
    providerId,
    sourceId: "machine-a",
    conversationId: "conversation-a",
    sessionId: "external-session-a",
    generation: 0,
    messages: [
      {
        id: "m1",
        order: 0,
        role: "assistant",
        text: "original reply",
        createdAt: 1000,
      },
    ],
  };
  const imported = importExternalHistory(harness.deps, batch);
  const bind = {
    pluginId: "sync",
    threadId: imported.threadId,
    expectedGeneration: 0,
    expectedSessionId: batch.sessionId,
    providerId,
    providerThreadId:
      providerId === "codex"
        ? batch.sessionId
        : "agent:dooffin:telegram:group:topic:123",
    environmentId: environment.id,
  };
  const release = {
    pluginId: bind.pluginId,
    threadId: imported.threadId,
    expectedGeneration: bind.expectedGeneration,
    expectedSessionId: bind.expectedSessionId,
  };
  return { host, project, environment, batch, imported, bind, release };
}

async function post(harness: TestAppHarness, operation: string, body: object) {
  return harness.app.request(`/api/v1/threads/experimental-${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("external provider sessions", () => {
  it.each([
    [false, "status"],
    [false, "turn"],
    [false, "queue"],
    [true, "status"],
    [true, "turn"],
    [true, "queue"],
  ] as const)(
    "rejects history, bind and release with unsettled work (bound: %s, state: %s)",
    async (bound, state) => {
      await withTestHarness(async (harness) => {
        const f = fixture(harness);
        if (bound) bindExternalSession(harness.deps, f.bind);
        if (state === "status") {
          harness.db
            .update(threads)
            .set({ status: "active" })
            .where(eq(threads.id, f.imported.threadId))
            .run();
        } else if (state === "turn") {
          harness.db.transaction((tx) =>
            appendStoredThreadEventsInTransaction(tx, [
              {
                threadId: f.imported.threadId,
                type: "turn/started",
                scope: { kind: "turn", turnId: "live" },
                providerThreadId: f.bind.providerThreadId,
                data: { providerThreadId: f.bind.providerThreadId },
              },
            ]),
          );
        } else {
          seedQueuedMessage(harness.deps, {
            threadId: f.imported.threadId,
            content: [{ type: "text", text: "queued", mentions: [] }],
          });
        }
        const before = getThread(harness.db, f.imported.threadId);
        const beforeEvents = harness.db.select().from(events).all();
        const beforeBinding = harness.db
          .select()
          .from(externalThreadBindings)
          .all();
        expect(() => importExternalHistory(harness.deps, f.batch)).toThrow(
          "idle, unarchived",
        );
        expect(() => bindExternalSession(harness.deps, f.bind)).toThrow(
          "idle, unarchived",
        );
        expect(
          (await post(harness, "release-external-session", f.release)).status,
        ).toBe(409);
        expect(getThread(harness.db, f.imported.threadId)).toEqual(before);
        expect(harness.db.select().from(events).all()).toEqual(beforeEvents);
        expect(harness.db.select().from(externalThreadBindings).all()).toEqual(
          beforeBinding,
        );
        for (const type of ["turn.submit", "thread.stop"] as const)
          expect(
            listQueuedThreadCommands(harness, type, f.imported.threadId),
          ).toEqual([]);
      });
    },
  );

  it.each([false, true])(
    "keeps history independent of interactions, while session changes reject turn-bound ones (%s)",
    async (turnBound) => {
      await withTestHarness(async (harness) => {
        const f = fixture(harness);
        createPendingInteraction(harness.db, {
          threadId: f.imported.threadId,
          payload: JSON.stringify(
            turnBound
              ? createCommandApprovalPayload()
              : { kind: "plugin", title: "Confirm" },
          ),
          ...(turnBound
            ? {
                originKind: "provider" as const,
                providerId: "codex",
                providerThreadId: f.bind.providerThreadId,
                providerRequestId: "pending-request",
                turnId: "pending-turn",
              }
            : {
                originKind: "plugin" as const,
                pluginId: "test-card",
                rendererId: "confirm",
                turnId: null,
              }),
        });
        expect(
          importExternalHistory(harness.deps, {
            ...f.batch,
            messages: [
              {
                id: "m2",
                order: 1,
                role: "assistant",
                text: "later reply",
                createdAt: 2000,
              },
            ],
          }).inserted,
        ).toBe(1);
        expect(
          (await post(harness, "release-external-session", f.release)).status,
        ).toBe(turnBound ? 409 : 200);
        if (turnBound) {
          expect(() => bindExternalSession(harness.deps, f.bind)).toThrow(
            "interactions",
          );
        } else {
          expect(bindExternalSession(harness.deps, f.bind).mode).toBe(
            "interactive",
          );
        }
        for (const type of ["turn.submit", "thread.stop"] as const)
          expect(
            listQueuedThreadCommands(harness, type, f.imported.threadId),
          ).toEqual([]);
      });
    },
  );

  it.each(["codex", "openclaw-dooffin"])(
    "binds without host work and routes the explicit send to the imported session: %s",
    async (providerId) => {
      await withTestHarness(async (harness) => {
        const f = fixture(harness, providerId);
        const before = harness.db.select().from(events).all().length;
        expect(
          await (await post(harness, "bind-external-session", f.bind)).json(),
        ).toEqual({
          threadId: f.imported.threadId,
          changed: true,
          mode: "interactive",
        });
        expect(getThread(harness.db, f.imported.threadId)).toMatchObject({
          providerId,
          environmentId: f.environment.id,
          status: "idle",
        });
        expect(
          getStoredProviderSession(harness.db, f.imported.threadId),
        ).toEqual({ kind: "owned", providerThreadId: f.bind.providerThreadId });
        expect(
          listQueuedThreadCommands(
            harness,
            "thread.start",
            f.imported.threadId,
          ),
        ).toHaveLength(0);
        expect(
          listQueuedThreadCommands(harness, "turn.submit", f.imported.threadId),
        ).toHaveLength(0);
        expect(bindExternalSession(harness.deps, f.bind)).toMatchObject({
          changed: false,
        });
        expect(harness.db.select().from(events).all()).toHaveLength(before + 1);
        expect(importExternalHistory(harness.deps, f.batch)).toMatchObject({
          inserted: 0,
          skipped: 1,
        });
        const send = await harness.app.request(
          `/api/v1/threads/${f.imported.threadId}/send`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input: [{ type: "text", text: "continue here", mentions: [] }],
              mode: "start",
              model: "gpt-5",
              permissionMode: "full",
              reasoningLevel: "medium",
              serviceTier: "default",
            }),
          },
        );
        expect(send.status).toBe(200);
        const command = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "turn.submit" &&
            command.threadId === f.imported.threadId,
        );
        expect(command.command).toMatchObject({
          type: "turn.submit",
          resumeContext: {
            providerId,
            providerThreadId: f.bind.providerThreadId,
          },
          environmentId: f.environment.id,
        });
        if (providerId !== "codex")
          expect(command.command).toMatchObject({
            options: {
              providerOptions: {
                expectedSourceSessionId: f.batch.sessionId,
                sessionKey: f.bind.providerThreadId,
              },
            },
          });
        expect(
          listQueuedThreadCommands(
            harness,
            "thread.start",
            f.imported.threadId,
          ),
        ).toHaveLength(0);
        expect(() =>
          importExternalHistory(harness.deps, {
            ...f.batch,
            messages: [
              {
                id: "m2",
                order: 1,
                role: "assistant",
                text: "outside reply",
                createdAt: 2000,
              },
            ],
          }),
        ).toThrow("idle");
      });
    },
  );

  it("refuses provider/session/ownership/environment conflicts atomically", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const before = getThread(harness.db, f.imported.threadId);
      for (const input of [
        { ...f.bind, providerId: "not-installed" },
        { ...f.bind, expectedGeneration: 1 },
        { ...f.bind, expectedSessionId: "other-session" },
        { ...f.bind, pluginId: "other-plugin" },
      ])
        expect(
          (await post(harness, "bind-external-session", input)).status,
        ).toBeGreaterThanOrEqual(400);
      const { project: foreign } = seedProjectWithSource(harness.deps, {
        hostId: f.host.id,
        path: "/tmp/foreign-project",
      });
      const otherEnvironment = seedEnvironment(harness.deps, {
        hostId: f.host.id,
        projectId: foreign.id,
        path: "/tmp/foreign-env",
      });
      expect(() =>
        bindExternalSession(harness.deps, {
          ...f.bind,
          environmentId: otherEnvironment.id,
        }),
      ).toThrow("Environment");
      expect(getThread(harness.db, f.imported.threadId)).toEqual(before);
      const second = importExternalHistory(harness.deps, {
        ...f.batch,
        conversationId: "other-conversation",
      });
      bindExternalSession(harness.deps, {
        ...f.bind,
        threadId: second.threadId,
      });
      expect(() => bindExternalSession(harness.deps, f.bind)).toThrow(
        "claimed",
      );
      expect(getThread(harness.db, f.imported.threadId)).toEqual(before);
      expect(
        harness.db
          .select()
          .from(events)
          .where(
            and(
              eq(events.threadId, f.imported.threadId),
              eq(events.type, "thread/identity"),
            ),
          )
          .all(),
      ).toHaveLength(0);
    });
  });

  it.each(["released", "retained", "failed"] as const)(
    "releases only an idle runtime, preserving history: %s",
    async (outcome) => {
      await withTestHarness(async (harness) => {
        const f = fixture(
          harness,
          outcome === "released" ? "openclaw-dooffin" : "codex",
        );
        bindExternalSession(harness.deps, f.bind);
        const releasing = post(harness, "release-external-session", {
          pluginId: "sync",
          threadId: f.imported.threadId,
          expectedGeneration: 0,
          expectedSessionId: f.batch.sessionId,
        });
        const queued = await waitForQueuedCommand(
          harness,
          ({ command }) =>
            command.type === "thread.stop" &&
            command.threadId === f.imported.threadId,
        );
        expect(queued.command).toMatchObject({ intent: "release" });
        expect(() => importExternalHistory(harness.deps, f.batch)).toThrow(
          "another request",
        );
        if (outcome === "failed")
          await reportQueuedCommandError(harness, queued, {
            errorCode: "test_release_failure",
            errorMessage: "no connection",
          });
        else
          await reportQueuedCommandSuccess(harness, queued, {
            providerCheckpointId: null,
            activeTurnRetained: outcome === "retained",
          });
        const response = await releasing;
        expect(response.status).toBe(
          outcome === "released" ? 200 : outcome === "retained" ? 409 : 502,
        );
        expect(
          listQueuedThreadCommands(
            harness,
            "thread.stop",
            f.imported.threadId,
          ).filter(
            (command) =>
              command.type === "thread.stop" && command.intent === "interrupt",
          ),
        ).toHaveLength(0);
        expect(getThread(harness.db, f.imported.threadId)?.providerId).toBe(
          outcome === "released" ? "external-history" : "codex",
        );
        expect(
          harness.db.select().from(externalThreadMessages).all(),
        ).toHaveLength(1);
        if (outcome === "released") {
          expect(
            importExternalHistory(harness.deps, {
              ...f.batch,
              generation: 1,
              sessionId: "external-session-b",
              messages: [
                {
                  id: "m1",
                  order: 0,
                  role: "assistant",
                  text: "new session",
                  createdAt: 2000,
                },
              ],
            }),
          ).toMatchObject({ inserted: 1 });
          bindExternalSession(harness.deps, {
            ...f.bind,
            expectedGeneration: 1,
            expectedSessionId: "external-session-b",
            providerThreadId: f.bind.providerThreadId,
          });
          expect(
            getStoredProviderSession(harness.db, f.imported.threadId),
          ).toEqual({
            kind: "owned",
            providerThreadId: f.bind.providerThreadId,
          });
        }
      });
    },
  );

  it("reads bindings without mutation and excludes other plugins", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const key = {
        projectId: f.project.id,
        pluginId: "sync",
        sourceId: f.batch.sourceId,
        conversationId: f.batch.conversationId,
      };
      expect(findExternalThread(harness.deps, key).binding).toMatchObject({
        threadId: f.imported.threadId,
        mode: "passive",
        lastOrder: 0,
      });
      expect(
        findExternalThread(harness.deps, { ...key, pluginId: "another" }),
      ).toEqual({ binding: null });
      await withThreadSendGuard(f.imported.threadId, async () => {
        expect(() => bindExternalSession(harness.deps, f.bind)).toThrow(
          "another request",
        );
        expect(() => importExternalHistory(harness.deps, f.batch)).toThrow(
          "another request",
        );
      });
      expect(
        harness.db.select().from(externalThreadBindings).all(),
      ).toHaveLength(1);
    });
  });

  it("releases a settled failed thread without clearing its durable history", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      bindExternalSession(harness.deps, f.bind);
      harness.db
        .update(threads)
        .set({ status: "error" })
        .where(eq(threads.id, f.imported.threadId))
        .run();
      const releasing = post(harness, "release-external-session", {
        pluginId: "sync",
        threadId: f.imported.threadId,
        expectedGeneration: 0,
        expectedSessionId: f.batch.sessionId,
      });
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === f.imported.threadId,
      );
      await reportQueuedCommandSuccess(harness, queued, {
        providerCheckpointId: null,
        activeTurnRetained: false,
      });
      expect((await releasing).status).toBe(200);
      expect(getThread(harness.db, f.imported.threadId)).toMatchObject({
        status: "idle",
        providerId: "external-history",
      });
      expect(
        harness.db.select().from(externalThreadMessages).all(),
      ).toHaveLength(1);
    });
  });

  it("does not steal a session after release even when its historical claim is older", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      bindExternalSession(harness.deps, f.bind);
      const releasing = post(harness, "release-external-session", {
        pluginId: "sync",
        threadId: f.imported.threadId,
        expectedGeneration: 0,
        expectedSessionId: f.batch.sessionId,
      });
      const queued = await waitForQueuedCommand(
        harness,
        ({ command }) =>
          command.type === "thread.stop" &&
          command.threadId === f.imported.threadId,
      );
      await reportQueuedCommandSuccess(harness, queued, {
        providerCheckpointId: null,
        activeTurnRetained: false,
      });
      expect((await releasing).status).toBe(200);
      const second = importExternalHistory(harness.deps, {
        ...f.batch,
        conversationId: "new-owner",
      });
      bindExternalSession(harness.deps, {
        ...f.bind,
        threadId: second.threadId,
      });
      expect(() => bindExternalSession(harness.deps, f.bind)).toThrow(
        "claimed by another",
      );
      expect(getThread(harness.db, f.imported.threadId)?.providerId).toBe(
        "external-history",
      );
    });
  });

  it("imports completed turns, uploaded attachments and source title/time through the shared projections", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const path = "image-fixture.png";
      const attachment = recordProjectAttachment(harness.db, {
        projectId: f.project.id,
        storedPath: path,
        originalName: path,
        mimeType: "image/png",
        sizeBytes: 10,
        createdAt: 1,
        readyAt: 1,
      });
      const batch: ExperimentalImportHistoryRequest = {
        ...f.batch,
        conversationId: "rich-conversation",
        messages: [],
        initialTitle: "Short",
        initialSourceTitle: "Full original searchable conversation title",
        initialCreatedAt: 10,
        initialUpdatedAt: 3000,
        turns: [
          {
            id: "turn-a",
            order: 0,
            createdAt: 100,
            completedAt: 200,
            status: "completed",
            items: [
              {
                createdAt: 110,
                item: {
                  type: "user",
                  text: "",
                  attachments: [{ type: "localImage", path }],
                },
              },
              { createdAt: 120, item: { type: "plan", text: "source plan" } },
              {
                createdAt: 130,
                item: {
                  type: "tool",
                  name: "inspect",
                  arguments: { path: "photo" },
                  result: { description: "cat", color: "grey" },
                  status: "completed",
                },
              },
              {
                createdAt: 140,
                item: { type: "assistant", text: "source answer" },
              },
            ],
          },
        ],
      };
      const result = importExternalHistory(harness.deps, batch);
      expect(getThread(harness.db, result.threadId)).toMatchObject({
        createdAt: 10,
        updatedAt: 3000,
        titleFallback: batch.initialSourceTitle,
      });
      expect(
        harness.db
          .select()
          .from(projectAttachmentThreads)
          .where(eq(projectAttachmentThreads.attachmentId, attachment.id))
          .all(),
      ).toEqual([{ threadId: result.threadId, attachmentId: attachment.id }]);
      const rows = harness.db
        .select()
        .from(events)
        .where(eq(events.threadId, result.threadId))
        .orderBy(events.sequence)
        .all();
      expect(rows.map((row) => row.itemKind)).toEqual([
        null,
        "userMessage",
        "plan",
        "toolCall",
        "agentMessage",
        null,
      ]);
      expect(new Set(rows.map((row) => row.turnId)).size).toBe(1);
      expect(
        searchThreadsWithPendingInteractionState(harness.db, {
          query: "searchable",
          limitPerGroup: 10,
        }).active.total,
      ).toBe(1);
      expect(importExternalHistory(harness.deps, batch)).toMatchObject({
        inserted: 0,
        skipped: 1,
      });
      expect(
        importExternalHistory(harness.deps, {
          ...batch,
          turns: batch.turns!.map((turn) => ({
            ...turn,
            items: turn.items.map((entry) => ({
              ...entry,
              item:
                entry.item.type === "tool"
                  ? {
                      ...entry.item,
                      result: { color: "grey", description: "cat" },
                    }
                  : entry.item,
            })),
          })),
        }),
      ).toMatchObject({ inserted: 0, skipped: 1 });
      const invalid = {
        ...batch,
        conversationId: "bad-image",
        turns: [
          {
            ...batch.turns![0]!,
            items: [
              ...batch.turns![0]!.items,
              {
                createdAt: 150,
                item: {
                  type: "user" as const,
                  text: "bad",
                  attachments: [
                    { type: "localFile" as const, path: "missing.pdf" },
                  ],
                },
              },
            ],
          },
        ],
      };
      expect(() => importExternalHistory(harness.deps, invalid)).toThrow(
        "not uploaded",
      );
      expect(
        harness.db
          .select()
          .from(externalThreadBindings)
          .where(eq(externalThreadBindings.conversationId, "bad-image"))
          .all(),
      ).toHaveLength(0);
      expect(
        harness.db.select().from(projectAttachmentThreads).all(),
      ).toHaveLength(1);
    });
  });

  it.each([false, true])(
    "adopts existing provider history by verified sequence, without duplicating events or dispatching",
    async (archived) => {
      await withTestHarness(async (harness) => {
        const f = fixture(harness);
        bindExternalSession(harness.deps, f.bind);
        if (archived)
          harness.db
            .update(threads)
            .set({ archivedAt: 1 })
            .where(eq(threads.id, f.imported.threadId))
            .run();
        harness.db
          .delete(externalThreadBindings)
          .where(eq(externalThreadBindings.threadId, f.imported.threadId))
          .run();
        const before = harness.db.select().from(events).all().length;
        const adopted = {
          ...f.batch,
          adoptThreadId: f.imported.threadId,
          messages: [{ ...f.batch.messages[0]!, existingSequence: 2 }],
        };
        expect(importExternalHistory(harness.deps, adopted)).toMatchObject({
          created: false,
          inserted: 1,
          threadId: f.imported.threadId,
        });
        expect(harness.db.select().from(events).all()).toHaveLength(before);
        expect(importExternalHistory(harness.deps, adopted)).toMatchObject({
          inserted: 0,
          skipped: 1,
        });
        expect(() =>
          importExternalHistory(harness.deps, {
            ...f.batch,
            adoptThreadId: f.imported.threadId,
            messages: [
              {
                id: "m2",
                order: 1,
                role: "assistant",
                text: "different",
                createdAt: 1000,
                existingSequence: 2,
              },
            ],
          }),
        ).toThrow("content does not match");
        expect(
          harness.db.select().from(externalThreadMessages).all(),
        ).toHaveLength(1);
        expect(
          listQueuedThreadCommands(harness, "turn.submit", f.imported.threadId),
        ).toHaveLength(0);
      });
    },
  );

  it("acknowledges a BB reply under its source ID without duplicating the runtime event", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      bindExternalSession(harness.deps, f.bind);
      const scope = { kind: "turn" as const, turnId: "native-bb-turn" };
      const common = {
        threadId: f.imported.threadId,
        scope,
        providerThreadId: f.batch.sessionId,
        createdAt: 3000,
      };
      const sequences = harness.db.transaction((tx) =>
        appendStoredThreadEventsInTransaction(tx, [
          {
            ...common,
            type: "turn/started",
            data: { providerThreadId: f.batch.sessionId },
          },
          {
            ...common,
            type: "item/completed",
            data: {
              providerThreadId: f.batch.sessionId,
              item: {
                type: "agentMessage",
                id: "native-bb-item",
                text: "reply from BB",
              },
            },
          },
          {
            ...common,
            type: "turn/completed",
            data: { providerThreadId: f.batch.sessionId, status: "completed" },
          },
        ]),
      );
      const count = harness.db.select().from(events).all().length;
      const acknowledged = {
        ...f.batch,
        messages: [
          {
            id: "gateway-bb-reply",
            order: 1,
            role: "assistant" as const,
            text: "reply from BB",
            createdAt: 3100,
            existingSequence: sequences[1]!,
            existingCreatedAt: 3000,
          },
        ],
      };
      expect(importExternalHistory(harness.deps, acknowledged)).toMatchObject({
        inserted: 1,
      });
      expect(harness.db.select().from(events).all()).toHaveLength(count);
      expect(
        importExternalHistory(harness.deps, {
          ...f.batch,
          messages: acknowledged.messages.map(
            ({
              existingSequence: _sequence,
              existingCreatedAt: _time,
              ...message
            }) => message,
          ),
        }),
      ).toMatchObject({ skipped: 1, inserted: 0 });
      expect(() =>
        importExternalHistory(harness.deps, {
          ...acknowledged,
          messages: [{ ...acknowledged.messages[0]!, existingSequence: 2 }],
        }),
      ).toThrow("original existing sequences");
    });
  });
});
