import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  setupCommandOutputTestEnvironment,
  runCommand,
  stubServerApi,
} from "../helpers/command-output-harness.js";
import { registerThreadCommands } from "../../commands/thread/index.js";

describe("bb thread import-history", () => {
  setupCommandOutputTestEnvironment();
  it("reads a batch file, uses the passive API, and prints replay counts as JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bb-history-cli-"));
    try {
      const path = join(dir, "batch.json");
      const batch = {
        projectId: "p1",
        pluginId: "sync",
        sourceId: "gateway",
        conversationId: "topic",
        providerId: "openclaw",
        sessionId: "s1",
        generation: 0,
        messages: [
          { id: "m1", order: 0, role: "user", text: "hello", createdAt: 1000 },
        ],
      };
      await writeFile(path, JSON.stringify(batch));
      const result = {
        threadId: "t1",
        created: true,
        inserted: 1,
        skipped: 0,
        generation: 0,
        lastOrder: 0,
      };
      const post = vi.fn(async () => result);
      stubServerApi({ "v1.threads.experimental-import-history.$post": post });
      await runCommand(
        ["thread", "import-history", "--file", path, "--json"],
        (program) => registerThreadCommands(program, () => "http://server"),
      );
      expect(post).toHaveBeenCalledExactlyOnceWith({
        json: { ...batch, attention: "preserve" },
      });
      expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toEqual(
        result,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
