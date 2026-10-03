import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  environments,
  events,
  getThread,
  hosts,
  projectSources,
  projects,
  threads,
} from "@bb/db";
import { createNodeBbSdk } from "@bb/sdk";
import type { ExperimentalEnsureProjectCheckoutRequest } from "@bb/server-contract";
import { bindExternalSession } from "../../src/services/threads/external-session.js";
import { importExternalHistory } from "../../src/services/threads/external-history.js";
import {
  listQueuedCommands,
  registerTestHostRpcCapture,
  reportQueuedCommandError,
  reportQueuedCommandSuccess,
  waitForQueuedCommand,
} from "../helpers/commands.js";
import {
  seedEnvironment,
  seedHostSession,
  seedProjectWithSource,
} from "../helpers/seed.js";
import { withTestHarness, type TestAppHarness } from "../helpers/test-app.js";

const route = "/api/v1/environments/experimental-ensure-project-checkout";

function fixture(harness: TestAppHarness) {
  const { host, session } = seedHostSession(harness.deps);
  registerTestHostRpcCapture(harness, {
    hostId: host.id,
    sessionId: session.id,
  });
  const { project, source } = seedProjectWithSource(harness.deps, {
    hostId: host.id,
  });
  const args: ExperimentalEnsureProjectCheckoutRequest = {
    projectId: project.id,
    hostId: host.id,
    expectedSourceId: source.id,
    expectedSourcePath: source.path,
  };
  return { host, project, source, args };
}

function post(harness: TestAppHarness, body: object) {
  return harness.app.request(route, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function inspect(
  harness: TestAppHarness,
  path = "/tmp/test-project",
  isWorktree = false,
) {
  const queued = await waitForQueuedCommand(
    harness,
    ({ command }) => command.type === "host.inspect_workspace",
  );
  await reportQueuedCommandSuccess(harness, queued, {
    path,
    isGitRepo: isWorktree,
    isWorktree,
    branchName: isWorktree ? "task" : null,
    defaultBranch: isWorktree ? "main" : null,
  });
}

describe("ensure project checkout without a turn", () => {
  it("uses the SDK to create once, preserves metadata on replay, and binds imported Codex history without provider work", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const notified = vi.spyOn(harness.hub, "notifyEnvironment");
      const sdk = createNodeBbSdk({
        baseUrl: "http://localhost",
        fetch: async (input, init) =>
          harness.app.request(new Request(input, init)),
      });
      const promise = sdk.environments.experimental_ensureProjectCheckout(
        f.args,
      );
      await inspect(harness, f.source.path, true);
      const first = await promise;
      expect(first).toMatchObject({
        created: true,
        environment: {
          status: "ready",
          path: f.source.path,
          isGitRepo: true,
          isWorktree: true,
          branchName: "task",
          defaultBranch: "main",
          managed: false,
          environmentProviderId: null,
          lifecycle: { phase: "active", teardown: null },
        },
      });
      expect(harness.db.select().from(threads).all()).toEqual([]);
      expect(harness.db.select().from(events).all()).toEqual([]);
      const repeatPromise = sdk.environments.experimental_ensureProjectCheckout(
        f.args,
      );
      await inspect(harness);
      const repeat = await repeatPromise;
      expect(repeat).toEqual({ ...first, created: false });
      expect(notified).toHaveBeenCalledTimes(1);
      const imported = importExternalHistory(harness.deps, {
        projectId: f.project.id,
        pluginId: "codex-migrate",
        sourceId: "codex-local",
        conversationId: "chat",
        sessionId: "codex-handle",
        providerId: "codex",
        generation: 0,
        messages: [
          {
            id: "m1",
            order: 0,
            role: "assistant",
            text: "history",
            createdAt: 1,
          },
        ],
      });
      expect(
        getThread(harness.db, imported.threadId)?.environmentId,
      ).toBeNull();
      const result = bindExternalSession(harness.deps, {
        threadId: imported.threadId,
        pluginId: "codex-migrate",
        expectedGeneration: 0,
        expectedSessionId: "codex-handle",
        providerId: "codex",
        providerThreadId: "codex-handle",
        environmentId: first.environment.id,
      });
      expect(result.mode).toBe("interactive");
      for (const type of [
        "environment.attach",
        "thread.start",
        "turn.submit",
        "provider.list_models",
      ] as const)
        expect(listQueuedCommands(harness, type)).toEqual([]);
      notified.mockRestore();
    });
  });

  it("deduplicates concurrent ensures transactionally", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const one = post(harness, f.args);
      const two = post(harness, f.args);
      await inspect(harness);
      await inspect(harness);
      const responses = await Promise.all([one, two]);
      expect(responses.map((r) => r.status)).toEqual([200, 200]);
      const bodies = await Promise.all(responses.map((r) => r.json()));
      expect(bodies[0].environment.id).toBe(bodies[1].environment.id);
      expect(bodies.map((b) => b.created).sort()).toEqual([false, true]);
      expect(harness.db.select().from(environments).all()).toHaveLength(1);
    });
  });

  it.each([
    "source-path",
    "source-replaced",
    "project-deleted",
    "host-removing",
  ])(
    "rejects a concurrent %s change without a partial environment",
    async (change) => {
      await withTestHarness(async (harness) => {
        const f = fixture(harness);
        const pending = post(harness, f.args);
        const command = await waitForQueuedCommand(
          harness,
          ({ command }) => command.type === "host.inspect_workspace",
        );
        if (change === "source-path")
          harness.db
            .update(projectSources)
            .set({ path: "/changed" })
            .where(eq(projectSources.id, f.source.id))
            .run();
        if (change === "source-replaced")
          harness.db
            .delete(projectSources)
            .where(eq(projectSources.id, f.source.id))
            .run();
        if (change === "project-deleted")
          harness.db
            .update(projects)
            .set({ deletedAt: 1 })
            .where(eq(projects.id, f.project.id))
            .run();
        if (change === "host-removing")
          harness.db
            .update(hosts)
            .set({ phase: "removing" })
            .where(eq(hosts.id, f.host.id))
            .run();
        await reportQueuedCommandSuccess(harness, command, {
          path: f.source.path,
          isGitRepo: false,
          isWorktree: false,
          branchName: null,
          defaultBranch: null,
        });
        expect((await pending).status).toBe(
          change === "project-deleted" ? 404 : 409,
        );
        expect(harness.db.select().from(environments).all()).toEqual([]);
      });
    },
  );

  it.each(["missing", "file", "offline"])(
    "keeps the database unchanged on %s inspection failure",
    async (failure) => {
      await withTestHarness(async (harness) => {
        const f = fixture(harness);
        const pending = post(harness, f.args);
        const command = await waitForQueuedCommand(
          harness,
          ({ command }) => command.type === "host.inspect_workspace",
        );
        await reportQueuedCommandError(harness, command, {
          errorCode:
            failure === "missing"
              ? "ENOENT"
              : failure === "file"
                ? "invalid_path"
                : "host_unavailable",
          errorMessage: "Checkout inspection failed",
        });
        expect((await pending).status).not.toBe(200);
        expect(harness.db.select().from(environments).all()).toEqual([]);
      });
    },
  );

  it.each(["owner", "teardown", "retiring", "provisioning"])(
    "does not reuse or alter a checkout with %s",
    async (state) => {
      await withTestHarness(async (harness) => {
        const f = fixture(harness);
        const env = seedEnvironment(harness.deps, {
          hostId: f.host.id,
          projectId: f.project.id,
          path: f.source.path,
        });
        harness.db
          .update(environments)
          .set({
            ...(state === "owner" ? { ownerThreadId: "other-thread" } : {}),
            ...(state === "teardown"
              ? { teardownStatus: "running" as const }
              : {}),
            ...(state === "retiring" ? { retireAt: 1 } : {}),
            ...(state === "provisioning"
              ? { status: "provisioning" as const }
              : {}),
          })
          .where(eq(environments.id, env.id))
          .run();
        const before = harness.db.select().from(environments).all();
        const pending = post(harness, f.args);
        await inspect(harness);
        expect((await pending).status).toBe(409);
        expect(harness.db.select().from(environments).all()).toEqual(before);
      });
    },
  );

  it("rejects a canonical symlink target owned by another project", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const foreign = seedProjectWithSource(harness.deps, {
        hostId: f.host.id,
        path: "/foreign",
      });
      const env = seedEnvironment(harness.deps, {
        hostId: f.host.id,
        projectId: foreign.project.id,
        path: "/foreign/worktree",
      });
      harness.db
        .update(environments)
        .set({ providerOwnsPath: true })
        .where(eq(environments.id, env.id))
        .run();
      const pending = post(harness, f.args);
      await inspect(harness, "/foreign/worktree/subdir");
      expect((await pending).status).toBe(409);
      expect(harness.db.select().from(environments).all()).toHaveLength(1);
    });
  });

  it("rejects a path claimed during host inspection", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const pending = post(harness, f.args);
      const command = await waitForQueuedCommand(
        harness,
        ({ command }) => command.type === "host.inspect_workspace",
      );
      const preparing = seedEnvironment(harness.deps, {
        hostId: f.host.id,
        projectId: f.project.id,
        path: null,
        status: "provisioning",
      });
      harness.db
        .update(environments)
        .set({ claimPath: f.source.path })
        .where(eq(environments.id, preparing.id))
        .run();
      const before = harness.db.select().from(environments).all();
      await reportQueuedCommandSuccess(harness, command, {
        path: f.source.path,
        isGitRepo: false,
        isWorktree: false,
        branchName: null,
        defaultBranch: null,
      });
      expect((await pending).status).toBe(409);
      expect(harness.db.select().from(environments).all()).toEqual(before);
    });
  });

  it("reuses a recorded source alias but rejects ambiguous alias environments", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const supplied = seedEnvironment(harness.deps, {
        hostId: f.host.id,
        projectId: f.project.id,
        path: f.source.path,
      });
      const first = post(harness, f.args);
      await inspect(harness, "/tmp/canonical");
      const response = await first;
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        created: false,
        environment: { id: supplied.id, path: f.source.path },
      });
      seedEnvironment(harness.deps, {
        hostId: f.host.id,
        projectId: f.project.id,
        path: "/tmp/canonical",
      });
      const second = post(harness, f.args);
      await inspect(harness, "/tmp/canonical");
      expect((await second).status).toBe(409);
      expect(harness.db.select().from(environments).all()).toHaveLength(2);
    });
  });

  it("ensures Windows drive-letter project checkouts with host path normalization", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      const sourcePath = "C:\\Users\\developer\\repo";
      harness.db
        .update(projectSources)
        .set({ path: sourcePath })
        .where(eq(projectSources.id, f.source.id))
        .run();
      const response = post(harness, {
        ...f.args,
        expectedSourcePath: sourcePath,
      });
      await inspect(harness, sourcePath);
      expect((await response).status).toBe(200);
      expect(await (await response).json()).toMatchObject({
        created: true,
        environment: { path: sourcePath, managed: false },
      });
      expect(harness.db.select().from(threads).all()).toEqual([]);
      expect(harness.db.select().from(events).all()).toEqual([]);
    });
  });

  it("rejects invalid requests and stale source preconditions before host work", async () => {
    await withTestHarness(async (harness) => {
      const f = fixture(harness);
      expect(
        (await post(harness, { ...f.args, prompt: "do something" })).status,
      ).toBe(400);
      expect(
        (await post(harness, { ...f.args, expectedSourceId: "stale" })).status,
      ).toBe(409);
      expect(
        (await post(harness, { ...f.args, projectId: "absent" })).status,
      ).toBe(404);
      expect(listQueuedCommands(harness, "host.inspect_workspace")).toEqual([]);
      expect(harness.db.select().from(environments).all()).toEqual([]);
    });
  });
});
