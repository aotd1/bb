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

describe("bb external session CLI", () => {
  setupCommandOutputTestEnvironment();
  it.each([
    {
      command: "bind-external-session",
      input: {
        pluginId: "sync",
        threadId: "t1",
        expectedGeneration: 1,
        expectedSessionId: "s1",
        providerId: "openclaw",
        environmentId: "e1",
        providerThreadId: "s1",
      },
      result: { threadId: "t1", changed: true, mode: "interactive" },
    },
    {
      command: "release-external-session",
      input: {
        pluginId: "sync",
        threadId: "t1",
        expectedGeneration: 1,
        expectedSessionId: "s1",
      },
      result: { threadId: "t1", changed: true, mode: "passive" },
    },
    {
      command: "find-external-thread",
      input: {
        projectId: "p1",
        pluginId: "sync",
        sourceId: "gateway",
        conversationId: "topic",
      },
      result: { binding: null },
    },
  ])(
    "validates the request file and calls $command",
    async ({ command, input, result }) => {
      const dir = await mkdtemp(join(tmpdir(), "bb-session-cli-"));
      try {
        const file = join(dir, "request.json");
        await writeFile(file, JSON.stringify(input));
        const post = vi.fn(async () => result);
        stubServerApi({ [`v1.threads.experimental-${command}.$post`]: post });
        await runCommand(
          ["thread", command, "--file", file, "--json"],
          (program) => registerThreadCommands(program, () => "http://server"),
        );
        expect(post).toHaveBeenCalledExactlyOnceWith({ json: input });
        expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toEqual(
          result,
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
