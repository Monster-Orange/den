/**
 * No `stack_namespace` anywhere: nothing changes (0.3.0-dev.36). For the
 * `default` workspace (projects `<stack>-main`) and a named one
 * (`<stack>-<name>`), `up -n`, `stack ls`, and every docker call `stack up`
 * and `stack down` make (project, container, volume and network names, and
 * the compose env), the override and route files they write, are
 * byte-identical to the engine before stack namespaces existed. The golden
 * file is that engine's own output (0.3.0-dev.35, 9810b7a); regenerate it
 * only on purpose, with DEN_UPDATE_GOLDEN=1 against that engine.
 *
 * Real bin/den in a throwaway distribution (acme/shop, acme/cart); `docker`
 * is a shim on PATH that records its argv and answers `compose config`.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
const GOLDEN = path.join(
  ENGINE,
  "tests",
  "fixtures",
  "stacks",
  "default-namespace.golden.json",
);
let tmp = "";
let root = "";
let repos = "";
let shim = "";
let log = "";
let edgeDir = "";

function write(file: string, content: string, mode?: number): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, mode ? { mode } : undefined);
}

/** `<TMP>` for the throwaway paths; no colour codes. */
const norm = (s: string): string =>
  s
    .split(tmp)
    .join("<TMP>")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "");

function den(args: string[]): string {
  const r = spawnSync(path.join(ENGINE, "bin", "den"), args, {
    cwd: root,
    encoding: "utf-8",
    env: {
      ...process.env,
      DEN_ROOT: root,
      DEN_HOME: path.join(tmp, "home"),
      DEN_EDGE_DIR: edgeDir,
      DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
      DEN_STACK_WORKSPACE: "",
      DEN_WORKSPACE_OVERRIDE: "",
      PATH: `${shim}:${process.env.PATH ?? ""}`,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 60_000,
  });
  return norm(`${r.stdout}${r.stderr}`);
}

/** Every file the stacks wrote under the edge state: overrides and routes. */
function written(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/override\.yml$|^stack-.*\.yml$/.test(e.name))
        out[norm(p)] = norm(fs.readFileSync(p, "utf-8"));
    }
  };
  walk(edgeDir);
  return out;
}

function run(workspace: string) {
  write(log, "");
  const upPlan = den(["up", "-n", "cart", "shop", "-w", workspace]);
  const ls = den(["stack", "ls", "-w", workspace]);
  const upOut = den(["stack", "up", "cart", "-w", workspace]);
  const files = written();
  const downOut = den(["stack", "down", "cart", "shop", "-w", workspace]);
  const docker = norm(fs.readFileSync(log, "utf-8"))
    .split("\n")
    .filter(Boolean);
  return { upPlan, ls, upOut, downOut, docker, files };
}

beforeAll(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-ns-bytes-")),
  );
  root = path.join(tmp, "den");
  repos = path.join(tmp, "repos");
  edgeDir = path.join(tmp, "edge");
  shim = path.join(tmp, "shim");
  log = path.join(tmp, "docker.log");
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
      "",
    ].join("\n"),
  );
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    "shop:\n  gh: acme/shop\ncart:\n  gh: acme/cart\n",
  );
  const member = (r: string) => [
    `      ${r}:`,
    "        mode: dev-managed",
    `        path: ${path.join(repos, r)}`,
  ];
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    [
      "active: [default, ws-a]",
      "focus: default",
      "workspaces:",
      "  default:",
      "    services:",
      ...member("shop"),
      ...member("cart"),
      "  ws-a:",
      "    services:",
      ...member("shop"),
      ...member("cart"),
      "",
    ].join("\n"),
  );
  write(
    path.join(repos, "shop", ".den.yml"),
    [
      "name: shop",
      "compose:",
      "  routes: { app: web:80 }",
      "services:",
      "  shop: {}",
      "",
    ].join("\n"),
  );
  write(
    path.join(repos, "cart", ".den.yml"),
    [
      "name: cart",
      "compose:",
      "  routes: { api: api:3001 }",
      "  uses: [shop]",
      "  env:",
      '    SHOP_URL: "http://{shop.web}:80"',
      "services:",
      "  cart: {}",
      "",
    ].join("\n"),
  );
  for (const r of ["shop", "cart"])
    write(path.join(repos, r, "docker-compose.yml"), "services: {}\n");
  // docker: record argv and the compose project env; answer `compose
  // config` with the project's services, volume and network; say every
  // container runs and every network exists.
  write(
    path.join(shim, "docker"),
    [
      "#!/bin/sh",
      `printf '%s|%s\\n' "COMPOSE_PROJECT_NAME=$COMPOSE_PROJECT_NAME SHOP_URL=$SHOP_URL" "$*" >> '${log}'`,
      'p=""; prev=""',
      'for a in "$@"; do [ "$prev" = "-p" ] && p="$a"; prev="$a"; done',
      'case " $* " in',
      "  *' config --format json '*)",
      '    printf \'{"name":"%s","services":{"web":{"ports":[{"target":80}]},"api":{"ports":[{"target":3001}]},"db":{"volumes":[{"type":"volume","source":"data","target":"/data"}]}},"networks":{"default":{"name":"%s_default"}},"volumes":{"data":{"name":"%s_data"}}}\\n\' "$p" "$p" "$p" ;;',
      "  *' inspect -f '*) echo true ;;",
      "esac",
      "exit 0",
      "",
    ].join("\n"),
    0o755,
  );
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("no stack_namespace: byte-identical names", () => {
  it("default (→ main) and a named workspace run exactly as before", () => {
    const got = { default: run("default"), "ws-a": run("ws-a") };
    if (process.env.DEN_UPDATE_GOLDEN === "1") {
      write(GOLDEN, JSON.stringify(got, null, 2) + "\n");
      return;
    }
    const golden = JSON.parse(fs.readFileSync(GOLDEN, "utf-8")) as typeof got;
    // The names themselves, said plainly, then every byte.
    expect(got.default.ls).toContain("project shop-main");
    expect(got["ws-a"].ls).toContain("project shop-ws-a");
    expect(got.default).toEqual(golden.default);
    expect(got["ws-a"]).toEqual(golden["ws-a"]);
  }, 120_000);
});
