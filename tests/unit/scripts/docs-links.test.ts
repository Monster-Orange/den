/**
 * DOC-2's link check (scripts/docs-links.js): every relative link in
 * README.md and docs/ reaches a file, and a #fragment names a heading there.
 * External links are skipped; links in code are not links.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface DocsLinks {
  brokenLinks: (
    root: string,
    files: string[],
  ) => { file: string; link: string; why: string }[];
  docFiles: (root: string) => string[];
  slug: (h: string) => string;
}

const load = async () =>
  (await import(
    path.join(process.cwd(), "scripts", "docs-links.js")
  )) as DocsLinks;

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "den-docs-links-"));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
}

describe("docs-links", () => {
  it("reports a missing file and a missing heading, nothing else", async () => {
    const { brokenLinks, docFiles } = await load();
    const root = repo({
      "README.md": [
        "# Den",
        "[cli](docs/cli.md) [gone](docs/gone.md) [web](https://example.com)",
        '<img src="docs/images/0.3.0/hero-dark.png" alt="hero">',
        "```",
        "[in a fence](docs/nowhere.md)",
        "```",
        "and `[inline](docs/nowhere.md)` code",
      ].join("\n"),
      "docs/cli.md": [
        "# CLI",
        "## make: den.mk",
        "[ok](#make-denmk) [bad anchor](#no-such-heading)",
        "[back](../README.md#den) [up](../README.md#nope)",
        "[outside](../../elsewhere.md)",
      ].join("\n"),
      "docs/images/0.3.0/hero-dark.png": "png",
    });
    expect(docFiles(root)).toEqual(["README.md", "docs/cli.md"]);
    expect(brokenLinks(root, docFiles(root))).toEqual([
      { file: "README.md", link: "docs/gone.md", why: "no such file" },
      {
        file: "docs/cli.md",
        link: "#no-such-heading",
        why: "no heading #no-such-heading in docs/cli.md",
      },
      {
        file: "docs/cli.md",
        link: "../README.md#nope",
        why: "no heading #nope in README.md",
      },
      {
        file: "docs/cli.md",
        link: "../../elsewhere.md",
        why: "points outside the repo",
      },
    ]);
  });

  it("slugs headings as GitHub does", async () => {
    const { slug } = await load();
    expect(slug("den.yml: the product profile")).toBe(
      "denyml-the-product-profile",
    );
    expect(slug("Refs: where Den's own features find their secrets")).toBe(
      "refs-where-dens-own-features-find-their-secrets",
    );
    expect(slug("Secrets in a target's env")).toBe("secrets-in-a-targets-env");
  });

  it("finds no broken link in this repo's README.md and docs/", async () => {
    const { brokenLinks, docFiles } = await load();
    const root = process.cwd();
    expect(brokenLinks(root, docFiles(root))).toEqual([]);
  });
});
