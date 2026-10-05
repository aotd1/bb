import type { PromptDraftAttachment, PromptDraftState } from "@bb/client-core";
import { PROMPT_ATTACHMENT_MAX_BYTES } from "@bb/domain";
import type { UploadedPromptAttachment } from "@bb/server-contract";
import { nanoid } from "nanoid";
import {
  deletePastedTextFile,
  readPastedTextFile,
  savePastedTextFile,
} from "./pasted-text-storage";

export const PASTED_TEXT_ATTACHMENT_THRESHOLD = 5_000;
const PASTED_TEXT_PREVIEW_LENGTH = 80;
const preparingPastedTexts = new Map<string, Promise<void>>();
export const PASTED_TEXT_MIME_TYPE = "text/plain; charset=utf-8";

export function isLargeTextPaste(clipboard: DataTransfer | null): boolean {
  if (
    !clipboard ||
    Array.from(clipboard.items).some((item) => item.kind === "file") ||
    clipboard.files?.length > 0
  ) {
    return false;
  }
  return isLargePastedText(clipboard.getData("text/plain"));
}

export function isLargePastedText(text: string): boolean {
  let count = 0;
  for (const character of text) {
    if (character.length > 0 && ++count >= PASTED_TEXT_ATTACHMENT_THRESHOLD)
      return true;
  }
  return false;
}

export function pastedTextPreview(text: string): string {
  const characters: string[] = [];
  let truncated = false;
  for (const character of text) {
    if (characters.length === PASTED_TEXT_PREVIEW_LENGTH) {
      truncated = true;
      break;
    }
    if (character === "\n" && characters.at(-1) === "\r") {
      characters[characters.length - 1] = " ";
    } else {
      characters.push(character);
    }
  }
  const preview = characters.join("").replace(/[\r\n]/gu, " ");
  return truncated
    ? `${Array.from(preview)
        .slice(0, PASTED_TEXT_PREVIEW_LENGTH - 1)
        .join("")}…`
    : preview;
}

function nextPastedTextName(
  attachments: readonly PromptDraftAttachment[],
): string {
  const names = new Set(attachments.map((attachment) => attachment.name));
  let index = 1;
  while (
    names.has(index === 1 ? "Pasted text.txt" : `Pasted text ${index}.txt`)
  )
    index += 1;
  return index === 1 ? "Pasted text.txt" : `Pasted text ${index}.txt`;
}

export interface PastedTextDraftTarget {
  getCurrent(): PromptDraftState;
  setDraft(draft: PromptDraftState): void;
}

interface PastedTextRecoveryStorage {
  save(id: string, file: Blob): Promise<void>;
  read(id: string): Promise<Blob>;
  remove(id: string): Promise<void>;
}

const recoveryStorage: PastedTextRecoveryStorage = {
  save: savePastedTextFile,
  read: readPastedTextFile,
  remove: deletePastedTextFile,
};

export class PastedTextAttachments {
  private records = new Map<string, PromptDraftAttachment>();
  private files = new Map<string, Blob>();
  private positions = new Map<string, number>();
  private disposed = false;

  constructor(
    private target: PastedTextDraftTarget,
    private upload: (file: File) => Promise<UploadedPromptAttachment>,
    private storage: PastedTextRecoveryStorage = recoveryStorage,
  ) {
    for (const [index, attachment] of target
      .getCurrent()
      .attachments.entries()) {
      if (attachment.pastedText) {
        this.records.set(attachment.pastedText.id, attachment);
        this.positions.set(attachment.pastedText.id, index);
      }
    }
  }

  create(text: string): string {
    const id = nanoid();
    const draft = this.target.getCurrent();
    const file = new Blob([text], { type: PASTED_TEXT_MIME_TYPE });
    this.files.set(id, file);
    this.positions.set(id, draft.attachments.length);
    this.records.set(id, {
      type: "localFile",
      path: `pasted-text:${id}`,
      name: nextPastedTextName(draft.attachments),
      mimeType: PASTED_TEXT_MIME_TYPE,
      sizeBytes: file.size,
      pastedText: { id, preview: pastedTextPreview(text), status: "preparing" },
    });
    return id;
  }

  setPresent(id: string, present: boolean): void {
    const record = this.records.get(id);
    if (!record) return;
    const draft = this.target.getCurrent();
    const index = draft.attachments.findIndex(
      (attachment) => attachment.pastedText?.id === id,
    );
    if (present && index < 0) {
      const name = draft.attachments.some(
        (attachment) => attachment.name === record.name,
      )
        ? nextPastedTextName(draft.attachments)
        : record.name;
      const restored = { ...record, name };
      this.records.set(id, restored);
      const attachments = [...draft.attachments];
      attachments.splice(
        Math.min(
          this.positions.get(id) ?? attachments.length,
          attachments.length,
        ),
        0,
        restored,
      );
      this.target.setDraft({ ...draft, attachments });
      if (restored.pastedText?.status === "preparing") void this.prepare(id);
    } else if (!present && index >= 0) {
      this.records.set(id, draft.attachments[index]!);
      this.positions.set(id, index);
      this.target.setDraft({
        ...draft,
        attachments: draft.attachments.filter(
          (attachment) => attachment.pastedText?.id !== id,
        ),
      });
    }
  }

  private replace(id: string, record: PromptDraftAttachment): void {
    this.records.set(id, record);
    const draft = this.target.getCurrent();
    if (
      !draft.attachments.some((attachment) => attachment.pastedText?.id === id)
    )
      return;
    this.target.setDraft({
      ...draft,
      attachments: draft.attachments.map((attachment) =>
        attachment.pastedText?.id === id ? record : attachment,
      ),
    });
  }

  prepare(id: string): Promise<void> {
    const pending = preparingPastedTexts.get(id);
    if (pending) return pending;
    const record = this.records.get(id);
    if (!record?.pastedText || record.pastedText.status === "ready")
      return Promise.resolve();
    const operation = this.prepareFile(id, record).finally(() => {
      preparingPastedTexts.delete(id);
      if (this.disposed) this.dispose();
    });
    preparingPastedTexts.set(id, operation);
    return operation;
  }

  private async prepareFile(
    id: string,
    record: PromptDraftAttachment,
  ): Promise<void> {
    if (!record.pastedText) return;
    let saved = false;
    this.replace(id, {
      ...record,
      pastedText: {
        ...record.pastedText,
        status: "preparing",
        error: undefined,
      },
    });
    try {
      const file = this.files.get(id) ?? (await this.storage.read(id));
      this.files.set(id, file);
      await this.storage.save(id, file);
      saved = true;
      if (file.size > PROMPT_ATTACHMENT_MAX_BYTES) {
        throw new Error(
          `Pasted text exceeds the ${PROMPT_ATTACHMENT_MAX_BYTES} byte attachment limit. Your text is retained; remove it or insert it as text.`,
        );
      }
      const uploaded = await this.upload(
        new File([file], record.name, { type: PASTED_TEXT_MIME_TYPE }),
      );
      this.replace(id, {
        ...uploaded,
        name: this.records.get(id)?.name ?? uploaded.name,
        pastedText: { ...record.pastedText, status: "ready" },
      });
      this.files.delete(id);
      await this.storage.remove(id).catch(() => undefined);
    } catch {
      const error = !saved
        ? "Recovery storage is unavailable. Text is retained in this session; retry or insert it as text before reloading."
        : record.sizeBytes > PROMPT_ATTACHMENT_MAX_BYTES
          ? `Pasted text exceeds the ${PROMPT_ATTACHMENT_MAX_BYTES} byte attachment limit.`
          : "Could not prepare pasted text. Your text is retained; retry or insert it as text.";
      this.replace(id, {
        ...record,
        pastedText: { ...record.pastedText, status: "error", error },
      });
    }
  }

  resume(): void {
    this.disposed = false;
    for (const record of this.records.values()) {
      if (record.pastedText?.status === "preparing")
        void this.prepare(record.pastedText.id);
    }
  }

  async text(id: string): Promise<string> {
    const file = this.files.get(id) ?? (await this.storage.read(id));
    return file.text();
  }

  dispose(): void {
    this.disposed = true;
    const activeIds = new Set(
      this.target
        .getCurrent()
        .attachments.map((attachment) => attachment.pastedText?.id),
    );
    for (const id of this.records.keys()) {
      if (!activeIds.has(id) && !preparingPastedTexts.has(id)) {
        void this.storage.remove(id).catch(() => undefined);
      }
    }
  }
}
