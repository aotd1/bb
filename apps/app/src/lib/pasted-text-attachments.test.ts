import { describe, expect, it, vi } from "vitest";
import { createDeferredPromise } from "@bb/test-helpers";
import {
  emptyPromptDraftState,
  parsePromptDraftStorage,
  promptDraftToInput,
  serializePromptDraftStorage,
} from "@bb/client-core";
import type { PromptDraftState } from "@bb/client-core";
import { PROMPT_ATTACHMENT_MAX_BYTES } from "@bb/domain";
import {
  isLargeTextPaste,
  pastedTextPreview,
  PastedTextAttachments,
} from "./pasted-text-attachments";

function clipboard(text: string, files = false): DataTransfer {
  return {
    items: files ? [{ kind: "file" }] : [],
    files: [],
    getData: (type: string) =>
      type === "text/plain" ? text : "<b>rich text</b>",
  } as unknown as DataTransfer;
}

function harness(initial: PromptDraftState = emptyPromptDraftState()) {
  let draft = initial;
  const files = new Map<string, Blob>();
  const storage = {
    save: vi.fn(async (id: string, file: Blob) => {
      files.set(id, file);
    }),
    read: vi.fn(async (id: string) => {
      const file = files.get(id);
      if (!file) throw new Error("Missing recovery file");
      return file;
    }),
    remove: vi.fn(async (id: string) => {
      files.delete(id);
    }),
  };
  const target = {
    getCurrent: () => draft,
    setDraft: (next: PromptDraftState) => {
      draft = next;
    },
  };
  const upload = vi.fn(async (file: File) => ({
    type: "localFile" as const,
    path: `uploads/${crypto.randomUUID()}/${file.name}`,
    name: file.name,
    sizeBytes: file.size,
    mimeType: file.type,
  }));
  const manager = new PastedTextAttachments(target, upload, storage);
  return { target, manager, upload, storage, files };
}

describe("pasted text attachments", () => {
  it.each(["x", "😀"])(
    "counts Unicode code points at both threshold boundaries (%s)",
    (character) => {
      expect(isLargeTextPaste(clipboard(character.repeat(4_999)))).toBe(false);
      expect(isLargeTextPaste(clipboard(character.repeat(5_000)))).toBe(true);
    },
  );

  it("only handles plain text without files, including one-line and multiline text", () => {
    expect(isLargeTextPaste(clipboard("short"))).toBe(false);
    expect(isLargeTextPaste(clipboard("x".repeat(5_000)))).toBe(true);
    expect(isLargeTextPaste(clipboard("line\n".repeat(2_001)))).toBe(true);
    expect(isLargeTextPaste(clipboard("x".repeat(10_001), true))).toBe(false);
    expect(isLargeTextPaste(null)).toBe(false);
  });

  it("bounds the display preview without splitting emoji or changing the source", () => {
    expect(pastedTextPreview("a\r\nb\nc")).toBe("a b c");
    expect(Array.from(pastedTextPreview("😀".repeat(100)))).toHaveLength(80);
    expect(pastedTextPreview("😀".repeat(100))).toBe(`${"😀".repeat(79)}…`);
  });

  it("preserves exact UTF-8 bytes and existing text while sending only metadata", async () => {
    const state = harness({
      text: "inspect these errors",
      mentions: [],
      attachments: [],
    });
    const text = `  Кириллица 😀\t\r\n${"\n ".repeat(6_000)}  `;
    const id = state.manager.create(text);
    state.manager.setPresent(id, true);
    await state.manager.prepare(id);
    expect(state.target.getCurrent().text).toBe("inspect these errors");
    expect(state.upload).toHaveBeenCalledOnce();
    const file = state.upload.mock.calls[0]![0];
    expect(file.type).toBe("text/plain; charset=utf-8");
    expect(file.size).toBe(Buffer.byteLength(text, "utf8"));
    expect(await file.text()).toBe(text);
    expect(Buffer.from(await file.arrayBuffer()).subarray(0, 3)).not.toEqual(
      Buffer.from([0xef, 0xbb, 0xbf]),
    );
    const input = promptDraftToInput(state.target.getCurrent());
    expect(input[0]).toEqual({
      type: "text",
      text: "inspect these errors",
      mentions: [],
    });
    expect(input[1]).toMatchObject({
      type: "localFile",
      name: "Pasted text.txt",
      sizeBytes: file.size,
    });
    expect(JSON.stringify(input).length).toBeLessThan(500);
  });

  it("supports 3,638,577 bytes and 75,151 lines without truncation", async () => {
    const state = harness();
    const prefix = "synthetic request entry: ".padEnd(47, "x") + "\n";
    const lines = prefix.repeat(75_150);
    const text = lines + "x".repeat(3_638_577 - lines.length);
    expect(text.split("\n")).toHaveLength(75_151);
    const id = state.manager.create(text);
    state.manager.setPresent(id, true);
    await state.manager.prepare(id);
    const file = state.upload.mock.calls[0]![0];
    expect(file.size).toBe(3_638_577);
    expect(await file.text()).toBe(text);
    expect(
      serializePromptDraftStorage(state.target.getCurrent())!.length,
    ).toBeLessThan(1_000);
  });

  it("keeps separate names, order, unique paths, and restores prepared attachments without reupload", async () => {
    const state = harness();
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      const id = state.manager.create("x".repeat(10_001));
      ids.push(id);
      state.manager.setPresent(id, true);
      await state.manager.prepare(id);
    }
    const original = state.target.getCurrent().attachments;
    expect(original.map((item) => item.name)).toEqual([
      "Pasted text.txt",
      "Pasted text 2.txt",
      "Pasted text 3.txt",
    ]);
    expect(new Set(original.map((item) => item.path)).size).toBe(3);
    state.manager.setPresent(ids[1]!, false);
    expect(
      state.target.getCurrent().attachments.map((item) => item.name),
    ).toEqual(["Pasted text.txt", "Pasted text 3.txt"]);
    state.manager.setPresent(ids[1]!, true);
    expect(state.target.getCurrent().attachments).toEqual(original);
    expect(state.upload).toHaveBeenCalledTimes(3);
  });

  it("retains failed uploads across draft reload, blocks submission, and retries once", async () => {
    const state = harness({ text: "request", mentions: [], attachments: [] });
    const text = "  😀\r\n".repeat(3_000);
    state.upload.mockRejectedValueOnce(new Error(text));
    const id = state.manager.create(text);
    state.manager.setPresent(id, true);
    await state.manager.prepare(id);
    expect(state.target.getCurrent().attachments[0]?.pastedText?.status).toBe(
      "error",
    );
    expect(JSON.stringify(state.target.getCurrent())).not.toContain(text);
    expect(() => promptDraftToInput(state.target.getCurrent())).toThrow(
      "Finish preparing",
    );
    state.target.setDraft(
      parsePromptDraftStorage(
        serializePromptDraftStorage(state.target.getCurrent()),
      ),
    );
    const restored = new PastedTextAttachments(
      state.target,
      state.upload,
      state.storage,
    );
    expect(await restored.text(id)).toBe(text);
    await restored.prepare(id);
    expect(state.upload).toHaveBeenCalledTimes(2);
    expect(state.target.getCurrent().attachments).toHaveLength(1);
    expect(state.target.getCurrent().text).toBe("request");
  });

  it("rejects oversized data without uploading or shortening the retained text", async () => {
    const state = harness();
    const text = "x".repeat(PROMPT_ATTACHMENT_MAX_BYTES + 1);
    const id = state.manager.create(text);
    state.manager.setPresent(id, true);
    await state.manager.prepare(id);
    expect(state.upload).not.toHaveBeenCalled();
    expect(
      state.target.getCurrent().attachments[0]?.pastedText?.error,
    ).toContain("byte attachment limit");
    expect(await state.manager.text(id)).toBe(text);
  });

  it("does not resurrect a removed attachment when preparation finishes", async () => {
    const state = harness();
    const uploaded =
      createDeferredPromise<Awaited<ReturnType<typeof state.upload>>>();
    state.upload.mockImplementationOnce(() => uploaded.promise);
    const id = state.manager.create("x".repeat(10_001));
    state.manager.setPresent(id, true);
    await vi.waitFor(() => expect(state.upload).toHaveBeenCalledOnce());
    state.manager.setPresent(id, false);
    uploaded.resolve({
      type: "localFile",
      path: "uploaded.txt",
      name: "Pasted text.txt",
      sizeBytes: 10_001,
      mimeType: "text/plain; charset=utf-8",
    });
    await vi.waitFor(() => expect(state.storage.remove).toHaveBeenCalled());
    expect(state.target.getCurrent().attachments).toEqual([]);
    state.manager.setPresent(id, true);
    expect(state.target.getCurrent().attachments[0]?.path).toBe("uploaded.txt");
    expect(state.upload).toHaveBeenCalledOnce();
  });

  it("keeps an in-flight result in the captured original draft", async () => {
    const first = harness();
    const second = harness({
      text: "other thread",
      mentions: [],
      attachments: [],
    });
    const id = first.manager.create("x".repeat(10_001));
    first.manager.setPresent(id, true);
    first.manager.dispose();
    await first.manager.prepare(id);
    expect(first.target.getCurrent().attachments[0]?.pastedText?.status).toBe(
      "ready",
    );
    expect(second.target.getCurrent()).toEqual({
      text: "other thread",
      mentions: [],
      attachments: [],
    });
  });
});
