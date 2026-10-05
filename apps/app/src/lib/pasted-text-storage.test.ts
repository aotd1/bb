// @vitest-environment jsdom

import { Blob as NodeBlob } from "node:buffer";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("Blob", NodeBlob);
  vi.resetModules();
});

afterEach(() => vi.unstubAllGlobals());

describe("pasted text recovery storage", () => {
  it("persists full UTF-8 content across module reload and removes discarded data", async () => {
    const original = await import("./pasted-text-storage");
    const text = `  Кириллица 😀\t\r\n${"synthetic\n".repeat(400_000)}  `;
    const file = new Blob([text], { type: "text/plain; charset=utf-8" });
    await original.savePastedTextFile("reload-test", file);
    vi.resetModules();
    const reloaded = await import("./pasted-text-storage");
    const recovered = await reloaded.readPastedTextFile("reload-test");
    expect(recovered.size).toBe(file.size);
    expect(await recovered.text()).toBe(text);
    await reloaded.deletePastedTextFile("reload-test");
    await expect(reloaded.readPastedTextFile("reload-test")).rejects.toThrow(
      "unavailable",
    );
  });

  it("keeps the full in-memory recovery file when persistent storage cannot be opened", async () => {
    vi.stubGlobal("indexedDB", {
      open() {
        throw new Error("storage unavailable");
      },
    });
    const storage = await import("./pasted-text-storage");
    const file = new Blob(["retained 😀\r\n".repeat(3_000)]);
    await expect(
      storage.savePastedTextFile("failed-storage", file),
    ).rejects.toThrow();
    expect(await storage.readPastedTextFile("failed-storage")).toBe(file);
  });
});
