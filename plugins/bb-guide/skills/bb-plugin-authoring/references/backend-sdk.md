# Backend SDK

### bb.sdk

The full bb SDK bound to this server over loopback — threads, projects,
providers, etc. **Bind-gated**: reading `bb.sdk` before the host binds it
throws. The real server binds it before loading plugins, so it is available
from the moment factories run there — but isolated harnesses may not, so
prefer using it from handlers, services, timers, and event handlers for
portability.

`bb.sdk.projects.list()` preserves the ordinary-project-only default. Plugins
that need the singleton personal project use
`bb.sdk.projects.list({ includePersonal: true })`.

**Area map.** Every area below is reachable from `bb.sdk`. This lists the
methods, not their arguments — read the bundled `bb-plugin-sdk.d.ts` for exact
signatures (see "Looking up the exact API").

