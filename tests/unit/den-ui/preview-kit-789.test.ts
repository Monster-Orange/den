/**
 * Issue 789: the kit's preview helper (preview.js), the parts that need no
 * browser: the frame's document, the checks on what goes into it, its
 * types, its package export and Den serving it. The frame itself (sandbox,
 * width, theme, a script inside can't reach the host) is
 * preview-kit-789.browser.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const SRC = path.join(ROOT, "packages/den-ui/src");

type Preview = {
  PREVIEW_SANDBOX: string;
  PREVIEW_WIDTHS: readonly number[];
  previewHtml: (o?: Record<string, unknown>) => string;
  previewTheme: (t: unknown) => string | null;
};
const load = async (): Promise<Preview> =>
  (await import("../../../packages/den-ui/src/preview.js")) as Preview;

describe("issue 789: the preview's document", () => {
  it("links the kit, the theme and the frame script, with the body", async () => {
    const { previewHtml } = await load();
    const html = previewHtml({
      html: "<main data-x>hi</main>",
      theme: "sketch",
      mode: "dark",
      kitBase: "/static/den-ui/",
    });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('data-mode="dark"');
    expect(html).toContain('href="/static/den-ui/tokens.css"');
    expect(html).toContain('href="/static/den-ui/base.css"');
    expect(html).toContain(
      'id="den-pv-theme" href="/static/den-ui/themes/sketch.css"',
    );
    expect(html).toContain('src="/static/den-ui/preview-frame.js"');
    expect(html).toContain("<body><main data-x>hi</main></body>");
  });

  it("with no theme, the kit's own look (the theme link is off)", async () => {
    const { previewHtml } = await load();
    const html = previewHtml({});
    expect(html).toContain(
      '<link rel="stylesheet" id="den-pv-theme" disabled>',
    );
    expect(html).toContain('href="/kit/tokens.css"');
    expect(html).toContain('data-mode="light"');
  });

  it("refuses a theme, base, mode or width it can't trust", async () => {
    const { previewHtml, previewTheme } = await load();
    for (const theme of ["../x", "a b", '"><script>', "X", "-a"])
      expect(() => previewHtml({ theme })).toThrow(/theme/);
    for (const kitBase of ["//evil.example/", "/kit", "/../x/", 'x"/', "kit/"])
      expect(() => previewHtml({ kitBase })).toThrow(/kitBase/);
    expect(() => previewHtml({ mode: "dim" })).toThrow(/mode/);
    expect(previewTheme(null)).toBeNull();
    expect(previewTheme("sketch")).toBe("sketch");
  });

  it("sandboxes with scripts only, and names Hub's widths", async () => {
    const { PREVIEW_SANDBOX, PREVIEW_WIDTHS } = await load();
    expect(PREVIEW_SANDBOX).toBe("allow-scripts");
    expect([...PREVIEW_WIDTHS]).toEqual([390, 768, 1440]);
  });
});

describe("issue 789: the helper ships", () => {
  it("is typed in the kit's .d.ts", () => {
    const d = fs.readFileSync(path.join(SRC, "preview.d.ts"), "utf8");
    for (const name of ["previewHtml", "mountPreview", "previewTheme"])
      expect(d).toMatch(new RegExp(`export declare function ${name}\\(`));
  });

  it("is a package export, and Den serves it and its frame script", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, "packages/den-ui/package.json"), "utf8"),
    ) as { exports: Record<string, string> };
    expect(pkg.exports["./preview"]).toBe("./src/preview.js");
    expect(pkg.exports["./preview-frame.js"]).toBe("./src/preview-frame.js");
    expect(pkg.exports["./themes/sketch.css"]).toBe("./src/themes/sketch.css");
    const assets = fs.readFileSync(
      path.join(ROOT, "src/ui/server/ui-assets.ts"),
      "utf8",
    );
    for (const f of ["preview.js", "preview-frame.js", "themes/sketch.css"])
      expect(assets).toContain(`"${f}"`);
  });
});
