/**
 * BUSY-1: a button that writes to Den goes through the working pop-up
 * (denShell.busyAction), whose request passes its `{ headers }` (the id
 * Try again resends). This counts, per page script, the writes that don't
 * (api("POST", …) and fetch(…, { method: "POST" }) without `{ headers }`),
 * against the count when BUSY-1 began. A new one fails here; moving one
 * onto the pop-up must lower its number, so the list only shrinks.
 * Pages' own scripts (*.html) count too (issue 133: Delete project and
 * Remove service on the Projects and Services pages).
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");

/** The writes not yet on the pop-up, per file (0.4.46 BUSY-1). */
const LEFT: Record<string, number> = {
  "agent-helpers.js": 1,
  "agents-page.js": 23,
  "agents-section.js": 2,
  "appearance.js": 2,
  "bell.js": 1,
  "error-page.js": 4,
  "graph.js": 1,
  "header.js": 2,
  "local-dev.html": 18,
  "persona-ui.js": 5,
  "release.html": 4,
  "server-agent-page.js": 4,
  "services.html": 2,
  "settings-registry.js": 15,
  "shell.js": 3,
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

describe("BUSY-1: writes go through the working pop-up", () => {
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

  it("no page script has more writes off the pop-up than its number", () => {
    const now: Record<string, number> = {};
    for (const f of fs
      .readdirSync(PUBLIC)
      .filter((x) => x.endsWith(".js") || x.endsWith(".html"))) {
      const n = writesOffThePopup(
        fs.readFileSync(path.join(PUBLIC, f), "utf-8"),
      );
      if (n) now[f] = n;
    }
    // A higher number: put the new button on denShell.busyAction. A lower
    // one: lower LEFT to match (the list only shrinks).
    expect(now).toEqual({ ...LEFT, ...NO_SHELL });
  });

  it("a script exempt for having no shell really has none", () => {
    for (const f of Object.keys(NO_SHELL)) {
      const src = fs.readFileSync(path.join(PUBLIC, f), "utf-8");
      expect(src).not.toMatch(/denShell|busyAction/);
    }
  });
});
