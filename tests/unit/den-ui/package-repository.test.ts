/**
 * The UI kit is published from this repository by npm's trusted
 * publishing, whose provenance is checked against the package's
 * `repository.url`: a missing or different URL is refused (E422). So the
 * kit names the same repository as Den's own package.json, with its folder.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const read = (p: string) =>
  JSON.parse(fs.readFileSync(path.join(process.cwd(), p), "utf-8")) as {
    repository?: { type?: string; url?: string; directory?: string };
  };

describe("den-ui names the repository it is published from", () => {
  it("its repository.url is Den's, with directory packages/den-ui", () => {
    const root = read("package.json").repository;
    const kit = read("packages/den-ui/package.json").repository;
    expect(root?.url).toMatch(/^git\+https:\/\/github\.com\/.+\.git$/);
    expect(kit).toEqual({
      type: "git",
      url: root?.url,
      directory: "packages/den-ui",
    });
  });
});
