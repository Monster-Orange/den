/**
 * Issues 669 and 670: Den's pages draw no dialog of their own. A file in
 * src/ui/server/public that makes a <dialog> itself, or gives a dialog its
 * own backdrop or corner radius, fails here: the kit's frame
 * (packages/den-ui/src/dialog.js, dialogHtml and mountDialog) draws them.
 *
 * LEGACY is a ratchet for the dialogs not moved yet: each count may only
 * go down. The confirms and large dialogs moved in 669 and 670 are never
 * in it.
 *
 * Issue 793: nor a pop-up of its own drawn as a full-window layer (a
 * `position: fixed` box with `inset: 0`, or pinned to all four edges, or
 * 100vw by 100vh). Such a layer sets no font, so it took whatever <body>
 * had: on a page whose font is on its main (#den-content), the browser's
 * serif. Only the layers in OVERLAYS stay, each with its reason.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const PUBLIC = path.join(__dirname, "../../../src/ui/server/public");

/** Moved onto the kit's frame (issues 669, 670): never back. */
const MOVED = [
  "restart-den.js",
  "ws-delete-agents.js",
  "server-agent-page.js",
  "settings-registry.js",
  "agent-helpers.js",
  "transcript-view.js",
  "report-den.js",
  "server-agent.html",
  "settings.html",
];

/** Not moved yet: how many each still has. Only ever lower these. */
const LEGACY: Record<string, number> = {
  "agents.html": 8,
  "persona-ui.css": 6,
  "persona-ui.js": 1,
  "shell.js": 4,
  "topbar.js": 2,
};

/**
 * Issue 793: full-window layers that stay, per file, each with why. A
 * count may only go down; a new layer is a pop-up, and goes through the
 * kit's frame (dialogHtml, mountDialog, askConfirm).
 *
 * Issue 806: Add Service moved onto the kit's frame (add-service.js), so
 * local-dev.html is off this list and may never come back. The two left
 * were reviewed then and stay, each for the reason it gives.
 */
const OVERLAYS: Record<string, { n: number; why: string }> = {
  "shell.js": {
    n: 1,
    why: "the command palette (.den-pal-wrap): a search field and its list over the page, not a dialog with a footer; it sets its own font (reviewed in issue 806)",
  },
  "graph.css": {
    n: 1,
    why: "the graph's details panel popped out (.dg-modal-back): the same side panel, moved, keeping the graph's own state, menus and Esc; inside the graph's .dg root, which sets the font (reviewed in issue 806)",
  },
};

const CREATE = /<dialog\b|createElement\(\s*["']dialog["']\s*\)/g;
/** A dialog's backdrop given a look, or a dialog's rule with a radius. */
const BACKDROP = /::backdrop\s*\{[^}]*\bbackground/g;
const RADIUS = /(?:\bdialog\b|-dlg\b)[^{}]*\{[^}]*\bborder-radius\s*:/g;

const uncomment = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");

/** Each offence in a source: dialogs made, backdrops, radii. */
export function offences(src: string): number {
  const code = uncomment(src);
  return (
    (code.match(CREATE) ?? []).length +
    (code.match(BACKDROP) ?? []).length +
    (code.match(RADIUS) ?? []).length
  );
}

const FIXED = /position\s*:\s*fixed\b/g;
const ZERO = String.raw`0(?:px)?\s*(?:!important\s*)?(?:[;"'\x60}\n]|$)`;
const AT = String.raw`(?:^|[\s;{"'\x60])`;
const INSET0 = new RegExp(AT + String.raw`inset\s*:\s*` + ZERO);
const EDGE0 = (side: string) =>
  new RegExp(AT + side + String.raw`\s*:\s*` + ZERO);
const FULL_W = /\bwidth\s*:\s*100(?:vw|dvw|%)/;
const FULL_H = /\bheight\s*:\s*100(?:vh|dvh|%)/;

/**
 * Issue 793: each full-window layer in a source: a `position: fixed` whose
 * rule (or inline style) has `inset: 0`, or 0 on all four edges, or a
 * full width and height.
 */
export function overlays(src: string): number {
  const code = uncomment(src);
  let n = 0;
  for (const m of code.matchAll(FIXED)) {
    const at = m.index ?? 0;
    // The rule (or style text) it is in: back to its "{" (or the last
    // "}"), on to its "}", never more than 400 characters either way.
    const from = Math.max(
      0,
      code.lastIndexOf("{", at),
      code.lastIndexOf("}", at),
      at - 400,
    );
    let to = code.indexOf("}", at);
    if (to < 0 || to > at + 400) to = at + 400;
    const rule = code.slice(from, to + 1);
    const pinned = ["top", "right", "bottom", "left"].every((s) =>
      EDGE0(s).test(rule),
    );
    if (INSET0.test(rule) || pinned || (FULL_W.test(rule) && FULL_H.test(rule)))
      n++;
  }
  return n;
}

/** Every page file: the folder and its subfolders (i18n). */
function pageFiles(dir = PUBLIC, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...pageFiles(path.join(dir, e.name), r));
    else if (/\.(js|html|css)$/.test(e.name)) out.push(r);
  }
  return out;
}

function scan(count = offences): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of pageFiles()) {
    const n = count(fs.readFileSync(path.join(PUBLIC, f), "utf-8"));
    if (n) out[f] = n;
  }
  return out;
}

describe("issues 669, 670: Den's pages draw no dialog of their own", () => {
  it("the check can fail", () => {
    expect(offences('const d = document.createElement("dialog");')).toBe(1);
    expect(offences("<dialog id=x></dialog>")).toBe(1);
    expect(
      offences(
        ".x-dlg{border-radius:10px}.x-dlg::backdrop{background:rgba(0,0,0,.25)}",
      ),
    ).toBe(2);
    expect(offences("dialog.y {\n  border-radius: 12px;\n}")).toBe(1);
    expect(
      offences("/* a <dialog> in a comment */ .row{border-radius:4px}"),
    ).toBe(0);
  });

  it("no moved file makes a dialog or styles one", () => {
    const found = scan();
    const back = MOVED.filter((f) => found[f]).map((f) => `${f}: ${found[f]}`);
    expect(back).toEqual([]);
  });

  it("no other file starts to; the ones not moved yet only go down", () => {
    const found = scan();
    const worse = Object.entries(found)
      .filter(([f, n]) => n > (LEGACY[f] ?? 0))
      .map(([f, n]) => `${f}: ${n} (allowed ${LEGACY[f] ?? 0})`);
    expect(worse).toEqual([]);
  });
});

describe("issue 793: no page draws a full-window pop-up of its own", () => {
  it("the check can fail", () => {
    expect(
      overlays(
        'el.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,.5);";',
      ),
    ).toBe(1);
    expect(overlays(".veil {\n  position: fixed;\n  inset: 0;\n}")).toBe(1);
    expect(
      overlays(
        ".veil { position: fixed; top: 0; right: 0; bottom: 0; left: 0 }",
      ),
    ).toBe(1);
    expect(
      overlays(".veil { position: fixed; width: 100vw; height: 100vh; }"),
    ).toBe(1);
    // A toast, a menu, a drawer on one side: not full-window.
    expect(
      overlays(
        ".toast { position: fixed; bottom: 70px; left: 50%; }" +
          ".menu { position: fixed; inset: auto; }" +
          ".drawer { position: fixed; top: 0; right: 0; bottom: 0; width: 420px; }",
      ),
    ).toBe(0);
    expect(overlays("/* position: fixed; inset: 0 */ .x { color: red }")).toBe(
      0,
    );
  });

  it("issue 806: Add Service is the kit's dialog, never a layer of its own", () => {
    expect(Object.keys(OVERLAYS)).not.toContain("local-dev.html");
    expect(
      overlays(fs.readFileSync(path.join(PUBLIC, "local-dev.html"), "utf-8")),
    ).toBe(0);
    const mod = fs.readFileSync(path.join(PUBLIC, "add-service.js"), "utf-8");
    expect(overlays(mod) + offences(mod)).toBe(0);
    expect(mod).toMatch(/\bdialogHtml\(/);
    expect(mod).toMatch(/\bmountDialog\(/);
  });

  it("each layer that stays is still there and has its reason", () => {
    const found = scan(overlays);
    for (const [f, o] of Object.entries(OVERLAYS)) {
      expect([f, o.why.length > 20]).toEqual([f, true]);
      expect([f, found[f] ?? 0]).toEqual([f, o.n]);
    }
  });

  it("no other file draws one; the ones that stay only go down", () => {
    const found = scan(overlays);
    const worse = Object.entries(found)
      .filter(([f, n]) => n > (OVERLAYS[f]?.n ?? 0))
      .map(([f, n]) => `${f}: ${n} (allowed ${OVERLAYS[f]?.n ?? 0})`);
    expect(worse).toEqual([]);
  });
});
