import { Command } from "commander";
import { experimentalImportHistoryRequestSchema } from "@bb/server-contract";
import { action } from "../../action.js";
import { createCliBbSdk } from "../../client.js";
import { resolveTextInput } from "../../text-input.js";
import { outputJson } from "../helpers.js";

export function registerImportHistoryCommand(
  thread: Command,
  getUrl: () => string,
): void {
  thread
    .command("import-history")
    .description(
      "Import finalized external history without running a model (experimental)",
    )
    .requiredOption("--file <path>", "JSON history batch; - reads stdin")
    .option("--json", "Print the import result as JSON")
    .action(
      action(async (options: { file: string; json?: boolean }) => {
        const text = await resolveTextInput({
          file: options.file,
          fileLabel: "--file",
          inline: undefined,
          inlineLabel: "batch",
        });
        const batch = experimentalImportHistoryRequestSchema.parse(
          JSON.parse(text ?? ""),
        );
        const result =
          await createCliBbSdk(getUrl()).threads.experimental_importHistory(
            batch,
          );
        if (outputJson(options, result)) return;
        console.log(
          `${result.threadId}: imported ${result.inserted}, skipped ${result.skipped}`,
        );
      }),
    );
}
