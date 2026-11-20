/**
 * Issue 562: a security release doesn't wait on an open question. A
 * version marked `den.security: true` in its package.json (read from
 * npm's version data, never a tag or the changelog) updates while the
 * server agent waits on its person's question or permission prompt. It
 * still never goes past a pending Allow, and never restarts mid-turn.
 * Unmarked versions wait as before. server_agent.security_update_skips_questions
 * (default true) turns it off.
 *
 * Fakes only: invented versions, a fake npm in a temp dir, never the real
 * registry.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  securityUpdateNote,
  updateCheck,
  type UpdateCheckDeps,
  type UpdateWait,
} from "../../../src/ui/server/update-check.js";
import {
  npmViewSecurity,
  parseSecurityMark,
} from "../../../src/ui/server/den-update.js";
import { readServerAgentConfig } from "../../../src/shared/den-config.js";

function fake(over: Partial<UpdateCheckDeps> = {}) {
  const notes: string[] = [];
  const asked: string[] = [];
  let wait: UpdateWait | null = "asked";
  let past: UpdateWait | null = null;
  let updates = 0;
  const d: UpdateCheckDeps = {
    running: () => "1.2.0",
    latest: async () => "1.3.0",
    pinned: () => "1.2.0",
    role: () => "lead",
    mode: () => "auto",
    cantUpdate: () => null,
    last: () => null,
    idle: async () => wait === null,
    waitWhy: async () => wait,
    waitPast: async () => past,
    waitChecks: () => 2,
    security: async (v) => {
      asked.push(v);
      return true;
    },
    securitySkipsQuestions: () => true,
    securityNote: (v, why) => notes.push(`security ${v} ${why}`),
    update: async () => {
      updates += 1;
      return { ok: true };
    },
    ask: () => true,
    notice: () => undefined,
    waitNote: (v, why) => notes.push(`wait ${v} ${why}`),
    waitDone: () => notes.push("wait done"),
    ...over,
  };
  return {
    d,
    notes,
    asked,
    setWait: (w: UpdateWait | null) => (wait = w),
    setPast: (w: UpdateWait | null) => (past = w),
    updates: () => updates,
  };
}

describe("a security release while the server agent waits on its person (issue 562)", () => {
  it("marked, the agent asked a question: it updates, and the bell says the question is still open", async () => {
    const f = fake();
    const t = await updateCheck(f.d).tick();
    expect(t).toMatchObject({
      did: "updating",
      version: "1.3.0",
      security: true,
    });
    expect(f.updates()).toBe(1);
    expect(f.asked).toEqual(["1.3.0"]);
    expect(f.notes).toContain("security 1.3.0 asked");
  });

  it("marked, the agent at a permission prompt: it updates", async () => {
    const f = fake();
    f.setWait("permission");
    const t = await updateCheck(f.d).tick();
    expect(t).toMatchObject({ did: "updating", version: "1.3.0" });
    expect(f.updates()).toBe(1);
    expect(f.notes).toContain("security 1.3.0 permission");
  });

  it("unmarked, the agent asked a question: it waits, as today", async () => {
    const f = fake({ security: async () => false });
    const t = await updateCheck(f.d).tick();
    expect(t).toMatchObject({ did: "waiting", wait: "asked" });
    expect(f.updates()).toBe(0);
    expect(f.notes.some((n) => n.startsWith("security"))).toBe(false);
  });

  it("marked, the mark unreadable (null): unmarked, it waits", async () => {
    const f = fake({ security: async () => null });
    expect(await updateCheck(f.d).tick()).toMatchObject({ did: "waiting" });
    expect(f.updates()).toBe(0);
  });

  it("marked, an Allow pending: it waits (with or without a question too)", async () => {
    const f = fake();
    f.setWait("approval");
    const c = updateCheck(f.d);
    expect(await c.tick()).toMatchObject({ did: "waiting", wait: "approval" });
    f.setWait("asked");
    f.setPast("approval");
    expect(await c.tick()).toMatchObject({ did: "waiting", wait: "approval" });
    expect(f.updates()).toBe(0);
  });

  it("marked, mid-turn with server_agent.security_update_skips_busy off: it waits for idle, then updates", async () => {
    const f = fake({ securitySkipsBusy: () => false });
    f.setWait("busy");
    const c = updateCheck(f.d);
    expect(await c.tick()).toMatchObject({ did: "waiting", wait: "busy" });
    f.setWait("asked");
    f.setPast("busy");
    expect(await c.tick()).toMatchObject({ did: "waiting", wait: "busy" });
    expect(f.updates()).toBe(0);
    f.setPast(null);
    expect(await c.tick()).toMatchObject({ did: "updating" });
    expect(f.updates()).toBe(1);
  });

  it("server_agent.security_update_skips_questions off: it waits", async () => {
    const f = fake({ securitySkipsQuestions: () => false });
    expect(await updateCheck(f.d).tick()).toMatchObject({
      did: "waiting",
      wait: "asked",
    });
    expect(f.updates()).toBe(0);
  });

  it("no waitPast to ask: it waits (never guesses past a person)", async () => {
    const f = fake({ waitPast: undefined });
    expect(await updateCheck(f.d).tick()).toMatchObject({ did: "waiting" });
    expect(f.updates()).toBe(0);
  });

  it("an idle agent never needs npm's mark", async () => {
    const f = fake();
    f.setWait(null);
    expect(await updateCheck(f.d).tick()).toMatchObject({ did: "updating" });
    expect(f.asked).toEqual([]);
    expect(f.notes.some((n) => n.startsWith("security"))).toBe(false);
  });
});

describe("issue 603: a security release doesn't wait for a busy agent", () => {
  /** The update's calls, and the log lines. */
  function rig(over: Partial<UpdateCheckDeps> = {}) {
    const calls: { v: string; security: boolean }[] = [];
    const logs: string[] = [];
    const f = fake({
      update: async (v, _reason, o) => {
        calls.push({ v, security: !!o?.security });
        return { ok: true };
      },
      log: (l) => void logs.push(l),
      ...over,
    });
    f.setWait("busy");
    return { ...f, calls, logs };
  }

  it("marked, mid-turn: it installs at this pass, on the security path", async () => {
    const f = rig();
    const t = await updateCheck(f.d).tick();
    expect(t).toMatchObject({
      did: "updating",
      version: "1.3.0",
      security: true,
    });
    // The security path: the restart reads waitPast again and holds for
    // the turn's end (holdRestart).
    expect(f.calls).toEqual([{ v: "1.3.0", security: true }]);
    expect(f.logs.some((l) => /waits:/.test(l))).toBe(false);
    // The audit line says it went ahead while the agent was busy.
    expect(
      f.logs.filter((l) =>
        /Den 1\.3\.0 is a security release: it updates while the Den agent is in the middle of a turn; the restart waits for the turn to end/.test(
          l,
        ),
      ),
    ).toHaveLength(1);
    // No "question still open" bell: there is no question.
    expect(f.notes.some((n) => n.startsWith("security"))).toBe(false);
  });

  it("marked, the agent asked a question and is working past it: it installs too", async () => {
    const f = rig();
    f.setWait("asked");
    f.setPast("busy");
    expect(await updateCheck(f.d).tick()).toMatchObject({
      did: "updating",
      security: true,
    });
    expect(f.calls).toEqual([{ v: "1.3.0", security: true }]);
  });

  it("unmarked, mid-turn: it waits, as today", async () => {
    const f = rig({ security: async () => false });
    const t = await updateCheck(f.d).tick();
    expect(t).toMatchObject({ did: "waiting", wait: "busy" });
    expect(f.calls).toEqual([]);
    expect(f.logs).toEqual([
      "update check: Den 1.3.0 waits: the Den agent is in the middle of a turn",
    ]);
  });

  it("server_agent.security_update_skips_busy off: a security release waits on a busy agent", async () => {
    const f = rig({ securitySkipsBusy: () => false });
    expect(await updateCheck(f.d).tick()).toMatchObject({
      did: "waiting",
      wait: "busy",
    });
    expect(f.calls).toEqual([]);
  });

  it("the setting unreadable: it waits (never guesses past a turn)", async () => {
    const f = rig({
      securitySkipsBusy: () => {
        throw new Error("bad config");
      },
    });
    expect(await updateCheck(f.d).tick()).toMatchObject({ did: "waiting" });
    expect(f.calls).toEqual([]);
  });

  it("the mark unreadable (null): unmarked, it waits", async () => {
    const f = rig({ security: async () => null });
    expect(await updateCheck(f.d).tick()).toMatchObject({ did: "waiting" });
    expect(f.calls).toEqual([]);
  });

  it("a wait read that fails is not a turn: it waits", async () => {
    const f = rig({
      waitWhy: async () => {
        throw new Error("no answer");
      },
    });
    expect(await updateCheck(f.d).tick()).toMatchObject({ did: "waiting" });
    expect(f.calls).toEqual([]);
  });

  it("only idle() to ask (no reason): it waits", async () => {
    const f = rig({ waitWhy: undefined, idle: async () => false });
    expect(await updateCheck(f.d).tick()).toMatchObject({ did: "waiting" });
    expect(f.calls).toEqual([]);
  });

  it("an Allow pending or an update under way still holds it", async () => {
    for (const w of ["approval", "updating"] as const) {
      const f = rig();
      f.setWait(w);
      expect(await updateCheck(f.d).tick()).toMatchObject({
        did: "waiting",
        wait: w,
      });
      expect(f.calls).toEqual([]);
    }
  });
});

describe("the security bell item", () => {
  it("names the agent and the version, with its key for es and ja", () => {
    const added: Record<string, unknown>[] = [];
    securityUpdateNote(
      { add: (n: Record<string, unknown>) => void added.push(n) } as never,
      "Den",
      "server",
      "1.3.0",
    );
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      text: "Den updated for a security fix while server was waiting on you; its question is still open",
      msg: {
        key: "bell.m.updatedSecurity",
        vars: { agent: "server", v: "1.3.0" },
      },
    });
  });

  it("its words are in en, es and ja", () => {
    const pub = path.join(process.cwd(), "src", "ui", "server", "public");
    for (const f of ["shell.js", "i18n/es.js", "i18n/ja.js"])
      expect(fs.readFileSync(path.join(pub, f), "utf8")).toMatch(
        /"bell\.m\.updatedSecurity":/,
      );
  });
});

describe("the mark, from npm's version data only", () => {
  it("den.security true is marked; anything else is not", () => {
    expect(parseSecurityMark('{"security": true}')).toBe(true);
    expect(parseSecurityMark("")).toBe(false); // no `den` in the version
    expect(parseSecurityMark('{"security": false}')).toBe(false);
    expect(parseSecurityMark('{"security": "true"}')).toBe(false);
    expect(parseSecurityMark("{}")).toBe(false);
    expect(parseSecurityMark("not json")).toBe(false);
    expect(parseSecurityMark("[true]")).toBe(false);
  });

  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0))
      fs.rmSync(d, { recursive: true, force: true });
  });
  /** A fake npm: logs its argv, prints `out`, exits `code`. */
  function fakeNpm(out: string, code = 0) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-562-"));
    dirs.push(dir);
    const log = path.join(dir, "argv.json");
    const script = path.join(dir, "npm.js");
    fs.writeFileSync(
      script,
      `require("fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));` +
        `process.stdout.write(${JSON.stringify(out)});process.exit(${code});`,
    );
    return { npm: [process.execPath, script], dir, log };
  }

  it("asks npm for that version's `den` field", async () => {
    const f = fakeNpm('{\n  "security": true\n}\n');
    expect(await npmViewSecurity(f.npm, "@scope/pkg", "1.3.0", f.dir)).toBe(
      true,
    );
    expect(JSON.parse(fs.readFileSync(f.log, "utf8"))).toEqual([
      "view",
      "@scope/pkg@1.3.0",
      "den",
      "--json",
    ]);
  });

  it("registry data without `den`: unmarked", async () => {
    const f = fakeNpm("");
    expect(await npmViewSecurity(f.npm, "@scope/pkg", "1.3.0", f.dir)).toBe(
      false,
    );
  });

  it("npm fails: can't tell (null), which counts as unmarked", async () => {
    const f = fakeNpm("npm ERR! 404", 1);
    expect(
      await npmViewSecurity(f.npm, "@scope/pkg", "1.3.0", f.dir),
    ).toBeNull();
  });

  it("a version that isn't one is never asked about", async () => {
    const f = fakeNpm('{"security": true}');
    expect(
      await npmViewSecurity(f.npm, "@scope/pkg", "latest", f.dir),
    ).toBeNull();
    expect(fs.existsSync(f.log)).toBe(false);
  });
});

describe("server_agent.security_update_skips_busy (issue 603)", () => {
  it("defaults to true; false turns it off; anything else names the key", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "den-603c-"));
    try {
      expect(readServerAgentConfig({}, root, {}).securityUpdateSkipsBusy).toBe(
        true,
      );
      expect(
        readServerAgentConfig(
          { server_agent: { security_update_skips_busy: false } },
          root,
          {},
        ).securityUpdateSkipsBusy,
      ).toBe(false);
      expect(() =>
        readServerAgentConfig(
          { server_agent: { security_update_skips_busy: "no" as never } },
          root,
          {},
        ),
      ).toThrow(/server_agent\.security_update_skips_busy/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("is in the docs beside security_update_skips_questions", () => {
    const doc = fs.readFileSync(
      path.join(process.cwd(), "docs", "distributions.md"),
      "utf8",
    );
    expect(doc).toMatch(/`server_agent\.security_update_skips_busy`/);
  });
});

describe("server_agent.security_update_skips_questions", () => {
  it("defaults to true; false turns it off; anything else names the key", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "den-562c-"));
    try {
      expect(
        readServerAgentConfig({}, root, {}).securityUpdateSkipsQuestions,
      ).toBe(true);
      expect(
        readServerAgentConfig(
          { server_agent: { security_update_skips_questions: false } },
          root,
          {},
        ).securityUpdateSkipsQuestions,
      ).toBe(false);
      expect(() =>
        readServerAgentConfig(
          { server_agent: { security_update_skips_questions: "no" as never } },
          root,
          {},
        ),
      ).toThrow(/server_agent\.security_update_skips_questions/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
