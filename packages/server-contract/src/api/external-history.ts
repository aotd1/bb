import { z } from "zod";
import {
  pluginMetadataSchema,
  pluginIdSchema,
  canonicalProjectAttachmentPath,
  jsonValueSchema,
} from "@bb/domain";

const identity = z.string().min(1).max(512);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const timestamp = integer.max(8_640_000_000_000_000);
const text = z.string().max(128_000);
const attachmentSchema = z
  .object({
    type: z.enum(["localImage", "localFile"]),
    path: z
      .string()
      .min(1)
      .max(1024)
      .superRefine((path, context) => {
        try {
          if (canonicalProjectAttachmentPath(path) !== path) throw new Error();
        } catch {
          context.addIssue({
            code: "custom",
            message:
              "Use the canonical path returned by project attachment upload",
          });
        }
      }),
  })
  .strict();
const content = {
  text,
  attachments: z.array(attachmentSchema).max(32).optional(),
};
export const externalHistoryItemSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("user"), ...content }).strict(),
  z.object({ type: z.literal("assistant"), text }).strict(),
  z.object({ type: z.literal("plan"), text }).strict(),
  z
    .object({
      type: z.literal("reasoning"),
      summary: z.array(text).max(100),
      content: z.array(text).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("tool"),
      name: identity,
      server: identity.optional(),
      arguments: z.record(z.string(), jsonValueSchema).optional(),
      result: jsonValueSchema.optional(),
      error: text.optional(),
      status: z.enum(["completed", "failed", "interrupted"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("command"),
      command: text,
      cwd: z.string().max(4096),
      output: text,
      exitCode: z.number().int().optional(),
      status: z.enum(["completed", "failed", "interrupted"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("fileChange"),
      changes: z
        .array(
          z
            .object({
              path: z.string().min(1).max(4096),
              kind: z.enum(["add", "delete", "update"]),
              movePath: z.string().max(4096).optional(),
              diff: text.optional(),
            })
            .strict(),
        )
        .max(100),
      status: z.enum(["completed", "failed", "interrupted"]),
    })
    .strict(),
]);
export type ExternalHistoryItem = z.infer<typeof externalHistoryItemSchema>;
export const externalThreadIdentitySchema = z
  .object({
    projectId: identity,
    pluginId: pluginIdSchema,
    sourceId: identity,
    conversationId: identity,
  })
  .strict();
export type ExperimentalFindExternalThreadRequest = z.infer<
  typeof externalThreadIdentitySchema
>;
export interface ExperimentalFindExternalThreadResponse {
  binding: {
    threadId: string;
    providerId: string;
    sessionId: string;
    generation: number;
    lastOrder: number | null;
    mode: "passive" | "interactive";
    runtimeProviderId: string;
    runtimeProviderThreadId: string | null;
    environmentId: string | null;
    archived: boolean;
  } | null;
}
export const experimentalExternalSessionRequestSchema = z
  .object({
    pluginId: pluginIdSchema,
    threadId: identity,
    expectedGeneration: integer,
    expectedSessionId: identity,
  })
  .strict();
export const experimentalBindExternalSessionRequestSchema =
  experimentalExternalSessionRequestSchema
    .extend({
      providerId: identity,
      environmentId: identity,
      providerThreadId: identity,
    })
    .strict();
export type ExperimentalBindExternalSessionRequest = z.infer<
  typeof experimentalBindExternalSessionRequestSchema
>;
export type ExperimentalReleaseExternalSessionRequest = z.infer<
  typeof experimentalExternalSessionRequestSchema
>;
export interface ExperimentalExternalSessionResponse {
  threadId: string;
  changed: boolean;
  mode: "passive" | "interactive";
}

export const experimentalImportHistoryRequestSchema = z
  .object({
    projectId: identity,
    pluginId: pluginIdSchema,
    sourceId: identity,
    conversationId: identity,
    providerId: identity,
    sessionId: identity,
    generation: integer,
    threadId: identity.optional(),
    adoptThreadId: identity.optional(),
    initialCreatedAt: timestamp.optional(),
    initialUpdatedAt: timestamp.optional(),
    initialTitle: z.string().min(1).max(512).optional(),
    initialSourceTitle: z.string().min(1).max(4096).optional(),
    activityAt: timestamp.optional(),
    initialPluginMetadata: pluginMetadataSchema.optional(),
    attention: z.enum(["preserve", "unread"]).default("preserve"),
    messages: z
      .array(
        z
          .object({
            id: identity,
            order: integer,
            role: z.enum(["user", "assistant"]),
            ...content,
            createdAt: timestamp,
            existingSequence: integer.min(1).optional(),
            existingCreatedAt: timestamp.optional(),
          })
          .strict(),
      )
      .max(500),
    turns: z
      .array(
        z
          .object({
            id: identity,
            order: integer,
            createdAt: timestamp,
            completedAt: timestamp,
            status: z.enum(["completed", "failed", "interrupted"]),
            items: z
              .array(
                z
                  .object({
                    createdAt: timestamp,
                    item: externalHistoryItemSchema,
                    existingSequence: integer.min(1).optional(),
                    existingCreatedAt: timestamp.optional(),
                  })
                  .strict(),
              )
              .min(1)
              .max(100),
          })
          .strict(),
      )
      .max(500)
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (new TextEncoder().encode(JSON.stringify(value)).length > 1024 * 1024) {
      context.addIssue({
        code: "custom",
        message: "History batch exceeds 1 MiB",
      });
    }
    if (
      value.messages.length +
        (value.turns ?? []).reduce((sum, turn) => sum + turn.items.length, 0) >
      500
    )
      context.addIssue({
        code: "custom",
        message: "At most 500 messages and turns per batch",
      });
    for (const message of value.messages) {
      if (
        message.existingCreatedAt !== undefined &&
        message.existingSequence === undefined
      )
        context.addIssue({
          code: "custom",
          message: "existingCreatedAt requires existingSequence",
        });
      if (!message.text && !message.attachments?.length)
        context.addIssue({
          code: "custom",
          message: "Messages require text or uploaded attachments",
        });
      if (message.role !== "user" && message.attachments?.length)
        context.addIssue({
          code: "custom",
          message: "Attachments are supported on user messages",
        });
    }
    if (
      value.initialCreatedAt !== undefined &&
      value.initialUpdatedAt !== undefined &&
      value.initialUpdatedAt < value.initialCreatedAt
    )
      context.addIssue({
        code: "custom",
        message: "Initial activity cannot precede creation",
      });
    for (const turn of value.turns ?? []) {
      if (turn.completedAt < turn.createdAt)
        context.addIssue({
          code: "custom",
          message: "Turn completion precedes its start",
        });
      for (const entry of turn.items) {
        if (
          entry.existingCreatedAt !== undefined &&
          entry.existingSequence === undefined
        )
          context.addIssue({
            code: "custom",
            message: "existingCreatedAt requires existingSequence",
          });
        if (
          entry.createdAt < turn.createdAt ||
          entry.createdAt > turn.completedAt
        )
          context.addIssue({
            code: "custom",
            message: "Item time must fall within its completed turn",
          });
        if (
          entry.item.type === "user" &&
          !entry.item.text &&
          !entry.item.attachments?.length
        )
          context.addIssue({
            code: "custom",
            message: "User items require content",
          });
      }
    }
    for (const lane of [value.messages, value.turns ?? []]) {
      if (
        lane.some(
          (entry, index) => index > 0 && entry.order <= lane[index - 1]!.order,
        )
      )
        context.addIssue({
          code: "custom",
          message: "Messages require unique IDs and strictly increasing order",
        });
    }
    const ids = new Set<string>();
    let previous = -1;
    for (const message of [...value.messages, ...(value.turns ?? [])].sort(
      (a, b) => a.order - b.order,
    )) {
      if (ids.has(message.id) || message.order <= previous) {
        context.addIssue({
          code: "custom",
          message: "Messages require unique IDs and strictly increasing order",
        });
      }
      ids.add(message.id);
      previous = message.order;
    }
  });

export type ExperimentalImportHistoryRequest = z.input<
  typeof experimentalImportHistoryRequestSchema
>;
export interface ExperimentalImportHistoryResponse {
  threadId: string;
  created: boolean;
  inserted: number;
  skipped: number;
  generation: number;
  lastOrder: number | null;
}
