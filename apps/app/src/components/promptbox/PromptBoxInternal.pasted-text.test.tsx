// @vitest-environment jsdom

import { Blob as NodeBlob, File as NodeFile } from "node:buffer";
import { useMemo, useSyncExternalStore } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { TiptapEditorHTMLElement } from "@tiptap/core";
import {
  EMPTY_ORDERED_MENTION_SUGGESTIONS,
  emptyPromptDraftState,
} from "@bb/client-core";
import type { PromptDraftState } from "@bb/client-core";
import { createDeferredPromise } from "@bb/test-helpers";
import { PluginComposerHostProvider } from "@/components/plugin/plugin-composer-host";
import { sdk } from "@/lib/sdk";
import {
  INERT_TYPEAHEAD_COMMAND_CONFIG,
  PromptBoxInternal,
} from "./PromptBoxInternal";

vi.mock("@/lib/sdk", () => ({
  sdk: { projects: { attachments: { upload: vi.fn() } } },
}));

function target(threadId: string, text = "") {
  let draft: PromptDraftState = { ...emptyPromptDraftState(), text };
  const listeners = new Set<() => void>();
  return {
    threadId,
    getCurrent: () => draft,
    setDraft: (next: PromptDraftState) => {
      draft = next;
      for (const listener of listeners) listener();
    },
    subscribeDraft: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function Harness({
  draftTarget,
  submit = () => {},
  attach = () => {},
}: {
  draftTarget: ReturnType<typeof target>;
  submit?: () => void;
  attach?: (files: File[]) => void;
}) {
  const draft = useSyncExternalStore(
    draftTarget.subscribeDraft,
    draftTarget.getCurrent,
  );
  const host = useMemo(
    () => ({
      ...draftTarget,
      scope: { kind: "thread" as const, threadId: draftTarget.threadId },
      textEffectKey: draftTarget.threadId,
      attachmentDraftTarget: draftTarget,
      focus: () => {},
    }),
    [draftTarget],
  );
  return (
    <PluginComposerHostProvider value={host}>
      <PromptBoxInternal
        value={draft.text}
        mentionRanges={draft.mentions}
        onChange={(text, mentions) =>
          draftTarget.setDraft({ ...draftTarget.getCurrent(), text, mentions })
        }
        onSubmit={submit}
        placeholder="Message"
        mentionMenuPlacement="bottom"
        typeahead={{
          mention: {
            results: EMPTY_ORDERED_MENTION_SUGGESTIONS,
            isLoading: false,
            isError: false,
            onQueryChange: () => {},
          },
          command: INERT_TYPEAHEAD_COMMAND_CONFIG,
        }}
        attachments={{
          items: draft.attachments,
          projectId: "project",
          onAttachFiles: attach,
        }}
      />
    </PluginComposerHostProvider>
  );
}

function editor() {
  const instance = (screen.getByRole("textbox") as TiptapEditorHTMLElement)
    .editor;
  if (!instance) throw new Error("Editor has not mounted");
  return instance;
}

function paste(text: string, files: File[] = [], html = "") {
  fireEvent.paste(screen.getByRole("textbox"), {
    clipboardData: {
      items: files.map((file) => ({ kind: "file", getAsFile: () => file })),
      files,
      getData: (type: string) =>
        type === "text/plain" ? text : type === "text/html" ? html : "",
    },
  });
}

beforeEach(() => {
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("File", NodeFile);
  vi.stubGlobal("indexedDB", new IDBFactory());
  const OriginalURL = URL;
  vi.stubGlobal(
    "URL",
    class extends OriginalURL {
      static createObjectURL() {
        return "blob:pasted-text-test";
      }
      static revokeObjectURL() {}
    },
  );
  vi.mocked(sdk.projects.attachments.upload)
    .mockReset()
    .mockImplementation(async ({ clientFile }) => {
      if (!(clientFile instanceof File))
        throw new Error("Expected an uploaded File");
      return {
        type: "localFile",
        path: `uploads/${crypto.randomUUID()}/${clientFile.name}`,
        name: clientFile.name,
        sizeBytes: clientFile.size,
        mimeType: clientFile.type,
      };
    });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("large Paste in the real message editor", () => {
  it("preserves the selected request and focus, uses plain text, and never parses the large HTML", async () => {
    const draftTarget = target("a", "inspect selected errors");
    render(<Harness draftTarget={draftTarget} />);
    act(() => {
      editor().commands.setTextSelection({ from: 9, to: 17 });
    });
    const text = "😀".repeat(10_001);
    const parser = vi.spyOn(DOMParser.prototype, "parseFromString");
    paste(text, [], `<p>${"html".repeat(10_000)}</p>`);
    expect(draftTarget.getCurrent().text).toBe("inspect selected errors");
    expect(editor().state.selection.from).toBe(9);
    expect(editor().state.selection.to).toBe(17);
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
    expect(screen.getByRole("textbox").textContent).not.toContain(text);
    expect(parser).not.toHaveBeenCalled();
    parser.mockRestore();
    await waitFor(() =>
      expect(draftTarget.getCurrent().attachments[0]?.pastedText?.status).toBe(
        "ready",
      ),
    );
    const uploaded = vi.mocked(sdk.projects.attachments.upload).mock
      .calls[0]![0].clientFile;
    if (!(uploaded instanceof File))
      throw new Error("Expected an uploaded File");
    expect(await uploaded.text()).toBe(text);
    expect(screen.getByRole("link", { name: "Pasted text.txt" })).toBeTruthy();
  });

  it("keeps short Paste and programmatic filling as editor text", () => {
    const draftTarget = target("a");
    render(<Harness draftTarget={draftTarget} />);
    paste("😀".repeat(4_999));
    expect(draftTarget.getCurrent().attachments).toEqual([]);
    expect(draftTarget.getCurrent().text).toBe("😀".repeat(4_999));
    act(() => {
      editor().commands.insertContent("x".repeat(10_001));
    });
    expect(draftTarget.getCurrent().attachments).toEqual([]);
    expect(sdk.projects.attachments.upload).not.toHaveBeenCalled();
  });

  it("orders text typing, pasted attachment, Undo and Redo in the same history", async () => {
    const draftTarget = target("a", "request ");
    render(<Harness draftTarget={draftTarget} />);
    act(() => {
      editor().commands.focus("end");
    });
    paste("line\r\n".repeat(2_000));
    await waitFor(() =>
      expect(draftTarget.getCurrent().attachments[0]?.pastedText?.status).toBe(
        "ready",
      ),
    );
    act(() => {
      editor().commands.insertContent("details");
    });
    expect(draftTarget.getCurrent().text).toBe("request details");
    act(() => {
      editor().commands.undo();
    });
    expect(draftTarget.getCurrent().text).toBe("request ");
    expect(draftTarget.getCurrent().attachments).toHaveLength(1);
    act(() => {
      editor().commands.undo();
    });
    expect(draftTarget.getCurrent().attachments).toEqual([]);
    expect(draftTarget.getCurrent().text).toBe("request ");
    act(() => {
      editor().commands.redo();
    });
    expect(draftTarget.getCurrent().attachments).toHaveLength(1);
    act(() => {
      editor().commands.redo();
    });
    expect(draftTarget.getCurrent().text).toBe("request details");
    expect(sdk.projects.attachments.upload).toHaveBeenCalledOnce();
  });

  it("blocks unfinished submission, supports deletion while uploading, and keeps a late result out", async () => {
    const draftTarget = target("a");
    const submit = vi.fn();
    const deferred =
      createDeferredPromise<
        Awaited<ReturnType<typeof sdk.projects.attachments.upload>>
      >();
    vi.mocked(sdk.projects.attachments.upload).mockImplementationOnce(
      () => deferred.promise,
    );
    render(<Harness draftTarget={draftTarget} submit={submit} />);
    paste("x".repeat(10_001));
    await waitFor(() =>
      expect(sdk.projects.attachments.upload).toHaveBeenCalledOnce(),
    );
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(submit).not.toHaveBeenCalled();
    expect(
      screen.getByRole("status", { name: "Uploading Pasted text.txt" }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Pasted text.txt" }),
    );
    await act(async () => {
      deferred.resolve({
        type: "localFile",
        path: "uploaded.txt",
        name: "Pasted text.txt",
        sizeBytes: 10_001,
      });
      await deferred.promise;
    });
    expect(draftTarget.getCurrent().attachments).toEqual([]);
    expect(screen.queryByText("Pasted text.txt")).toBeNull();
  });

  it("shows recovery actions on failure and inserts the complete retained text only on request", async () => {
    const draftTarget = target("a", "request ");
    vi.mocked(sdk.projects.attachments.upload).mockRejectedValueOnce(
      new Error("network error"),
    );
    render(<Harness draftTarget={draftTarget} />);
    act(() => {
      editor().commands.focus("end");
    });
    const text = "  Кириллица\t😀\r\n".repeat(1_000);
    paste(text);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Insert as text" }),
      ).toBeTruthy(),
    );
    expect(draftTarget.getCurrent().text).toBe("request ");
    fireEvent.click(screen.getByRole("button", { name: "Insert as text" }));
    await waitFor(() =>
      expect(draftTarget.getCurrent().attachments).toEqual([]),
    );
    expect(draftTarget.getCurrent().text).toBe(`request ${text}`);
  });

  it("leaves file and image Paste with the existing handler without extra text", () => {
    const draftTarget = target("a");
    const attach = vi.fn();
    render(<Harness draftTarget={draftTarget} attach={attach} />);
    const image = new File(["image"], "image.png", { type: "image/png" });
    paste("x".repeat(10_001), [image], "<b>service text</b>");
    expect(attach).toHaveBeenCalledWith([image]);
    expect(draftTarget.getCurrent().attachments).toEqual([]);
    expect(draftTarget.getCurrent().text).toBe("");
    expect(sdk.projects.attachments.upload).not.toHaveBeenCalled();
  });

  it("finishes preparation in the original thread after switching the editor", async () => {
    const first = target("a", "first request");
    const second = target("b", "second request");
    const deferred =
      createDeferredPromise<
        Awaited<ReturnType<typeof sdk.projects.attachments.upload>>
      >();
    vi.mocked(sdk.projects.attachments.upload).mockImplementationOnce(
      () => deferred.promise,
    );
    const view = render(<Harness draftTarget={first} />);
    paste("x".repeat(10_001));
    await waitFor(() =>
      expect(sdk.projects.attachments.upload).toHaveBeenCalledOnce(),
    );
    view.rerender(<Harness draftTarget={second} />);
    await act(async () => {
      deferred.resolve({
        type: "localFile",
        path: "uploaded.txt",
        name: "Pasted text.txt",
        sizeBytes: 10_001,
      });
      await deferred.promise;
    });
    expect(first.getCurrent().attachments[0]?.pastedText?.status).toBe("ready");
    expect(second.getCurrent().attachments).toEqual([]);
    expect(second.getCurrent().text).toBe("second request");
  });
});
