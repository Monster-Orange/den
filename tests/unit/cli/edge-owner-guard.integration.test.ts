/**
 * An edge another state dir owns is never replaced (0.3.0-dev.40, P1). A
 * scratch root with its own DEN_EDGE_DIR but the real edge.org ran `stack
 * up`; its implicit edge up wrote compose.yml under the scratch dir, and
 * `docker compose up -d` recreated the user's real edge (the container and
 * project are named by org) with the scratch certs and routes mounted.
 *
 *   - the edge container is labelled `den.edge.root=<realpath of its state
 *     dir>` and `den.edge.org=<org>`; edge up, stack up's implicit edge up
 *     and edge down touch an existing edge only when its root is theirs;
 *   - two state dirs, one edge.org: the second dir's `stack up` is refused
 *     ("edge acme-edge belongs to <dir>; not replacing it"), exits
 *     non-zero, never calls compose, and the first dir's container (its id
 *     and mounts) is unchanged; `edge down` from it likewise;
 *   - `edge up --take-over` is the only override;
 *   - an unlabelled (legacy) edge is adopted from the default state dir
 *     only, never under a DEN_EDGE_DIR that overrides it;
 *   - under such an override, a refusal also says to give the root a
 *     distinct edge.org.
 *
 * Real bin/den in a throwaway distribution; `docker` is a shim on PATH
 * that records its argv and keeps one fake container: `compose up` (re)
 * creates it from its compose.yml's label, `compose down` removes it,
 * `inspect` answers from it. Nothing real runs.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
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
/** The fake container: `<den.edge.root label>|<mounts>`, and its id. */
let box = "";
let boxId = "";
let dirA = "";
let dirB = "";
/** The state dir the config names (the default). */
let dirD = "";

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

/** bin/den, with DEN_EDGE_DIR set to `edgeDir` (unset: the default). */
function den(
  args: string[],
  edgeDir: string | null,
): { code: number; out: string } {
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
      ...(edgeDir ? { DEN_EDGE_DIR: edgeDir } : {}),
      DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const docker = (): string[] =>
  fs.readFileSync(log, "utf-8").split("\n").filter(Boolean);
const composeCalls = () => docker().filter((l) => l.startsWith("compose"));
const container = () => ({
  state: fs.existsSync(box) ? fs.readFileSync(box, "utf-8") : null,
  id: fs.existsSync(boxId) ? fs.readFileSync(boxId, "utf-8") : null,
});
/** A legacy edge: no den.edge.root label, its dynamic dir mounted from `dir`. */
function legacyEdge(dir: string): void {
  write(box, `<no value>|${dir}/dynamic>/etc/edge/dynamic;\n`);
  write(boxId, "legacy0\n");
}

beforeAll(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-edge-owner-")),
  );
  root = path.join(tmp, "den");
  const repos = path.join(tmp, "repos");
  dirA = path.join(tmp, "edge-a");
  dirB = path.join(tmp, "edge-b");
  dirD = path.join(tmp, "edge-default");
  shim = path.join(tmp, "shim");
  log = path.join(tmp, "docker.log");
  box = path.join(tmp, "container");
  boxId = path.join(tmp, "container.id");
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
      `  state_dir: ${dirD}`,
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    "shop:\n  gh: acme/shop\n",
  );
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [default]",
      "focus: default",
      "workspaces:",
      "  default:",
      "    services:",
      "      shop:",
      "        mode: dev-managed",
      `        path: ${path.join(repos, "shop")}`,
      "",
    ].join("\n"),
  );
  write(
    path.join(repos, "shop", ".den.yml"),
    "name: shop\ncompose:\n  routes: { app: web:80 }\nservices:\n  shop: {}\n",
  );
  write(path.join(repos, "shop", "docker-compose.yml"), "services: {}\n");
  write(
    path.join(shim, "docker"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${log}'`,
      'f=""; prev=""',
      'for a in "$@"; do [ "$prev" = "-f" ] && [ -z "$f" ] && f="$a"; prev="$a"; done',
      'case " $* " in',
      `  *' inspect --type container '*) [ -f '${box}' ] && cat '${box}' && exit 0; exit 1 ;;`,
      `  *' config --format json '*) echo '{"name":"shop-main","services":{"web":{"ports":[{"target":80}]}}}' ;;`,
      // The edge's own compose file: up (re)creates the container, down removes it.
      "  *' -p '*) ;;",
      "  *' compose -f '*' up '*)",
      '    r=$(sed -n "s/^ *den\\.edge\\.root: //p" "$f")',
      `    printf '%s|%s>/etc/edge/dynamic;\\n' "$r" "$(dirname "$f")/dynamic" > '${box}'`,
      `    echo "c$$" > '${boxId}' ;;`,
      `  *' compose -f '*' down '*) rm -f '${box}' '${boxId}' ;;`,
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    0o755,
  );
});

beforeEach(() => {
  write(log, "");
  fs.rmSync(box, { force: true });
  fs.rmSync(boxId, { force: true });
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const refusal = (dir: string) =>
  `edge acme-edge belongs to ${dir}; not replacing it`;

describe("two state dirs, one edge.org", () => {
  it("the first dir's edge up labels the container with its state dir", () => {
    const r = den(["edge", "up"], dirA);
    expect(r.code).toBe(0);
    expect(container().state).toBe(
      `${dirA}|${dirA}/dynamic>/etc/edge/dynamic;\n`,
    );
    expect(fs.readFileSync(path.join(dirA, "compose.yml"), "utf-8")).toMatch(
      /den\.edge\.root: .*edge-a\n\s+den\.edge\.org: acme\n/,
    );
  });

  it("the second dir's stack up is refused: no compose call, the first's container id and mounts unchanged", () => {
    expect(den(["edge", "up"], dirA).code).toBe(0);
    const before = container();
    write(log, "");
    const r = den(["stack", "up", "shop"], dirB);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(refusal(dirA));
    expect(r.out).toContain("Give this root a distinct edge.org.");
    expect(composeCalls()).toEqual([]);
    expect(container()).toEqual(before);
    expect(fs.existsSync(path.join(dirB, "compose.yml"))).toBe(false);
  });

  it("the second dir's edge up and edge down are refused the same way", () => {
    expect(den(["edge", "up"], dirA).code).toBe(0);
    const before = container();
    write(log, "");
    for (const sub of ["up", "down"]) {
      const r = den(["edge", sub], dirB);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(refusal(dirA));
    }
    expect(composeCalls()).toEqual([]);
    expect(container()).toEqual(before);
  });

  it("from its own dir edge up, stack up and edge down proceed as before", () => {
    expect(den(["edge", "up"], dirA).code).toBe(0);
    write(log, "");
    expect(den(["edge", "up"], dirA).code).toBe(0);
    expect(composeCalls()).toEqual([
      `compose -f ${dirA}/compose.yml up -d --remove-orphans`,
    ]);
    const st = den(["stack", "up", "shop"], dirA);
    expect(st.code).toBe(0);
    expect(composeCalls().some((c) => c.includes("-p shop-main"))).toBe(true);
    expect(den(["edge", "down"], dirA).code).toBe(0);
    expect(container().state).toBeNull();
  });

  it("edge up --take-over is the only override", () => {
    expect(den(["edge", "up"], dirA).code).toBe(0);
    const r = den(["edge", "up", "--take-over"], dirB);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`Taking over edge acme-edge from ${dirA}`);
    expect(container().state).toBe(
      `${dirB}|${dirB}/dynamic>/etc/edge/dynamic;\n`,
    );
    // Nothing else takes over: stack up from the first dir is now refused.
    const st = den(["stack", "up", "shop"], dirA);
    expect(st.code).not.toBe(0);
    expect(st.out).toContain(refusal(dirB));
  });

  it("with no edge at all it proceeds from any dir", () => {
    const r = den(["edge", "up"], dirB);
    expect(r.code).toBe(0);
    expect(composeCalls()).toEqual([
      `compose -f ${dirB}/compose.yml up -d --remove-orphans`,
    ]);
  });
});

describe("an unlabelled (legacy) edge", () => {
  it("is adopted from the default state dir: the first edge up there recreates it once, labelled", () => {
    legacyEdge(dirD);
    const r = den(["edge", "up"], null);
    expect(r.code).toBe(0);
    expect(composeCalls()).toEqual([
      `compose -f ${dirD}/compose.yml up -d --remove-orphans`,
    ]);
    expect(container().state).toBe(
      `${dirD}|${dirD}/dynamic>/etc/edge/dynamic;\n`,
    );
  });

  it("is never adopted under a DEN_EDGE_DIR that overrides the default: refused, naming its mounts' dir", () => {
    legacyEdge(dirD);
    const before = container();
    for (const argv of [
      ["edge", "up"],
      ["stack", "up", "shop"],
      ["edge", "down"],
    ]) {
      const r = den(argv, dirB);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(refusal(dirD));
    }
    expect(composeCalls()).toEqual([]);
    expect(container()).toEqual(before);
  });
});
