import { collectOptionalFieldPaths } from "@bb/test-helpers";
import {
  TERMINAL_COLS_MAX,
  TERMINAL_DATA_MAX_BASE64_LENGTH,
  TERMINAL_DATA_MAX_BYTES,
  TERMINAL_ROWS_MAX,
  threadScope,
  turnScope,
  type JsonObject,
} from "@bb/domain";
import { describe, expect, it } from "vitest";
import * as contract from "../src/index.js";
import {
  HOST_ARTIFACT_MAX_BYTES,
  HOST_DAEMON_PROTOCOL_VERSION,
  HOST_DAEMON_ONLINE_RPC_COMMAND_TYPES,
  HOST_DAEMON_SETTLED_COMMAND_TYPES,
  hostDaemonEnrollRequestSchema,
  hostDaemonEnrollResponseSchema,
  hostDaemonCommandResultSchemaByType,
  hostDaemonCommandSchema,
  hostDaemonDaemonWsMessageSchema,
  hostDaemonEventBatchRequestSchema,
  hostDaemonEventBatchResponseSchema,
  hostDaemonInteractiveInterruptRequestSchema,
  hostDaemonInteractiveInterruptResponseSchema,
  hostDaemonInjectedSkillSourceSchema,
  hostDaemonInteractiveRequestResponseSchema,
  hostDaemonInteractiveRequestSchema,
  hostDaemonOnlineRpcCommandSchema,
  type HostDaemonOnlineRpcCommandType,
  type HostDaemonRpcCommandType,
  hostDaemonOnlineRpcResponseMessageSchema,
  hostDaemonServerWsMessageSchema,
  hostDaemonSessionOpenRequestSchema,
  hostDaemonSessionOpenResponseSchema,
  hostDaemonTerminalOutputChunkSchema,
  threadStopCommandSchema,
  type HostDaemonSettledCommandType,
} from "../src/index.js";

const CLIENT_REQUEST_ID = "creq_23456789ab";
const ACP_LAUNCH_SPEC = {
  displayName: "Local ACP",
  command: "local-acp",
  args: ["serve"],
  env: {
    LOCAL_ACP_MODE: "test",
  },
  cwd: "/tmp/local-acp",
  modelCli: {
    listArgs: ["models", "list"],
    selectFlag: "--model",
    primaryModels: ["local-default"],
  },
  reasoningCli: {
    flag: "--reasoning-effort",
    supportedLevels: ["low", "medium", "high"],
    levelValues: {
      max: "high",
    },
    defaultLevel: "high",
  },
  nativeReasoning: {
    configId: "reasoning_effort",
    supportedLevels: ["none", "low", "medium", "high", "xhigh", "max"],
    defaultLevel: "medium",
  },
  nativeSkillRoots: {
    user: [".agents/skills"],
    project: [".agents/skills"],
  },
  permissionCli: {
    full: ["--always-approve"],
    insertAfterArgs: 1,
  },
};

type OnlineRpcResponseResultFixtures = Record<
  HostDaemonOnlineRpcCommandType,
  JsonObject
>;
type SettledResponseResultFixtures = Record<
  HostDaemonSettledCommandType,
  JsonObject
>;

interface OnlineRpcResponseMismatchCase {
  commandType: HostDaemonOnlineRpcCommandType;
  name: string;
  result: JsonObject;
}

interface OnlineRpcResponseRoundTripCase {
  commandType: HostDaemonOnlineRpcCommandType;
  name: string;
  result: JsonObject;
}

const WORKSPACE_UNAVAILABLE_RESULT: JsonObject = {
  outcome: "unavailable",
  failure: {
    code: "path_not_found",
    workspacePath: "/tmp/missing-workspace",
    message: "Workspace path is missing",
  },
};

const WORKSPACE_STATUS_AVAILABLE_RESULT: JsonObject = {
  outcome: "available",
  workspaceStatus: {
    workingTree: {
      insertions: 3,
      deletions: 1,
      lineStatsComplete: true,
      files: [
        {
          path: "src/index.ts",
          status: "M",
          insertions: 3,
          deletions: 1,
        },
      ],
      hasUncommittedChanges: true,
      state: "dirty_and_committed_unmerged",
    },
    branch: {
      currentBranch: "feature/host-rpc",
      defaultBranch: "main",
    },
    checkout: {
      kind: "branch",
      branchName: "feature/host-rpc",
      headSha: null,
    },
    mergeBase: {
      insertions: 5,
      deletions: 0,
      lineStatsComplete: true,
      files: [
        {
          path: "README.md",
          status: "A",
          insertions: 5,
          deletions: 0,
        },
      ],
      mergeBaseBranch: "main",
      baseRef: "abc123",
      aheadCount: 1,
      behindCount: 0,
      hasCommittedUnmergedChanges: true,
      commits: [
        {
          sha: "abcdef123456",
          shortSha: "abcdef1",
          subject: "Add host RPC guard",
          authorName: "Test User",
          authoredAt: 1_700_000_000_000,
        },
      ],
    },
  },
};

const WORKSPACE_DIFF_AVAILABLE_RESULT: JsonObject = {
  outcome: "available",
  diff: {
    diff: "diff --git a/src/index.ts b/src/index.ts\n",
    truncated: false,
    shortstat: "1 file changed, 3 insertions(+), 1 deletion(-)",
    files: "src/index.ts\n",
    mergeBaseRef: "abc123",
  },
};

const ONLINE_RPC_RESPONSE_RESULT_FIXTURES: OnlineRpcResponseResultFixtures = {
  "environment.hook.run": {},
  "environment.hook.cancel": { status: "terminated" },
  "desktop.browser.list_instances": { instances: [] },
  "desktop.browser.list_tabs": { tabs: [] },
  "desktop.browser.create_tab": {
    tab: {
      tabId: "tab",
      threadId: "thread",
      title: "",
      url: "about:blank",
      presentation: "hidden",
      control: null,
    },
  },
  "desktop.browser.reveal_tab": { ok: true },
  "desktop.browser.close_tab": { ok: true },
  "desktop.browser.capture_tab": {
    mimeType: "image/jpeg",
    width: 800,
    height: 600,
    base64: "",
  },
  "desktop.browser.acquire_control": {
    lease: {
      leaseId: "lease",
      controllerLabel: "Agent",
      expiresAt: 1700000000000,
    },
  },
  "desktop.browser.open_connection": {
    wsEndpoint: "ws://127.0.0.1:1234/scoped",
    expiresAt: 1700000000000,
  },
  "desktop.browser.release_control": { ok: true },
  "desktop.browser.list_import_sources": {
    sources: [
      {
        id: "chrome",
        name: "Google Chrome",
        profiles: [{ directory: "Default", name: "Person 1", cookieCount: 12 }],
      },
      {
        id: "safari",
        name: "Safari",
        profiles: [],
        unavailable: "notInstalled",
      },
    ],
  },
  "desktop.browser.import_cookies": {
    ok: true,
    imported: 12,
    skipped: 1,
    skippedDomains: ["example.com"],
  },
  "plugin.host.call": { output: { ok: true } },
  "plugin.host.cancel": { cancelled: true },
  "plugin.host.dispose": { disposed: true },
  "connect-tunnel.ensure-identity": {
    label: "sawyer-air",
    baseDomain: "getbb.app",
  },
  "host.list_files": {
    files: [
      {
        path: "src/index.ts",
        name: "index.ts",
      },
    ],
    truncated: false,
  },
  "host.list_paths": {
    paths: [
      {
        kind: "directory",
        path: "src",
        name: "src",
        score: 0,
        positions: [],
      },
      {
        kind: "file",
        path: "src/index.ts",
        name: "index.ts",
        score: 1,
        positions: [0, 4],
      },
    ],
    truncated: false,
  },
  "host.mkdir": { ok: true },
  "host.move_path": { ok: true },
  "host.remove_path": { ok: true },
  "host.browse_directory": {
    directory: "/home/me/project",
    parent: "/home/me",
    entries: [
      { kind: "directory", name: "src", path: "/home/me/project/src" },
      { kind: "file", name: "README.md", path: "/home/me/project/README.md" },
    ],
  },
  "host.paths_exist": {
    existence: {
      "/home/me/project": true,
      "/home/me/missing": false,
    },
  },
  "project.inspect": {
    path: "/home/me/project",
    gitRemoteUrl: "git@example.com:me/project.git",
  },
  "project.clone_default_path": {
    path: "/home/me/.bb/checkouts/project",
  },
  "host.pick_folder": {
    path: "/home/me/project",
  },
  "host.list_commands": {
    commands: [
      {
        name: "review",
        source: "skill",
        origin: "project",
        description: "Review the current diff",
        argumentHint: null,
      },
    ],
  },
  "host.list_skills": {
    skills: [
      {
        id: `skill_${"a".repeat(64)}`,
        name: "review",
        description: "Review the current diff",
        filePath: "/home/user/.bb/skills/review/SKILL.md",
        rootKind: "bb-data-dir",
        linked: false,
      },
    ],
  },
  "host.delete_skill": {
    deletedPath: "/home/user/.bb/skills/review",
  },
  "host.write_skill": {
    outcome: "written",
    filePath: "/home/user/.bb/skills/review/SKILL.md",
    sha256: "b".repeat(64),
  },
  "host.global_skills_status": {
    entries: [
      {
        name: "bb-cli",
        path: "/home/user/.agents/skills/bb-cli",
        treeHash: "c".repeat(64),
      },
    ],
  },
  "host.install_global_skills": {
    installations: [
      { name: "bb-cli", path: "/home/user/.agents/skills/bb-cli" },
    ],
  },
  "host.inspect_workspace": {
    path: "/tmp/project",
    isGitRepo: true,
    isWorktree: false,
    branchName: "main",
    defaultBranch: "main",
  },
  "host.inspect_git_source": {
    checkout: {
      kind: "branch",
      branchName: "main",
      headSha: "abc123",
    },
    defaultBranch: "main",
    defaultBranchRelation: "equal",
    isWorktree: false,
    hasUncommittedChanges: false,
    operation: {
      kind: "none",
    },
    originDefaultBranch: "origin/main",
  },
  "host.list_branch_options": {
    branches: ["main"],
    branchesTruncated: false,
    remoteBranches: ["origin/main"],
    remoteBranchesTruncated: false,
    selectedBranch: {
      name: "main",
      kind: "local",
    },
  },
  "host.read_file": {
    path: "/tmp/report.html",
    content: "<!doctype html>",
    contentEncoding: "utf8",
    mimeType: "text/html",
    sizeBytes: 15,
    sha256: "a".repeat(64),
  },
  "host.read_file_chunk": {
    path: "/tmp/clip.mp4",
    content: "AAEC",
    offset: 0,
    sizeBytes: 3,
    modifiedAtMs: 1234,
    mimeType: "video/mp4",
    revision: "a".repeat(64),
  },
  "host.read_file_relative": {
    path: "assets/logo.png",
    content: "iVBORw0KGgo=",
    contentEncoding: "base64",
    mimeType: "image/png",
    sizeBytes: 8,
    sha256: "b".repeat(64),
  },
  "host.write_file": {
    outcome: "written",
    sha256: "c".repeat(64),
    sizeBytes: 12,
  },
  "provider.list_models": {
    models: [
      {
        id: "codex/gpt-5",
        model: "gpt-5",
        displayName: "GPT-5",
        routeProviderId: "openai-codex",
        description: "Test model",
        supportedReasoningEfforts: [
          {
            reasoningEffort: "medium",
            description: "Balanced",
          },
        ],
        defaultReasoningEffort: "medium",
        isDefault: true,
      },
    ],
    selectedOnlyModels: [],
  },
  "provider.health": {
    supported: true,
    health: {
      status: "ready",
      statusMessage: null,
      accountEmail: "agent@example.com",
      planLabel: "Pro",
      installedVersion: "1.2.3",
      minimumSupportedVersion: "1.0.0",
      canInstall: true,
      canUpdate: true,
      loginCommand: "agent login",
    },
  },
  "provider.usage": {
    supported: true,
    usage: {
      status: "ok",
      accountEmail: "codex@example.com",
      planLabel: "Pro",
      windows: [
        {
          label: "Current session",
          usedPercent: 6,
          resetsAt: "2026-06-20T05:28:16.000Z",
        },
      ],
    },
  },
  "provider.installation.status": {
    executableName: "codex",
    executablePath: null,
    installed: false,
    installSource: "notInstalled",
    currentVersion: null,
    latestVersion: "0.136.0",
    minimumSupportedVersion: "0.136.0",
    npmPackageName: "@openai/codex",
    npmGlobalPackageVersion: null,
    installAction: {
      kind: "install",
      label: "Install",
      command: "npm install -g @openai/codex@latest",
    },
    needsUpdate: false,
    versionUnsupported: false,
  },
  "provider.installation.run": {
    events: [
      {
        type: "started",
        provider: "codex",
        command: "npm install -g @openai/codex@latest",
      },
      {
        type: "completed",
        provider: "codex",
        exitCode: 0,
        signal: null,
        success: true,
      },
    ],
  },
  "workspace.status": WORKSPACE_UNAVAILABLE_RESULT,
  "workspace.diff": {
    outcome: "unavailable",
    failure: {
      code: "not_git_repo",
      workspacePath: "/tmp/workspace",
      message: "Path is not a git repository: /tmp/workspace",
    },
  },
  "workspace.diffFiles": WORKSPACE_UNAVAILABLE_RESULT,
  "workspace.diffPatch": WORKSPACE_UNAVAILABLE_RESULT,
  "workspace.pull_request": {
    outcome: "available",
    pullRequest: {
      number: 42,
      title: "Add host RPC guard",
      state: "OPEN",
      url: "https://github.com/acme/bb/pull/42",
      isDraft: false,
      baseRefName: "main",
      headRefName: "feature/host-rpc",
      updatedAt: "2026-06-16T12:30:00Z",
      autoMerge: false,
      inMergeQueue: false,
      checks: [
        {
          name: "test",
          status: "completed",
          conclusion: "success",
          url: null,
          startedAt: "2026-06-16T12:25:00Z",
        },
      ],
      reviewDecision: "APPROVED",
      reviewRequestCount: 0,
      mergeStateStatus: "CLEAN",
      mergeable: "MERGEABLE",
    },
  },
  "server_move.inspect": {
    dataDir: "/home/me/.bb-machines/bb.example.com",
    platform: "linux",
    timeZone: "America/Los_Angeles",
    bbAppVersion: "0.0.5",
    serverEntryAvailable: false,
    existingServerData: null,
    dataDirHasServerData: false,
    portAvailable: true,
    ghAuthenticated: null,
    codexCredentialsPresent: false,
    pathsExist: { "/home/me/plugins/local": false },
    diskFreeBytes: 1_000_000,
  },
  "server_move.probe": { reachable: true, message: null, state: "ready" },
  "server_move.prepare": {
    localServerUrl: "http://127.0.0.1:38886",
    pid: 4242,
  },
  "server_move.activate": { ok: true },
  "server_move.abort": { ok: true },
  "server_move.delete_old_copy": { deleted: true },
};

const SETTLED_RESPONSE_RESULT_FIXTURES: SettledResponseResultFixtures = {
  "thread.rewind.discard": {},
  "thread.rewind.prepare": {
    providerThreadId: "provider-thread-rewind",
  },
  "thread.start": {
    providerThreadId: "provider-thread-123",
  },
  "turn.submit": {},
  "thread.stop": { providerCheckpointId: null },
  "thread.storage.delete": { providerCheckpointId: null },
  "thread.goal.clear": { cleared: true },
  "thread.plan.cancel": { cancelled: true },
  "thread.rename": {},
  "thread.archive": {},
  "thread.unarchive": {},
  "interactive.resolve": {},
  "environment.attach": {
    path: "/tmp/env",
    isGitRepo: true,
    isWorktree: false,
    branchName: "bb/env-123",
    defaultBranch: "main",
  },
  "environment.attach.cancel": {
    aborted: true,
  },
  "project.clone": {
    path: "/home/me/.bb/checkouts/project",
    gitRemoteUrl: "git@example.com:me/project.git",
  },
  "workspace.commit": {
    commitSha: "abcdef123456",
    commitSubject: "Checkpoint work",
  },
  "workspace.pull_request_action": {},
};

const WORKSPACE_DIFF_FILES_AVAILABLE_RESULT: JsonObject = {
  outcome: "available",
  files: [
    {
      path: "src/renamed.ts",
      previousPath: "src/original.ts",
      statusLetter: "R",
      additions: 3,
      deletions: 1,
      binary: false,
      origin: "tracked",
    },
  ],
  shortstat: "1 file changed, 3 insertions(+), 1 deletion(-)",
  mergeBaseRef: "abc123",
  truncated: false,
};

const WORKSPACE_DIFF_PATCH_AVAILABLE_RESULT: JsonObject = {
  outcome: "available",
  patches: [
    {
      path: "src/renamed.ts",
      patch: "diff --git a/src/original.ts b/src/renamed.ts\n",
      truncated: true,
    },
  ],
};

const ADDITIONAL_ONLINE_RPC_RESPONSE_ROUND_TRIP_CASES: OnlineRpcResponseRoundTripCase[] =
  [
    {
      name: "host.read_file not-modified result",
      commandType: "host.read_file",
      result: {
        path: "/tmp/preview.png",
        contentEncoding: "base64",
        mimeType: "image/png",
        sizeBytes: 1024,
        sha256: "a".repeat(64),
        notModified: true,
      },
    },
    {
      name: "host.inspect_git_source mid-merge result",
      commandType: "host.inspect_git_source",
      result: {
        checkout: {
          kind: "branch",
          branchName: "feature/test",
          headSha: "abc123",
        },
        defaultBranch: "main",
        defaultBranchRelation: "equal",
        isWorktree: false,
        hasUncommittedChanges: true,
        operation: { kind: "merge", hasConflicts: true },
        originDefaultBranch: "origin/main",
      },
    },
    {
      name: "workspace.status available result",
      commandType: "workspace.status",
      result: WORKSPACE_STATUS_AVAILABLE_RESULT,
    },
    {
      name: "workspace.status clean result without a merge base",
      commandType: "workspace.status",
      result: {
        outcome: "available",
        workspaceStatus: {
          workingTree: {
            insertions: 0,
            deletions: 0,
            lineStatsComplete: true,
            files: [],
            hasUncommittedChanges: false,
            state: "clean",
          },
          branch: {
            currentBranch: "bb/env-123",
            defaultBranch: "main",
          },
          checkout: {
            kind: "branch",
            branchName: "bb/env-123",
            headSha: null,
          },
          mergeBase: null,
        },
      },
    },
    {
      name: "workspace.diff available result",
      commandType: "workspace.diff",
      result: WORKSPACE_DIFF_AVAILABLE_RESULT,
    },
    {
      name: "workspace.diffFiles available result",
      commandType: "workspace.diffFiles",
      result: WORKSPACE_DIFF_FILES_AVAILABLE_RESULT,
    },
    {
      name: "workspace.diffPatch available result",
      commandType: "workspace.diffPatch",
      result: WORKSPACE_DIFF_PATCH_AVAILABLE_RESULT,
    },
    {
      name: "workspace.pull_request no-PR result",
      commandType: "workspace.pull_request",
      result: { outcome: "absent" },
    },
    {
      name: "workspace.pull_request unavailable result",
      commandType: "workspace.pull_request",
      result: {
        outcome: "unavailable",
        message: "GitHub CLI is not available",
      },
    },
  ];

const ONLINE_RPC_RESPONSE_MISMATCH_CASES: OnlineRpcResponseMismatchCase[] = [
  {
    name: "host.list_files command with a read-file result",
    commandType: "host.list_files",
    result: {
      path: "/tmp/report.html",
      content: "<!doctype html>",
      contentEncoding: "utf8",
      mimeType: "text/html",
      sizeBytes: 15,
    },
  },
  {
    name: "host.read_file command with a list-files result",
    commandType: "host.read_file",
    result: {
      files: [],
      truncated: false,
    },
  },
  {
    name: "provider.list_models command with a provider-list result",
    commandType: "provider.list_models",
    result: {
      providers: [],
    },
  },
  {
    name: "provider.list_models command with unrelated collection result",
    commandType: "provider.list_models",
    result: {
      captures: [],
    },
  },
];

function buildHostRpcResponseMessage(
  commandType: HostDaemonRpcCommandType,
  result: JsonObject,
): JsonObject {
  return {
    type: "host-rpc.response",
    requestId: `rpc-${commandType}`,
    commandType,
    ok: true,
    result,
  };
}

function expectHostRpcResponseRoundTrip(
  commandType: HostDaemonRpcCommandType,
  result: JsonObject,
  name: string,
): void {
  const message = buildHostRpcResponseMessage(commandType, result);
  const jsonRoundTripped = JSON.parse(JSON.stringify(message));

  expect(
    hostDaemonOnlineRpcResponseMessageSchema.parse(jsonRoundTripped),
    name,
  ).toEqual(message);
  expect(hostDaemonDaemonWsMessageSchema.parse(jsonRoundTripped), name).toEqual(
    message,
  );
}

function terminalDataBase64(byteLength: number): string {
  return Buffer.alloc(byteLength, "a").toString("base64");
}

const INTENTIONAL_OPTIONAL_HOST_DAEMON_FIELDS: Record<string, string> = {
  "hostDaemonCommandSchema.resolution.description":
    "the interaction.resolve command's resolution is the persisted union, so it also admits the plugin_submitted arm and the description a plugin's describeSubmission returned. It never reaches the wire: a plugin interaction is settled in the server against its waiting requestInput promise and never queues a daemon command, so an older daemon never sees the field.",
  "hostDaemonCommandSchema.resolution.description.detail":
    "a described submission carries Markdown detail only when the plugin returned some; absence means the row title is the whole row.",
  "hostDaemonCommandSchema.resolution.description.payload":
    "a described submission carries a payload only when the plugin has something for its own timeline renderer; absence means the row renders from title and detail alone.",
  "hostDaemonCommandSchema.resolution.description.title":
    "a described submission overrides the row title only when the plugin returned one; absence means the presentation's completed label stands.",
  "hostDaemonCommandSchema.dynamicTools.presentation":
    "a dynamic tool declares a row presentation only when its plugin wrote one; absence means bb renders the call with the standard tool name and the plugin's branding glyph.",
  "hostDaemonCommandSchema.dynamicTools.presentation.badge":
    "a dynamic tool's presentation carries a badge only when there is something to flag about how the call will run; absence means the ordinary case, not a blank badge.",
  "hostDaemonCommandSchema.dynamicTools.presentation.detail":
    "a dynamic tool's presentation has a detail only when the plugin summarized the call; a missing detail means the label and title are the whole summary, not an empty string.",
  "hostDaemonCommandSchema.dynamicTools.presentation.suppress":
    "a dynamic tool's presentation marks suppress only for low-value rows the plugin wants collapsed; absence means render normally.",
  "hostDaemonCommandSchema.dynamicTools.presentation.tint":
    "a dynamic tool's presentation carries a tint only when the plugin wants an accent colour; absence means the neutral row tint, which is not a colour value.",
  "hostDaemonCommandSchema.dynamicTools.presentation.title":
    "a dynamic tool's presentation has a title only when the call has a headline (a path, a query); absence means the label stands alone.",
  "hostDaemonCommandSchema.input.mimeType":
    "a localFile prompt input carries a mime type only when the uploader determined one; absence means the daemon must sniff or fall back, not that the file is untyped.",
  "hostDaemonCommandSchema.input.name":
    "a localFile prompt input names itself only when the uploader knew a name; absence means the path is the file's only identity, not that it is unnamed.",
  "hostDaemonCommandSchema.input.sizeBytes":
    "a localFile prompt input carries a size only when the uploader measured one; absence means unknown, and no reader may read it as zero.",
  "hostDaemonCommandSchema.input.visibility":
    "a prompt input declares visibility only to hide itself from the person: the single value agent-only marks an input the transcript does not show, so absence is the ordinary visible input.",
  "hostDaemonCommandSchema.inputGroups.mimeType":
    "a localFile prompt input carries a mime type only when the uploader determined one; absence means the daemon must sniff or fall back, not that the file is untyped.",
  "hostDaemonCommandSchema.inputGroups.name":
    "a localFile prompt input names itself only when the uploader knew a name; absence means the path is the file's only identity, not that it is unnamed.",
  "hostDaemonCommandSchema.inputGroups.sizeBytes":
    "a localFile prompt input carries a size only when the uploader measured one; absence means unknown, and no reader may read it as zero.",
  "hostDaemonCommandSchema.inputGroups.visibility":
    "a prompt input declares visibility only to hide itself from the person: the single value agent-only marks an input the transcript does not show, so absence is the ordinary visible input.",
  "hostDaemonCommandSchema.resumeContext.dynamicTools.presentation":
    "a dynamic tool declares a row presentation only when its plugin wrote one; absence means bb renders the call with the standard tool name and the plugin's branding glyph.",
  "hostDaemonCommandSchema.resumeContext.dynamicTools.presentation.badge":
    "a dynamic tool's presentation carries a badge only when there is something to flag about how the call will run; absence means the ordinary case, not a blank badge.",
  "hostDaemonCommandSchema.resumeContext.dynamicTools.presentation.detail":
    "a dynamic tool's presentation has a detail only when the plugin summarized the call; a missing detail means the label and title are the whole summary, not an empty string.",
  "hostDaemonCommandSchema.resumeContext.dynamicTools.presentation.suppress":
    "a dynamic tool's presentation marks suppress only for low-value rows the plugin wants collapsed; absence means render normally.",
  "hostDaemonCommandSchema.resumeContext.dynamicTools.presentation.tint":
    "a dynamic tool's presentation carries a tint only when the plugin wants an accent colour; absence means the neutral row tint, which is not a colour value.",
  "hostDaemonCommandSchema.resumeContext.dynamicTools.presentation.title":
    "a dynamic tool's presentation has a title only when the call has a headline (a path, a query); absence means the label stands alone.",
  "hostDaemonInteractiveRequestSchema.interaction.payload.questions.options":
    "a user question omits options when it takes free text only; absence is the question's shape, not missing choices.",
  "hostDaemonInteractiveRequestSchema.interaction.payload.questions.options.description":
    "a question option carries a description only when its label needs a gloss; absence means the label stands alone.",
  "hostDaemonInteractiveRequestSchema.interaction.payload.questions.shortLabel":
    "a user question omits shortLabel when its prompt is short enough to title the row itself.",
  "hostDaemonOnlineRpcCommandSchema.nativeRoots.commands.project.skipIfManifest":
    "a provider-native root names a vendor-plugin marker file only when the plugin that knows that vendor layout declares one; absence means every skill-shaped directory under the root is a skill, and core names no vendor path itself.",
  "hostDaemonOnlineRpcCommandSchema.nativeRoots.commands.user.skipIfManifest":
    "a provider-native root names a vendor-plugin marker file only when the plugin that knows that vendor layout declares one; absence means every skill-shaped directory under the root is a skill, and core names no vendor path itself.",
  "hostDaemonOnlineRpcCommandSchema.nativeRoots.resolved.commands.fallbackName":
    "a resolved skill-file root carries a fallback name only when the file's frontmatter names none and something else supplies it; absence means the parent directory's name is used.",
  "hostDaemonOnlineRpcCommandSchema.nativeRoots.resolved.commands.skipIfManifest":
    "a provider-native root names a vendor-plugin marker file only when the plugin that knows that vendor layout declares one; absence means every skill-shaped directory under the root is a skill, and core names no vendor path itself.",
  "hostDaemonOnlineRpcCommandSchema.nativeRoots.resolved.skills.fallbackName":
    "a resolved skill-file root carries a fallback name only when the file's frontmatter names none and something else supplies it; absence means the parent directory's name is used.",
  "hostDaemonOnlineRpcCommandSchema.nativeRoots.resolved.skills.skipIfManifest":
    "a provider-native root names a vendor-plugin marker file only when the plugin that knows that vendor layout declares one; absence means every skill-shaped directory under the root is a skill, and core names no vendor path itself.",
  "hostDaemonOnlineRpcCommandSchema.nativeRoots.skills.project.skipIfManifest":
    "a provider-native root names a vendor-plugin marker file only when the plugin that knows that vendor layout declares one; absence means every skill-shaped directory under the root is a skill, and core names no vendor path itself.",
  "hostDaemonOnlineRpcCommandSchema.nativeRoots.skills.user.skipIfManifest":
    "a provider-native root names a vendor-plugin marker file only when the plugin that knows that vendor layout declares one; absence means every skill-shaped directory under the root is a skill, and core names no vendor path itself.",
  "hostDaemonCommandSchema.targetPath":
    "project.clone omits targetPath when the daemon should derive its default checkout location for the project.",
  "hostDaemonOnlineRpcCommandSchema.expectedSha256":
    "host.write_file may omit expectedSha256 for unconditional writes; a hash is the compare-and-swap guard and null means create-only.",
  "hostDaemonOnlineRpcCommandSchema.ifNoneMatch":
    "host.read_file omits ifNoneMatch for unconditional reads; when present the daemon may omit unchanged file content.",
  "hostDaemonOnlineRpcCommandSchema.mode":
    "host.write_file may omit mode to preserve existing permissions; when present it only controls newly created files.",
  "hostDaemonOnlineRpcCommandSchema.mergeBaseBranch":
    "workspace.status may omit mergeBaseBranch when the caller only needs working-tree state.",
  "hostDaemonInteractiveRequestSchema.interaction.payload.subject.presentation.badge":
    "a tool_use approval's presentation carries a badge only when the bridge has something to flag about how the call will run, such as a command opting out of the session sandbox; absence means the ordinary case, not a blank badge.",
  "hostDaemonInteractiveRequestSchema.interaction.payload.subject.presentation.detail":
    "a tool_use approval's presentation has a detail only when the bridge summarized the call; a missing detail means the label and title are the whole summary, not an empty string.",
  "hostDaemonInteractiveRequestSchema.interaction.payload.subject.presentation.suppress":
    "a tool_use approval's presentation marks suppress only for low-value rows the bridge wants collapsed; absence means render normally.",
  "hostDaemonInteractiveRequestSchema.interaction.payload.subject.presentation.tint":
    "a tool_use approval's presentation carries a tint only when the bridge wants an accent colour; absence means the neutral row tint, which is not a colour value.",
  "hostDaemonInteractiveRequestSchema.interaction.payload.subject.presentation.title":
    "a tool_use approval's presentation has a title only when the call has a headline (a path, a query); absence means the label stands alone.",
  "hostDaemonOnlineRpcCommandSchema.cwd":
    "provider.list_models may omit cwd when only user-level provider configuration applies.",
  "hostDaemonOnlineRpcCommandSchema.query":
    "host.list_files may omit a search string to list files without filtering.",
  "hostDaemonOnlineRpcCommandSchema.path":
    "host.browse_directory may omit path to list the host's home directory, which a remote caller cannot resolve.",
  "hostDaemonOnlineRpcCommandSchema.ref":
    "host.read_file may omit ref to read from disk; setting ref switches to git history at that ref.",
  "hostDaemonOnlineRpcCommandSchema.rootPath":
    "host.read_file may omit rootPath only for explicit absolute disk reads; ref-based reads still require it.",
  "hostDaemonOnlineRpcCommandSchema.selectedBranch":
    "host.list_branch_options may omit exact selected-branch classification when the caller only needs a branch option page.",
  "hostDaemonCommandSchema.threadStoragePath":
    "thread.start may include a storage path so the daemon creates the directory before the agent starts.",
  "hostDaemonCommandSchema.fork":
    "thread.start omits fork unless the new thread should clone an existing provider session; absent means a normal start.",
  "hostDaemonCommandSchema.fork.sourceProviderCheckpointId":
    "thread.start.fork names a checkpoint only when the clone should stop at an earlier source turn; absent means clone the session tip.",
  "hostDaemonCommandSchema.inputGroups":
    "thread.start and turn.submit omit inputGroups for ordinary single user-message turns; presence preserves grouped user messages within one turn.",
  "hostDaemonCommandSchema.options.promptMode":
    "thread runtime options carry a prompt mode only when the prompt entered one through the provider's declared composer action.",
};

describe("cache usage wire compatibility", () => {
  it.each([
    {},
    { cacheReadInputTokens: 31, cacheWriteInputTokens: 9 },
    { cacheWriteInputTokens: 0 },
  ])("preserves legacy and reported cache fields %j", (counts) => {
    const usage = {
      totalTokens: 140,
      inputTokens: 80,
      cachedInputTokens: 40,
      outputTokens: 20,
      reasoningOutputTokens: 0,
      ...counts,
    };
    const batch = {
      sessionId: "session-usage",
      eventGroups: [
        {
          threadId: "thread-usage",
          events: [
            {
              type: "thread/tokenUsage/updated",
              threadId: "thread-usage",
              providerThreadId: "provider-usage",
              scope: turnScope("turn-usage"),
              tokenUsage: {
                total: usage,
                last: usage,
                modelContextWindow: null,
              },
            },
          ],
        },
      ],
    };
    expect(hostDaemonEventBatchRequestSchema.parse(batch)).toEqual(batch);
  });
});

describe("host-daemon local schemas", () => {
  it("parses workspace open target routes", () => {
    expect(
      contract.workspaceOpenTargetSchema.parse({
        id: "custom:my-editor",
        label: "My Editor",
        kind: "editor",
        icon: {
          kind: "builtin",
          name: "vscode",
        },
        capabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtColumn: true,
          openFileAtLine: true,
        },
        remoteSshCapabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtColumn: true,
          openFileAtLine: true,
        },
      }),
    ).toEqual({
      id: "custom:my-editor",
      label: "My Editor",
      kind: "editor",
      icon: {
        kind: "builtin",
        name: "vscode",
      },
      capabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtColumn: true,
        openFileAtLine: true,
      },
      remoteSshCapabilities: {
        openDirectory: true,
        openFile: true,
        openFileAtColumn: true,
        openFileAtLine: true,
      },
    });

    expect(
      contract.workspaceOpenTargetsResponseSchema.parse({
        targets: [
          {
            id: "default-app",
            label: "Default App",
            capabilities: {
              openDirectory: true,
              openFile: true,
              openFileAtLine: false,
            },
          },
          {
            id: "finder",
            label: "Finder",
            capabilities: {
              openDirectory: true,
              openFile: false,
              openFileAtLine: false,
            },
          },
          {
            id: "terminal",
            label: "Terminal",
            capabilities: {
              openDirectory: true,
              openFile: false,
              openFileAtLine: false,
            },
          },
        ],
      }),
    ).toEqual({
      targets: [
        {
          id: "default-app",
          label: "Default App",
          capabilities: {
            openDirectory: true,
            openFile: true,
            openFileAtLine: false,
          },
        },
        {
          id: "finder",
          label: "Finder",
          capabilities: {
            openDirectory: true,
            openFile: false,
            openFileAtLine: false,
          },
        },
        {
          id: "terminal",
          label: "Terminal",
          capabilities: {
            openDirectory: true,
            openFile: false,
            openFileAtLine: false,
          },
        },
      ],
    });

    expect(
      contract.openInTargetRequestSchema.parse({
        lineNumber: 12,
        path: "/tmp/workspace",
        targetId: "zed",
      }),
    ).toEqual({
      context: { kind: "local" },
      columnNumber: null,
      lineNumber: 12,
      path: "/tmp/workspace",
      targetId: "zed",
    });

    expect(
      contract.openInTargetRequestSchema.parse({
        context: {
          kind: "remote-ssh",
          serverOrigin: "https://bb.example.test",
          hostId: "host_remote",
        },
        lineNumber: 12,
        path: "/home/me/project/file.ts",
        targetId: "vscode",
      }),
    ).toEqual({
      context: {
        kind: "remote-ssh",
        serverOrigin: "https://bb.example.test",
        hostId: "host_remote",
      },
      columnNumber: null,
      lineNumber: 12,
      path: "/home/me/project/file.ts",
      targetId: "vscode",
    });
  });

  it("rejects malformed workspace open payloads", () => {
    expect(() =>
      contract.workspaceOpenTargetSchema.parse({
        id: "",
        label: "Unknown",
        capabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtLine: true,
        },
      }),
    ).toThrow();

    expect(() =>
      contract.workspaceOpenTargetSchema.parse({
        id: "custom:bad-icon",
        label: "Bad Icon",
        icon: {
          kind: "data-url",
          dataUrl: "https://example.test/icon.png",
        },
        capabilities: {
          openDirectory: true,
          openFile: true,
          openFileAtLine: true,
        },
      }),
    ).toThrow();

    expect(() =>
      contract.workspaceOpenTargetSchema.parse({
        id: "vscode",
        label: "VS Code",
      }),
    ).toThrow();

    expect(() =>
      contract.workspaceOpenTargetsResponseSchema.parse({
        targets: [
          {
            id: "vscode",
            label: "",
          },
        ],
      }),
    ).toThrow();

    expect(() =>
      contract.openInTargetRequestSchema.parse({
        path: "/tmp/workspace",
      }),
    ).toThrow();

    expect(() =>
      contract.openInTargetRequestSchema.parse({
        lineNumber: 0,
        path: "/tmp/workspace",
        targetId: "zed",
      }),
    ).toThrow();

    expect(() =>
      contract.openInTargetRequestSchema.parse({
        columnNumber: 0,
        lineNumber: 1,
        path: "/tmp/workspace",
        targetId: "zed",
      }),
    ).toThrow();

    expect(() =>
      contract.openInTargetRequestSchema.parse({
        context: {
          kind: "remote-ssh",
          serverOrigin: "not a url",
          hostId: "host_remote",
        },
        lineNumber: 1,
        path: "/tmp/workspace",
        targetId: "vscode",
      }),
    ).toThrow();
  });
});

const BRIDGE_LAUNCH = {
  pluginId: "provider-pi",
  source: { kind: "artifact", digest: "a".repeat(64), byteLength: 4096 },
  providerOptions: {},
  envPassthrough: [],
  capabilities: {
    providerInstallation: false,
    supportsServiceTier: false,
    permissionModes: ["full"],
    supportsThreadArchive: false,
    supportsThreadRename: false,
    fork: "none",
  },
} as const;

const ACP_BRIDGE_LAUNCH = {
  ...BRIDGE_LAUNCH,
  pluginId: "provider-acp",
  providerOptions: { acpLaunchSpec: ACP_LAUNCH_SPEC },
} as const;

const CONTRIBUTED_ENV = [
  {
    name: "PLUGIN_API_URL",
    value: { serverPath: "/plugins/auth-proxy/api" },
    source: { plugin: "auth-proxy" },
    reason: "Route provider traffic through the plugin",
  },
] as const;

describe("host-daemon command schemas", () => {
  it("uses the current host-daemon protocol version", () => {
