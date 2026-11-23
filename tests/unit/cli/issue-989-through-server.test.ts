/**
 * Issue 989 (sandbox, slice 3): a person-only CLI verb goes through the
 * running server, so the server's person check is its boundary, not the
 * CLI's own. With the server answering, the server makes the change and
 * the CLI writes nothing; a refusal is said and nothing is written (never
 * a fall back to writing it here); with no server answering, the CLI
 * writes as before (inside the agent sandbox, issue 936, an agent's
 * direct write is refused).
 *
 * A fake server records each call. Invented names.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import * as http from "http";
import {
  personServerFor,
  throughServer,
  type PersonServer,
  type ServerAnswer,
} from "../../../src/ui/cli/person-server.js";
import { writeRotation } from "../../../src/shared/agents/rotation.js";
import { agentFilesDir } from "../../../src/shared/agents/records.js";
import { cleanupRigs, rig, type Rig } from "../agents/helpers/rig.js";
import { sandboxFor } from "../../../src/shared/agents/sandbox.js";

afterEach(async () => {
  await cleanupRigs();
});

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A server that answers `answer` to every call, and logs them. */
function fake(answer: ServerAnswer | null): {
  server: PersonServer;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    server: async (method, p, body) => {
      calls.push({ method, path: p, body });
      return answer;
    },
  };
}

const agents = (r: Rig, server: PersonServer, ...args: string[]) =>
  cmdAgents(args, { ...r.deps, server, loginPath: async () => {} });
const recordFile = (r: Rig, id: string) =>
  path.join(r.stateDir, "agents", `${id}.json`);
const record = (r: Rig, id: string) =>
  JSON.parse(fs.readFileSync(recordFile(r, id), "utf-8")) as Record<
    string,
    unknown
  >;

async function withAgent(): Promise<Rig> {
  const r = await rig();
  const packs = path.join(r.dir, "personas");
  fs.mkdirSync(packs, { recursive: true });
  fs.writeFileSync(
    path.join(packs, "peer.md"),
    "---\nname: peer\n---\nYou help.\n",
  );
  r.config.personaPacks = ["personas"];
  const started = await agents(
    r,
    async () => null,
    "start",
    "-w",
    "north",
    "--persona",
    "peer",
    "--id",
    "scout",
  );
  expect({ started, err: r.err }).toEqual({ started: 0, err: [] });
  return r;
}

describe("issue 989: throughServer", () => {
  it("the server's answer when it agrees; a refusal throws its error; null when none answered", async () => {
    expect(
      await throughServer(
        fake({ status: 200, json: { ok: true, a: 1 } }).server,
        "POST",
        "/x",
        {},
      ),
    ).toEqual({ ok: true, a: 1 });
    await expect(
      throughServer(
        fake({ status: 403, json: { ok: false, error: "only a person can" } })
          .server,
        "POST",
        "/x",
        {},
      ),
    ).rejects.toThrow("only a person can");
    await expect(
      throughServer(fake({ status: 401, json: null }).server, "POST", "/x", {}),
    ).rejects.toThrow(/401/);
    // ok: false in a 200 is a refusal too.
    await expect(
      throughServer(
        fake({ status: 200, json: { ok: false, error: "no" } }).server,
        "POST",
        "/x",
        {},
      ),
    ).rejects.toThrow("no");
    expect(await throughServer(fake(null).server, "POST", "/x", {})).toBeNull();
  });
});

describe("issue 989: a test run never reaches this machine's Den", () => {
  it("under jest the default server answers none, unless DEN_PERSON_SERVER=on", async () => {
    let hits = 0;
    const srv = http.createServer((_q, res) => {
      hits++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    try {
      const env = { JEST_WORKER_ID: "1" };
      expect(
        await personServerFor(undefined, { env, port: () => port })(
          "POST",
          "/x",
          {},
        ),
      ).toBeNull();
      expect(hits).toBe(0);
      const on = { ...env, DEN_PERSON_SERVER: "on" };
      expect(
        await personServerFor(undefined, { env: on, port: () => port })(
          "POST",
          "/x",
          {},
        ),
      ).toEqual({ status: 200, json: { ok: true } });
      expect(hits).toBe(1);
    } finally {
      await new Promise<void>((r) => srv.close(() => r()));
    }
  });
});

describe("issue 989: the person token never leaves this machine", () => {
  for (const bind of ["192.0.2.1", "den.example.com", "[2001:db8::1]"]) {
    it(`DEN_BIND_HOST=${bind}: refused before anything is sent`, async () => {
      const sent: string[] = [];
      const server = personServerFor(undefined, {
        env: { DEN_PERSON_SERVER: "on", DEN_BIND_HOST: bind },
        port: () => 7777,
        fetch: async (u) => {
          sent.push(String(u));
          return new Response("{}");
        },
      });
      await expect(
        server("POST", "/api/agents/signin-token", { token: "x" }),
      ).rejects.toThrow(/not this machine's address/);
      expect(sent).toEqual([]);
    });
  }
  for (const bind of ["", "0.0.0.0", "127.0.0.1", "127.0.0.2", "::1"]) {
    it(`DEN_BIND_HOST="${bind}": a loopback address is dialed`, async () => {
      const sent: string[] = [];
      const server = personServerFor(undefined, {
        env: { DEN_PERSON_SERVER: "on", DEN_BIND_HOST: bind },
        port: () => 7777,
        fetch: async (u) => {
          sent.push(String(u));
          return new Response(JSON.stringify({ ok: true }));
        },
      });
      expect(await server("POST", "/x", {})).toEqual({
        status: 200,
        json: { ok: true },
      });
      expect(sent).toHaveLength(1);
    });
  }
  it("an address on one of this machine's interfaces is dialed", async () => {
    const sent: string[] = [];
    const server = personServerFor(undefined, {
      env: { DEN_PERSON_SERVER: "on", DEN_BIND_HOST: "100.64.0.7" },
      port: () => 7777,
      localAddresses: () => ["100.64.0.7"],
      fetch: async (u) => {
        sent.push(String(u));
        return new Response(JSON.stringify({ ok: true }));
      },
    });
    await server("POST", "/x", {});
    expect(sent).toEqual(["http://100.64.0.7:7777/x"]);
  });
});

describe("issue 989: an agent is still refused before any server call", () => {
  it("agents permission in an agent's session, under a test run: refused, nothing written, no call", async () => {
    const r = await withAgent();
    const before = fs.readFileSync(recordFile(r, "scout"), "utf-8");
    const f = fake({ status: 200, json: { ok: true } });
    const code = await cmdAgents(["permission", "scout", "all"], {
      ...r.deps,
      env: {
        ...r.deps.env,
        JEST_WORKER_ID: "1",
        DEN_ACTOR_TOKEN_FILE: "/x/token",
      },
      server: f.server,
      loginPath: async () => {},
    }).catch(() => 1);
    expect(code).not.toBe(0);
    expect(f.calls).toEqual([]);
    expect(fs.readFileSync(recordFile(r, "scout"), "utf-8")).toBe(before);
  });
});

describe("issue 989: agents permission <id> goes through the server", () => {
  it("with the server answering, the server sets it and the CLI writes nothing", async () => {
    const r = await withAgent();
    const before = fs.readFileSync(recordFile(r, "scout"), "utf-8");
    const f = fake({
      status: 200,
      json: { ok: true, agent: "scout", mode: "edits" },
    });
    expect(await agents(r, f.server, "permission", "scout", "edits")).toBe(0);
    expect(f.calls).toEqual([
      {
        method: "POST",
        path: "/api/workspaces/north/agents/scout/mode",
        body: { mode: "edits" },
      },
    ]);
    expect(fs.readFileSync(recordFile(r, "scout"), "utf-8")).toBe(before);
    expect(r.out.at(-1)).toContain("scout: edits");
  });

  it("--clear sends null", async () => {
    const r = await withAgent();
    const f = fake({
      status: 200,
      json: { ok: true, agent: "scout", mode: null },
    });
    expect(await agents(r, f.server, "permission", "scout", "--clear")).toBe(0);
    expect(f.calls[0].body).toEqual({ mode: null });
  });

  it("the server refusing (an agent's token, or no person token): said, and nothing is written here", async () => {
    const r = await withAgent();
    for (const answer of [
      {
        status: 403,
        json: { ok: false, error: "only a person can change an agent's mode" },
      },
      { status: 401, json: { ok: false, error: "sign in first" } },
    ]) {
      const before = fs.readFileSync(recordFile(r, "scout"), "utf-8");
      const f = fake(answer);
      expect(await agents(r, f.server, "permission", "scout", "all")).not.toBe(
        0,
      );
      expect(fs.readFileSync(recordFile(r, "scout"), "utf-8")).toBe(before);
      expect(record(r, "scout").overrides ?? []).not.toContain("permission");
      expect(r.err.join("\n")).toContain(String(answer.json.error));
    }
  });

  it("no server answering: the CLI sets it as before", async () => {
    const r = await withAgent();
    const f = fake(null);
    expect(await agents(r, f.server, "permission", "scout", "edits")).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(record(r, "scout")).toMatchObject({ permission: "edits" });
  });
});

describe("issue 989: agents permission -w <project> goes through the server", () => {
  it("with the server answering, the server sets it and the CLI saves nothing", async () => {
    const r = await rig();
    const f = fake({ status: 200, json: { ok: true, mode: "auto" } });
    expect(await agents(r, f.server, "permission", "-w", "north", "auto")).toBe(
      0,
    );
    expect(f.calls).toEqual([
      {
        method: "POST",
        path: "/api/workspaces/north/agent-modes",
        body: { mode: "auto" },
      },
    ]);
    expect(r.wsPermission.north).toBeUndefined();
  });

  it("a refusal is said and nothing is saved; no server: saved as before", async () => {
    const r = await rig();
    const no = fake({
      status: 403,
      json: { ok: false, error: "only a person can set a project's mode" },
    });
    expect(
      await agents(r, no.server, "permission", "-w", "north", "all"),
    ).not.toBe(0);
    expect(r.wsPermission.north).toBeUndefined();
    expect(
      await agents(r, fake(null).server, "permission", "-w", "north", "auto"),
    ).toBe(0);
    expect(r.wsPermission.north).toBe("auto");
  });
});

/** Everything a verb may write here: Den's state and the user config. */
function written(r: Rig): string {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) out.push(`${f}\n${fs.readFileSync(f, "utf-8")}`);
    }
  };
  walk(r.stateDir);
  walk(path.join(r.dir, "config"));
  return out.join("\n---\n");
}

describe("issue 989: keep, set and rotate go through the server", () => {
  const cases: {
    verb: string[];
    method: string;
    path: string;
    body: unknown;
    said: RegExp;
    /** Makes the verb's own write show (it is a no-op on a fresh agent). */
    prep?: (r: Rig) => Promise<void>;
  }[] = [
    {
      verb: ["keep", "scout"],
      method: "POST",
      path: "/api/workspaces/north/agents/scout/keep",
      body: { never: false },
      said: /kept scout's conversation/,
      prep: async (r) =>
        writeRotation(agentFilesDir(r.stateDir, "scout"), {
          compactions: 2,
          after: 3,
        }),
    },
    {
      verb: ["keep", "scout", "--never"],
      method: "POST",
      path: "/api/workspaces/north/agents/scout/keep",
      body: { never: true },
      said: /never rotates/,
    },
    {
      verb: ["set", "scout", "resume_on_restart", "off"],
      method: "POST",
      path: "/api/workspaces/north/agents/scout/settings",
      body: { resumeOnRestart: false },
      said: /doesn't resume/,
    },
    {
      verb: ["set", "scout", "resume_on_restart", "default"],
      method: "POST",
      path: "/api/workspaces/north/agents/scout/settings",
      body: { resumeOnRestart: null },
      said: /as its persona says/,
      prep: async (r) => {
        expect(
          await agents(
            r,
            fake(null).server,
            "set",
            "scout",
            "resume_on_restart",
            "on",
          ),
        ).toBe(0);
      },
    },
    {
      verb: ["rotate", "--agent", "scout", "after_compactions", "5"],
      method: "PUT",
      path: "/api/agents/rotation",
      body: {
        scope: "agent",
        target: "scout",
        key: "after_compactions",
        value: 5,
      },
      said: /after_compactions = 5 at agent scout/,
    },
    {
      verb: ["rotate", "--unset", "on_due"],
      method: "PUT",
      path: "/api/agents/rotation",
      body: { scope: "install", key: "on_due", value: null },
      said: /on_due cleared at this install/,
    },
  ];

  for (const c of cases) {
    it(`${c.verb.join(" ")}: the server makes it; a refusal writes nothing; no server: written here`, async () => {
      const r = await withAgent();
      await c.prep?.(r);
      const before = written(r);
      const yes = fake({ status: 200, json: { ok: true } });
      expect(await agents(r, yes.server, ...c.verb)).toBe(0);
      expect(yes.calls).toEqual([
        { method: c.method, path: c.path, body: c.body },
      ]);
      expect(written(r)).toBe(before);
      expect(r.out.at(-1)).toMatch(c.said);

      const no = fake({
        status: 403,
        json: { ok: false, error: "only a person can do that" },
      });
      expect(await agents(r, no.server, ...c.verb)).not.toBe(0);
      expect(written(r)).toBe(before);
      expect(r.err.join("\n")).toContain("only a person can do that");

      expect(await agents(r, fake(null).server, ...c.verb)).toBe(0);
      expect(written(r)).not.toBe(before);
    });
  }
});

describe("issue 989: restart, persona and move go through the server", () => {
  const started = {
    status: 200,
    json: {
      ok: true,
      agent: {
        id: "scout",
        persona: "peer",
        workspace: "north",
        cwd: "/w/north",
        session: "den-scout",
      },
    },
  };
  const pending = (extra: Record<string, unknown> = {}) => ({
    status: 202,
    json: { ok: true, agent: "scout", pending: true, ...extra },
  });
  const cases: {
    verb: string[];
    path: string;
    body: unknown;
    answer: ServerAnswer;
    said: RegExp;
  }[] = [
    {
      verb: ["restart", "scout"],
      path: "/api/workspaces/north/agents/scout/restart",
      body: { when: "after-turn" },
      answer: pending(),
      said: /scout restarts at its next idle/,
    },
    {
      verb: ["restart", "scout", "--now"],
      path: "/api/workspaces/north/agents/scout/restart",
      body: { when: "now" },
      answer: started,
      said: /restarted agent scout; same conversation, as den-scout in \/w\/north/,
    },
    {
      verb: ["persona", "scout", "planner", "--model", "m1"],
      path: "/api/workspaces/north/agents/scout/persona",
      body: { persona: "planner", model: "m1" },
      answer: started,
      said: /agent scout is now peer/,
    },
    {
      verb: ["persona", "scout", "planner", "--after-turn"],
      path: "/api/workspaces/north/agents/scout/persona",
      body: { persona: "planner", when: "after-turn" },
      answer: pending({ persona: "planner" }),
      said: /scout becomes planner at its next idle/,
    },
    {
      verb: ["move", "scout", "-w", "south"],
      path: "/api/workspaces/north/agents/scout/move",
      body: { to: "south", when: "after-turn" },
      answer: pending({ to: "south" }),
      said: /scout moves to south at its next idle/,
    },
    {
      verb: ["move", "scout", "-w", "south", "--now"],
      path: "/api/workspaces/north/agents/scout/move",
      body: { to: "south", when: "now" },
      answer: {
        status: 200,
        json: {
          ok: true,
          agent: "scout",
          from: "north",
          to: "south",
          resumed: true,
        },
      },
      said: /moved agent scout from north to south/,
    },
  ];

  for (const c of cases) {
    it(`${c.verb.join(" ")}: the server does it and audits it; a refusal changes nothing here`, async () => {
      const r = await withAgent();
      const before = written(r);
      const made = r.made.length;
      const yes = fake(c.answer);
      expect(await agents(r, yes.server, ...c.verb)).toBe(0);
      expect(yes.calls).toEqual([
        { method: "POST", path: c.path, body: c.body },
      ]);
      // Nothing written here, not even the CLI's own audit row; no session.
      expect(written(r)).toBe(before);
      expect(r.made.length).toBe(made);
      expect(r.out.join("\n")).toMatch(c.said);

      const no = fake({
        status: 403,
        json: { ok: false, error: "only a person can do that" },
      });
      expect(await agents(r, no.server, ...c.verb)).not.toBe(0);
      expect(written(r)).toBe(before);
      expect(r.made.length).toBe(made);
      expect(r.err.join("\n")).toContain("only a person can do that");
    });
  }
});

describe("issue 989: the agents' sign-in goes through the server", () => {
  const TOKEN = "fake-token-for-989-0123456789abcdef";
  /** The token deps: each local write is counted; the input is TOKEN. */
  function tokenRig(r: Rig, server: PersonServer) {
    const local = { saved: 0, cleared: 0 };
    const run = (...args: string[]) =>
      cmdAgents(args, {
        ...r.deps,
        server,
        loginPath: async () => {},
        tokenInput: async () => TOKEN,
        tokenSave: async () => {
          local.saved++;
          return { ref: "configured", store: "Local store" };
        },
        tokenClear: async () => {
          local.cleared++;
          return {
            cleared: true,
            how: "item",
            store: "Local store",
            refDropped: false,
          };
        },
        tokenDeps: {
          status: () => ({
            backend: "1password",
            label: "1Password",
            implicit: false,
            detect: { available: true },
          }),
        },
      } as Parameters<typeof cmdAgents>[1]);
    return { run, local };
  }
  const said = (r: Rig) => [...r.out, ...r.err].join("\n");

  it("token set: the server saves it, the CLI saves nothing; a refusal never prints the token", async () => {
    const r = await rig();
    const yes = fake({ status: 200, json: { ok: true, store: "Keychain" } });
    const t = tokenRig(r, yes.server);
    expect(await t.run("token", "set")).toBe(0);
    expect(yes.calls).toEqual([
      {
        method: "POST",
        path: "/api/agents/signin-token",
        body: { token: TOKEN },
      },
    ]);
    expect(t.local.saved).toBe(0);
    expect(r.out.at(-1)).toMatch(/saved in Keychain/);

    // A server that echoes it back: still never printed here.
    const no = fake({
      status: 500,
      json: { ok: false, error: `store said no to ${TOKEN}` },
    });
    const t2 = tokenRig(r, no.server);
    expect(await t2.run("token", "set")).not.toBe(0);
    expect(t2.local.saved).toBe(0);
    expect(r.err.join("\n")).toContain("store said no");
    expect(said(r)).not.toContain(TOKEN);

    const t3 = tokenRig(r, fake(null).server);
    expect(await t3.run("token", "set")).toBe(0);
    expect(t3.local.saved).toBe(1);
  });

  it("token clear: the server removes it; a refusal removes nothing; no server: removed here", async () => {
    const r = await rig();
    const yes = fake({ status: 200, json: { ok: true, cleared: true } });
    const t = tokenRig(r, yes.server);
    expect(await t.run("token", "clear", "--yes")).toBe(0);
    expect(yes.calls).toEqual([
      { method: "DELETE", path: "/api/agents/signin-token", body: undefined },
    ]);
    expect(t.local.cleared).toBe(0);
    expect(r.out.at(-1)).toMatch(/removed the agents' sign-in token/);

    const no = fake({
      status: 403,
      json: { ok: false, error: "only a person removes it" },
    });
    const t2 = tokenRig(r, no.server);
    expect(await t2.run("token", "clear", "--yes")).not.toBe(0);
    expect(t2.local.cleared).toBe(0);
    expect(r.err.join("\n")).toContain("only a person removes it");

    const t3 = tokenRig(r, fake(null).server);
    expect(await t3.run("token", "clear", "--yes")).toBe(0);
    expect(t3.local.cleared).toBe(1);
  });

  it("accounts add, order and set-token: the server makes each; nothing is written here", async () => {
    const r = await rig();
    // Two accounts made here first (no server), to order and to set.
    const local = tokenRig(r, fake(null).server);
    expect(await local.run("accounts", "add", "--name", "one")).toBe(0);
    expect(await local.run("accounts", "add", "--name", "two")).toBe(0);
    const before = written(r);

    const yes = fake({ status: 200, json: { ok: true, accounts: [] } });
    const t = tokenRig(r, yes.server);
    expect(await t.run("accounts", "add", "--name", "three")).toBe(0);
    expect(await t.run("accounts", "order", "two", "one")).toBe(0);
    expect(await t.run("accounts", "set-token", "one")).toBe(0);
    expect(written(r)).toBe(before);
    expect(yes.calls.map((c) => [c.method, c.path])).toEqual([
      ["POST", "/api/agents/accounts"],
      ["POST", "/api/agents/accounts/order"],
      ["POST", "/api/agents/accounts/token"],
    ]);
    expect(yes.calls[0].body).toEqual({ runtime: "den-claude", name: "three" });
    const order = (yes.calls[1].body as { order: string[] }).order;
    expect(order).toHaveLength(2);
    expect(yes.calls[2].body).toEqual({
      runtime: "den-claude",
      account: order[1],
      token: TOKEN,
    });
    expect(said(r)).not.toContain(TOKEN);

    const no = fake({ status: 403, json: { ok: false, error: "nope" } });
    expect(
      await tokenRig(r, no.server).run("accounts", "add", "--name", "four"),
    ).not.toBe(0);
    // A server that echoes the token sent: still never printed here.
    const echo = fake({
      status: 500,
      json: { ok: false, error: `nope ${TOKEN}` },
    });
    expect(
      await tokenRig(r, echo.server).run("accounts", "set-token", "one"),
    ).not.toBe(0);
    expect(written(r)).toBe(before);
    expect(said(r)).not.toContain(TOKEN);
  });
});

describe("issue 989: notifications read and clear go through the server", () => {
  const cases: { args: string[]; path: string; body: unknown; said: RegExp }[] =
    [
      {
        args: ["read"],
        path: "/api/notifications/read",
        body: { all: true },
        said: /Marked 3 read/,
      },
      {
        args: ["read", "n1"],
        path: "/api/notifications/read",
        body: { id: "n1" },
        said: /Marked 3 read/,
      },
      {
        args: ["clear", "-p", "north"],
        path: "/api/notifications/clear",
        body: { scope: "workspace/north" },
        said: /Cleared 3/,
      },
    ];
  for (const c of cases) {
    it(`notifications ${c.args.join(" ")}: the server changes the bell; a refusal changes nothing`, async () => {
      const { cmdNotifications } =
        await import("../../../src/ui/cli/notifications-command.js");
      const r = await rig();
      const run = (server: PersonServer) =>
        cmdNotifications(c.args, {
          stateDir: r.stateDir,
          env: {},
          server,
          out: (l) => r.out.push(l),
          err: (l) => r.err.push(l),
        });
      const before = written(r);
      const yes = fake({
        status: 200,
        json: { ok: true, changed: 3, unread: 0 },
      });
      expect(await run(yes.server)).toBe(0);
      expect(yes.calls).toEqual([
        { method: "POST", path: c.path, body: c.body },
      ]);
      expect(written(r)).toBe(before);
      expect(r.out.at(-1)).toMatch(c.said);

      const no = fake({
        status: 403,
        json: { ok: false, error: "The bell is the person's to change." },
      });
      expect(await run(no.server)).not.toBe(0);
      expect(written(r)).toBe(before);
      expect(r.err.join("\n")).toContain("The bell is the person's to change.");
    });
  }
});

describe("issue 989: web owner link and unlink go through the server", () => {
  /** A server answering each call with the next of `answers`. */
  function seq(answers: (ServerAnswer | null)[]) {
    const calls: Call[] = [];
    const server: PersonServer = async (method, p, body) => {
      calls.push({ method, path: p, body });
      return answers.shift() ?? null;
    };
    return { server, calls };
  }
  async function owner(args: string[], server: PersonServer) {
    const { cmdWebOwner } = await import("../../../src/ui/cli/web-command.js");
    const r = await rig();
    let out = "";
    let err = "";
    const code = await cmdWebOwner(args, {
      out: (s) => (out += s),
      err: (s) => (err += s),
      stateDir: r.stateDir,
      clientId: "Iv23liInvented",
      server,
      sleep: async () => {},
    });
    return { code, out, err, r };
  }

  it("unlink: the server forgets the owner; a refusal changes nothing", async () => {
    const yes = seq([{ status: 200, json: { ok: true, was: "octo" } }]);
    const a = await owner(["unlink"], yes.server);
    expect(a.code).toBe(0);
    expect(yes.calls).toEqual([
      { method: "POST", path: "/api/web/owner/unlink", body: {} },
    ]);
    expect(a.out).toMatch(/Unlinked @octo/);

    const no = seq([
      { status: 403, json: { ok: false, error: "sign in to approve" } },
    ]);
    const b = await owner(["unlink"], no.server);
    expect(b.code).not.toBe(0);
    expect(b.err).toContain("sign in to approve");
  });

  it("link: the server runs GitHub's device flow; the CLI shows its code and waits for its outcome", async () => {
    const pending = {
      ok: true,
      id: "f1",
      state: "pending",
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    };
    const s = seq([
      { status: 200, json: pending },
      { status: 200, json: pending },
      { status: 200, json: { ok: true, id: "f1", state: "ok", login: "octo" } },
    ]);
    const a = await owner(["link"], s.server);
    expect(a.code).toBe(0);
    expect(s.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /api/web/owner/link",
      "GET /api/web/owner/link/f1",
      "GET /api/web/owner/link/f1",
    ]);
    expect(a.out).toContain("ABCD-1234");
    expect(a.out).toMatch(/Linked @octo/);
    // The server keeps the owner; nothing is written here.
    expect(fs.existsSync(path.join(a.r.stateDir, "web-owner.json"))).toBe(
      false,
    );
  });

  it("link: an expired or refused flow is said, exit not 0", async () => {
    const s = seq([
      {
        status: 200,
        json: { ok: true, id: "f2", state: "pending", userCode: "WXYZ-0000" },
      },
      {
        status: 200,
        json: {
          ok: false,
          id: "f2",
          state: "expired",
          error: "The code expired before it was approved. Start again.",
        },
      },
    ]);
    const a = await owner(["link"], s.server);
    expect(a.code).not.toBe(0);
    expect(a.err).toContain("The code expired");
  });
});

describe("issue 989: gate end and gate box go through the server", () => {
  async function gate(server: PersonServer, dir: string) {
    const { GateStore } = await import("../../../src/shared/gates/store.js");
    const { cmdGate } = await import("../../../src/ui/cli/gate-command.js");
    const store = new GateStore({ dir, alive: () => true });
    const out: string[] = [];
    const err: string[] = [];
    const run = (...args: string[]) =>
      cmdGate(args, {
        store,
        env: {},
        server,
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        now: Date.now,
        sleep: () => Promise.resolve(),
        exec: () => ({ pid: 1, kill: () => {}, done: Promise.resolve(0) }),
        every: () => () => {},
        onSignal: () => () => {},
        exit: () => {},
        pid: 4242,
        cwd: "/tmp/repo",
      });
    return { run, out, err, store };
  }
  const snap = (dir: string) =>
    fs
      .readdirSync(dir)
      .sort()
      .map((f) => `${f}\n${fs.readFileSync(path.join(dir, f), "utf-8")}`)
      .join("\n---\n");

  const cases: { args: string[]; path: string; body: unknown; said: RegExp }[] =
    [
      {
        args: ["end", "slot-1"],
        path: "/api/gate-slots/end",
        body: { id: "slot-1" },
        said: /Ended slot-1/,
      },
      {
        args: [
          "box",
          "add",
          "box1",
          "--playwright",
          "ws://10.0.0.9:3000/",
          "--slots",
          "2",
        ],
        path: "/api/gate-slots/boxes",
        body: {
          box: expect.objectContaining({
            name: "box1",
            playwright: "ws://10.0.0.9:3000/",
            browser_slots: 2,
          }),
        },
        said: /Box box1 set: 2 browser slots/,
      },
      {
        args: ["box", "remove", "box1"],
        path: "/api/gate-slots/boxes/remove",
        body: { name: "box1" },
        said: /Removed box box1/,
      },
      {
        args: ["box", "disable", "box1"],
        path: "/api/gate-slots/boxes/enable",
        body: { name: "box1", enabled: false },
        said: /Box box1 turned off/,
      },
    ];
  for (const c of cases) {
    it(`gate ${c.args.slice(0, 2).join(" ")}: the server changes it; a refusal changes nothing`, async () => {
      const r = await rig();
      const dir = path.join(r.dir, "gate");
      fs.mkdirSync(dir, { recursive: true });
      const yes = fake({
        status: 200,
        json: { ok: true, boxes: [], slots: [] },
      });
      const g = await gate(yes.server, dir);
      const before = snap(dir);
      expect(await g.run(...c.args)).toBe(0);
      expect(yes.calls).toEqual([
        { method: "POST", path: c.path, body: c.body },
      ]);
      expect(snap(dir)).toBe(before);
      expect(g.out.at(-1)).toMatch(c.said);

      const no = fake({
        status: 403,
        json: { ok: false, error: "only a person can do that" },
      });
      const g2 = await gate(no.server, dir);
      expect(await g2.run(...c.args)).not.toBe(0);
      expect(snap(dir)).toBe(before);
      expect(g2.err.join("\n")).toContain("only a person can do that");

      // No server: the CLI changes the store itself (a box to change, a
      // slot to end, first).
      const g3 = await gate(fake(null).server, dir);
      g3.store.setBox({
        name: "box1",
        playwright: "ws://10.0.0.9:3000/",
        browser_slots: 1,
      });
      const held = g3.store.ask({
        kind: "browser",
        who: "w",
        label: "l",
        pid: 1,
        estimateMin: 5,
      });
      const args = c.args[0] === "end" ? ["end", held.id] : c.args;
      expect(await g3.run(...args)).toBe(0);
      expect(g3.err).toEqual([]);
    });
  }
});

describe("issue 989: hub link goes through the server", () => {
  async function hubLink(args: string[], server: PersonServer) {
    const { cmdHubLink } =
      await import("../../../src/ui/cli/hub-link-command.js");
    const out: string[] = [];
    const err: string[] = [];
    const writes: unknown[] = [];
    const code = await cmdHubLink(args, {
      env: {},
      server,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      resolveProject: (t) => (t === "north" ? "north" : null),
      read: () => null,
      write: (ws, link) => writes.push([ws, link]),
      choices: async () => ({
        suggestions: [],
        projects: [{ id: "h1", slug: "atlas", name: "Atlas" }],
      }),
    });
    return { code, out, err, writes };
  }

  it("a link or --none: the server sets it; a refusal sets nothing; no server: set here", async () => {
    const yes = fake({
      status: 200,
      json: {
        ok: true,
        project: "north",
        hub: { id: "h1", slug: "atlas", name: "Atlas" },
      },
    });
    const a = await hubLink(["-p", "north", "atlas"], yes.server);
    expect(a.code).toBe(0);
    expect(yes.calls).toEqual([
      {
        method: "PUT",
        path: "/api/workspaces/north/hub-project",
        body: { hub: "atlas" },
      },
    ]);
    expect(a.writes).toEqual([]);
    expect(a.out.join("\n")).toMatch(/Atlas/);

    const none = fake({
      status: 200,
      json: { ok: true, project: "north", hub: null },
    });
    const b = await hubLink(["-p", "north", "--none"], none.server);
    expect(b.code).toBe(0);
    expect(none.calls[0].body).toEqual({ hub: null });
    expect(b.writes).toEqual([]);

    const no = fake({
      status: 403,
      json: {
        ok: false,
        error: "Linking a project to Hub is a person's ask; an agent can't.",
      },
    });
    const c = await hubLink(["-p", "north", "atlas"], no.server);
    expect(c.code).not.toBe(0);
    expect(c.writes).toEqual([]);
    expect(c.err.join("\n")).toContain("a person's ask");

    const d = await hubLink(["-p", "north", "atlas"], fake(null).server);
    expect(d.code).toBe(0);
    expect(d.writes).toHaveLength(1);
  });
});

describe("issue 989: workspace create, activate, deactivate and delete go through the server", () => {
  const cases: {
    verb: "create" | "activate" | "deactivate" | "delete";
    method: string;
    path: string;
    body: unknown;
  }[] = [
    {
      verb: "create",
      method: "POST",
      path: "/api/workspaces/create",
      body: { name: "atlas" },
    },
    {
      verb: "activate",
      method: "POST",
      path: "/api/workspaces",
      body: { name: "atlas", action: "activate" },
    },
    {
      verb: "deactivate",
      method: "POST",
      path: "/api/workspaces",
      body: { name: "atlas", action: "deactivate" },
    },
    {
      verb: "delete",
      method: "DELETE",
      path: "/api/workspaces",
      body: { name: "atlas", cleanupDirectory: true },
    },
  ];
  for (const c of cases) {
    it(`workspace ${c.verb}: the server's answer is final; no server: done here`, async () => {
      const { workspaceViaServer } =
        await import("../../../src/ui/cli/workspace-person.js");
      const yes = fake({ status: 200, json: { ok: true, slug: "atlas" } });
      expect(await workspaceViaServer(c.verb, "atlas", yes.server)).toEqual({
        kind: "done",
        json: { ok: true, slug: "atlas" },
      });
      expect(yes.calls).toEqual([
        { method: c.method, path: c.path, body: c.body },
      ]);

      const no = fake({
        status: 403,
        json: { ok: false, error: "only a person makes projects" },
      });
      expect(await workspaceViaServer(c.verb, "atlas", no.server)).toEqual({
        kind: "refused",
        error: "only a person makes projects",
      });
      expect(
        await workspaceViaServer(c.verb, "atlas", fake(null).server),
      ).toEqual({
        kind: "unanswered",
      });
    });
  }

  it("an agent's session is refused before anything, server or not", async () => {
    const { workspacePersonRefusal } =
      await import("../../../src/ui/cli/workspace-person.js");
    expect(
      workspacePersonRefusal("create", { DEN_ACTOR_TOKEN_FILE: "/x/t" }),
    ).toMatch(/only a person/i);
    expect(workspacePersonRefusal("create", {})).toBeNull();
  });
});

describe("issue 989: an agent can't reset projects with workspace seed or init", () => {
  const agent = { DEN_ACTOR_TOKEN_FILE: "/x/t" };
  it("--reset in an agent's session: refused before anything", async () => {
    const { seedResetRefusal } =
      await import("../../../src/ui/cli/workspace-person.js");
    for (const via of ["workspace seed", "init"] as const)
      expect(
        seedResetRefusal({ reset: true, willReset: false, via }, agent),
      ).toMatch(new RegExp(`only a person can reset.*${via}`, "i"));
  });
  it("a reset by the prompt (entries there, no --reset) in an agent's session: refused too", async () => {
    const { seedResetRefusal } =
      await import("../../../src/ui/cli/workspace-person.js");
    expect(
      seedResetRefusal(
        { reset: false, willReset: true, via: "workspace seed" },
        agent,
      ),
    ).toMatch(/only a person can reset/i);
  });
  it("a plain seed (nothing to reset) by an agent, and any seed by a person: allowed", async () => {
    const { seedResetRefusal } =
      await import("../../../src/ui/cli/workspace-person.js");
    expect(
      seedResetRefusal(
        { reset: false, willReset: false, via: "workspace seed" },
        agent,
      ),
    ).toBeNull();
    for (const o of [
      { reset: true, willReset: true },
      { reset: false, willReset: true },
      { reset: true, willReset: false },
    ])
      expect(seedResetRefusal({ ...o, via: "init" }, {})).toBeNull();
  });
});

/**
 * Issue 989 with the agent sandbox (issue 936): an agent that clears its
 * token variables looks like a person to the CLI, and with no server
 * answering the CLI writes the change itself. In the sandbox that write
 * fails and nothing changes. Outside it the same command writes, so the
 * sandbox is what stops it.
 */
const sandboxTool =
  (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) ||
  (process.platform === "linux" &&
    spawnSync("bwrap", ["--dev-bind", "/", "/", "true"]).status === 0);
const itSandbox = sandboxTool ? it : it.skip;

describe("issue 989: in the agent sandbox, with no server", () => {
  const ENGINE = path.resolve(__dirname, "../../..");
  function install() {
    const base = fs.realpathSync(fs.mkdtempSync("/tmp/dsb9-"));
    const l = {
      base,
      stateDir: path.join(base, "state"),
      distRoot: path.join(base, "root"),
      gateDir: path.join(base, "gate"),
      agentId: "a1",
    };
    for (const d of [
      l.stateDir,
      path.join(l.distRoot, "config", "local"),
      l.gateDir,
    ])
      fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(l.distRoot, "den.yml"), "name: t\n");
    fs.writeFileSync(
      path.join(l.distRoot, "config", "local", "user.yml"),
      "local_dev: true\n",
    );
    // No server: nothing listens on port 1.
    fs.writeFileSync(path.join(l.stateDir, "web.json"), '{"port":1}\n');
    return l;
  }
  /** An agent's env with its token variables cleared. */
  function clearedEnv(l: ReturnType<typeof install>): NodeJS.ProcessEnv {
    const e: NodeJS.ProcessEnv = {
      ...process.env,
      DEN_HOME: l.stateDir,
      DEN_ROOT: l.distRoot,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    };
    delete e.DEN_ACTOR_TOKEN_FILE;
    delete e.DEN_ACTOR_TOKEN;
    delete e.DEN_AGENT;
    return e;
  }
  const argv = [path.join(ENGINE, "bin", "den"), "workspace", "create", "sbx"];
  const wsFile = (l: ReturnType<typeof install>) =>
    path.join(l.distRoot, "config", "local", "workspaces.yml");

  itSandbox(
    "a project write fails in the sandbox, and nothing is written",
    () => {
      const l = install();
      try {
        const w = sandboxFor(argv, l, { platform: process.platform, on: true });
        expect(w.applied).toBe(true);
        const r = spawnSync(w.argv[0], w.argv.slice(1), {
          encoding: "utf-8",
          env: { ...clearedEnv(l), ...w.env },
          timeout: 60_000,
        });
        expect(r.status).not.toBe(0);
        expect(`${r.stdout}${r.stderr}`).toMatch(
          /EPERM|EROFS|not permitted|read-only file system/,
        );
        expect(`${r.stdout}${r.stderr}`).not.toMatch(/Created project/);
        expect(fs.existsSync(wsFile(l))).toBe(false);
      } finally {
        fs.rmSync(l.base, { recursive: true, force: true });
      }
    },
    90_000,
  );

  it("outside the sandbox the same command writes (the control)", () => {
    const l = install();
    try {
      const r = spawnSync(argv[0], argv.slice(1), {
        encoding: "utf-8",
        env: clearedEnv(l),
        timeout: 60_000,
      });
      expect(r.status).toBe(0);
      expect(fs.readFileSync(wsFile(l), "utf-8")).toMatch(/sbx/);
    } finally {
      fs.rmSync(l.base, { recursive: true, force: true });
    }
  }, 90_000);
});
