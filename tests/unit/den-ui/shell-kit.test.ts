/**
 * Issue 95 (UI kit slice 1): the kit's shell, its words and its parity
 * gate, the checks that need no browser.
 *
 *   - strings.js: en, es and ja have the same keys, every one `kit.`, with
 *     the same {placeholders}; DenUI.strings adds a product's words.
 *   - shell-html.js runs in Node and draws markup with no inline style or
 *     handler (clean under `script-src 'self'; style-src 'self'`), the
 *     product's parts in their slots: Report · bell · account on the right.
 *   - den-ui-parity fails on a product's own copy of a kit component and
 *     passes when DIVERGE.md names it with a reason.
 *   - Every kit file is exported, packed and served by Den (KIT_FILES).
 *
 * The browser half is shell-kit-parity.browser.test.ts (no visible change)
 * and kit-csp.browser.test.ts (a kit page under a strict CSP).
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as strings from "../../../packages/den-ui/src/strings.js";
import {
  reportButtonHtml,
  shellHtml,
} from "../../../packages/den-ui/src/shell-html.js";
import { KIT_FILES, KIT_PAGE_CSS } from "../../../src/ui/server/ui-assets.js";

const PKG = path.join(process.cwd(), "packages", "den-ui");
const GATE = path.join(PKG, "bin", "den-ui-parity.mjs");
type Table = Record<string, string>;
const { en, es, ja } = strings as unknown as Record<string, Table>;
const holes = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("the kit's words (strings.js)", () => {
  it("has the same keys in en, es and ja, every one kit.", () => {
    const base = (t: Table) =>
      Object.keys(t)
        .map((k) => k.replace(/\.(one|other)$/, ""))
        .filter((k, i, a) => a.indexOf(k) === i)
        .sort();
    expect(Object.keys(en).length).toBeGreaterThan(80);
    for (const k of Object.keys(en)) expect(k).toMatch(/^kit\./);
    expect(base(es)).toEqual(base(en));
    expect(base(ja)).toEqual(base(en));
    // A plural form (.one) is en's and es's; ja has one form.
    for (const k of Object.keys(en).filter((x) => !/\.one$/.test(x))) {
      expect([k, holes(es[k] ?? "")]).toEqual([k, holes(en[k])]);
      expect([k, holes(ja[k] ?? "")]).toEqual([k, holes(en[k])]);
    }
  });

  it("fills {product}, falls back to en, and takes a product's words", () => {
    const { kitT, setProduct, addStrings } = strings as unknown as {
      kitT: (l: string, k: string, v?: object) => string;
      setProduct: (n: string) => void;
      addStrings: (l: string, t: Table) => void;
    };
    setProduct("Acme");
    expect(kitT("xx", "kit.report.word")).toBe(en["kit.report.word"]);
    expect(kitT("ja", "kit.report.word")).toBe(ja["kit.report.word"]);
    addStrings("es", { "kit.report.word": "Avisar" });
    expect(kitT("es", "kit.report.word")).toBe("Avisar");
    const filed = kitT("en", "kit.report.filed", { n: 12 });
    expect(filed).toContain("12");
  });
});

describe("shellHtml (shell-html.js), in Node", () => {
  const model = {
    product: { name: "Acme <b>", version: "1.2.3" },
    lang: "ja",
    groups: [{ id: "work", label: "Work" }],
    nav: [
      { id: "a", label: "Alpha", href: "/a", group: "work", current: true },
      { id: "b", label: "Beta", href: "/b", group: "work", pin: "b" },
    ],
    slots: {
      start: '<span id="s-start"></span>',
      end: '<span id="s-end"></span>',
      bell: '<button id="s-bell"></button>',
      account: '<span id="s-account"></span>',
    },
  };
  const html = shellHtml(model);

  it("is clean under script-src 'self'; style-src 'self'", () => {
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<script|<style|javascript:/i);
  });

  it("puts the product's parts in their slots: Report · bell · account", () => {
    const at = (s: string) => html.indexOf(s);
    const order = [
      'class="den-brand"',
      'id="s-start"',
      'id="s-end"',
      "data-den-report",
      'id="s-bell"',
      'id="version-pill"',
      'id="s-account"',
      'id="den-rail"',
    ].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("escapes the product's text and marks the current page and pins", () => {
    expect(html).toContain("Acme &lt;b&gt;");
    expect(html).toContain(">v1.2.3<");
    expect(html).toMatch(/href="\/a" data-nav="a" aria-current="page"/);
    expect(html).toMatch(
      /<div class="den-pin-row"><a class="den-ni" href="\/b"/,
    );
    // The kit's words in the page's language.
    expect(html).toContain(ja["kit.pages"]);
    expect(html).toContain(ja["kit.report.word"]);
  });

  it("draws a product mark: escaped text, or the product's svg, named by its label", () => {
    const text = shellHtml({
      ...model,
      product: { name: "Acme", mark: { text: "<H>", label: "Acme home" } },
    });
    expect(text).toContain(
      '<span class="den-mark" id="den-mark" role="img" aria-label="Acme home">&lt;H&gt;</span>',
    );
    const svg = '<svg viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>';
    expect(
      shellHtml({
        ...model,
        product: { name: "Acme", mark: { svg, label: "Acme" } },
      }),
    ).toContain(
      `<span class="den-mark" id="den-mark" role="img" aria-label="Acme">${svg}</span>`,
    );
    // No mark: as before (Den fills the empty slot itself).
    expect(html).toContain(
      '<span class="den-mark" id="den-mark" aria-hidden="true"></span>',
    );
  });

  it("leaves Report out when reports are off", () => {
    expect(shellHtml({ ...model, report: false })).not.toContain(
      "data-den-report",
    );
    expect(reportButtonHtml({ inFoot: true })).toContain("den-rb-in");
  });
});

describe("den-ui-parity (bin)", () => {
  const run = (root: string) =>
    spawnSync(process.execPath, [GATE, "--root", root, "--src", "src"], {
      encoding: "utf-8",
    });
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "den-ui-parity-"));

  it("fails on a product's own copy of a kit component", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "frame.js"),
      "el.innerHTML = '<header class=\"den-top\"></header>';\n",
    );
    fs.writeFileSync(
      path.join(root, "src", "frame.css"),
      ".den-rb { color: red; }\n",
    );
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/shell: .*1 copy/);
    expect(r.stdout).toMatch(/report: .*1 copy/);
  });

  it("passes when DIVERGE.md names the component with a reason", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "frame.css"),
      ".den-rb { color: red; }\n",
    );
    fs.writeFileSync(
      path.join(root, "DIVERGE.md"),
      "| component | reason |\n|---|---|\n| report |  |\n",
    );
    expect(run(root).status).toBe(1); // no reason: does not count
    fs.writeFileSync(
      path.join(root, "DIVERGE.md"),
      "| component | reason |\n|---|---|\n| report | a ticket desk |\n",
    );
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("report diverges");
  });

  it("checks through a symlink too (npx, node_modules/.bin)", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "frame.css"),
      ".den-rb { color: red; }\n",
    );
    const bin = path.join(tmp(), "den-ui-parity");
    fs.symlinkSync(GATE, bin);
    const r = spawnSync(
      process.execPath,
      [bin, "--root", root, "--src", "src"],
      { encoding: "utf-8" },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/report: .*1 copy/);
  });

  it("finds no copy in Den", () => {
    const r = run(process.cwd());
    expect([r.status, r.stdout.trim()]).toEqual([
      0,
      "den-ui-parity: ok, no copies of the kit's 6 components in src",
    ]);
  });
});

describe("the package ships every kit file", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(PKG, "package.json"), "utf-8"),
  ) as {
    version: string;
    files: string[];
    bin: Record<string, string>;
  };
  it("Den links the kit's stylesheets in every page with the shell", () => {
    // No component injects a <style> (CSP): the page has its sheet first.
    for (const f of ["shell.css", "busy.css", "dialog.css"])
      expect(KIT_PAGE_CSS).toContain(`/kit/${f}`);
  });

  it("Den serves each one at /kit/ (KIT_FILES)", () => {
    const src = fs
      .readdirSync(path.join(PKG, "src"))
      .filter((f) => /\.(js|css)$/.test(f));
    for (const f of src) expect([f, KIT_FILES.includes(f)]).toEqual([f, true]);
  });
  it("packs src/ and bin/, with den-ui-parity as its bin", () => {
    expect(pkg.version).toMatch(/^0\.6\.\d+$/);
    expect(pkg.files).toEqual(expect.arrayContaining(["src/", "bin/"]));
    expect(pkg.bin["den-ui-parity"]).toBe("bin/den-ui-parity.mjs");
    expect(fs.existsSync(path.join(PKG, pkg.bin["den-ui-parity"]))).toBe(true);
  });
});
