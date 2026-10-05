# Pasted text attachments

Pasting at least 5,000 Unicode code points into an attachment-enabled message
composer creates an ordinary `Pasted text.txt` file. Typing and programmatic
editor updates do not trigger conversion. The threshold is defined once in
`PASTED_TEXT_ATTACHMENT_THRESHOLD`.

The editor preserves its existing text and selection. Each paste has a separate
attachment with a unique upload path and a collision-free display name. The
card shows the UTF-8 byte size, a preview of at most 80 code points, a content
link, and a remove button. Paste and removal participate in the editor's Undo
and Redo history, including edits made after a paste. Redo reuses an uploaded
file. Files and images retain priority over accompanying clipboard text.

The Blob contains the exact plain-text clipboard string encoded as UTF-8,
without a BOM or newline conversion. HTML clipboard data is ignored for this
conversion. The existing 35 MiB attachment limit applies; there is no separate
smaller pasted-text limit.

## Storage and delivery

Before upload, the full Blob is saved in IndexedDB, while the existing draft
store contains only attachment metadata and the bounded preview. Preparation
and errors block submission, including programmatic submission through the
composer. Failed preparation offers Retry and an explicit Insert as text
action. If persistent recovery storage is unavailable, the UI reports that the
text is retained only for the current session. A late upload updates the
original draft only if that attachment is still present.

Successful preparation uses `sdk.projects.attachments.upload`, the ordinary
project attachment endpoint and storage lifecycle. Recovery data is removed
after successful upload, or when a removed attachment's composer is disposed.
Removing an uploaded attachment does not delete a file that may be referenced
by history or a running turn. Submission retries reuse the prepared attachment.

The submitted prompt has separate `text` and `localFile` inputs; it contains no
pasted-text recovery metadata or full file contents. Existing daemon attachment
staging downloads the server-owned attachment into the executing host's thread
storage before starting the provider. Fetch/staging failures prevent runtime
startup. The attachment path in provider input is therefore on the agent host,
not the browser or server. No daemon wire fields were added, so no protocol
version change is required. Optional original filename/size metadata was added
to the server-to-client timeline contract for history cards and message editing.

Codex and Pi receive the display name and staged path in the existing user
attachment description. Claude uses its existing named file description. ACP
uses its existing `resource_link` adapter with the staged file URI and name.
Attachment contents remain user data. No new provider-specific pasted-text
protocol or automatic agent request is introduced.

The shared web composer supplies this behavior to new threads, thread follow-up
and embedded chat, and message editing where file attachments are enabled.
Desktop and mobile clients that host that composer receive the same behavior.
There is no change to external provider applications or standalone native
editors. The plugin SDK currently has no shared Paste/Undo attachment hook;
implementing this entirely as a plugin would require extending that API.

## CLI and SDK

The equivalent non-clipboard operation uses the existing ordinary attachment
interfaces. Keep the short request separate from the file:

```sh
bb thread tell thr_example "Inspect errors" --file /absolute/path/pasted.txt
```

SDK clients upload a `File`/`Blob` through
`sdk.projects.attachments.upload({ projectId, clientFile })`, then include the
returned `path`, `name`, `sizeBytes` and `mimeType` in a `localFile` prompt input
alongside the optional `text` input. No new CLI flags or public plugin API are
needed for this clipboard-only trigger.

## Codex reference investigation

On 2026-10-05, the installed ChatGPT macOS application (version 26.930.31730,
build 12947) contained the Codex application bundle in `Contents/Resources/app.asar`.
Read-only inspection of its editor and attachment handler found a `>= 5e3`
length condition for plain text and creation of a `text/plain` File named
`Pasted text.txt`. The editor also considers an optional Markdown rendition.
This is evidence about that installed build, not a published Codex contract.
The extracted application code is not included in this repository.

Codex uses JavaScript string length, so supplementary characters count as two
UTF-16 units. BB deliberately retains the requested Unicode code-point rule:
an emoji counts as one. BB adopts the observed numeric boundary of 5,000,
inclusive, instead of the originally proposed greater-than-10,000 boundary.

## Verification, 2026-10-05

Automated coverage includes 4,999/5,000 boundaries with ASCII and emoji,
single-line and multiline text, exact UTF-8 recovery with Cyrillic/emoji/tabs/
spaces/LF/CRLF, unique names/order/removal, Undo/Redo after typing, upload errors,
retry, oversize input, pending submission guards, removal during preparation,
switching drafts, persistent recovery and restored draft metadata, original
history names, image/file priority and rich-text interception.

The daemon dispatch integration test fetches 3,638,577 bytes from an opaque
server attachment identifier into a separate temporary agent-storage root,
reads the complete staged file, checks 75,151 lines, and verifies the request
stays separate in a runtime input serialized to fewer than 2,000 characters.
Existing failure tests verify that failed staging does not start a provider.

Manual verification used an isolated development instance and headless Chrome
on macOS, with synthetic data generated in memory. A Paste event created a
compact card; downloading the result returned exactly 3,638,577 bytes and
75,151 lines. The editor held only the short request, and its serialized draft
metadata was under 1 KiB. Reloading and reopening the composer restored both.
Sending the attachment to a real local Codex agent resulted in a file-tool read
and the response `UTF-8 bytes: 3638577 Lines: 75151`. The editor cleared after
successful submission, and reloaded history retained the content link and
original display name. The [editor screenshot](assets/pasted-text-editor.jpg)
shows the compact attachment beside the short request.

Container verification ran the actual bundled `stagePromptAttachments` and
`toCodexUserInput` functions inside an ephemeral Linux Docker container with
Node 22.23.3. A temporary QA HTTP transport served only the synthetic attachment
downloaded from the development instance. No client or server attachment
directory was mounted into the container. Staging created the file under the
container's `/tmp/bb-container-agent` root; reading it confirmed 3,638,577 bytes
and 75,151 lines. Codex input contained only the request and attachment marker.
The container and QA transport were removed after verification.

A second enrolled physical host and a full model turn inside an enrolled
container were not manually exercised. Native iOS/Android clipboard events and
real Claude/Pi/ACP model turns were also not manually exercised. Shared-composer,
provider adapter and daemon integration tests cover the relevant contracts.
No user HAR, supplied Markdown attachment, or full synthetic fixture is
included in the checkout or this report.

Checks used Turbo with dependency orchestration:

| Check                                                           | Result                                      |
| --------------------------------------------------------------- | ------------------------------------------- |
| App editor, uploads, recovery, drafts and attachment cards      | 200 passed                                  |
| App history rendering, streaming and message actions            | 82 passed                                   |
| Client-core prompt drafts                                       | 19 passed                                   |
| Thread-view parsing and timeline                                | 90 passed                                   |
| Host daemon thread dispatch and staging                         | 33 passed                                   |
| Codex provider suite                                            | 333 passed                                  |
| Pi provider suite                                               | 183 passed, 1 existing skipped test         |
| ACP named resource-link delivery                                | 1 passed (focused test)                     |
| Claude existing file descriptions                               | 2 passed (focused tests)                    |
| App/client-core/server-contract/thread-view/Codex/Pi typechecks | Passed                                      |
| App/Codex/Pi lint                                               | Passed; existing repository warnings remain |

Representative commands:

```sh
pnpm exec turbo run test --filter=@bb/app -- PromptBoxInternal AttachmentPreview ConversationAttachments usePromptDraftStorage useComposerAttachmentUploads pasted-text
pnpm exec turbo run test --filter=@bb/app -- ConversationMessageContent ConversationAttachments ThreadTimelineRows.actions
pnpm exec turbo run test --filter=@bb/client-core -- prompt-draft
pnpm exec turbo run test --filter=@bb/thread-view -- user-message-parsing build-thread-timeline
pnpm exec turbo run test --filter=@bb/host-daemon -- thread-dispatch
pnpm exec turbo run test --filter=bb-plugin-provider-codex --filter=bb-plugin-provider-pi
pnpm exec turbo run test --filter=@bb/provider-bridge-acp -- bridge.test -t 'pasted text file'
pnpm exec turbo run test --filter=bb-plugin-provider-claude-code -- bridge.test -t 'localFile'
pnpm exec turbo run typecheck --filter=@bb/app --filter=@bb/client-core --filter=@bb/server-contract --filter=@bb/thread-view --filter=bb-plugin-provider-codex --filter=bb-plugin-provider-pi
pnpm exec turbo run lint --filter=@bb/app --filter=bb-plugin-provider-codex --filter=bb-plugin-provider-pi
```

## Upstream preparation, 2026-10-05

The `pasted-text-attachments-upstream` branch starts at upstream `main` commit
`5d31d8c32d85d7bde75d211b8295836b33fc2a26`. The original four feature commits
were cherry-picked onto that base. The composer extension conflict was resolved
by retaining both upstream thread-link paste conversion and pasted attachment
history; a duplicate SDK import introduced by the automatic merge was removed.

Two real-composer regression tests verify that thread URLs inside a large paste
remain exact file data without mention resolution, and that a subsequent short
thread-link paste still becomes a pill. Undo and Redo retain the correct order
across attachment creation, URL insertion, and pill conversion without a second
upload or lookup.

Checks rerun on the updated branch through Turbo:

| Check                                                                                       | Result                                    |
| ------------------------------------------------------------------------------------------- | ----------------------------------------- |
| Shared composer, pasted text, thread links and history                                      | 323 passed                                |
| Client-core prompt drafts                                                                   | 19 passed                                 |
| Thread-view parsing and timeline                                                            | 90 passed                                 |
| Host daemon dispatch and attachment staging                                                 | 33 passed                                 |
| Codex provider suite                                                                        | 336 passed                                |
| Pi provider suite                                                                           | 183 passed, 1 existing skipped test       |
| Focused ACP pasted-text resource-link contract                                              | 1 passed; other tests filtered out        |
| App/client-core/server-contract/thread-view/Codex/Pi/ACP typecheck and available lint tasks | 15 tasks passed; existing warnings remain |

The manual multi-megabyte scenario, container staging check, and editor
screenshot above were captured on the original branch, before this update.
They were not repeated on the upstream-based branch. The remote-host, native
mobile and live non-Codex provider limitations still apply. No Codex Desktop
reference screenshot was captured: the computer-use tool refused access to
`com.openai.codex`. The documentation image is explicitly a BB prototype.
