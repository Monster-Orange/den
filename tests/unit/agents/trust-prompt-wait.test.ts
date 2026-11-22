/**
 * Issue 659: the folder-trust question in plain words.
 *
 * What happened: an agent's start stopped at its runtime's "Do you trust
 * the files in this folder?" question, and Den showed nothing; after a No
 * it showed only "exited (1)".
 *
 *   1. While the question is on its screen, the agent's row (and so its
 *      pane) says "Waiting: trust this folder?", it counts as waiting,
 *      and the bell has a "needs you" item saying so.
 *   2. After an exit that came from declining it, the row, `agents list`
 *      and the bell say "Didn't start: this folder isn't trusted. Resume
 *      and choose Yes."
 *   3. Answered Yes: the wait and its bell item go.
 *
 * Den looks at the screen (trustTick), never types the answer: it is the
 * person's. A real host on a temp socket and a scripted PTY: nothing
 * runs. Invented names only.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { readRecord } from "../../../src/shared/agents/records.js";
import * as ops from "../../../src/ui/cli/agent-ops.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { listedSessions } from "../../../src/ui/server/session-routes.js";
import { cleanupRigs, rig, settle, type Rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const ID = "be-dev";
const agents = (r: Rig, ...a: string[]) => cmdAgents(a, r.deps);
const rec = (r: Rig) => readRecord(r.stateDir, ID)!;

const TRUST =
  "\x1b[2J\x1b[HDo you trust the files in this folder?\r\n\r\n" +
  "  /work/north/notes\r\n\r\n" +
  "❯ 1. Yes, proceed\r\n  2. No, exit\r\n\r\nEnter to confirm · Esc to cancel\r\n";

const WAITING = "Waiting: trust this folder?";
const DECLINED =
  "Didn't start: this folder isn't trusted. Resume and choose Yes.";

function bell(r: Rig): Array<Record<string, unknown>> {
  const f = path.join(r.stateDir, "notifications.json");
  if (!fs.existsSync(f)) return [];
  return (
    JSON.parse(fs.readFileSync(f, "utf-8")) as {
      items: Array<Record<string, unknown>>;
    }
  ).items.filter((n) => n.subject === `agent:${ID}`);
}

async function jsonRow(r: Rig): Promise<Record<string, unknown>> {
  r.out.length = 0;
  expect(await agents(r, "list", "-w", "north", "--json")).toBe(0);
  return (JSON.parse(r.out.join("\n")) as Array<Record<string, unknown>>)[0];
}

async function listedRow(r: Rig) {
  const c = await r.deps.connect!();
  const sessions = await c.list();
  c.close();
  return listedSessions(sessions, {
    stateDir: () => r.stateDir,
    dist: () => "acme",
    activeWorkspaces: () => ["north"],
  }).find((x) => x.agent === ID)!;
}

/** Started; its runtime asks whether to trust the folder. */
async function asking(r: Rig) {
  r.deps.env = {
    ...r.deps.env,
    CLAUDE_CONFIG_DIR: path.join(r.dir, "claude-config"),
  };
  expect(await agents(r, "start", "-w", "north", "--persona", ID)).toBe(0);
  const p = r.made[r.made.length - 1];
  p.emit(TRUST);
  await settle();
  return { p, d: ops.resolveAgentsDeps(r.deps) };
}

describe("issue 659, clause 1: the question on screen", () => {
  it("the row, the page's list and the bell say Waiting: trust this folder?", async () => {
    const r = await rig();
    const { d } = await asking(r);
    const ev = await ops.trustTick(d);
    expect(ev).toEqual([
      expect.objectContaining({ kind: "waiting", agent: ID }),
    ]);
    expect((await jsonRow(r)).trustWait).toBe(true);
    // The Agents page's list: waiting, and why (its row and its pane).
    const row = await listedRow(r);
    expect(row.waiting).toBe(true);
    expect(row.waitingWhy).toBe("trust");
    // The bell: one "needs you" item, in plain words.
    const items = bell(r);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "waiting",
      msg: { key: "bell.m.trust" },
    });
    expect(String(items[0].text)).toContain(WAITING);
    r.out.length = 0;
    expect(await agents(r, "list", "-w", "north")).toBe(0);
    expect(r.out.join("\n")).toContain(WAITING);
    // Looked at again: said once.
    expect(await ops.trustTick(d)).toEqual([]);
    expect(bell(r)).toHaveLength(1);
  }, 30_000);

  it("answered Yes: the wait and its bell item go", async () => {
    const r = await rig();
    const { p, d } = await asking(r);
    await ops.trustTick(d);
    p.emit("\x1b[2J\x1b[H╭ Claude Code ╮\r\n> \r\n");
    await settle();
    expect(await ops.trustTick(d)).toEqual([
      expect.objectContaining({ kind: "answered", agent: ID }),
    ]);
    expect((await jsonRow(r)).trustWait).toBeUndefined();
    expect((await listedRow(r)).waiting).toBeUndefined();
    expect(bell(r)).toHaveLength(0);
  }, 30_000);
});

describe("issue 659, clause 2: after a No", () => {
  it("the row, agents list and the bell say why it didn't start", async () => {
    const r = await rig();
    const { p, d } = await asking(r);
    await ops.trustTick(d);
    p.exit(1);
    await settle();
    expect(await ops.trustTick(d)).toEqual([
      expect.objectContaining({ kind: "declined", agent: ID }),
    ]);
    const row = await jsonRow(r);
    expect(row.state).toBe("exited (1)");
    expect(row.trustDeclined).toBe(true);
    expect(row.resumable).toBe(true);
    r.out.length = 0;
    expect(await agents(r, "list", "-w", "north")).toBe(0);
    expect(r.out.join("\n")).toContain(DECLINED);
    const items = bell(r);
    expect(items.map((n) => (n.msg as { key: string }).key)).toEqual([
      "bell.m.trustDeclined",
    ]);
    expect(String(items[0].text)).toContain(DECLINED);
    expect(rec(r).trustAsked).toBeUndefined();
  }, 30_000);

  it("a No between two looks (never seen waiting): still said, once", async () => {
    const r = await rig();
    const { p, d } = await asking(r);
    p.exit(1);
    await settle();
    expect((await ops.trustTick(d)).map((e) => e.kind)).toEqual(["declined"]);
    expect(await ops.trustTick(d)).toEqual([]);
    expect((await jsonRow(r)).trustDeclined).toBe(true);
  }, 30_000);

  it("its next start clears it", async () => {
    const r = await rig();
    const { p, d } = await asking(r);
    p.exit(1);
    await settle();
    await ops.trustTick(d);
    expect(await agents(r, "resume", ID)).toBe(0);
    expect(rec(r).trustDeclined).toBeUndefined();
    expect((await jsonRow(r)).trustDeclined).toBeUndefined();
  }, 30_000);
});

describe("issue 659: the words, in en, es and ja", () => {
  const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
  function catalogs(): Record<string, Record<string, string>> {
    const window: Record<string, unknown> = {};
    const ctx = vm.createContext({
      window,
      document: {
        getElementById: () => null,
        documentElement: { lang: "en" },
        addEventListener: () => {},
      },
      Intl,
    });
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"])
      try {
        vm.runInContext(fs.readFileSync(path.join(PUBLIC, f), "utf-8"), ctx);
      } catch {
        /* shell.js stops at its first DOM use */
      }
    return window.denMessages as Record<string, Record<string, string>>;
  }

  it("the row's and the bell's words, in English and in every language", () => {
    const m = catalogs();
    expect(m.en["ag.waiting.trust"]).toBe(WAITING);
    expect(m.en["ag.why.trustDeclined"]).toBe(DECLINED);
    expect(m.en["bell.m.trust"]).toContain(WAITING);
    expect(m.en["bell.m.trustDeclined"]).toContain("{name}");
    for (const lang of ["es", "ja"])
      for (const k of [
        "ag.waiting.trust",
        "ag.why.trustDeclined",
        "bell.m.trust",
        "bell.m.trustDeclined",
      ]) {
        expect(m[lang][k]).toBeTruthy();
        expect(m[lang][k]).not.toBe(m.en[k]);
      }
  });
});
