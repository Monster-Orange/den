/**
 * Issues 669 and 670: Den's pages draw no dialog of their own. A file in
 * src/ui/server/public that makes a <dialog> itself, or gives a dialog its
 * own backdrop or corner radius, fails here: the kit's frame
 * (packages/den-ui/src/dialog.js, dialogHtml and mountDialog) draws them.
 *
 * LEGACY is a ratchet for the dialogs not moved yet: each count may only
 * go down. The confirms and large dialogs moved in 669 and 670 are never
 * in it.
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

const CREATE = /<dialog\b|createElement\(\s*["']dialog["']\s*\)/g;
/** A dialog's backdrop given a look, or a dialog's rule with a radius. */
const BACKDROP = /::backdrop\s*\{[^}]*\bbackground/g;
const RADIUS = /(?:\bdialog\b|-dlg\b)[^{}]*\{[^}]*\bborder-radius\s*:/g;

/** Each offence in a source: dialogs made, backdrops, radii. */
export function offences(src: string): number {
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "");
  return (
    (code.match(CREATE) ?? []).length +
    (code.match(BACKDROP) ?? []).length +
    (code.match(RADIUS) ?? []).length
  );
}

function scan(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of fs.readdirSync(PUBLIC)) {
    if (!/\.(js|html|css)$/.test(f)) continue;
    const n = offences(fs.readFileSync(path.join(PUBLIC, f), "utf-8"));
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
