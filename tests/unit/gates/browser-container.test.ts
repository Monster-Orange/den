/**
 * Gate: on macOS a browser slot needs a container browser. A browser
 * started on a shared Mac (host WebKit) can take its window server down,
 * and every login session with it. So a browser-kind ask there declares
 * where its browser runs: a container's Playwright server (ws:// or
 * wss://), or "self" (the run starts its own container). One rule
 * (shared/gates/browser-container.ts), called by `gate run`, the MCP tool
 * gate_slot_request and the runners' HTTP ask. A Setting turns it off.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  BROWSER_ENDPOINT_VARS,
  BROWSER_WORDS,
  browserSlotCheck,
  browserSlotRefusal,
  checkBrowserEndpoint,
  endpointFromEnv,
} from "../../../src/shared/gates/browser-container.js";
import { RunnerTokens } from "../../../src/shared/gates/runner-tokens.js";
import { GateStore, checkGatePatch } from "../../../src/shared/gates/store.js";
import { gateView } from "../../../src/shared/gates/view.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";
import { callTool, type ToolContext } from "../../../src/ui/mcp/tools.js";
import type { DenApi } from "../../../src/ui/mcp/api.js";
import { handleGateRoutes } from "../../../src/ui/server/gate-routes.js";
import {
  checkRequest,
  setPrincipal,
} from "../../../src/ui/server/request-guard.js";

const tmps: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise<void>((r) => s.close(() => r()));
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate-browser-"));
  tmps.push(d);
  return d;
};

const mac = (over: { requires?: boolean } = {}) => ({
  platform: "darwin" as const,
  ...(over.requires !== undefined ? { requiresContainer: over.requires } : {}),
});

describe("the rule", () => {
  it("macOS, a browser ask with no endpoint: refused", () => {
    expect(browserSlotCheck({ kind: "browser", ...mac() })).toEqual({
      ok: false,
      code: "browser_needs_container",
    });
  });

  it("macOS, a ws:// or wss:// endpoint: allowed, and what is recorded is the address without its path", () => {
    expect(
      browserSlotCheck({
        kind: "browser",
        endpoint: "ws://127.0.0.1:3000/a1b2c3",
        ...mac(),
      }),
    ).toEqual({ ok: true, declared: "ws://127.0.0.1:3000" });
    expect(
      browserSlotCheck({
        kind: "browser",
        endpoint: "wss://pw.example.test",
        ...mac(),
      }),
    ).toEqual({ ok: true, declared: "wss://pw.example.test" });
  });

  it('macOS, "self" (the run starts its own container): allowed, recorded as self', () => {
    expect(
      browserSlotCheck({ kind: "browser", endpoint: "self", ...mac() }),
    ).toEqual({ ok: true, declared: "self" });
  });

  it("not macOS: allowed with no endpoint", () => {
    expect(browserSlotCheck({ kind: "browser", platform: "linux" })).toEqual({
      ok: true,
    });
    expect(browserSlotCheck({ kind: "browser", platform: "win32" })).toEqual({
      ok: true,
    });
  });

  it("the setting off: allowed on macOS; on elsewhere: refused there too", () => {
    expect(
      browserSlotCheck({ kind: "browser", ...mac({ requires: false }) }),
    ).toEqual({ ok: true });
    expect(
      browserSlotCheck({
        kind: "browser",
        platform: "linux",
        requiresContainer: true,
      }),
    ).toMatchObject({ ok: false, code: "browser_needs_container" });
  });

  it("a cpu ask never needs one", () => {
    expect(browserSlotCheck({ kind: "cpu", ...mac() })).toEqual({ ok: true });
  });

  it("a run for a named test box uses that box's browser: allowed", () => {
    expect(
      browserSlotCheck({ kind: "browser", where: "box-1", ...mac() }),
    ).toEqual({ ok: true });
    // Issue 1198: "any" with none declared waits for a box only (a box's
    // browser is a container); it never lands on this machine.
    expect(
      browserSlotCheck({
        kind: "browser",
        where: "any",
        boxCouldServe: true,
        ...mac(),
      }),
    ).toEqual({ ok: true, boxesOnly: true });
    // No box could ever take it: refused at once, as before.
    expect(
      browserSlotCheck({ kind: "browser", where: "any", ...mac() }),
    ).toMatchObject({ ok: false, code: "browser_needs_container" });
  });

  it.each([
    "http://127.0.0.1:3000",
    "127.0.0.1:3000",
    "ws://",
    "ws:// spaced",
    "file:///tmp/x",
    "",
  ])("a bad endpoint (%p) is refused, anywhere, saying so", (endpoint) => {
    for (const platform of ["darwin", "linux"] as const)
      expect(
        browserSlotCheck({ kind: "browser", endpoint, platform }),
      ).toMatchObject({ ok: false, code: "browser_endpoint_bad" });
  });

  it("checkBrowserEndpoint: ws, wss and self only", () => {
    expect(checkBrowserEndpoint("ws://localhost:3000/")).toBeNull();
    expect(checkBrowserEndpoint("self")).toBeNull();
    expect(checkBrowserEndpoint("http://localhost:3000")).toMatch(/ws:\/\//);
  });

  it("the run's environment: the first of DEN_PW_WS, HUB_PW_WEBKIT_WS, E2E_WEBKIT_WS that is set", () => {
    expect(BROWSER_ENDPOINT_VARS).toEqual([
      "DEN_PW_WS",
      "HUB_PW_WEBKIT_WS",
      "E2E_WEBKIT_WS",
    ]);
    expect(endpointFromEnv({})).toBeUndefined();
    expect(endpointFromEnv({ E2E_WEBKIT_WS: "ws://h:1" })).toEqual({
      endpoint: "ws://h:1",
      from: "E2E_WEBKIT_WS",
    });
    // A good one wins over a bad one set before it.
    expect(
      endpointFromEnv({ DEN_PW_WS: "nope", HUB_PW_WEBKIT_WS: "wss://h" }),
    ).toEqual({ endpoint: "wss://h", from: "HUB_PW_WEBKIT_WS" });
    // Only bad ones: the first, so the refusal names it.
    expect(endpointFromEnv({ DEN_PW_WS: "nope", E2E_WEBKIT_WS: " " })).toEqual({
      endpoint: "nope",
      from: "DEN_PW_WS",
    });
  });

  it("the refusal names every way out, in en, es and ja", () => {
    for (const lang of ["en", "es", "ja"] as const) {
      const cli = browserSlotRefusal(
        { ok: false, code: "browser_needs_container" },
        { lang, surface: "cli", cli: "acme" },
      );
      for (const v of BROWSER_ENDPOINT_VARS) expect(cli).toContain(v);
      expect(cli).toContain("--browser-endpoint");
      expect(cli).toContain("--browser-endpoint=self");
      expect(cli).toContain(
        "acme gate settings --browser-requires-container 0",
      );
      const field = browserSlotRefusal(
        { ok: false, code: "browser_needs_container" },
        { lang, surface: "field", cli: "acme" },
      );
      expect(field).toContain("browser_endpoint");
      expect(field).toContain('"self"');
      expect(field).toContain("--browser-requires-container 0");
    }
  });

  it("es and ja have every en line, with the same placeholders", () => {
    const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
    for (const lang of ["es", "ja"] as const) {
      expect(Object.keys(BROWSER_WORDS[lang]).sort()).toEqual(
        Object.keys(BROWSER_WORDS.en).sort(),
      );
      for (const [k, v] of Object.entries(BROWSER_WORDS.en))
        expect(ph(BROWSER_WORDS[lang][k as keyof typeof v])).toEqual(ph(v));
    }
  });
});

describe("the setting", () => {
  it("defaults on for a macOS host and off elsewhere; 0 or 1 turns it", () => {
    const m = new GateStore({ dir: tmp(), platform: "darwin" });
    const l = new GateStore({ dir: tmp(), platform: "linux" });
    expect(m.settings().browserRequiresContainer).toBe(true);
    expect(l.settings().browserRequiresContainer).toBe(false);
    const c = checkGatePatch({ browser_requires_container: 0 });
    expect(c.ok).toBe(true);
    if (c.ok) m.writeSettings(c.patch);
    expect(m.settings().browserRequiresContainer).toBe(false);
    expect(checkGatePatch({ browser_requires_container: 2 }).ok).toBe(false);
  });
});

function deps(platform: NodeJS.Platform, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ran: { argv: string[]; env?: Record<string, string> }[] = [];
  const d: GateDeps = {
    store: new GateStore({ dir: tmp(), alive: () => true, platform }),
    env,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: Date.now,
    sleep: () => Promise.resolve(),
    exec: (cmd, args, e) => {
      ran.push({ argv: [cmd, ...args], ...(e ? { env: e } : {}) });
      return { pid: 5151, kill: () => {}, done: Promise.resolve(0) };
    },
    every: () => () => {},
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd: "/x/some-repo",
    lang: "en",
  };
  return { d, out, err, ran };
}

describe("gate run (the CLI)", () => {
  const browserRun = ["run", "--kind", "browser", "--", "npm", "test"];

  it("macOS, no endpoint: refused before asking, exit 2, naming the ways out", async () => {
    const { d, err, ran } = deps("darwin");
    expect(await cmdGate(browserRun, d)).toBe(2);
    expect(ran).toEqual([]);
    expect(d.store.list()).toEqual([]);
    expect(err.join("\n")).toContain("DEN_PW_WS");
    expect(err.join("\n")).toContain("--browser-endpoint=self");
    expect(err.join("\n")).toContain("--browser-requires-container 0");
  });

  it("macOS, an endpoint in the run's environment: runs", async () => {
    const { d, ran } = deps("darwin", { E2E_WEBKIT_WS: "ws://127.0.0.1:3000" });
    expect(await cmdGate(browserRun, d)).toBe(0);
    expect(ran.map((r) => r.argv)).toEqual([["npm", "test"]]);
  });

  it("macOS, --browser-endpoint ws://…: runs, and the run gets it as DEN_PW_WS", async () => {
    const { d, ran } = deps("darwin");
    expect(
      await cmdGate(
        [
          "run",
          "--kind",
          "browser",
          "--browser-endpoint",
          "ws://127.0.0.1:3000/x",
          "--",
          "npm",
          "test",
        ],
        d,
      ),
    ).toBe(0);
    expect(ran[0]!.env).toMatchObject({ DEN_PW_WS: "ws://127.0.0.1:3000/x" });
  });

  it("macOS, --browser-endpoint=self: runs; status shows it was declared", async () => {
    const { d, ran } = deps("darwin");
    let seen: string[] = [];
    d.exec = (cmd, args) => {
      ran.push({ argv: [cmd, ...args] });
      seen = d.store.list().map((e) => e.browserEndpoint ?? "");
      const st: string[] = [];
      void cmdGate(["status"], { ...d, out: (l) => st.push(l) });
      seen.push(...st);
      return { pid: 5151, kill: () => {}, done: Promise.resolve(0) };
    };
    expect(
      await cmdGate(
        ["run", "--kind=browser", "--browser-endpoint=self", "--", "x"],
        d,
      ),
    ).toBe(0);
    expect(seen[0]).toBe("self");
    expect(seen.join("\n")).toMatch(/browser self/);
  });

  it("a bad endpoint is refused, naming where it came from", async () => {
    const a = deps("linux");
    expect(
      await cmdGate(
        [
          "run",
          "--kind",
          "browser",
          "--browser-endpoint",
          "http://h:1",
          "--",
          "x",
        ],
        a.d,
      ),
    ).toBe(2);
    expect(a.err.join("\n")).toContain("--browser-endpoint");
    const b = deps("darwin", { DEN_PW_WS: "localhost:3000" });
    expect(await cmdGate(browserRun, b.d)).toBe(2);
    expect(b.err.join("\n")).toContain("DEN_PW_WS");
  });

  it("not macOS, or the setting off: runs with no endpoint", async () => {
    const l = deps("linux");
    expect(await cmdGate(browserRun, l.d)).toBe(0);
    const m = deps("darwin");
    m.d.store.writeSettings({ browser_requires_container: 0 });
    expect(await cmdGate(browserRun, m.d)).toBe(0);
  });

  it("gate settings shows and changes it", async () => {
    const { d, out } = deps("darwin");
    expect(
      await cmdGate(["settings", "--browser-requires-container", "0"], d),
    ).toBe(0);
    expect(out.join("\n")).toContain("browser runs need a container: no");
    expect(d.store.settings().browserRequiresContainer).toBe(false);
  });
});

const api: DenApi = {
  baseUrl: "http://localhost:47003",
  async get(p: string) {
    if (p === "/api/workspaces")
      return { active: ["north"], workspaces: { north: {} } };
    throw new Error(`no API call expected: ${p}`);
  },
  async stream() {
    throw new Error("no streams here");
  },
} as unknown as DenApi;

function mcpCtx(platform: NodeJS.Platform): ToolContext {
  return {
    api,
    cfg: {
      actions: [],
      runTestsEnvs: ["local"],
      logsRemote: false,
      approvals: true,
    } as unknown as ToolContext["cfg"],
    cli: "acme",
    scope: { workspace: "north", actor: "agent:coder" },
    gates: new GateStore({ dir: tmp(), alive: () => true, platform }),
  };
}

describe("gate_slot_request (MCP)", () => {
  it("macOS, no endpoint: refused, naming browser_endpoint and self", async () => {
    const c = mcpCtx("darwin");
    const r = await callTool("gate_slot_request", { kind: "browser" }, c);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/browser_endpoint[\s\S]*"self"/);
    expect(c.gates!.list()).toEqual([]);
  });

  it("macOS, browser_endpoint ws:// or self: granted, and recorded", async () => {
    const c = mcpCtx("darwin");
    const r = await callTool(
      "gate_slot_request",
      { kind: "browser", browser_endpoint: "self" },
      c,
    );
    expect(JSON.parse(r.text)).toMatchObject({
      granted: true,
      browserEndpoint: "self",
    });
    const c2 = mcpCtx("darwin");
    const r2 = await callTool(
      "gate_slot_request",
      { kind: "browser", browser_endpoint: "wss://pw.test:3000/k" },
      c2,
    );
    expect(JSON.parse(r2.text)).toMatchObject({
      granted: true,
      browserEndpoint: "wss://pw.test:3000",
    });
  });

  it("a bad endpoint is refused; not macOS needs none", async () => {
    const bad = await callTool(
      "gate_slot_request",
      { kind: "browser", browser_endpoint: "http://x:1" },
      mcpCtx("linux"),
    );
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/ws:\/\//);
    const r = await callTool(
      "gate_slot_request",
      { kind: "browser" },
      mcpCtx("linux"),
    );
    expect(JSON.parse(r.text)).toMatchObject({ granted: true });
  });
});

describe("the runners' HTTP ask", () => {
  async function serve(platform: NodeJS.Platform) {
    const store = new GateStore({ dir: tmp(), alive: () => true, platform });
    const tokens = RunnerTokens.at(tmp());
    const server = http.createServer((req, res) => {
      req.headers.host = "localhost:41299";
      const g = checkRequest(req, {
        port: 41299,
        loopbackNames: ["localhost", "127.0.0.1", "[::1]"],
        edgeHosts: () => [],
        verifyBearer: () => null,
        verifyRunner: (tok) => {
          const c = tokens.check(tok);
          return c.ok ? c.runner : null;
        },
      });
      if (!g.ok) {
        res.writeHead(g.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: false, code: g.code }));
        return;
      }
      setPrincipal(req, g.principal);
      const p = new URL(req.url ?? "/", "http://localhost").pathname;
      void handleGateRoutes(req, res, p, {
        store: () => store,
        title: "Acme",
        runners: () => tokens,
        pollMs: 20,
        audit: (() => ({})) as never,
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { token } = tokens.create("ci-a");
    const ask = async (body: Record<string, unknown>) => {
      const r = await fetch(base + "/api/gate-slots/ask", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ estimate_minutes: 5, wait_seconds: 0, ...body }),
      });
      return {
        status: r.status,
        json: (await r.json()) as Record<string, unknown>,
      };
    };
    return { store, ask };
  }

  it("macOS, no endpoint: 400 browser_needs_container; self or ws://: granted and recorded", async () => {
    const { store, ask } = await serve("darwin");
    const no = await ask({ kind: "browser" });
    expect(no.status).toBe(400);
    expect(no.json).toMatchObject({
      ok: false,
      code: "browser_needs_container",
    });
    expect(String(no.json.error)).toContain("browser_endpoint");
    const self = await ask({ kind: "browser", browserEndpoint: "self" });
    expect(self.json).toMatchObject({ ok: true, granted: true });
    expect(
      gateView(store).slots.find((s) => s.id === self.json.id),
    ).toMatchObject({ browserEndpoint: "self" });
    const bad = await ask({ kind: "browser", browser_endpoint: "http://x:1" });
    expect(bad.json).toMatchObject({ code: "browser_endpoint_bad" });
  });

  it("not macOS: a browser ask needs none", async () => {
    const { ask } = await serve("linux");
    expect((await ask({ kind: "browser" })).json).toMatchObject({ ok: true });
  });
});
