import { Extension } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { Step, StepMap, StepResult } from "@tiptap/pm/transform";
import type { EditorView } from "@tiptap/pm/view";
import { z } from "zod";

const stepSchema = z.object({ id: z.string(), present: z.boolean() });

export class PastedTextAttachmentStep extends Step {
  constructor(
    readonly id: string,
    readonly present: boolean,
  ) {
    super();
  }

  apply(doc: Node): StepResult {
    return StepResult.ok(doc);
  }

  getMap(): StepMap {
    return StepMap.empty;
  }

  invert(): Step {
    return new PastedTextAttachmentStep(this.id, !this.present);
  }

  map(): Step {
    return this;
  }

  toJSON() {
    return {
      stepType: "bbPastedTextAttachment",
      id: this.id,
      present: this.present,
    };
  }

  static fromJSON(_schema: unknown, json: unknown): PastedTextAttachmentStep {
    const value = stepSchema.parse(json);
    return new PastedTextAttachmentStep(value.id, value.present);
  }
}

Step.jsonID("bbPastedTextAttachment", PastedTextAttachmentStep);

export const PastedTextHistory = Extension.create<{
  onChange: (id: string, present: boolean) => void;
}>({
  name: "pastedTextHistory",
  addOptions() {
    return { onChange: () => {} };
  },
  addProseMirrorPlugins() {
    const onChange = this.options.onChange;
    return [
      new Plugin({
        key: new PluginKey("bbPastedTextHistory"),
        state: {
          init: () => null,
          apply(transaction) {
            for (const step of transaction.steps) {
              if (step instanceof PastedTextAttachmentStep)
                onChange(step.id, step.present);
            }
            return null;
          },
        },
      }),
    ];
  },
});

export function recordPastedTextAttachment(
  view: EditorView,
  id: string,
  present: boolean,
): void {
  view.dispatch(
    closeHistory(view.state.tr).step(new PastedTextAttachmentStep(id, present)),
  );
  view.dispatch(closeHistory(view.state.tr));
}
