import type { Hono } from "hono";
import {
  publicApiRoutes,
  typedRoutes,
  type PublicApiSchema,
} from "@bb/server-contract";
import { ApiError } from "../../errors.js";
import type { AppDeps } from "../../types.js";
import {
  bindExternalSession,
  releaseExternalSession,
  findExternalThread,
} from "../../services/threads/external-session.js";
import { importExternalHistory } from "../../services/threads/external-history.js";

export function registerExternalHistoryRoutes(app: Hono, deps: AppDeps): void {
  const route = publicApiRoutes.threads.experimental_importHistory;
  for (const path of [
    route.path,
    publicApiRoutes.threads.experimental_bindExternalSession.path,
    publicApiRoutes.threads.experimental_releaseExternalSession.path,
    publicApiRoutes.threads.experimental_findExternalThread.path,
  ])
    app.use(path, async (context, next) => {
      if (context.req.method !== "POST" || !context.req.raw.body) return next();
      const reader = context.req.raw.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.length;
          if (size > 1024 * 1024) {
            await reader.cancel();
            throw new ApiError(
              413,
              "invalid_request",
              "History batch exceeds 1 MiB",
            );
          }
          chunks.push(chunk.value);
        }
      } finally {
        reader.releaseLock();
      }
      const body = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.length;
      }
      context.req.raw = new Request(context.req.raw, { body });
      return next();
    });
  const { post } = typedRoutes<PublicApiSchema>(app, {
    onValidationError: (message) =>
      new ApiError(400, "invalid_request", message),
  });
  post(
    publicApiRoutes.threads.experimental_bindExternalSession,
    (context, payload) => context.json(bindExternalSession(deps, payload)),
  );
  post(
    publicApiRoutes.threads.experimental_releaseExternalSession,
    async (context, payload) =>
      context.json(await releaseExternalSession(deps, payload)),
  );
  post(
    publicApiRoutes.threads.experimental_findExternalThread,
    (context, payload) => context.json(findExternalThread(deps, payload)),
  );
  post(route, (context, payload) =>
    context.json(importExternalHistory(deps, payload)),
  );
}
