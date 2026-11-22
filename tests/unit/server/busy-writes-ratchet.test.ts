/**
 * BUSY-1, as issue 1054 left it: the writes sent outside busyAction,
 * with no request id of the kit's (`{ headers }`, the id Try again
 * resends). Since 1054 that is not a fault in itself: each must show its
 * wait on screen (holdDots or holdRow) or give a reason (busy-ok), which
 * busy-button-sweep-1054.test.ts checks for every write. This keeps the
 * count per page script so a new bare write is seen and named, never
 * slipped in; a change that moves writes either way updates its number.
 * Pages' own scripts (*.html) count too (issue 133: Delete project and
 * Remove service on the Projects and Services pages).
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");

/**
 * The writes outside busyAction, per file (0.4.46 BUSY-1). Issue 1054
 * took three off it on purpose, each held on screen instead (one more in
 * agents-page.js, local-dev.html and services.html): a drag's save holds
 * its row, and Delete project holds its last dialog's button.
 * busy-button-sweep-1054.test.ts checks every write shows its wait.
 * Issue 1086 took one away: Remove all stopped no longer closes shells.
 */
const LEFT: Record<string, number> = {
  "agent-helpers.js": 1,
  "agents-page.js": 23,
  "agents-section.js": 1,
  "appearance.js": 2,
  "bell.js": 1,
  "error-page.js": 4,
  "graph.js": 1,
  "header.js": 2,
  "local-dev.html": 19,
  "persona-ui.js": 5,
  "release.html": 4,
  "server-agent-page.js": 4,
  "services.html": 3,
  "settings-registry.js": 15,
  "shell.js": 4,
  "svc-panel.js": 1,
  "topbar.js": 2,
};

/**
 * Writes on pages without Den's shell, so no working pop-up exists there.
 * embed-page.js is the embedded agent pane (issue 103): it runs in another
 * web app's frame, with no cookie and no denShell (embed.html mounts no
 * shell; tests/unit/server/shell.test.ts lists it). Its two writes (the
 * key, and Send with the key) say what happened in the pane itself. Held
 * exactly: a new write there, or a write gone, changes this number.
 */
const NO_SHELL: Record<string, number> = {
  "embed-page.js": 2,
};

const WRITE =
  /api\(\s*"(?:POST|PUT|PATCH|DELETE)"|method:\s*"(?:POST|PUT|PATCH|DELETE)"/g;
const BUSY_HEADERS = /\{\s*headers\s*,?\s*\}/;

export function writesOffThePopup(src: string): number {
  let n = 0;
  for (const m of src.matchAll(WRITE)) {
    const call = src.slice(m.index!, m.index! + 300).split(";")[0]!;
    if (!BUSY_HEADERS.test(call)) n++;
  }
  return n;
}

describe("BUSY-1: writes sent outside busyAction, counted", () => {
  it("counts a write without the pop-up's headers, and not one with them", () => {
    expect(writesOffThePopup('api("POST", "/api/x", {});')).toBe(1);
    expect(
      writesOffThePopup('fetch("/api/x", { method: "POST", body: "{}" });'),
    ).toBe(1);
    expect(
      writesOffThePopup(
        'run: (headers) =>\n  api("POST", "/api/x", {}, {\n    headers,\n  }),',
      ),
    ).toBe(0);
    expect(writesOffThePopup('api("GET", "/api/x");')).toBe(0);
  });

  it("each page script has exactly its number of writes outside busyAction", () => {
    const now: Record<string, number> = {};
    for (const f of fs
      .readdirSync(PUBLIC)
      .filter((x) => x.endsWith(".js") || x.endsWith(".html"))) {
      const n = writesOffThePopup(
        fs.readFileSync(path.join(PUBLIC, f), "utf-8"),
      );
      if (n) now[f] = n;
    }
    // A different number: a write moved in or out of busyAction. Set LEFT
    // to match; the 1054 sweep says whether its wait is shown.
    expect(now).toEqual({ ...LEFT, ...NO_SHELL });
  });

  it("a script exempt for having no shell really has none", () => {
    for (const f of Object.keys(NO_SHELL)) {
      const src = fs.readFileSync(path.join(PUBLIC, f), "utf-8");
      expect(src).not.toMatch(/denShell|busyAction/);
    }
  });
});
