import { z } from "zod";
import { pluginMetadataSchema, pluginIdSchema } from "@bb/domain";

const identity = z.string().min(1).max(512);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

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
    initialTitle: z.string().min(1).max(512).optional(),
    initialPluginMetadata: pluginMetadataSchema.optional(),
    attention: z.enum(["preserve", "unread"]).default("preserve"),
    messages: z
      .array(
        z
          .object({
            id: identity,
            order: integer,
            role: z.enum(["user", "assistant"]),
            text: z.string().min(1).max(128_000),
            createdAt: integer.max(8_640_000_000_000_000),
          })
          .strict(),
      )
      .max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (new TextEncoder().encode(JSON.stringify(value)).length > 1024 * 1024) {
      context.addIssue({
        code: "custom",
        message: "History batch exceeds 1 MiB",
      });
    }
    const ids = new Set<string>();
    let previous = -1;
    for (const message of value.messages) {
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
