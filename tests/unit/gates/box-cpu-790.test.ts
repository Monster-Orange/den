/**
 * Issue 790: a cpu check (unit tests, lint) can run on a test box over
 * ssh, in the box's own cpu slot, and never with this machine's secrets.
 *
 * - Slots: a box takes cpu runs only once it has cpu_slots (default 0).
 *   A cpu run on a box holds the box's cpu slot and none of this
 *   machine's cpu room. The box's memory and hold still apply.
 * - Secrets: this machine's environment never goes. A run is refused on
 *   a box (with "--box local" to run it here) when an argument or an
 *   --env value is a store reference or a token, or an --env name looks
 *   secret, or an untracked file it would ship holds one. A refusal names
 *   the place (argument 2, --env NAME, a file), never the value.
 * - The remote side: every argument is quoted alone; the run's id is
 *   checked before it is used in a path; dependencies are installed into
 *   a temp folder, moved into place only when the install worked, and
 *   made read-only. The remote scripts run here with sh, in a temp HOME,
 *   with a stub npm: nothing reaches a real box.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { execFileSync, spawn, spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  assign,
  checkBox,
  boxCapOf,
  type GateBox,
} from "../../../src/shared/gates/boxes.js";
import {
  GATE_DEFAULTS,
  localRoom,
  type GateEntry,
} from "../../../src/shared/gates/rules.js";
import { GateStore } from "../../../src/shared/gates/store.js";
import { cmdGate, type GateDeps } from "../../../src/ui/cli/gate-command.js";
import type { BoxCpuRun } from "../../../src/shared/gates/box-cpu.js";
import {
  BOX_RUN_ROOT,
  boxRunIdOk,
  boxSecretRefusal,
  depsScript,
  runScript,
  shQuote,
  shipPlan,
  sweepScript,
} from "../../../src/shared/gates/box-cpu.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) {
    spawnSync("chmod", ["-R", "u+w", d]);
    fs.rmSync(d, { recursive: true, force: true });
  }
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-790-"));
  tmps.push(d);
  return d;
};

const T0 = Date.parse("2026-11-24T06:00:00Z");
const entry = (
  id: string,
  kind: "browser" | "cpu",
  more: Partial<GateEntry> = {},
): GateEntry => ({
  id,
  kind,
  who: id,
  label: id,
  pid: 1,
  askedAt: new Date(T0).toISOString(),
  estimateMin: 5,
  ...more,
});
const box = (more: Partial<GateBox> = {}): GateBox => ({
  name: "b1",
  ssh: "den@b1",
  browser_slots: 1,
  ...more,
});

describe("issue 790: a box's cpu slots", () => {
  it("cpu_slots is a setting from 0 to 64; absent means 0", () => {
    const c = checkBox({ name: "b1", ssh: "den@b1", cpu_slots: 3 });
    expect(c.ok && c.box.cpu_slots).toBe(3);
    const d = checkBox({ name: "b1", ssh: "den@b1" });
    expect(d.ok && boxCapOf(d.box, true).cpuSlots).toBe(0);
    expect(checkBox({ name: "b1", cpu_slots: 65 }).ok).toBe(false);
    expect(checkBox({ name: "b1", cpu_slots: 1.5 }).ok).toBe(false);
  });

  it("a cpu run with --box <name> takes the box's cpu slot", () => {
    const caps = [boxCapOf(box({ cpu_slots: 1 }), true)];
    expect(
      assign([entry("c1", "cpu", { where: "b1" })], GATE_DEFAULTS, T0, caps),
    ).toEqual([{ id: "c1", box: "b1" }]);
  });

  it("a box with no cpu slots never takes a cpu run", () => {
    const caps = [boxCapOf(box(), true)];
    expect(
      assign([entry("c1", "cpu", { where: "b1" })], GATE_DEFAULTS, T0, caps),
    ).toEqual([]);
  });

  it("its cpu and browser slots are counted apart", () => {
    const caps = [boxCapOf(box({ cpu_slots: 1, browser_slots: 1 }), true)];
    const q = [
      entry("br", "browser", {
        where: "b1",
        grantedAt: new Date(T0).toISOString(),
        box: "b1",
      }),
      entry("c1", "cpu", { where: "b1" }),
      entry("c2", "cpu", { where: "b1" }),
    ];
    expect(assign(q, GATE_DEFAULTS, T0, caps)).toEqual([
      { id: "c1", box: "b1" },
    ]);
  });

  it("a cpu run on a box leaves this machine's cpu room whole", () => {
    const s = { ...GATE_DEFAULTS, cpuSlots: 1 };
    const held = entry("onbox", "cpu", {
      where: "b1",
      box: "b1",
      grantedAt: new Date(T0).toISOString(),
    });
    expect(localRoom([held], s).fits(entry("here", "cpu"))).toBe(true);
    expect(assign([held, entry("here", "cpu")], s, T0, [])).toEqual([
      { id: "here" },
    ]);
  });

  it("a closed box (low memory, held, unreachable) gives no cpu slot", () => {
    const caps = [boxCapOf(box({ cpu_slots: 2 }), false)];
    expect(
      assign([entry("c1", "cpu", { where: "b1" })], GATE_DEFAULTS, T0, caps),
    ).toEqual([]);
  });

  it("--box any: this machine first, then a box with a free cpu slot", () => {
    const s = { ...GATE_DEFAULTS, cpuSlots: 1 };
    const caps = [boxCapOf(box({ cpu_slots: 1 }), true)];
    const q = [
      entry("c1", "cpu", { where: "any" }),
      entry("c2", "cpu", { where: "any" }),
    ];
    expect(assign(q, s, T0, caps)).toEqual([
      { id: "c1" },
      { id: "c2", box: "b1" },
    ]);
  });
});

describe("issue 790: nothing secret leaves this machine", () => {
  const refuse = (args: string[], env: Record<string, string> = {}) =>
    boxSecretRefusal(args, env);

  it("an ordinary check goes", () => {
    expect(
      refuse(["npx", "jest", "--maxWorkers=1", "tests/unit/a.test.ts"]),
    ).toBeNull();
    expect(refuse(["npm", "run", "lint"], { NODE_ENV: "test" })).toBeNull();
  });

  it("a store reference in an argument: refused, by position, never the value", () => {
    const r = refuse(["node", "x.js", "op://Vault/Item/field"]);
    expect(r).toMatch(/argument 3/);
    expect(r).toMatch(/--box local/);
    expect(r).not.toContain("Vault");
  });

  it("a token-shaped argument: refused", () => {
    const tok = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const r = refuse(["curl", "-H", `Authorization: Bearer ${tok}`]);
    expect(r).toMatch(/argument 3/);
    expect(r).not.toContain(tok);
  });

  it("an --env name that looks secret, or a secret value: refused by name", () => {
    expect(refuse(["npm", "test"], { GITHUB_TOKEN: "x" })).toMatch(
      /--env GITHUB_TOKEN/,
    );
    expect(refuse(["npm", "test"], { OP_SERVICE_ACCOUNT_TOKEN: "x" })).toMatch(
      /OP_SERVICE_ACCOUNT_TOKEN/,
    );
    const r = refuse(["npm", "test"], { FOO: "keychain://den/key" });
    expect(r).toMatch(/--env FOO/);
    expect(r).not.toContain("den/key");
  });

  it("a command that names a secret variable, or a store's own program: refused", () => {
    expect(refuse(["sh", "-c", "echo $OP_SERVICE_ACCOUNT_TOKEN"])).toMatch(
      /argument 3/,
    );
    expect(refuse(["op", "read", "x"])).toMatch(/argument 1/);
    expect(refuse(["security", "find-generic-password"])).toMatch(/argument 1/);
  });
});

describe("issue 790: the tree that ships", () => {
  const files: Record<string, string> = {
    "package.json": "{}",
    "package-lock.json": "{}",
    "src/a.ts": "export const a = 1;",
    ".env": "X=1",
    ".env.local": "X=1",
    ".npmrc": "//registry/:_authToken=abc",
    "certs/dev.pem": "x",
    ".aws/credentials": "x",
    ".docker/config.json": "{}",
    "infra/prod.tfvars": "x",
    ".dev.vars": "x",
  };
  const plan = (
    untracked: string[] = [],
    extra: Record<string, string> = {},
  ) => {
    const all = { ...files, ...extra };
    return shipPlan(Object.keys(all), new Set(untracked), (f) =>
      Buffer.from(all[f]!),
    );
  };

  it("secret files are left out, by name", () => {
    const p = plan();
    expect(p.refused).toBeUndefined();
    expect(p.ship.sort()).toEqual([
      "package-lock.json",
      "package.json",
      "src/a.ts",
    ]);
    expect(p.left.sort()).toEqual(
      [
        ".aws/credentials",
        ".dev.vars",
        ".docker/config.json",
        ".env",
        ".env.local",
        ".npmrc",
        "certs/dev.pem",
        "infra/prod.tfvars",
      ].sort(),
    );
  });

  it("an untracked file holding a token refuses the run, naming the file only", () => {
    const tok = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
    const p = plan(["tmp/out.txt"], { "tmp/out.txt": `got ${tok}\n` });
    expect(p.refused).toMatch(/tmp\/out\.txt/);
    expect(p.refused).toMatch(/--box local/);
    expect(p.refused).not.toContain(tok);
  });

  it("an untracked store reference refuses too; a tracked fixture does not", () => {
    expect(plan(["notes.md"], { "notes.md": "op://V/I/f" }).refused).toMatch(
      /notes\.md/,
    );
    const tok = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
    expect(plan([], { "tests/fixture.ts": tok }).refused).toBeUndefined();
  });

  it("an untracked binary or large file is skipped and named, not scanned", () => {
    const p = plan(["img.png", "big.log"], {
      "img.png": "\u0000\u0001PNG",
      "big.log": "x".repeat(2 * 1024 * 1024),
    });
    expect(p.refused).toBeUndefined();
    expect(p.skipped.sort()).toEqual(["big.log", "img.png"]);
    expect(p.ship).not.toContain("big.log");
  });

  it("no package-lock.json: refused (no loose install on a box)", () => {
    const p = shipPlan(["package.json", "src/a.ts"], new Set(), () =>
      Buffer.from("x"),
    );
    expect(p.refused).toMatch(/package-lock\.json/);
  });
});

describe("issue 790: the remote side", () => {
  it("a run's id is letters, digits, dot, dash, underscore; never . or ..", () => {
    expect(boxRunIdOk("cpu-1a2b3c.4_x")).toBe(true);
    for (const bad of [
      "",
      ".",
      "..",
      "a/b",
      "a b",
      "a;rm",
      "$(x)",
      "a'b",
      "x".repeat(81),
    ])
      expect([bad, boxRunIdOk(bad)]).toEqual([bad, false]);
  });

  it("each argument arrives as one literal argument (', $(), ; and a space)", () => {
    const nasty = [
      "it's",
      "$(touch pwned)",
      "a; touch pwned2",
      "two words",
      "`id`",
      '"q"',
    ];
    const home = tmp();
    // The remote login shell parses the string once, as ssh's does.
    const out = execFileSync(
      "sh",
      ["-c", `printf '%s\\n' ${nasty.map(shQuote).join(" ")}`],
      { cwd: home, encoding: "utf-8" },
    );
    expect(out.split("\n").slice(0, -1)).toEqual(nasty);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  it("the run script: the box's own env only, plus what was allowed", () => {
    const home = tmp();
    const id = "cpu-abc";
    const dir = path.join(home, BOX_RUN_ROOT, "runs", id, "tree");
    fs.mkdirSync(dir, { recursive: true });
    const r = spawnSync(
      "sh",
      [
        "-c",
        runScript(id, ["sh", "-c", "env | sort"], {
          CI: "true",
          GATE_SLOT: id,
        }),
      ],
      {
        env: { HOME: home, PATH: process.env.PATH, HOST_SECRET: "nope" },
        encoding: "utf-8",
      },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("CI=true");
    expect(r.stdout).toContain(`GATE_SLOT=${id}`);
    expect(r.stdout).not.toContain("HOST_SECRET");
    expect(
      fs.existsSync(path.join(home, BOX_RUN_ROOT, "runs", id, "pid")),
    ).toBe(true);
  });

  it("the run script refuses a bad id before any path", () => {
    expect(() => runScript("../x", ["true"], {})).toThrow(/id/);
    expect(() => sweepScript(["ok", "a b"])).toThrow(/id/);
  });

  /** A stub npm: `ci` writes node_modules/dep, or sleeps when SLOW is set. */
  function stubNpm(): string {
    const bin = tmp();
    fs.writeFileSync(
      path.join(bin, "npm"),
      `#!/bin/sh\n[ -n "$SLOW" ] && sleep 30\nmkdir -p node_modules/dep && echo ok > node_modules/dep/index.js\n`,
      { mode: 0o755 },
    );
    return bin;
  }
  const deps = (home: string, tree: string, bin: string, slow = false) =>
    spawn("sh", ["-c", depsScript("a".repeat(64))], {
      cwd: tree,
      env: {
        HOME: home,
        PATH: `${bin}:${process.env.PATH}`,
        ...(slow ? { SLOW: "1" } : {}),
      },
      stdio: "ignore",
    });
  const treeWithLock = (home: string) => {
    const t = path.join(home, BOX_RUN_ROOT, "runs", "r1", "tree");
    fs.mkdirSync(t, { recursive: true });
    fs.writeFileSync(path.join(t, "package.json"), "{}");
    fs.writeFileSync(path.join(t, "package-lock.json"), "{}");
    return t;
  };
  const done = (k: ReturnType<typeof spawn>) =>
    new Promise<number | null>((res) => k.on("close", (c) => res(c)));

  it("deps: installed once, read-only, linked into the run; a run can't change them", async () => {
    const home = tmp();
    const tree = treeWithLock(home);
    expect(await done(deps(home, tree, stubNpm()))).toBe(0);
    const cached = path.join(home, BOX_RUN_ROOT, "deps", "a".repeat(64));
    expect(
      fs.readFileSync(path.join(tree, "node_modules/dep/index.js"), "utf-8"),
    ).toBe("ok\n");
    expect(fs.realpathSync(path.join(tree, "node_modules"))).toBe(
      fs.realpathSync(path.join(cached, "node_modules")),
    );
    const w = spawnSync("sh", ["-c", "echo bad > node_modules/dep/index.js"], {
      cwd: tree,
    });
    expect(w.status).not.toBe(0);
    expect(
      fs.readFileSync(path.join(cached, "node_modules/dep/index.js"), "utf-8"),
    ).toBe("ok\n");
  });

  it("deps: an install killed midway leaves no deps/<sha>", async () => {
    const home = tmp();
    const tree = treeWithLock(home);
    const k = deps(home, tree, stubNpm(), true);
    await new Promise((r) => setTimeout(r, 1000));
    k.kill("SIGKILL");
    await done(k);
    expect(
      fs.existsSync(path.join(home, BOX_RUN_ROOT, "deps", "a".repeat(64))),
    ).toBe(false);
  }, 15_000);

  it("the sweep stops a run whose slot is gone, removes its folder, keeps live ones", async () => {
    const home = tmp();
    const runs = path.join(home, BOX_RUN_ROOT, "runs");
    fs.mkdirSync(path.join(runs, "gone", "tree"), { recursive: true });
    fs.mkdirSync(path.join(runs, "live", "tree"), { recursive: true });
    const orphan = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
    fs.writeFileSync(path.join(runs, "gone", "pid"), String(orphan.pid));
    const ended = done(orphan);
    const r = spawnSync("sh", ["-c", sweepScript(["live"])], {
      env: { HOME: home, PATH: process.env.PATH },
      encoding: "utf-8",
    });
    expect(r.status).toBe(0);
    expect(fs.readdirSync(runs)).toEqual(["live"]);
    await ended;
    expect(
      orphan.killed || orphan.exitCode !== null || orphan.signalCode !== null,
    ).toBe(true);
  }, 20_000);
});

describe("issue 790: gate run --kind cpu --box", () => {
  /** A git checkout's files, as the fake git reports them. */
  const repo = (untracked: Record<string, string> = {}) => {
    const root = tmp();
    const tracked = {
      "package.json": "{}",
      "package-lock.json": "{}",
      "a.test.ts": "x",
    };
    for (const [f, c] of Object.entries({ ...tracked, ...untracked }))
      fs.writeFileSync(path.join(root, f), c);
    const git = (a: string[]) =>
      a[0] === "rev-parse"
        ? `${fs.realpathSync(root)}\n`
        : a.includes("-co")
          ? [...Object.keys(tracked), ...Object.keys(untracked)].join("\0")
          : Object.keys(untracked).join("\0");
    return { root, git };
  };

  function setup(more: Partial<GateBox> = { cpu_slots: 1 }, untracked = {}) {
    const store = new GateStore({
      platform: "linux",
      dir: tmp(),
      alive: () => true,
      now: () => T0,
      probe: () => Promise.resolve({ state: "open" }),
    });
    store.setBox(box(more));
    const r = repo(untracked);
    const err: string[] = [];
    const ran: string[] = [];
    const onBox: BoxCpuRun[] = [];
    const d: GateDeps = {
      store,
      env: { GITHUB_TOKEN: "x", HOME: "/h", FOO: "bar" },
      out: () => {},
      err: (l: string) => void err.push(l),
      now: () => T0,
      sleep: () => Promise.resolve(),
      exec: (cmd: string) => {
        ran.push(cmd);
        return { pid: 5151, kill: () => {}, done: Promise.resolve(0) };
      },
      boxCpu: (_b: GateBox, run: BoxCpuRun) => {
        onBox.push(run);
        return { ok: true as const, kill: () => {}, done: Promise.resolve(7) };
      },
      git: r.git,
      every: () => () => {},
      onSignal: () => () => {},
      exit: () => {},
      pid: 4242,
      cwd: r.root,
    };
    return { store, d, err, ran, onBox };
  }

  it("runs on the box in the box's cpu slot; its exit code comes back", async () => {
    const t = setup();
    // This machine's cpu slots are all taken: the box run still starts.
    for (let i = 0; i < t.store.settings().cpuSlots; i++)
      t.store.ask({
        kind: "cpu",
        who: `x${i}`,
        label: `here${i}`,
        pid: 1,
        estimateMin: 5,
      });
    const code = await cmdGate(
      ["run", "--box", "b1", "--env", "FOO", "--", "npx", "jest", "a.test.ts"],
      t.d,
    );
    expect(code).toBe(7);
    expect(t.err.join("\n")).toMatch(/holds cpu on box b1/);
    expect(t.ran).toEqual([]);
    expect(t.onBox).toHaveLength(1);
    const run = t.onBox[0]!;
    expect(run.argv).toEqual(["npx", "jest", "a.test.ts"]);
    expect(run.env.FOO).toBe("bar");
    expect(run.env.CI).toBe("true");
    expect(run.env).not.toHaveProperty("HOME");
    expect(run.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(run.live).toEqual([run.id]);
  });

  it("an argument holding a store reference: refused on the box, by position", async () => {
    const t = setup();
    expect(
      await cmdGate(
        ["run", "--box", "b1", "--", "node", "x.js", "op://V/I/f"],
        t.d,
      ),
    ).toBe(2);
    expect(t.err.join("\n")).toMatch(/argument 3/);
    expect(t.err.join("\n")).not.toContain("op://V");
    expect(t.onBox).toEqual([]);
  });

  it("--env of a secret name: refused", async () => {
    const t = setup();
    expect(
      await cmdGate(
        ["run", "--box", "b1", "--env", "GITHUB_TOKEN", "--", "npm", "test"],
        t.d,
      ),
    ).toBe(2);
    expect(t.err.join("\n")).toMatch(/--env GITHUB_TOKEN/);
  });

  it("an untracked file with a token refuses the box run, naming the file", async () => {
    const tok = "ghp_" + "Z9y8X7w6V5u4T3s2R1q0P9o8N7m6L5k4J3i2";
    const t = setup({ cpu_slots: 1 }, { "out.txt": tok });
    expect(
      await cmdGate(["run", "--box", "b1", "--", "npm", "test"], t.d),
    ).toBe(2);
    expect(t.err.join("\n")).toMatch(/out\.txt/);
    expect(t.err.join("\n")).not.toContain(tok);
  });

  it("--box any with a secret: stays on this machine, saying why", async () => {
    const t = setup();
    expect(
      await cmdGate(["run", "--box", "any", "--", "op", "read", "x"], t.d),
    ).toBe(0);
    expect(t.ran).toEqual(["op"]);
    expect(t.err.join("\n")).toMatch(/stays on this machine/);
  });

  it("--env without a box is refused (a run here has this machine's env)", async () => {
    const t = setup();
    expect(
      await cmdGate(["run", "--env", "FOO", "--", "npm", "test"], t.d),
    ).toBe(2);
  });
});
