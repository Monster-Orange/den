/**
 * AG-DROP on the agents page, through the real routes: a file dropped onto
 * an agent's terminal pane, pasted into it, or picked with its Attach
 * button goes to the server (POST /api/sessions/<id>/uploads), lands under
 * <state>/uploads/<session id>/, and its absolute path is typed at the
 * cursor: shell-quoted, space-separated, a trailing space, no Enter.
 *
 *   - while a file is over the pane: "Drop to attach to <agent>";
 *   - a paste of plain text stays a paste (xterm's);
 *   - past agents.uploads.max_bytes: the chip says so, naming the setting,
 *     and nothing is typed;
 *   - at 375 px the bar fits and nothing scrolls sideways; no page errors.
 *
 * The demo distribution with a session host in this process and a
 * scripted PTY (helpers/agents-page-server.ts): what the page types is
 * what the PTY was written. Needs Playwright's chromium;
 * DEN_SKIP_BROWSER_TESTS=1 skips it. DEN_HELPERS_BROWSER=firefox|webkit
 * runs it there.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import type { Browser, Page } from "playwright";
import { connectHost } from "../../../src/shared/sessions/client.js";
import { sessionPaths } from "../../../src/shared/sessions/paths.js";
import type { ScriptedPty } from "../sessions/helpers/fake-pty.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let browser: Browser | null = null;
let s: AgentsPageServer;
let sid = "";
let pty: ScriptedPty;

beforeAll(async () => {
  try {
    const pw = await import("playwright");
    const engine = (
      ["firefox", "webkit"].includes(process.env.DEN_HELPERS_BROWSER ?? "")
        ? process.env.DEN_HELPERS_BROWSER
        : "chromium"
    ) as "chromium" | "firefox" | "webkit";
    const ws = process.env.DEN_PW_WS;
    browser = ws
      ? await pw[engine].connect(ws, { exposeNetwork: "<loopback>" })
      : await pw[engine].launch();
  } catch (err) {
    if (process.env.DEN_SKIP_BROWSER_TESTS === "1") return;
    throw err;
  }
  s = await startAgentsPageServer();
  const host = await connectHost(sessionPaths(s.stateDir).socket);
  const info = await host.start({
    name: "acme-north:scout",
    cwd: s.wsDir("north"),
    argv: ["sh"],
    env: {},
    cols: 80,
    rows: 24,
  });
  host.close();
  sid = info.ref.id;
  pty = s.made.at(-1)!;
  s.seed({
    id: "scout",
    persona: "builder",
    runtime: "den-claude",
    workspace: "north",
    session: { backend: "den-pty", id: sid },
    sessionName: "acme-north:scout",
  });
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await s?.stop();
});

/** Everything the page typed into the agent's PTY since `from`. */
const typed = (from: number) =>
  Buffer.concat(pty.writes.slice(from)).toString("utf8");

async function open(width = 1280) {
  const ctx = await browser!.newContext({
    viewport: { width, height: 900 },
    reducedMotion: "reduce",
  });
  await ctx.addInitScript(() => {
    try {
      for (const k of ["den-changelog-seen", "acme-changelog-seen"])
        localStorage.setItem(k, "9.9.9");
    } catch {
      /* none */
    }
  });
  const p: Page = await ctx.newPage();
  const errors: string[] = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(`${s.base}/agents?open=${sid}&layout=tabs`);
  await p.waitForSelector("#agl:not([aria-busy]) .agr", { timeout: 20_000 });
  await p.evaluate(() =>
    (window as unknown as { closeChangelog?: () => void }).closeChangelog?.(),
  );
  // Connected: the PTY's output is on screen.
  const mark = `ready-${Math.random().toString(36).slice(2, 8)}`;
  await p.locator(`.pane[data-id="${sid}"] .xterm`).waitFor();
  await new Promise((r) => setTimeout(r, 300));
  pty.emit(`${mark}$ `);
  await p.waitForFunction(
    (m) =>
      document.querySelector(".pane .xterm-rows")?.textContent?.includes(m),
    mark,
    { timeout: 15_000 },
  );
  return { p, errors };
}

/** Dispatch a drag of `files` onto the pane's terminal, ending in a drop. */
async function drop(
  p: Page,
  files: { name: string; type: string; bytes: number[] }[],
  { end = true } = {},
) {
  await p.evaluate(
    ([sel, fs, end]) => {
      const dt = new DataTransfer();
      for (const f of fs as { name: string; type: string; bytes: number[] }[])
        dt.items.add(
          new File([new Uint8Array(f.bytes)], f.name, { type: f.type }),
        );
      const el = document.querySelector(sel as string)!;
      for (const type of ["dragenter", "dragover", ...(end ? ["drop"] : [])])
        el.dispatchEvent(
          new DragEvent(type, {
            dataTransfer: dt,
            bubbles: true,
            cancelable: true,
          }),
        );
    },
    [`.pane[data-id="${sid}"] .xterm-screen`, files, end] as const,
  );
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
const upDir = () => path.join(s.stateDir, "uploads", sid);
const pathRe = (name: string) =>
  new RegExp(
    `'?(${upDir().replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}/\\d{8}-\\d{6}-\\d{3}-${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})'? $`,
  );

describe("AG-DROP: a file onto an agent's terminal", () => {
  it("a drop shows the overlay, sends the files, and types their paths at the cursor (quoted, a trailing space, no Enter)", async () => {
    if (!browser) return;
    const { p, errors } = await open();
    // Over the pane: its overlay names the agent.
    await drop(p, [{ name: "a.png", type: "image/png", bytes: PNG }], {
      end: false,
    });
    const ov = p.locator(`.pane[data-id="${sid}"] .agdrop`);
    await ov.waitFor();
    expect(await ov.textContent()).toBe("Drop to attach to scout");
    await p.evaluate((sel) => {
      document
        .querySelector(sel)!
        .dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
    }, `.pane[data-id="${sid}"] .xterm-screen`);
    await ov.waitFor({ state: "detached" });

    const from = pty.writes.length;
    await drop(p, [
      { name: "shot one.png", type: "image/png", bytes: PNG },
      { name: "notes.txt", type: "text/plain", bytes: [104, 105] },
    ]);
    const t0 = Date.now();
    while (!/ $/.test(typed(from)) && Date.now() - t0 < 15_000)
      await new Promise((r) => setTimeout(r, 100));
    const out = typed(from);
    expect(out).not.toMatch(/[\r\n]/);
    // One with a space is quoted; the other is a plain word.
    const m = /^'([^']+)' (\S+) $/.exec(out);
    expect(m).not.toBeNull();
    const [, fileA, fileB] = m!;
    for (const f of [fileA, fileB]) expect(path.dirname(f)).toBe(upDir());
    expect(fileA).toMatch(/\/\d{8}-\d{6}-\d{3}-shot one\.png$/);
    expect(fileB).toMatch(/\/\d{8}-\d{6}-\d{3}-notes\.txt$/);
    expect([...fs.readFileSync(fileA)]).toEqual(PNG);
    expect(fs.readFileSync(fileB, "utf8")).toBe("hi");
    expect(out.endsWith(" ")).toBe(true);
    // Its chips say so, then go.
    await p
      .locator(`.pane[data-id="${sid}"] .agup-c[data-tone="ok"]`)
      .first()
      .waitFor();
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("a pasted image is sent and its path typed; pasted text stays a paste", async () => {
    // Firefox gives a made-up paste event an empty clipboard of its own
    // (neither its files nor its text reach the page), so a test can't
    // paste there; Chromium and WebKit carry it.
    if (!browser || process.env.DEN_HELPERS_BROWSER === "firefox") return;
    const { p, errors } = await open();
    const paste = (o: { text?: string; file?: boolean }) =>
      p.evaluate(
        ([sel, o]) => {
          const dt = new DataTransfer();
          const opt = o as { text?: string; file?: boolean };
          if (opt.text) dt.setData("text/plain", opt.text);
          if (opt.file)
            dt.items.add(
              new File([new Uint8Array([1, 2, 3])], "image.png", {
                type: "image/png",
              }),
            );
          const ta = document.querySelector(sel as string) as HTMLElement;
          ta.focus();
          ta.dispatchEvent(
            new ClipboardEvent("paste", {
              clipboardData: dt,
              bubbles: true,
              cancelable: true,
            }),
          );
        },
        [`.pane[data-id="${sid}"] textarea.xterm-helper-textarea`, o] as const,
      );
    let from = pty.writes.length;
    await paste({ file: true });
    const t0 = Date.now();
    while (!/ $/.test(typed(from)) && Date.now() - t0 < 15_000)
      await new Promise((r) => setTimeout(r, 100));
    expect(typed(from)).toMatch(pathRe("pasted.png"));
    from = pty.writes.length;
    await paste({ text: "hello there" });
    const t1 = Date.now();
    while (!typed(from).includes("hello there") && Date.now() - t1 < 10_000)
      await new Promise((r) => setTimeout(r, 100));
    expect(typed(from)).toContain("hello there");
    expect(typed(from)).not.toContain("uploads");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  for (const width of [1280, 375])
    it(`at ${width}: the bar's Attach picks files and types their paths; nothing scrolls sideways`, async () => {
      if (!browser) return;
      const { p, errors } = await open(width);
      const attach = p.locator(`.pane[data-id="${sid}"] [data-act="attach"]`);
      await attach.waitFor();
      expect(await attach.getAttribute("aria-label")).toBe(
        "Attach a file to scout",
      );
      const from = pty.writes.length;
      const [fc] = await Promise.all([
        p.waitForEvent("filechooser"),
        attach.click(),
      ]);
      expect(fc.isMultiple()).toBe(true);
      await fc.setFiles({
        name: "my doc.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1"),
      });
      const t0 = Date.now();
      while (!/ $/.test(typed(from)) && Date.now() - t0 < 15_000)
        await new Promise((r) => setTimeout(r, 100));
      expect(typed(from)).toMatch(/^'.*\/\d{8}-\d{6}-\d{3}-my doc\.pdf' $/);
      expect(
        await p.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      const bar = await p
        .locator(`.pane[data-id="${sid}"] .bar2`)
        .evaluate((b) => b.scrollWidth <= b.clientWidth + 1);
      expect(bar).toBe(true);
      expect(errors).toEqual([]);
      await p.context().close();
    }, 90_000);

  it("past agents.uploads.max_bytes: the chip names the setting, nothing is typed or kept", async () => {
    if (!browser) return;
    const cfg = path.join(s.tmp, "dist", "config", "acme.yml");
    const was = fs.readFileSync(cfg, "utf8");
    fs.writeFileSync(cfg, `${was}\nagents:\n  uploads:\n    max_bytes: 1000\n`);
    try {
      const { p, errors } = await open();
      const from = pty.writes.length;
      const before = fs.existsSync(upDir()) ? fs.readdirSync(upDir()) : [];
      await drop(p, [
        {
          name: "big.bin",
          type: "application/octet-stream",
          bytes: Array.from({ length: 2000 }, (_, i) => i & 255),
        },
      ]);
      const bad = p.locator(`.pane[data-id="${sid}"] .agup-c[data-tone="bad"]`);
      await bad.waitFor({ timeout: 15_000 });
      expect(await bad.textContent()).toContain("agents.uploads.max_bytes");
      await new Promise((r) => setTimeout(r, 300));
      expect(typed(from)).toBe("");
      expect(fs.existsSync(upDir()) ? fs.readdirSync(upDir()) : []).toEqual(
        before,
      );
      expect(errors).toEqual([]);
      await p.context().close();
    } finally {
      fs.writeFileSync(cfg, was);
    }
  }, 90_000);

  it("AG-DROP-2: ⌘/Ctrl-click on a path the agent printed: its menu's Download brings the file to this browser", async () => {
    if (!browser) return;
    const dir = path.join(s.wsDir("north"), "out");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "r.txt"), "the agent's report\n");
    const { p, errors } = await open();
    pty.emit("\u001b[2J\u001b[Hsee out/r.txt here\r\n");
    await p.waitForFunction(() =>
      document
        .querySelector(".pane .xterm-rows")
        ?.textContent?.includes("see out/r.txt here"),
    );
    const at = await p.$eval(`.pane[data-id="${sid}"]`, (el) => {
      const scr = el.querySelector(".xterm-screen")!.getBoundingClientRect();
      const cols = Number((el as HTMLElement).dataset.cols);
      const rows = Number((el as HTMLElement).dataset.rows);
      return {
        x: scr.left + 6.5 * (scr.width / cols),
        y: scr.top + 0.5 * (scr.height / rows),
      };
    });
    const mod = (await p.evaluate(() => /mac/i.test(navigator.platform)))
      ? "Meta"
      : "Control";
    await p.mouse.move(at.x, at.y + 300);
    await p.mouse.move(at.x, at.y, { steps: 3 });
    await p
      .locator(`.pane[data-id="${sid}"] .xterm-cursor-pointer`)
      .waitFor({ timeout: 10_000 });
    await p.keyboard.down(mod);
    await p.mouse.click(at.x, at.y);
    await p.keyboard.up(mod);
    const menu = p.locator('.den-pop[role="menu"]');
    await menu.waitFor();
    const [dl] = await Promise.all([
      p.waitForEvent("download"),
      menu.getByRole("menuitem", { name: "Download" }).click(),
    ]);
    expect(dl.suggestedFilename()).toBe("r.txt");
    const got = await dl.path();
    expect(fs.readFileSync(got!, "utf8")).toBe("the agent's report\n");
    // The page stays.
    expect(new URL(p.url()).pathname).toBe("/agents");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("a drop beside the panes never replaces the page", async () => {
    if (!browser) return;
    const { p, errors } = await open();
    const prevented = await p.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(["x"], "x.txt", { type: "text/plain" }));
      const e = new DragEvent("drop", {
        dataTransfer: dt,
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(e);
      return e.defaultPrevented;
    });
    expect(prevented).toBe(true);
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);
});

/**
 * A drag that lands where a person's pointer is: the element under (x, y)
 * gets dragenter, dragover and drop, as in a real drag. The toast's words
 * after it, if one shows.
 */
async function dropAt(p: Page, x: number, y: number) {
  return p.evaluate(
    ([x, y, bytes]) => {
      document.querySelector(".den-toast")?.remove();
      const dt = new DataTransfer();
      dt.items.add(
        new File([new Uint8Array(bytes as number[])], "pt.png", {
          type: "image/png",
        }),
      );
      const el = document.elementFromPoint(x as number, y as number)!;
      let overlay = "";
      for (const type of ["dragenter", "dragover", "drop"]) {
        el.dispatchEvent(
          new DragEvent(type, {
            dataTransfer: dt,
            bubbles: true,
            cancelable: true,
            clientX: x as number,
            clientY: y as number,
          }),
        );
        if (type === "dragover")
          overlay = document.querySelector(".pane .agdrop")?.textContent ?? "";
      }
      return {
        overlay,
        toast: document.querySelector(".den-toast")?.textContent ?? "",
      };
    },
    [x, y, PNG] as const,
  );
}

async function centre(p: Page, sel: string) {
  const b = (await p.locator(sel).boundingBox())!;
  return [b.x + b.width / 2, b.y + b.height / 2] as const;
}

async function typedSoon(from: number, want: RegExp) {
  const t0 = Date.now();
  while (!want.test(typed(from)) && Date.now() - t0 < 8000)
    await new Promise((r) => setTimeout(r, 100));
  return typed(from);
}

/**
 * 0.4.45 (stop-ship): the whole pane takes a drop, where a person's pointer
 * lets go: the terminal, the To line under it, the marker bar over it. After
 * the agent restarts the pane follows it, and a drop goes to the new
 * session. A pane that can't take one says why; a drop beside every pane
 * says where to drop. Last here: the restart swaps the session.
 */
describe("AG-DROP: the whole pane, and after a restart", () => {
  it("the terminal, the To line and the marker bar each take a drop", async () => {
    if (!browser) return;
    const { p, errors } = await open();
    const pane = `.pane[data-id="${sid}"]`;
    for (const part of [".xterm-screen", ".agto", ".bar2"]) {
      const from = pty.writes.length;
      const r = await dropAt(p, ...(await centre(p, `${pane} ${part}`)));
      expect(r.overlay).toBe("Drop to attach to scout");
      expect(await typedSoon(from, / $/)).toMatch(/uploads\/.*-pt\.png $/);
    }
    expect(errors).toEqual([]);
    await p.context().close();
  }, 90_000);

  it("a drop beside every pane says where to drop", async () => {
    if (!browser) return;
    const { p, errors } = await open();
    const r = await dropAt(p, 5, 895);
    expect(r.toast).toBe("Drop the file on an agent's pane to attach it.");
    expect(errors).toEqual([]);
    await p.context().close();
  }, 60_000);

  it("after a restart the pane follows the agent; a drop goes to the new session; an ended one says why", async () => {
    if (!browser) return;
    const { p, errors } = await open();
    const old = pty;
    // The session ends: the pane can't take a file, and says why.
    old.exit(0);
    await p
      .waitForFunction(
        (id) =>
          !!document.querySelector(`.pane[data-id="${id}"]`) &&
          /exited|ended|stopped/i.test(
            document.querySelector(`.pane[data-id="${id}"]`)?.textContent ?? "",
          ),
        sid,
        { timeout: 15_000 },
      )
      .catch(() => undefined);
    await new Promise((r) => setTimeout(r, 1500));
    const ended = await dropAt(p, ...(await centre(p, ".pane .xterm-screen")));
    expect(ended.overlay).toBe("Can't attach: scout isn't running");
    expect(ended.toast).toBe("Can't attach: scout isn't running");
    // The agent restarts: a new session for the same agent.
    const host = await connectHost(sessionPaths(s.stateDir).socket);
    const info = await host.start({
      name: "acme-north:scout",
      cwd: s.wsDir("north"),
      argv: ["sh"],
      env: {},
      cols: 80,
      rows: 24,
    });
    host.close();
    sid = info.ref.id;
    pty = s.made.at(-1)!;
    s.seed({
      id: "scout",
      persona: "builder",
      runtime: "den-claude",
      workspace: "north",
      session: { backend: "den-pty", id: sid },
      sessionName: "acme-north:scout",
    });
    await p.waitForSelector(`.pane[data-id="${sid}"]`, { timeout: 20_000 });
    await new Promise((r) => setTimeout(r, 800));
    for (const part of [".xterm-screen", ".agto", ".bar2"]) {
      const from = pty.writes.length;
      const r = await dropAt(
        p,
        ...(await centre(p, `.pane[data-id="${sid}"] ${part}`)),
      );
      expect(r.toast).toBe("");
      expect(await typedSoon(from, / $/)).toMatch(pathRe("pt.png"));
    }
    expect(errors).toEqual([]);
    await p.context().close();
  }, 120_000);
});
