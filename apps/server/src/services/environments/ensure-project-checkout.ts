import path from "node:path";
import {
  createEnvironment,
  findProjectEnvironmentByHostPath,
  getHost,
  getProjectSourceByHost,
  noopNotifier,
} from "@bb/db";
import {
  experimentalEnsureProjectCheckoutRequestSchema,
  type ExperimentalEnsureProjectCheckoutRequest,
  type ExperimentalEnsureProjectCheckoutResponse,
} from "@bb/server-contract";
import type { AppDeps } from "../../types.js";
import { ApiError } from "../../errors.js";
import { callHostRetryableOnlineRpcForWork } from "../hosts/online-rpc.js";
import { findHostDataDir, requirePublicProject } from "../lib/entity-lookup.js";
import { suppliedWorkspacePathRefusal } from "../threads/workspace-path-claims.js";
import { assertEnvironmentPathAvailable } from "./path-admission.js";
import { toEnvironmentResponse } from "./environment-response.js";

function conflict(message: string): never {
  throw new ApiError(409, "environment_checkout_conflict", message);
}

function sourceTarget(
  deps: AppDeps,
  args: ExperimentalEnsureProjectCheckoutRequest,
) {
  requirePublicProject(deps.db, args.projectId);
  const host = getHost(deps.db, args.hostId);
  if (!host || host.destroyedAt !== null)
    throw new ApiError(404, "host_not_found", "Host not found");
  if (host.phase !== "active") conflict("Host must be active");
  const source = getProjectSourceByHost(deps.db, args.projectId, args.hostId);
  if (
    !source ||
    source.type !== "local_path" ||
    source.id !== args.expectedSourceId ||
    source.path !== args.expectedSourcePath
  )
    conflict(
      "Project source changed; refresh the local-path source before ensuring its checkout",
    );
  if (
    !path.posix.isAbsolute(source.path) ||
    source.path.includes("\0") ||
    path.posix.resolve(source.path) === "/"
  )
    throw new ApiError(
      400,
      "invalid_request",
      "Source must name an absolute project directory",
    );
  return { source, path: path.posix.resolve(source.path) };
}

function admitPath(
  deps: AppDeps,
  args: ExperimentalEnsureProjectCheckoutRequest,
  targetPath: string,
) {
  const refusal = suppliedWorkspacePathRefusal(deps.db, {
    projectId: args.projectId,
    hostId: args.hostId,
    dataDir: findHostDataDir(deps, args.hostId),
    path: targetPath,
  });
  if (refusal !== null) conflict(refusal);
  assertEnvironmentPathAvailable(deps, {
    hostId: args.hostId,
    path: targetPath,
    threadId: null,
  });
}

export async function ensureProjectCheckout(
  deps: AppDeps,
  input: ExperimentalEnsureProjectCheckoutRequest,
): Promise<ExperimentalEnsureProjectCheckoutResponse> {
  const parsed =
    experimentalEnsureProjectCheckoutRequestSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(400, "invalid_request", parsed.error.message);
  const args = parsed.data;
  const initial = sourceTarget(deps, args);
  admitPath(deps, args, initial.path);
  const inspected = await callHostRetryableOnlineRpcForWork(deps, {
    hostId: args.hostId,
    timeoutMs: 60_000,
    command: { type: "host.inspect_workspace", path: initial.path },
  });
  const result = deps.db.transaction(
    () => {
      const current = sourceTarget(deps, args);
      if (current.source.updatedAt !== initial.source.updatedAt)
        conflict(
          "Project source changed during checkout inspection; refresh and retry",
        );
      admitPath(deps, args, current.path);
      admitPath(deps, args, inspected.path);
      const canonical = findProjectEnvironmentByHostPath(
        deps.db,
        args.projectId,
        args.hostId,
        inspected.path,
      );
      const supplied =
        current.path === inspected.path
          ? canonical
          : findProjectEnvironmentByHostPath(
              deps.db,
              args.projectId,
              args.hostId,
              current.path,
            );
      if (canonical && supplied && canonical.id !== supplied.id)
        conflict("Checkout aliases refer to different recorded environments");
      const existing = canonical ?? supplied;
      if (existing) {
        if (
          existing.status !== "ready" ||
          existing.ownerThreadId !== null ||
          existing.teardownStatus !== null ||
          existing.retireAt !== null
        )
          conflict(
            "Recorded checkout must be ready, unowned, and outside retirement or teardown",
          );
        return { environment: existing, created: false };
      }
      return {
        environment: createEnvironment(deps.db, noopNotifier, {
          projectId: args.projectId,
          hostId: args.hostId,
          ...inspected,
          providerOwnsPath: false,
          environmentProvider: null,
          status: "ready",
        }),
        created: true,
      };
    },
    { behavior: "immediate" },
  );
  if (result.created) {
    deps.hub.notifyEnvironment(result.environment.id, ["environment-created"]);
  }
  return {
    environment: toEnvironmentResponse(deps.db, result.environment),
    created: result.created,
  };
}
