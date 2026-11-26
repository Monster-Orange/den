/**
 * Gate: a declared browser endpoint that is really the host's own browser
 * does not pass while browser runs need a container.
 *
 * A ws:// address on loopback, or on one of the host's own addresses,
 * reaches a Playwright server started on this machine unless a container
 * publishes that port. So while the Setting needs a container, such an
 * address passes only when a running container publishes its port. And
 * on the strict level (browser_requires_container 2), "self" (the run
 * says it starts its own container, which the gate can't check before it
 * starts) is refused too.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  BROWSER_WORDS,
  browserSlotCheck,
  browserSlotRefusal,
  dockerCandidates,
  dockerEnv,
  isHostAddress,
  normalizeAddress,
  parsePublished,
} from "../../../src/shared/gates/browser-container.js";
import { GateStore, checkGatePatch } from "../../../src/shared/gates/store.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";
import { callTool, type ToolContext } from "../../../src/ui/mcp/tools.js";
import type { DenApi } from "../../../src/ui/mcp/api.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-gate-host-ep-"));
  tmps.push(d);
  return d;
};

// The new refusals are for strict installs (personal ones stay open).
const mac = {
  platform: "darwin" as const,
  requiresContainer: true,
  mode: "strict" as const,
};
const none: readonly { address: string; port: number }[] = [];
const any3000 = [{ address: "0.0.0.0", port: 3000 }];

describe("which addresses are the host", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "app.localhost",
    "127.0.0.1",
    "127.1.2.3",
    "0.0.0.0",
    "[::1]",
    "[::]",
    "[::ffff:127.0.0.1]",
    "[::ffff:7f00:1]",
    "[::7f00:1]",
    "::127.0.0.1",
    "localhost.",
    "127.0.0.1.",
    "100.64.0.9",
  ])("%p is the host", (h) => {
    expect(isHostAddress(h, ["100.64.0.9"])).toBe(true);
  });

  it.each(["pw.example.test", "10.1.2.3", "[fd00::1]", "localhost.example"])(
    "%p is not",
    (h) => {
      expect(isHostAddress(h, ["100.64.0.9"])).toBe(false);
    },
  );
});

describe("docker's published bindings", () => {
  it("reads each binding's host address and port", () => {
    expect(
      parsePublished(
        [
          "0.0.0.0:3000->3000/tcp, [::]:3000->3000/tcp",
          "127.0.0.1:9222->3000/tcp",
          ":::8080->80/tcp",
          "5432/tcp",
          "",
          "0.0.0.0:7000-7001->7000-7001/tcp",
        ].join("\n"),
      ),
    ).toEqual([
      { address: "0.0.0.0", port: 3000 },
      { address: "::", port: 3000 },
      { address: "127.0.0.1", port: 9222 },
      { address: "::", port: 8080 },
      { address: "0.0.0.0", port: 7000 },
      { address: "0.0.0.0", port: 7001 },
    ]);
  });

  it("normalizes addresses: brackets, trailing dot, IPv4 in IPv6", () => {
    expect(normalizeAddress("[::FFFF:7f00:1]")).toBe("127.0.0.1");
    expect(normalizeAddress("[::7f00:1]")).toBe("127.0.0.1");
    expect(normalizeAddress("LocalHost.")).toBe("localhost");
    expect(normalizeAddress("[::1]")).toBe("::1");
  });

  it("docker's environment: no DOCKER_HOST, DOCKER_CONTEXT or DOCKER_CONFIG; HOME is the account's", () => {
    const env = dockerEnv(
      {
        DOCKER_HOST: "unix:///w/fake.sock",
        DOCKER_CONTEXT: "fake",
        DOCKER_CONFIG: "/w/cfg",
        HOME: "/w",
        PATH: "/w/bin:/usr/bin",
        LANG: "en_US.UTF-8",
      },
      "/Users/real",
    );
    expect(env.DOCKER_HOST).toBeUndefined();
    expect(env.DOCKER_CONTEXT).toBeUndefined();
    expect(env.DOCKER_CONFIG).toBeUndefined();
    expect(env.HOME).toBe("/Users/real");
    expect(env.PATH).toBe("/usr/bin:/bin");
    expect(env.LANG).toBe("en_US.UTF-8");
  });

  it("docker's candidates follow the account's home, not $HOME", () => {
    // A child with a fake HOME (jest's process.env never reaches os).
    const r = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        'import { dockerCandidates } from "./src/shared/gates/browser-container.ts"; console.log(JSON.stringify(dockerCandidates()));',
      ],
      {
        cwd: path.join(__dirname, "../../.."),
        env: {
          ...process.env,
          // A checkout's own node_modules sets no DEN_ROOT (tests/setup.ts),
          // and a -e child has no entry script to walk up from.
          DEN_ROOT: path.join(__dirname, "../../.."),
          HOME: "/w/fake-home",
          TSX_DISABLE_CACHE: "1",
        },
        encoding: "utf8",
      },
    );
    expect(r.status).toBe(0);
    const c = JSON.parse(r.stdout.trim().split("\n").pop()!) as string[];
    expect(c.length).toBeGreaterThan(0);
    expect(c.some((p) => p.startsWith("/w/"))).toBe(false);
  }, 30_000);

  it("docker is looked for in system folders first, never by bare name", () => {
    const c = dockerCandidates("/home/x");
    expect(c[0]).toBe("/usr/local/bin/docker");
    expect(c.every((p) => p.startsWith("/"))).toBe(true);
    expect(c.at(-1)).toBe("/home/x/.orbstack/bin/docker");
  });
});

describe("the rule", () => {
  it("needs a container: a loopback ws:// no container publishes is refused", () => {
    for (const endpoint of [
      "ws://127.0.0.1:3000/x",
      "ws://localhost:3000",
      "wss://[::1]:3000",
      "ws://0.0.0.0:3000",
    ])
      expect(
        browserSlotCheck({
          kind: "browser",
          endpoint,
          ...mac,
          published: none,
        }),
      ).toEqual({ ok: false, code: "browser_endpoint_host" });
  });

  it("an address of the host's own is refused the same way", () => {
    expect(
      browserSlotCheck({
        kind: "browser",
        endpoint: "ws://100.64.0.9:3000",
        ...mac,
        hostAddresses: ["100.64.0.9"],
        published: none,
      }),
    ).toEqual({ ok: false, code: "browser_endpoint_host" });
  });

  it("unknown which ports containers publish: refused (not proven)", () => {
    expect(
      browserSlotCheck({
        kind: "browser",
        endpoint: "ws://127.0.0.1:3000",
        ...mac,
      }),
    ).toEqual({ ok: false, code: "browser_endpoint_host" });
  });

  it("a container publishes the port: allowed, recorded", () => {
    expect(
      browserSlotCheck({
        kind: "browser",
        endpoint: "ws://127.0.0.1:3000/x",
        ...mac,
        published: any3000,
      }),
    ).toEqual({ ok: true, declared: "ws://127.0.0.1:3000" });
    // A default port counts as its number.
    expect(
      browserSlotCheck({
        kind: "browser",
        endpoint: "ws://localhost/x",
        ...mac,
        published: [
          { address: "0.0.0.0", port: 80 },
          { address: "::", port: 80 },
        ],
      }),
    ).toMatchObject({ ok: true });
  });

  it("a remote address needs no proof", () => {
    expect(
      browserSlotCheck({
        kind: "browser",
        endpoint: "wss://pw.example.test:3000",
        ...mac,
        resolved: ["203.0.113.5"],
        published: none,
      }),
    ).toMatchObject({ ok: true });
  });

  it("the setting off: a loopback ws:// passes as before", () => {
    expect(
      browserSlotCheck({
        kind: "browser",
        endpoint: "ws://127.0.0.1:3000",
        platform: "darwin",
        requiresContainer: false,
        published: none,
      }),
    ).toMatchObject({ ok: true });
  });

  it("a trailing dot is still loopback", () => {
    expect(
      browserSlotCheck({
        kind: "browser",
        endpoint: "ws://localhost.:5000",
        ...mac,
        published: none,
      }),
    ).toEqual({ ok: false, code: "browser_endpoint_host" });
  });

  it("a name that resolves to this machine is refused; one that doesn't resolve too", () => {
    for (const resolved of [["127.0.0.1"], ["203.0.113.5", "100.64.0.9"], []])
      expect(
        browserSlotCheck({
          kind: "browser",
          endpoint: "ws://den.example.test:5000",
          ...mac,
          hostAddresses: ["100.64.0.9"],
          resolved,
          published: none,
        }),
      ).toEqual({ ok: false, code: "browser_endpoint_host" });
    expect(
      browserSlotCheck({
        kind: "browser",
        endpoint: "ws://den.example.test:5000",
        ...mac,
        published: none,
      }),
    ).toEqual({ ok: false, code: "browser_endpoint_host" });
  });

  it("a binding on one address covers only that address", () => {
    const only = [{ address: "127.0.0.1", port: 9222 }];
    const ask = (endpoint: string) =>
      browserSlotCheck({
        kind: "browser",
        endpoint,
        ...mac,
        hostAddresses: ["192.168.1.20"],
        published: only,
      });
    expect(ask("ws://127.0.0.1:9222")).toMatchObject({ ok: true });
    expect(ask("ws://[::ffff:7f00:1]:9222")).toMatchObject({ ok: true });
    expect(ask("ws://[::1]:9222")).toMatchObject({ ok: false });
    expect(ask("ws://192.168.1.20:9222")).toMatchObject({ ok: false });
    // localhost stands for both loopbacks: ::1 isn't covered.
    expect(ask("ws://localhost:9222")).toMatchObject({ ok: false });
  });

  it("0.0.0.0 covers IPv4 host addresses only; :: covers both", () => {
    const v6 = (address: string) =>
      browserSlotCheck({
        kind: "browser",
        endpoint: "ws://[::1]:3000",
        ...mac,
        published: [{ address, port: 3000 }],
      });
    expect(v6("0.0.0.0")).toMatchObject({ ok: false });
    expect(v6("::")).toMatchObject({ ok: true });
    for (const address of ["0.0.0.0", "::"])
      expect(
        browserSlotCheck({
          kind: "browser",
          endpoint: "ws://192.168.1.20:3000",
          ...mac,
          hostAddresses: ["192.168.1.20"],
          published: [{ address, port: 3000 }],
        }),
      ).toMatchObject({ ok: true });
  });

  it("a personal install: endpoints pass as before, ws://localhost and self on level 2 included", () => {
    const personal = { ...mac, mode: "personal" as const };
    for (const endpoint of [
      "ws://localhost:3000",
      "ws://127.0.0.1:9222",
      "ws://den.example.test:5000",
    ])
      expect(
        browserSlotCheck({
          kind: "browser",
          endpoint,
          ...personal,
          published: none,
        }),
      ).toMatchObject({ ok: true });
    expect(
      browserSlotCheck({
        kind: "browser",
        endpoint: "self",
        ...personal,
        strict: true,
      }),
    ).toEqual({ ok: true, declared: "self" });
    // The container rule itself still holds: no endpoint is refused.
    expect(browserSlotCheck({ kind: "browser", ...personal })).toMatchObject({
      ok: false,
      code: "browser_needs_container",
    });
  });

  it("no mode given (unreadable): strict", () => {
    expect(
      browserSlotCheck({
        kind: "browser",
        endpoint: "ws://localhost:3000",
        platform: "darwin",
        requiresContainer: true,
        published: none,
      }),
    ).toEqual({ ok: false, code: "browser_endpoint_host" });
  });

  it('strict: "self" is refused; on the plain level it still passes', () => {
    expect(
      browserSlotCheck({
        kind: "browser",
        endpoint: "self",
        ...mac,
        strict: true,
      }),
    ).toEqual({ ok: false, code: "browser_self_strict" });
    expect(
      browserSlotCheck({ kind: "browser", endpoint: "self", ...mac }),
    ).toEqual({ ok: true, declared: "self" });
  });

  it("the two refusals say what to do, in en, es and ja", () => {
    for (const lang of ["en", "es", "ja"] as const) {
      const host = browserSlotRefusal(
        { ok: false, code: "browser_endpoint_host" },
        { lang, surface: "cli", cli: "acme", value: "ws://127.0.0.1:3000" },
      );
      expect(host).toContain("ws://127.0.0.1:3000");
      expect(host).not.toMatch(/\{\w+\}/);
      const strict = browserSlotRefusal(
        { ok: false, code: "browser_self_strict" },
        { lang, surface: "field", cli: "acme" },
      );
      expect(strict).toContain("--browser-requires-container 1");
      expect(strict).not.toMatch(/\{\w+\}/);
    }
    expect(Object.keys(BROWSER_WORDS.es).sort()).toEqual(
      Object.keys(BROWSER_WORDS.en).sort(),
    );
  });
});

describe("the setting's strict level", () => {
  it("2 is strict, 1 is on, 0 is off; 3 is refused", () => {
    const m = new GateStore({ dir: tmp(), platform: "darwin" });
    expect(m.settings().browserContainerStrict).toBe(false);
    for (const [v, on, strict] of [
      [2, true, true],
      [1, true, false],
      [0, false, false],
    ] as const) {
      const c = checkGatePatch({ browser_requires_container: v });
      expect(c.ok).toBe(true);
      if (c.ok) m.writeSettings(c.patch);
      expect(m.settings().browserRequiresContainer).toBe(on);
      expect(m.settings().browserContainerStrict).toBe(strict);
    }
    expect(checkGatePatch({ browser_requires_container: 3 }).ok).toBe(false);
  });
});

function deps(
  ports: number[] | "fail",
  env: NodeJS.ProcessEnv = {},
  mode: "personal" | "strict" = "strict",
) {
  const err: string[] = [];
  const ran: string[][] = [];
  const store = new GateStore({
    dir: tmp(),
    alive: () => true,
    platform: "darwin",
    containerBindings: () =>
      ports === "fail"
        ? Promise.reject(new Error("no docker"))
        : Promise.resolve(
            ports.flatMap((port) => [
              { address: "0.0.0.0", port },
              { address: "::", port },
            ]),
          ),
    hostAddresses: () => ["100.64.0.9"],
    installMode: () => mode,
    resolveHost: (n) =>
      n === "den.example.test"
        ? Promise.resolve(["100.64.0.9"])
        : Promise.reject(new Error("ENOTFOUND")),
  });
  const d: GateDeps = {
    store,
    env,
    out: () => {},
    err: (l) => err.push(l),
    now: Date.now,
    sleep: () => Promise.resolve(),
    exec: (cmd, args) => {
      ran.push([cmd, ...args]);
      return { pid: 5151, kill: () => {}, done: Promise.resolve(0) };
    },
    every: () => () => {},
    onSignal: () => () => {},
    exit: () => {},
    pid: 4242,
    cwd: "/x/some-repo",
    lang: "en",
  };
  return { d, err, ran };
}

const run = (...flags: string[]) => [
  "run",
  "--kind",
  "browser",
  ...flags,
  "--",
  "npm",
  "test",
];

describe("gate run (the CLI)", () => {
  it("--browser-endpoint on loopback, no container on that port: refused, exit 2, nothing runs", async () => {
    const { d, err, ran } = deps([]);
    expect(
      await cmdGate(run("--browser-endpoint", "ws://127.0.0.1:3000/x"), d),
    ).toBe(2);
    expect(ran).toEqual([]);
    expect(d.store.list()).toEqual([]);
    expect(err.join("\n")).toContain("ws://127.0.0.1:3000/x");
  });

  it("DEN_PW_WS on loopback with docker unreachable: refused", async () => {
    const { d, ran } = deps("fail", { DEN_PW_WS: "ws://localhost:3000" });
    expect(await cmdGate(run(), d)).toBe(2);
    expect(ran).toEqual([]);
  });

  it("a container publishes the port: runs", async () => {
    const { d, ran } = deps([3000], { DEN_PW_WS: "ws://localhost:3000" });
    expect(await cmdGate(run(), d)).toBe(0);
    expect(ran).toEqual([["npm", "test"]]);
  });

  it("a name that resolves to this machine: refused; one that doesn't resolve: refused", async () => {
    for (const ep of ["ws://den.example.test:3000", "ws://nowhere.test:3000"]) {
      const { d, ran } = deps([]);
      expect(await cmdGate(run("--browser-endpoint", ep), d)).toBe(2);
      expect(ran).toEqual([]);
    }
  });

  it("a personal install: --browser-endpoint ws://localhost:<port> runs as before, Docker not asked", async () => {
    const { d, ran } = deps("fail", {}, "personal");
    expect(
      await cmdGate(run("--browser-endpoint", "ws://localhost:3000"), d),
    ).toBe(0);
    expect(ran).toEqual([["npm", "test"]]);
  });

  it("strict: --browser-endpoint=self is refused", async () => {
    const { d, err, ran } = deps([]);
    d.store.writeSettings({ browser_requires_container: 2 });
    expect(await cmdGate(run("--browser-endpoint=self"), d)).toBe(2);
    expect(ran).toEqual([]);
    expect(err.join("\n")).toContain("--browser-requires-container 1");
  });
});

const api = {
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

describe("gate_slot_request (MCP)", () => {
  it("a loopback endpoint no container publishes: refused; a published one: granted", async () => {
    const ctx = (ports: number[]): ToolContext => ({
      api,
      cfg: {
        actions: [],
        runTestsEnvs: ["local"],
        logsRemote: false,
        approvals: true,
      } as unknown as ToolContext["cfg"],
      cli: "acme",
      scope: { workspace: "north", actor: "agent:coder" },
      gates: new GateStore({
        dir: tmp(),
        alive: () => true,
        platform: "darwin",
        containerBindings: () =>
          Promise.resolve(
            ports.flatMap((port) => [
              { address: "0.0.0.0", port },
              { address: "::", port },
            ]),
          ),
        hostAddresses: () => [],
        installMode: () => "strict",
        resolveHost: () => Promise.reject(new Error("ENOTFOUND")),
      }),
    });
    const no = ctx([]);
    const r = await callTool(
      "gate_slot_request",
      { kind: "browser", browser_endpoint: "ws://127.0.0.1:3000" },
      no,
    );
    expect(r.isError).toBe(true);
    expect(no.gates!.list()).toEqual([]);
    const yes = await callTool(
      "gate_slot_request",
      { kind: "browser", browser_endpoint: "ws://127.0.0.1:3000" },
      ctx([3000]),
    );
    expect(JSON.parse(yes.text)).toMatchObject({ granted: true });
  });
});
