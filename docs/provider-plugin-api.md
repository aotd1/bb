# Provider plugin API

This document is the reference for BB's provider plugin surface — what "a
provider is a plugin" means. It has no phases: every change that touches this
surface keeps it true, and a test (`packages/plugin-sdk/src/__tests__/
provider-plugin-doc.test.ts`) checks its code blocks against the real types.
Members that still carry the `experimental_` prefix are named with it here;
each has an entry in [api_to_audit.md](api_to_audit.md) saying why.

A "provider" is a coding agent BB can run a thread on (Claude Code, Codex, Pi,
ACP agents such as Cursor or Amp). The design goal is that **everything a
provider touches is owned by its plugin** — translating the agent's native
output into BB's data model, projecting that data onto the timeline, and how
its tools are represented — with the smallest possible provider-agnostic core.

## Principles

1. **Zero first-party privilege.** First-party providers use only the public
   API. Every special case is a public primitive or is deleted.
2. **Each fact lives in one place.** A capability is declared or reported,
   never both. Presentation comes from the bridge, never from core tables.
3. **Core understands a small semantic vocabulary.** Everything else is an
   extension kind with mandatory declarative presentation.
4. **Every client renders everything without plugin code.** Plugin renderers
   are a web upgrade; mobile renders the declarative base.

## Layers

A provider's output flows through these layers. The plugin owns the first two;
core owns the rest and never branches on a provider id.

```
host agent  ─►  bridge (plugin)  ─►  thread/delta (core vocabulary)  ─►
delta assembler (core)  ─►  ThreadEvent (core)  ─►  persistence (core)  ─►
timeline projection (core)  ─►  renderers (core + optional plugin web renderer)
```

## 1. Registration (plugin server code)

A plugin registers one or more providers through `bb.providers.register`. One
plugin may own several providers (the ACP plugin owns Cursor and the
user-configured agents); user-configured instances are rows in the plugin's
own settings that produce registrations at runtime.

```ts
bb.providers.register({
  id: "claude-code", // flat; first registration wins; external-history is reserved
  displayName: "Claude Code",
  family: undefined, // optional grouping key (the ACP agents share one)
  icon: "./icons/claude.svg", // a plugin SVG, served as logoUrl; a glyph name; or "<pluginId>/<name>"
  strings: {
    signInHint: "Run `claude` on the machine to sign in.",
    expiredHint: "Your Claude session expired. Run `claude`, then reload.",
    installUrl: "https://docs.anthropic.com/claude-code",
    brandPrefix: "Claude ", // optional; stripped from model display names
    planModeCopy: undefined, // optional; plan-mode banner copy
    iconTint: undefined, // optional { light, dark }
  },
  maintenance: { health: true, usage: true, installation: true }, // each defaults to false
  capabilities: {
    // pre-session facts, one client shape: ProviderInfo
    permissionModes: ["accept-edits", "auto", "full"], // closed core enum
    fork: "checkpoint", // "none" | "tip" | "checkpoint"
    supportsNativeUserQuestion: true,
    supportsManualCompaction: true,
    supportsThreadArchive: true,
    supportsThreadRename: true,
    supportsServiceTier: false,
    reasoningLevels: ["low", "high"], // the coarse ladder; `reasoningLevels` below is precise
  },
  reasoningLevels: [
    // picker options; model/list is precise
    { id: "low", label: "Low" },
    { id: "high", label: "High" },
  ],
