/**
 * `-n`/`--dry-run` and `--plan` run nothing, whatever names the target: the
 * cwd repo (bare), a repo, a `repo/service` address, a service alias, a
 * compose stack name, an app (-A). Every `up`/`down`/`restart` command in the
 * fixture touches a marker file, so a real run is visible.
 *
 * Also: a service with no commands of its own is started by its repo's up.
 */
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmp: string;
let marks: string;
let repos: string;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

const cmds = (id: string) =>
  [
    "    commands:",
    "      local:",
    `        up: touch ${path.join("MARKS", `${id}.up`)}`,
    `        down: touch ${path.join("MARKS", `${id}.down`)}`,
    `        restart: touch ${path.join("MARKS", `${id}.restart`)}`,
    "",
  ].join("\n");

const touched = (): string[] => fs.readdirSync(marks).sort();

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-dryrun-"));
  marks = path.join(tmp, "marks");
  fs.mkdirSync(marks);
  const distRoot = path.join(tmp, "den");
  repos = path.join(tmp, "repos");
  const names = ["voiceapp", "kb", "docs", "store", "core", "front"];

  write(path.join(distRoot, "den.yml"), "product:\n  name: den\n");
  // Derived edges the fixtures can't expose: front uses core (remote),
  // voiceapp sits on store.
  write(
    path.join(distRoot, "config", "den.yml"),
    "repos_root: ../repos\ngraph:\n  edges:\n    front->core: hard\n    voiceapp->store: hard\n",
  );
  write(
    path.join(distRoot, "config", "local", "service-catalog.yml"),
    names.map((n) => `${n}:\n  gh: x/${n}\n`).join(""),
  );
  write(
    path.join(distRoot, "config", "local", "workspaces.yml"),
    [
      "active: default",
      "workspaces:",
      "  default:",
      "    services:",
      ...names.flatMap((n) => [
        `      ${n}:`,
        "        mode: dev-managed",
        `        path: ${path.join(repos, n)}`,
      ]),
      "",
    ].join("\n"),
  );
  const m = (s: string) => s.replaceAll("MARKS", marks);
  // voice has no commands: the repo's up (api's) starts it.
  write(
    path.join(repos, "voiceapp", ".den.yml"),
    m(
      `name: voiceapp\napplication: studio\nentrypoint: api\nservices:\n  api:\n${cmds("voiceapp-api")}  voice:\n    port: 7000\n    depends_on: [store]\n`,
    ),
  );
  // A compose stack named apart from its repo; its service's own commands
  // override the generated stack ones.
  write(
    path.join(repos, "kb", ".den.yml"),
    m(
      `name: kb\napplication: studio\nentrypoint: api\ncompose:\n  name: search\nservices:\n  api:\n${cmds("kb-api")}  worker:\n    port: 7100\n`,
    ),
  );
  // A dependency that other running services may share.
  write(
    path.join(repos, "store", ".den.yml"),
    m(`name: store\nservices:\n  db:\n${cmds("store-db")}`),
  );
  // A remote service, and a local one that depends on it.
  write(
    path.join(repos, "core", ".den.yml"),
    "name: core\nservices:\n  api:\n    runs:\n      local: remote\n    target:\n      env: dev\n      url: https://core.example/\n",
  );
  write(
    path.join(repos, "front", ".den.yml"),
    m(
      `name: front\nservices:\n  web:\n    depends_on: [core]\n${cmds("front-web")}`,
    ),
  );
  // A service key that is not the repo name.
  write(
    path.join(repos, "docs", ".den.yml"),
    m(`name: docs\nservices:\n  indexer:\n${cmds("docs-indexer")}`),
  );
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const ENGINE = path.resolve(__dirname, "../../..");
const cli = (
  args: string[],
  cwd = tmp,
): Promise<{ status: number | null; out: string }> =>
  new Promise((resolve) => {
    const p = spawn(path.join(ENGINE, "bin", "den"), args, {
      cwd,
      env: {
        ...process.env,
        DEN_ROOT: path.join(tmp, "den"),
        DEN_HOME: path.join(tmp, "home"),
        DEN_INVOKE_CWD: cwd,
        DEN_SECRETS_PROVIDER: "env",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr!.on("data", (d: Buffer) => (out += d.toString()));
    p.on("close", (status) => resolve({ status, out }));
  });

describe("dry-run and plan are read-only on every path", () => {
  const forms: [string, string[], string?][] = [
    ["bare (cwd repo)", [], "voiceapp"],
    ["repo", ["voiceapp"]],
    ["repo/service address", ["voiceapp/voice"]],
    ["address with its own up", ["kb/api"]],
    ["service alias", ["indexer"]],
    ["compose stack name", ["search"]],
    ["app", ["-A", "studio"]],
  ];
  const cases = forms.flatMap(([label, target, cwdRepo]) =>
    (
      [
        ["up", "-n"],
        ["up", "--dry-run"],
        ["up", "--plan"],
        ["down", "-n"],
        ["restart", "-n"],
        ["restart", "--dry-run"],
      ] as const
    ).map(
      ([cmd, flag]) =>
        [`${cmd} ${flag}: ${label}`, [cmd, ...target, flag], cwdRepo] as const,
    ),
  );

  it.each(cases)(
    "%s",
    async (_label, args, cwdRepo) => {
      const r = await cli([...args], cwdRepo ? path.join(repos, cwdRepo) : tmp);
      expect(touched()).toEqual([]);
      expect(r.out).not.toMatch(/not found/);
      // The output rides along, so a failure says why.
      // Restart of a repo-started service fails, as its real run does.
      const fails = args[0] === "restart" && args.includes("voiceapp/voice");
      expect({ status: r.status, out: r.out }).toMatchObject({
        status: fails ? 1 : 0,
      });
    },
    60_000,
  );

  it("an unknown name fails with exit 1, dry run or not", async () => {
    const dry = await cli(["up", "nowhere", "-n"]);
    expect(dry.status).toBe(1);
    expect(dry.out).toMatch(
      /"nowhere" is not a service in any active project/,
    );
    const real = await cli(["up", "nowhere"]);
    expect(real.status).toBe(1);
    expect(touched()).toEqual([]);
  }, 60_000);
});

describe("a dry run says what a real run does", () => {
  it("up includes dependencies and runs the repo's up for a repo-started service", async () => {
    const r = await cli(["up", "voiceapp/voice", "-n"]);
    expect(r.out).toMatch(/Would up: store → voiceapp\b/);
    expect(r.out).toMatch(/has no up of its own; running voiceapp's up/);
    expect(r.status).toBe(0);
  }, 60_000);

  it("down stops only what was named, never its dependencies", async () => {
    const r = await cli(["down", "voiceapp/voice", "-n"]);
    expect(r.out).not.toMatch(/store/);
    expect(r.out).toMatch(
      /voiceapp\/voice has no down of its own; it is stopped by voiceapp's down\. Run `den down voiceapp`/,
    );
    expect(r.status).toBe(0);
    const own = await cli(["down", "kb/api", "-n"]);
    expect(own.out).toMatch(/Would down: kb\/api\n/);
  }, 60_000);

  it("restart of a repo-started service is the real run's error, exit 1", async () => {
    const r = await cli(["restart", "voiceapp/voice", "--dry-run"]);
    expect(r.out).not.toMatch(/store/);
    expect(r.out).toMatch(
      /has no restart of its own; it is started by voiceapp's up/,
    );
    expect(r.status).toBe(1);
  }, 60_000);

  it("a repo's derived down names its targets", async () => {
    const r = await cli(["down", "voiceapp", "-n"]);
    expect(r.out).toMatch(/Would down: .*voiceapp/);
  }, 60_000);

  it("down <repo> stops only that repo unless --with-deps", async () => {
    const r = await cli(["down", "voiceapp", "-n"]);
    expect(r.out).toMatch(/Would down: voiceapp\n/);
    expect(r.out).not.toMatch(/\+ dependencies/);
    const deps = await cli(["down", "voiceapp", "--with-deps", "-n"]);
    expect(deps.out).toMatch(/Derived down for voiceapp \(\+ dependencies\)/);
    expect(deps.out).toMatch(/Would down: voiceapp → store\n/);
    expect(deps.status).toBe(0);
  }, 60_000);

  it("a remote dependency is skipped in the plan, saying why", async () => {
    const r = await cli(["up", "front/web", "-n"]);
    expect(r.out).toMatch(/Would up: front\/web\n/);
    expect(r.out).toMatch(/core \(remote, skipped\): core runs in dev/);
    expect(r.status).toBe(0);
  }, 60_000);

  it("down of a remote repo warns about no dependents: it stops nothing", async () => {
    const r = await cli(["down", "core", "-n"]);
    expect(r.out).toMatch(/✗ core runs in dev; nothing to stop here/);
    expect(r.out).not.toMatch(/also depends on what this stops/);
  }, 60_000);

  it("a named remote target fails with the real run's reason", async () => {
    const r = await cli(["restart", "core", "-n"]);
    expect(r.out).toMatch(/✗ core runs in dev; nothing to restart here/);
    expect(r.status).toBe(1);
  }, 60_000);

  it("a compose sub-service restarts on its own", async () => {
    const r = await cli(["restart", "kb/worker", "-n"]);
    expect(r.out).toMatch(/Would restart: kb\/worker\n/);
    expect(r.status).toBe(0);
  }, 60_000);
});

describe("a service with no commands of its own", () => {
  type Runner =
    typeof import("../../../src/shared/environment-manager/service-runner.js");
  let runner: Runner;
  beforeAll(async () => {
    process.env.DEN_ROOT = path.join(tmp, "den");
    process.env.DEN_HOME = path.join(tmp, "home");
    delete process.env.DEN_INVOKE_CWD;
    runner =
      await import("../../../src/shared/environment-manager/service-runner.js");
  });
  afterAll(() => {
    delete process.env.DEN_ROOT;
    delete process.env.DEN_HOME;
    for (const f of touched()) fs.unlinkSync(path.join(marks, f));
  });

  const run = (command: string) =>
    new Promise<{ code: number; lines: string[] }>((resolve) => {
      const lines: string[] = [];
      runner.runServiceCommand({
        address: "voiceapp/voice",
        command,
        workspace: "default",
        runtime: "daemon",
        onLine: (l) => lines.push(l),
        onClose: (code) => resolve({ code, lines }),
        // A detached up hands off: its launcher exiting is the end.
        onServiceExit: (code) => resolve({ code, lines }),
      });
    });

  it("up runs its repo's up, saying so", async () => {
    const r = await run("up");
    expect(r.lines.join("\n")).toMatch(
      /voiceapp\/voice has no up of its own; running voiceapp's up/,
    );
    expect(r.code).toBe(0);
    expect(touched()).toContain("voiceapp-api.up");
  }, 30_000);

  it("restart points at the repo instead of reaching its other services", async () => {
    const r = await run("restart");
    expect(r.code).toBe(1);
    expect(r.lines.join("\n")).toMatch(
      /has no restart of its own; it is started by voiceapp's up\. Run `den restart voiceapp`/,
    );
    expect(touched()).not.toContain("voiceapp-api.restart");
  }, 30_000);
});
