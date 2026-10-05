// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAttachmentItems,
  ConversationAttachments,
} from "./ConversationAttachments";

afterEach(cleanup);

describe("named text attachments in history", () => {
  it("shows the original file name and size with a persistent content link", () => {
    const items = buildAttachmentItems({
      projectId: "project",
      attachments: {
        webImages: 0,
        localImages: 0,
        localFiles: 1,
        imageUrls: [],
        localImagePaths: [],
        localFilePaths: ["Pasted-text-unique.txt"],
        localFileDetails: [
          {
            path: "Pasted-text-unique.txt",
            name: "Pasted text.txt",
            sizeBytes: 3_638_577,
          },
        ],
      },
    });
    render(<ConversationAttachments {...items} projectId="project" />);
    const link = screen.getByRole("link", { name: "Pasted text.txt · 3.5 MB" });
    expect(link.getAttribute("href")).toBe(
      "/api/v1/projects/project/attachments/content?path=Pasted-text-unique.txt",
    );
  });
});
