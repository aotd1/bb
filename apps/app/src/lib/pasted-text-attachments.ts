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
interface PastedTextRecord {
  attachment: PromptDraftAttachment;
  file: Blob | null;
  activeManagers: number;
}

const preparingPastedTexts = new Map<
  string,
  { record: PastedTextRecord; promise: Promise<void> }
>();
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
  private records = new Map<string, PastedTextRecord>();
  private positions = new Map<string, number>();
  private disposed = true;

  constructor(
    private target: PastedTextDraftTarget,
    private upload: (file: File) => Promise<UploadedPromptAttachment>,
    private storage: PastedTextRecoveryStorage = recoveryStorage,
  ) {
    for (const [index, attachment] of target
      .getCurrent()
      .attachments.entries()) {
      if (attachment.pastedText) {
        this.remember(attachment.pastedText.id, attachment);
        this.positions.set(attachment.pastedText.id, index);
      }
    }
  }

  private remember(
    id: string,
    attachment: PromptDraftAttachment,
  ): PastedTextRecord {
    const existing = this.records.get(id);
    const pending = preparingPastedTexts.get(id)?.record;
    if (existing && (!pending || existing === pending)) return existing;
    const record = pending ?? {
      attachment,
      file: null,
      activeManagers: 0,
    };
    if (!this.disposed) {
      if (existing) existing.activeManagers -= 1;
      record.activeManagers += 1;
    }
    this.records.set(id, record);
    return record;
  }

  create(text: string): string {
    const id = nanoid();
    const draft = this.target.getCurrent();
    const file = new Blob([text], { type: PASTED_TEXT_MIME_TYPE });
    this.positions.set(id, draft.attachments.length);
    const record = this.remember(id, {
      type: "localFile",
      path: `pasted-text:${id}`,
      name: nextPastedTextName(draft.attachments),
      mimeType: PASTED_TEXT_MIME_TYPE,
      sizeBytes: file.size,
      pastedText: { id, preview: pastedTextPreview(text), status: "preparing" },
    });
    record.file = file;
    return id;
  }

  setPresent(id: string, present: boolean): void {
    const draft = this.target.getCurrent();
    const index = draft.attachments.findIndex(
      (attachment) => attachment.pastedText?.id === id,
    );
    const current = draft.attachments[index];
    const state = current ? this.remember(id, current) : this.records.get(id);
    if (!state) return;
    const record = state.attachment;
    if (present && index < 0) {
      const name = draft.attachments.some(
        (attachment) => attachment.name === record.name,
      )
        ? nextPastedTextName(draft.attachments)
        : record.name;
      const restored = { ...record, name };
      state.attachment = restored;
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
      state.attachment = draft.attachments[index]!;
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
    this.remember(id, record).attachment = record;
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
    if (pending) {
      this.remember(id, pending.record.attachment);
      return pending.promise;
    }
    const current = this.target
      .getCurrent()
      .attachments.find((attachment) => attachment.pastedText?.id === id);
    const state = current ? this.remember(id, current) : this.records.get(id);
    const record = state?.attachment;
    if (!state || !record?.pastedText || record.pastedText.status === "ready")
      return Promise.resolve();
    const operation = this.prepareFile(id, state).finally(() => {
      preparingPastedTexts.delete(id);
      if (this.disposed) this.dispose();
    });
    preparingPastedTexts.set(id, { record: state, promise: operation });
    return operation;
  }

  private async prepareFile(
    id: string,
    state: PastedTextRecord,
  ): Promise<void> {
    const record = state.attachment;
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
      const file = state.file ?? (await this.storage.read(id));
      state.file = file;
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
        name: state.attachment.name,
        pastedText: { ...record.pastedText, status: "ready" },
      });
      state.file = null;
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
    if (this.disposed) {
      for (const record of this.records.values()) record.activeManagers += 1;
    }
    this.disposed = false;
    for (const { attachment: record } of this.records.values()) {
      if (record.pastedText?.status === "preparing")
        void this.prepare(record.pastedText.id);
    }
  }

  async text(id: string): Promise<string> {
    const file = this.records.get(id)?.file ?? (await this.storage.read(id));
    return file.text();
  }

  dispose(): void {
    if (!this.disposed) {
      for (const record of this.records.values()) record.activeManagers -= 1;
    }
    this.disposed = true;
    const activeIds = new Set(
      this.target
        .getCurrent()
        .attachments.map((attachment) => attachment.pastedText?.id),
    );
    for (const [id, record] of this.records) {
      if (
        record.activeManagers === 0 &&
        !activeIds.has(id) &&
        !preparingPastedTexts.has(id)
      ) {
        void this.storage.remove(id).catch(() => undefined);
      }
    }
  }
}
