/**
 * Edge up keeps running stacks routed (0.3.0-dev.40, P1). A recreated (or
 * restarted) edge container starts on its own network only; every stack's
 * routes then answered 502 until that stack's next `stack up`. Now, after
 * edge up (and stack up / restart's implicit edge up), the edge rejoins
 * the routed networks of each stack that has its routes file in this
 * edge's dynamic dir and whose compose project is running:
 *
 *   - running stacks are rejoined, one line each; stopped ones are not;
 *   - a network the edge is on already is a no-op (no connect call);
 *   - a routes file for a project that is no stack of this config, and a
 *     running stack with no routes file in this dir, are not touched.
 *
 * Real bin/den in a throwaway distribution; `docker` is a shim on PATH that
 * records its argv: `ps` answers from a list of running projects, `inspect`
 * of the edge from the networks it is on, `network connect` adds to them.
 * Nothing real runs.
 */
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  expect,
  it,
} from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let root = "";
let shim = "";
let log = "";
/** Projects with a container up, one per line. */
let runningFile = "";
/** The networks the edge container is on, one per line. */
let netsFile = "";
let edgeDir = "";
const STACKS = ["shop", "blog", "docs"];

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

function den(args: string[]): { code: number; out: string } {
  const r = spawnSync(path.join(ENGINE, "bin", "den"), args, {
    cwd: root,
    encoding: "utf-8",
    input: "",
    // A minimal env: nothing of the developer's beyond PATH.
    env: {
      HOME: path.join(tmp, "home"),
      PATH: `${shim}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      DEN_ROOT: root,
      DEN_HOME: path.join(tmp, "home", ".den"),
      DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const connects = () =>
  fs
    .readFileSync(log, "utf-8")
    .split("\n")
    .filter((l) => l.startsWith("network connect "));
/** The routes file `stack up` leaves for a project. */
const routesFile = (project: string, dir = edgeDir) =>
  write(path.join(dir, "dynamic", `stack-${project}.yml`), "http: {}\n");

beforeAll(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-rejoin-")));
  root = path.join(tmp, "den");
  const repos = path.join(tmp, "repos");
  edgeDir = path.join(tmp, "edge");
  shim = path.join(tmp, "shim");
  log = path.join(tmp, "docker.log");
  runningFile = path.join(tmp, "running");
  netsFile = path.join(tmp, "edge-nets");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(
    path.join(root, "config", "den.yml"),
    [
      "environments: [local]",
      "edge:",
      "  org: acme",
      "  domain: acme.localhost",
      "  publish: false",
      "  tls: none",
      `  state_dir: ${edgeDir}`,
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    STACKS.map((s) => `${s}:\n  gh: acme/${s}\n`).join(""),
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [default]",
      "focus: default",
      "workspaces:",
      "  default:",
      "    services:",
      ...STACKS.flatMap((s) => [
        `      ${s}:`,
        "        mode: dev-managed",
        `        path: ${path.join(repos, s)}`,
      ]),
      "",
    ].join("\n"),
  );
  for (const s of STACKS) {
    write(
      path.join(repos, s, ".den.yml"),
      `name: ${s}\ncompose:\n  routes: { app: web:80 }\nservices:\n  ${s}: {}\n`,
    );
    write(path.join(repos, s, "docker-compose.yml"), "services: {}\n");
  }
  write(
    path.join(shim, "docker"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${log}'`,
      'p=""; prev=""',
      'for a in "$@"; do [ "$prev" = "-p" ] && p="$a"; prev="$a"; done',
      'case " $* " in',
      // No edge container yet: edge up creates it (the owner guard proceeds).
      "  *' inspect --type container '*) exit 1 ;;",
      `  *' inspect -f '*NetworkSettings*) tr '\\n' ' ' < '${netsFile}'; echo ;;`,
      `  *' ps -q --filter label=com.docker.compose.project='*)`,
      '    for a in "$@"; do want="${a#label=com.docker.compose.project=}"; done',
      `    grep -qx "$want" '${runningFile}' && echo "id-$want" ;;`,
      `  *' config --format json '*) echo "{\\"name\\":\\"$p\\",\\"services\\":{\\"web\\":{\\"ports\\":[{\\"target\\":80}]}}}" ;;`,
      `  ' network connect '*) echo "$3" >> '${netsFile}' ;;`,
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    0o755,
  );
});

beforeEach(() => {
  write(log, "");
  write(runningFile, "");
  write(netsFile, "acme-edge\n");
  fs.rmSync(path.join(edgeDir, "dynamic"), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("edge up rejoins running stacks' networks", () => {
  it("two running stacks and one stopped, each with a routes file: connects for the two running only", () => {
    for (const p of ["shop-main", "blog-main", "docs-main"]) routesFile(p);
    write(runningFile, "shop-main\nblog-main\n");
    const r = den(["edge", "up"]);
    expect(r.code).toBe(0);
    expect(connects().sort()).toEqual([
      "network connect blog-main_default acme-edge",
      "network connect shop-main_default acme-edge",
    ]);
    expect(r.out).toContain("rejoined shop-main_default (shop-main)");
    expect(r.out).toContain("rejoined blog-main_default (blog-main)");
    expect(r.out).not.toContain("docs-main");
  });

  it("a network the edge is on already is a no-op", () => {
    routesFile("shop-main");
    routesFile("blog-main");
    write(runningFile, "shop-main\nblog-main\n");
    write(netsFile, "acme-edge\nshop-main_default\n");
    const r = den(["edge", "up"]);
    expect(r.code).toBe(0);
    expect(connects()).toEqual(["network connect blog-main_default acme-edge"]);
    expect(r.out).not.toContain("rejoined shop-main_default");
    // Again: the edge is on both now; nothing to do.
    write(log, "");
    expect(den(["edge", "up"]).code).toBe(0);
    expect(connects()).toEqual([]);
  });

  it("a routes file for a project outside this config, and a running stack with no routes file here, are ignored", () => {
    routesFile("shop-main");
    routesFile("intruder-main");
    // docs runs, but its routes file is another state dir's.
    routesFile("docs-main", path.join(tmp, "other-edge"));
    write(runningFile, "shop-main\nintruder-main\ndocs-main\n");
    const r = den(["edge", "up"]);
    expect(r.code).toBe(0);
    expect(connects()).toEqual(["network connect shop-main_default acme-edge"]);
    const calls = fs.readFileSync(log, "utf-8");
    expect(calls).not.toContain("intruder");
    expect(calls).not.toContain("-p docs-main");
  });

  it("stack up's implicit edge up rejoins the other running stacks too", () => {
    routesFile("blog-main");
    write(runningFile, "blog-main\n");
    const r = den(["stack", "up", "shop"]);
    expect(r.code).toBe(0);
    expect(connects()).toContain("network connect blog-main_default acme-edge");
    expect(r.out).toContain("rejoined blog-main_default (blog-main)");
  });
});
