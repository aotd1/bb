import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  threadEventItemSchema,
  jsonValueSchema,
  type JsonValue,
  type ThreadEventItem,
} from "@bb/domain";
import type { ExternalHistoryItem } from "@bb/server-contract";
import { ApiError } from "../../errors.js";

export function stableExternalHistoryJson(serialized: string): string {
  const input = jsonValueSchema.parse(JSON.parse(serialized));
  function sorted(value: JsonValue): JsonValue {
    if (Array.isArray(value)) return value.map(sorted);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, sorted(value[key]!)]),
      );
    return value;
  }
  return JSON.stringify(sorted(input));
}

export function externalHistoryItem(
  item: ExternalHistoryItem,
): ThreadEventItem {
  const id = `external_${randomUUID()}`;
  switch (item.type) {
    case "user":
      return {
        type: "userMessage",
        id,
        experimental_externalHistory: true,
        content: [
          ...(item.text ? [{ type: "text" as const, text: item.text }] : []),
          ...(item.attachments ?? []),
        ],
      };
    case "assistant":
      return { type: "agentMessage", id, text: item.text };
    case "plan":
      return { type: "plan", id, text: item.text };
    case "reasoning":
      return {
        type: "reasoning",
        id,
        summary: item.summary,
        content: item.content,
      };
    case "tool":
      return {
        type: "toolCall",
        id,
        tool: item.name,
        status: item.status,
        ...(item.server === undefined ? {} : { server: item.server }),
        ...(item.arguments === undefined ? {} : { arguments: item.arguments }),
        ...(item.result === undefined ? {} : { result: item.result }),
        ...(item.error === undefined ? {} : { error: item.error }),
      };
    case "command":
      return {
        type: "commandExecution",
        id,
        command: item.command,
        cwd: item.cwd,
        aggregatedOutput: item.output,
        status: item.status,
        approvalStatus: null,
        ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
      };
    case "fileChange":
      return {
        type: "fileChange",
        id,
        changes: item.changes,
        status: item.status,
        approvalStatus: null,
      };
  }
}

function comparable(item: ThreadEventItem): string {
  switch (item.type) {
    case "userMessage":
      return JSON.stringify({ type: item.type, content: item.content });
    case "agentMessage":
    case "plan":
      return JSON.stringify({ type: item.type, text: item.text });
    case "reasoning":
      return JSON.stringify({
        type: item.type,
        summary: item.summary,
        content: item.content,
      });
    case "toolCall":
      return JSON.stringify({
        type: item.type,
        server: item.server,
        tool: item.tool,
        arguments: item.arguments,
        status: item.status,
        result: item.result,
        error: item.error,
      });
    case "commandExecution":
      return JSON.stringify({
        type: item.type,
        command: item.command,
        cwd: item.cwd,
        status: item.status,
        aggregatedOutput: item.aggregatedOutput,
        exitCode: item.exitCode,
      });
    case "fileChange":
      return JSON.stringify({
        type: item.type,
        changes: item.changes,
        status: item.status,
      });
    default:
      throw new ApiError(
        409,
        "external_history_conflict",
        "Legacy item type is not supported for adoption",
      );
  }
}

export function validateExistingExternalItem(
  row: { type: string; data: string; createdAt: number } | undefined,
  expected: ThreadEventItem,
  createdAt: number,
): void {
  if (!row || row.createdAt !== createdAt)
    throw new ApiError(
      409,
      "external_history_conflict",
      "Legacy item sequence/time does not match",
    );
  const raw: unknown = JSON.parse(row.data);
  let actual: ThreadEventItem;
  if (row.type === "client/turn/requested" && expected.type === "userMessage") {
    const contentSchema = threadEventItemSchema.options[0].shape.content;
    const parsed = z.object({ input: contentSchema }).safeParse(raw);
    if (!parsed.success)
      throw new ApiError(
        409,
        "external_history_conflict",
        "Legacy user content is not supported for adoption",
      );
    actual = { type: "userMessage", id: "legacy", content: parsed.data.input };
  } else if (row.type === "item/completed") {
    const parsed = z.object({ item: threadEventItemSchema }).safeParse(raw);
    if (!parsed.success)
      throw new ApiError(
        409,
        "external_history_conflict",
        "Legacy item is invalid; repair it before adoption",
      );
    actual = parsed.data.item;
  } else
    throw new ApiError(
      409,
      "external_history_conflict",
      "Legacy sequence must identify a completed item or user request",
    );
  if (
    stableExternalHistoryJson(comparable(actual)) !==
    stableExternalHistoryJson(comparable(expected))
  )
    throw new ApiError(
      409,
      "external_history_conflict",
      "Legacy item content does not match; adoption does not rewrite events",
    );
}
