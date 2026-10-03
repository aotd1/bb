import fs from "node:fs/promises";
import path from "node:path";
import { provisionWorkspace } from "@bb/host-workspace";
import type { HostDaemonOnlineRpcResult } from "@bb/host-daemon-contract";
import {
  CommandDispatchError,
  type CommandOf,
  type CommandDispatchOptions,
} from "../command-dispatch-support.js";

export async function inspectHostWorkspace(
  command: CommandOf<"host.inspect_workspace">,
  options: Pick<CommandDispatchOptions, "runtimeManager">,
): Promise<HostDaemonOnlineRpcResult<"host.inspect_workspace">> {
  if (!path.isAbsolute(command.path) || command.path.includes("\0"))
    throw new CommandDispatchError("invalid_path", "Path must be absolute");
  const resolvedPath = await fs.realpath(command.path);
  if (
    resolvedPath === path.parse(resolvedPath).root ||
    !(await fs.stat(resolvedPath)).isDirectory()
  )
    throw new CommandDispatchError(
      "invalid_path",
      "Path must name a directory other than the filesystem root",
    );
  const workspace = await provisionWorkspace({
    path: resolvedPath,
    shellPath: options.runtimeManager.getShellEnv().PATH,
  });
  const [branchName, defaultBranch] = await Promise.all([
    workspace.getCurrentBranch(),
    workspace.getDefaultBranch(),
  ]);
  return {
    path: resolvedPath,
    isGitRepo: workspace.isGitRepo,
    isWorktree: workspace.isWorktree,
    branchName,
    defaultBranch: defaultBranch ?? branchName,
  };
}
