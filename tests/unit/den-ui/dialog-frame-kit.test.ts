/**
 * Issues 669 and 670: one dialog frame in the kit, for both products.
 *
 *   dialogHtml({ kind: "confirm" | "panel", ... })  a pure function: the
 *     whole <dialog>, working with no script (method=dialog forms);
 *   mountDialog(...)  the browser half (focus, Esc, return focus, Report).
 *
 * Checked here, with no browser:
 *   - the markup of a Yes/No confirm and of a large dialog (heading, close,
 *     scrolling body, footer), everything escaped, every action a submit
 *     of a method=dialog form;
 *   - parity: the same dialog data, rendered through Den's call path
 *     (/dialog-den.js) and through the server-side call the second product
 *     makes (the kit's dialogHtml in Node), is the same HTML; askConfirm's
 *     frame is the same as the confirm written out by hand;
 *   - one look: dialog.css takes the theme's radius, backdrop and font.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  DIALOG_WORDS,
  askSpec,
  configureDialog,
  dialogHtml,
} from "../../../packages/den-ui/src/dialog.js";
import { dialogHtml as denDialogHtml } from "../../../src/ui/server/public/dialog-den.js";

const ROOT = path.join(__dirname, "../../..");
const CSS = fs.readFileSync(
  path.join(ROOT, "packages/den-ui/src/dialog.css"),
  "utf-8",
);
const DTS = fs.readFileSync(
  path.join(ROOT, "packages/den-ui/src/dialog.d.ts"),
  "utf-8",
);

const CONFIRM = {
  kind: "confirm" as const,
  id: "unlink",
  title: "Unlink <north>?",
  body: "<p>Its threads stay.</p>",
  actions: [
    { label: "Cancel", value: "cancel" },
    { label: "Yes, unlink", value: "yes", kind: "danger" as const },
  ],
};

const PANEL = {
  kind: "panel" as const,
  id: "helpers",
  title: "Helpers of scout",
  subtitle: "2 running",
  closeLabel: "Close",
  headActions: [{ label: "Clear done", value: "clear", type: "button" }],
  body: "<ol><li>one</li></ol>",
  foot: '<p class="dk-note">Read only.</p>',
};

describe("issue 669: the confirm frame", () => {
  it("is a whole <dialog>: an alertdialog, named and described", () => {
    configureDialog({ lang: () => "en", words: {}, report: null });
    const html = dialogHtml(CONFIRM);
    expect(html.startsWith("<dialog ")).toBe(true);
    expect(html.endsWith("</dialog>")).toBe(true);
    expect(html).toContain('id="unlink"');
    expect(html).toContain('role="alertdialog"');
    expect(html).toContain('aria-labelledby="unlink-h"');
    expect(html).toContain('aria-describedby="unlink-m"');
    expect(html).toContain(
      '<h2 id="unlink-h" tabindex="-1">Unlink &lt;north&gt;?</h2>',
    );
    expect(html).toContain('<div class="dk-msg" id="unlink-m">');
  });

  it("works with no script: one method=dialog form, every action a submit with its value", () => {
    const html = dialogHtml(CONFIRM);
    expect(html.match(/<form [^>]*method="dialog"/g)?.length).toBe(1);
    expect(html).toMatch(
      /<button type="submit" class="dk-btn" value="cancel" data-dk="cancel" formnovalidate>Cancel<\/button>/,
    );
    expect(html).toMatch(
      /<button type="submit" class="dk-btn dk-danger" value="yes" data-dk="yes">Yes, unlink<\/button>/,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toMatch(/\son[a-z]+=/);
  });

  it("the footer carries the product's Report first, when given", () => {
    const html = dialogHtml({ ...CONFIRM, report: "<button data-den-report>R</button>" });
    expect(html).toMatch(
      /<div data-den-foot class="dk-ft"><button data-den-report>R<\/button><button type="submit" class="dk-btn" value="cancel"/,
    );
  });

  it("opens with no script when asked (open), and takes the product's hooks", () => {
    const html = dialogHtml({
      ...CONFIRM,
      open: true,
      className: "hubp-dlg",
      attrs: { "data-state": "confirm" },
      actions: [
        { label: "Back", href: "/t/waiting?x=1&y=2" },
        { label: "Go", value: "go", kind: "primary", attrs: { "data-rd": "go" } },
      ],
    });
    expect(html).toMatch(/^<dialog [^>]*\sopen[\s>]/);
    expect(html).toContain('class="dk-dlg dk-confirm hubp-dlg"');
    expect(html).toContain('data-state="confirm"');
    expect(html).toContain('<a class="dk-btn" href="/t/waiting?x=1&amp;y=2">Back</a>');
    expect(html).toContain('data-rd="go"');
  });

  it("askConfirm and askText are thin wrappers on the frame", () => {
    configureDialog({ lang: () => "en", words: {}, report: null });
    const s = askSpec("confirm", { title: "Gone?", message: "a\nb", danger: true }, "q1");
    expect(s.kind).toBe("confirm");
    const html = dialogHtml(s);
    expect(html).toContain('data-dk-kind="confirm"');
    expect(html).toContain('<p class="dk-text">a\nb</p>');
    expect(html).toContain('data-dk="cancel"');
    expect(html).toContain("dk-danger");
    const text = dialogHtml(askSpec("text", { title: "Rename", value: 'x"y' }, "q2"));
    expect(text).toContain('role="dialog"');
    expect(text).toContain('value="x&quot;y"');
    const tellHtml = dialogHtml(askSpec("tell", { message: "Done" }, "q3"));
    expect(tellHtml).not.toContain('data-dk="cancel"');
  });
});

describe("issue 670: the large dialog frame", () => {
  it("has a heading, a close in the header, a scrolling body and a footer", () => {
    configureDialog({ lang: () => "en", words: {}, report: null });
    const html = dialogHtml(PANEL);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('class="dk-dlg dk-panel"');
    expect(html).toMatch(
      /<div class="dk-hd"><h2 id="helpers-h" tabindex="-1">Helpers of scout<\/h2><span class="dk-sub" id="helpers-sub">2 running<\/span>/,
    );
    // Close works with no script: a submit of its own method=dialog form.
    expect(html).toMatch(
      /<form class="dk-x-f" method="dialog"><button type="submit" class="dk-btn dk-x" value="close" data-dk="close">Close<\/button><\/form>/,
    );
    expect(html).toContain('<div class="dk-body" id="helpers-body"><ol><li>one</li></ol></div>');
    expect(html).toContain('<p class="dk-note">Read only.</p>');
    expect(html).toContain('data-dk="clear"');
    // Clear done before Close.
    expect(html.indexOf('data-dk="clear"')).toBeLessThan(html.indexOf('data-dk="close"'));
  });

  it("names its heading and body by the product's ids, when given", () => {
    const html = dialogHtml({ ...PANEL, ids: { h: "hp-h", body: "hp-body", sub: "x-sub" } });
    expect(html).toContain('aria-labelledby="hp-h"');
    expect(html).toContain('id="hp-body"');
    expect(html).toContain('id="x-sub"');
  });

  it("the close word comes from the kit in en, es and ja", () => {
    for (const l of ["en", "es", "ja"]) expect(DIALOG_WORDS[l]!.close).toBeTruthy();
    configureDialog({ lang: () => "es", words: {}, report: null });
    expect(dialogHtml({ ...PANEL, closeLabel: undefined })).toContain(">Cerrar</button>");
    configureDialog({ lang: () => "en" });
  });
});

describe("issues 669, 670: parity, both products' call shapes", () => {
  const SHAPES = [
    ["confirm", CONFIRM],
    ["panel", PANEL],
    ["confirm, open, with Report", { ...CONFIRM, open: true, report: "<a data-den-report>R</a>" }],
  ] as const;

  it.each(SHAPES)("%s: Den's path and the server-side call render the same HTML", (_n, spec) => {
    configureDialog({ lang: () => "en", words: {}, report: null });
    const den = denDialogHtml(spec as never);
    const server = dialogHtml(JSON.parse(JSON.stringify(spec)));
    expect(den).toBe(server);
  });

  it("the parity check can fail: different data, different HTML", () => {
    expect(dialogHtml(CONFIRM)).not.toBe(dialogHtml({ ...CONFIRM, title: "Other" }));
  });

  it("askConfirm's frame is the confirm a server writes by hand", () => {
    configureDialog({ lang: () => "en", words: {}, report: null });
    const viaAsk = dialogHtml(
      askSpec("confirm", { title: "Unlink?", message: "It stays.", okLabel: "Yes" }, "u"),
    );
    const byHand = dialogHtml({
      kind: "confirm",
      id: "u",
      title: "Unlink?",
      body: '<p class="dk-text">It stays.</p>',
      actions: [
        { label: "Cancel", value: "cancel" },
        { label: "Yes", value: "ok", kind: "primary" },
      ],
    });
    expect(viaAsk).toBe(byHand);
  });
});

describe("issues 669, 670: one look", () => {
  /** The rule for a selector in dialog.css. */
  const rule = (sel: string) =>
    CSS.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`))?.[1] ?? "";

  it("the theme's radius, backdrop and font; no number of its own", () => {
    const frame = rule(".dk-dlg");
    expect(frame).toMatch(/border-radius:\s*var\(--radius\)/);
    expect(frame).toMatch(/font-family:\s*var\(--sans\)/);
    expect(rule(".dk-dlg::backdrop")).toMatch(/background:\s*var\(--kit-scrim\)/);
    expect(CSS).not.toMatch(/border-radius:\s*\d/);
    expect(CSS).not.toMatch(/\brgba?\(|#[0-9a-fA-F]{3,8}\b/);
  });

  it("form fields and buttons inside take the dialog's font (issue 651)", () => {
    expect(CSS).toMatch(/\.dk-dlg :where\(button, input, select, textarea\)\s*\{\s*font: inherit;/);
  });

  it("the large dialog's body scrolls, its header and footer stay", () => {
    expect(rule(".dk-body")).toMatch(/overflow:\s*auto/);
    expect(rule(".dk-panel")).toMatch(/display:\s*flex/);
  });

  it("dialog.d.ts declares the frame", () => {
    expect(DTS).toMatch(/export interface DialogSpec/);
    expect(DTS).toMatch(/export declare function dialogHtml\(spec: DialogSpec\): string;/);
    expect(DTS).toMatch(/export declare function mountDialog\(/);
    expect(DTS).toMatch(/export declare function askSpec\(/);
  });
});
