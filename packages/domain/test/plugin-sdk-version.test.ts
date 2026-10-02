/// <reference types="node" />
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { PLUGIN_SDK_VERSION } from "../src/plugin-sdk-version.js";

it("advertises the version of the bundled Plugin SDK", () => {
  const manifest: unknown = JSON.parse(
    readFileSync(
      new URL("../../plugin-sdk/package.json", import.meta.url),
      "utf8",
    ),
  );

  expect(manifest).toMatchObject({ version: PLUGIN_SDK_VERSION });
});
