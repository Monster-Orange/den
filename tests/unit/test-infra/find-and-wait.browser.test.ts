/**
 * Issue 841: the shared finders and waits (tests/unit/helpers/find.ts) in
 * real Chromium and WebKit. A page served from a routed origin opens a
 * dialog, adds a row and fetches after a delay; the test waits for each
 * state by name, never a sleep, and a wait that runs out says which state.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import type { Browser, Page, Route } from "playwright";
import { closeBrowserSuite } from "../../browser-teardown.js";
import { launchBrowser } from "../helpers/browser.js";
import { byLabel, byRole, settled, waitFor } from "../helpers/find.js";

const ORIGIN = "http://find.test";
const browsers: Record<string, Browser> = {};

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    for (const [name, kind] of [
      ["chromium", pw.chromium],
      ["webkit", pw.webkit],
    ] as const)
      browsers[name] = await launchBrowser(kind);
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
}, 90_000);

afterAll(async () => {
  await closeBrowserSuite({ browsers: Object.values(browsers) });
}, 60_000);

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"></head>
<body>
<label>Project name <input id="n"></label>
<button id="add">Add project</button>
<button id="ask">Delete project</button>
<table><tbody id="rows"></tbody></table>
<dialog aria-label="Delete project" id="d"><button id="cancel">Cancel</button></dialog>
<script>
  const later = (fn) => setTimeout(fn, 300);
  add.onclick = () => later(() =>
    fetch("/api/projects", { method: "POST", body: n.value })
      .then((r) => r.text())
      .then((name) => { rows.insertAdjacentHTML("beforeend",
        "<tr><td>" + name + "</td></tr>"); }));
  ask.onclick = () => later(() => d.showModal());
  cancel.onclick = () => later(() => d.close());
</script></body></html>`;

async function open(b: Browser): Promise<Page> {
  const p = await (await b.newContext()).newPage();
  await p.route(`${ORIGIN}/**`, (r: Route) => {
    const url = r.request().url();
    if (url.endsWith("/api/projects"))
      return r.fulfill({ body: r.request().postData() ?? "" });
    return r.fulfill({ contentType: "text/html", body: PAGE });
  });
  await p.goto(`${ORIGIN}/`);
  return p;
}

for (const engine of ["chromium", "webkit"])
  describe(`find and wait in ${engine} (issue 841)`, () => {
    it("finds by label and role, and waits for a request, a row and a dialog", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      await byLabel(p, "Project name").fill("billing");
      const r = await settled(
        p,
        "/api/projects",
        () => byRole(p, "button", "Add project").click(),
        { method: "POST" },
      );
      expect(r.url()).toBe(`${ORIGIN}/api/projects`);
      await waitFor(p, { row: "billing" });

      await byRole(p, "button", "Delete project").click();
      await waitFor(p, { dialog: "Delete project" });
      await byRole(p, "button", "Cancel").click();
      await waitFor(p, { dialogClosed: "Delete project" });
      await p.context().close();
    });

    it("a wait that runs out names the state", async () => {
      const b = browsers[engine];
      if (!b) return;
      const p = await open(b);
      await expect(
        waitFor(p, { row: "never" }, { timeout: 400 }),
      ).rejects.toThrow(/waited 400 ms for a row "never"/);
      await p.context().close();
    });
  });
