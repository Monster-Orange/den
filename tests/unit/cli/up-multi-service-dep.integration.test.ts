/**
 * `up <repo>` with a multi-service dependency (0.3.0-dev.35; backported to
 * 0.2.8). acme has two services, api and worker, each with its own `up` and
 * no repo-level `up`. shop depends on acme (a hard edge). `up shop` derived
 * the closure, reached acme, ran the repo address and aborted:
 * `command "up" not found for service "acme"` … Aborting (fail-fast).
 *
 * Now the decision `up -a` makes is shared: a repo with no up of its own
 * but per-service ups starts those services (all of them, or the ones its
 * dependents name), then its dependents start. Only a dependency with no up
 * at all is skipped, said as `-a` says it. A dependency whose up fails still
 * fails fast.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

let tmp: string;
let marks: string;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A service whose up leaves a mark (or fails, with `fail`). */
function svc(
  name: string,
  mark: string,
  o: { deps?: string[]; fail?: boolean } = {},
): string[] {
  return [
    `  ${name}:`,
    ...(o.deps?.length ? [`    depends_on: [${o.deps.join(", ")}]`] : []),
    "    commands:",
    "      local:",
    "        up:",
    `          cmd: ${o.fail ? "exit 3" : `touch ${path.join(marks, mark)}`}`,
    "          detachable: false",
  ];
}

const REPOS = ["acme", "shop", "cart", "docs", "broken", "store"];

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-up-multi-"));
  marks = path.join(tmp, "marks");
  fs.mkdirSync(marks);
  const repos = path.join(tmp, "repos");
  const dist = path.join(tmp, "den");
  write(path.join(dist, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(dist, "config", "den.yml"),
    [
      "repos_root: ../repos",
      "graph:",
      "  edges:",
      '    "shop->acme": hard',
      '    "shop->docs": hard',
      '    "cart->acme": hard',
      '    "store->broken": hard',
      "",
    ].join("\n"),
  );
  write(
    path.join(dist, "config", "local", "service-catalog.yml"),
    REPOS.map((n) => `${n}:\n  gh: acme/${n}\n`).join(""),
  );
  write(
    path.join(dist, "config", "local", "workspaces.yml"),
    [
      "active: default",
      "workspaces:",
      "  default:",
      "    services:",
      ...REPOS.flatMap((n) => [
        `      ${n}:`,
        "        mode: dev-managed",
        `        path: ${path.join(repos, n)}`,
      ]),
      "",
    ].join("\n"),
  );
  const manifest = (name: string, lines: string[]) =>
    write(
      path.join(repos, name, ".den.yml"),
      [`name: ${name}`, "services:", ...lines, ""].join("\n"),
    );
  // acme: two services, each with its own up; no repo-level up.
  manifest("acme", [
    ...svc("api", "acme-api"),
    ...svc("worker", "acme-worker"),
  ]);
  // shop needs acme as a whole (and docs, which has no up at all).
  manifest("shop", svc("shop", "shop"));
  // cart names one of acme's services.
  manifest("cart", svc("cart", "cart", { deps: ["acme/api"] }));
  // docs: a service with no up command at all.
  manifest("docs", [
    "  docs:",
    "    commands:",
    "      local:",
    '        lint: "true"',
  ]);
  // broken: per-service up that fails; store depends on it.
  manifest("broken", [
    ...svc("api", "broken-api", { fail: true }),
    ...svc("worker", "broken-worker"),
  ]);
  manifest("store", svc("store", "store"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  for (const f of fs.readdirSync(marks)) fs.rmSync(path.join(marks, f));
});

const ENGINE = path.resolve(__dirname, "../../..");
const cli = (args: string[]): Promise<{ status: number | null; out: string }> =>
  new Promise((resolve) => {
    const p = spawn(path.join(ENGINE, "bin", "den"), args, {
      cwd: tmp,
      env: {
        ...process.env,
        DEN_ROOT: path.join(tmp, "den"),
        DEN_HOME: path.join(tmp, "home"),
        HOME: path.join(tmp, "home"),
        DEN_INVOKE_CWD: tmp,
        DEN_SECRETS_PROVIDER: "none",
        DEN_FORCE_TABS: "0",
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout!.on("data", (d: Buffer) => (out += d.toString()));
    p.stderr!.on("data", (d: Buffer) => (out += d.toString()));
    p.on("close", (status) => resolve({ status, out }));
  });
const marked = () => fs.readdirSync(marks).sort();

describe("up <repo> with a multi-service dependency", () => {
  it("starts every service of a dependency with no repo-level up, then the repo; one with no up at all is skipped", async () => {
    const r = await cli(["up", "shop"]);
    expect({ status: r.status, marks: marked() }).toEqual({
      status: 0,
      marks: ["acme-api", "acme-worker", "shop"],
    });
    expect(r.out).not.toMatch(/not found for service "acme"/);
    expect(r.out).not.toMatch(/Aborting \(fail-fast\)/);
    // Said as `up -a` says it.
    expect(r.out).toMatch(/Skipping \(no local up command\): docs/);
  }, 90_000);

  it("starts only the services a dependent names", async () => {
    const r = await cli(["up", "cart"]);
    expect({ status: r.status, marks: marked() }).toEqual({
      status: 0,
      marks: ["acme-api", "cart"],
    });
  }, 90_000);

  it("a dependency whose up fails still fails fast: its dependent never starts", async () => {
    const r = await cli(["up", "store"]);
    expect(r.status).toBe(1);
    expect(marked()).not.toContain("store");
    expect(r.out).toMatch(
      /Aborting \(fail-fast\): broken\/api failed to start/,
    );
  }, 90_000);

  it("up -a makes the same decision: acme's services start, docs is skipped", async () => {
    const r = await cli(["up", "-a"]);
    expect(marked()).toEqual(
      expect.arrayContaining([
        "acme-api",
        "acme-worker",
        "shop",
        "cart",
        "store",
      ]),
    );
    expect(r.out).toMatch(/Skipping \(no local up command\): docs/);
    expect(r.out).not.toMatch(/Skipping \(no local up command\):[^\n]*acme/);
  }, 90_000);
});
