import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runGit } from "@bb/host-workspace";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RuntimeManager } from "../runtime-manager.js";
import { dispatchOnlineRpcCommand } from "../command-dispatch.js";
import { makeDispatchOptions } from "../../test/command/dispatch-helpers.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "bb-inspect-workspace-"),
  );
  roots.push(root);
  const checkout = path.join(root, "checkout");
  await fs.mkdir(checkout);
  await fs.writeFile(
    path.join(checkout, ".bb-env-setup.sh"),
    "#!/bin/sh\ntouch setup-was-run\n",
  );
  const createRuntime = vi.fn(() => {
    throw new Error("Runtime creation is forbidden during inspection");
  });
  const manager = new RuntimeManager({
    dataDir: path.join(root, "data"),
    createRuntime,
  });
  const options = makeDispatchOptions({
    runtimeManager: manager,
    dataDir: root,
  });
  return { root, checkout, options, createRuntime };
}

describe("host.inspect_workspace", () => {
  it("validates a non-git directory and resolves aliases without runtime or setup", async () => {
    const f = await fixture();
    const alias = path.join(f.root, "alias");
    await fs.symlink(f.checkout, alias);
    expect(
      await dispatchOnlineRpcCommand(
        { type: "host.inspect_workspace", path: alias },
        f.options,
      ),
    ).toEqual({
      path: await fs.realpath(f.checkout),
      isGitRepo: false,
      isWorktree: false,
      branchName: null,
      defaultBranch: null,
    });
    expect(f.createRuntime).not.toHaveBeenCalled();
    await expect(
      fs.stat(path.join(f.checkout, "setup-was-run")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a real linked worktree and branch without changing HEAD or the checkout", async () => {
    const f = await fixture();
    await runGit(["init", "-b", "main"], { cwd: f.checkout });
    await runGit(
      [
        "-c",
        "user.name=BB Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      { cwd: f.checkout },
    );
    const linked = path.join(f.root, "linked");
    await runGit(["worktree", "add", "-b", "imported-session", linked], {
      cwd: f.checkout,
    });
    const result = await dispatchOnlineRpcCommand(
      { type: "host.inspect_workspace", path: linked },
      f.options,
    );
    expect(result).toMatchObject({
      path: await fs.realpath(linked),
      isGitRepo: true,
      isWorktree: true,
      branchName: "imported-session",
    });
    expect(
      (
        await runGit(["branch", "--show-current"], { cwd: f.checkout })
      ).stdout.trim(),
    ).toBe("main");
    expect(f.createRuntime).not.toHaveBeenCalled();
  });

  it("rejects missing paths, files, relative paths and the filesystem root", async () => {
    const f = await fixture();
    await expect(
      dispatchOnlineRpcCommand(
        { type: "host.inspect_workspace", path: path.join(f.root, "absent") },
        f.options,
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
    for (const target of [
      "relative",
      "/",
      path.join(f.checkout, ".bb-env-setup.sh"),
    ])
      await expect(
        dispatchOnlineRpcCommand(
          { type: "host.inspect_workspace", path: target },
          f.options,
        ),
      ).rejects.toMatchObject({ code: "invalid_path" });
    expect(f.createRuntime).not.toHaveBeenCalled();
  });
});
