import { Command } from "commander";
import {
  experimentalBindExternalSessionRequestSchema,
  experimentalExternalSessionRequestSchema,
  externalThreadIdentitySchema,
} from "@bb/server-contract";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { resolveTextInput } from "../../text-input.js";
import { outputJson } from "../helpers.js";

export function registerExternalSessionCommands(
  thread: Command,
  getUrl: () => string,
): void {
  for (const name of [
    "bind-external-session",
    "release-external-session",
    "find-external-thread",
  ] as const) {
    thread
      .command(name)
      .description("Manage external history session bindings (experimental)")
      .requiredOption("--file <path>", "JSON request; - reads stdin")
      .option("--json", "Print the result as JSON")
      .action(
        action(async (options: { file: string; json?: boolean }) => {
          const text = await resolveTextInput({
            file: options.file,
            fileLabel: "--file",
            inline: undefined,
            inlineLabel: "request",
          });
          const input: unknown = JSON.parse(text ?? "");
          const sdk = createCliBbSdk(getUrl());
          const result =
            name === "bind-external-session"
              ? await sdk.threads.experimental_bindExternalSession(
                  experimentalBindExternalSessionRequestSchema.parse(input),
                )
              : name === "release-external-session"
                ? await sdk.threads.experimental_releaseExternalSession(
                    experimentalExternalSessionRequestSchema.parse(input),
                  )
                : await sdk.threads.experimental_findExternalThread(
                    externalThreadIdentitySchema.parse(input),
                  );
          if (!outputJson(options, result)) console.log(JSON.stringify(result));
        }),
      );
  }
}
