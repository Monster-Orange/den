/**
 * `<cli> relocate <repo> <path>` and `<cli> register <path> -w <ws>`.
 *
 * relocate: a checkout moved; every workspace's dev-managed entries for the
 * repo point at the new path, managed entries are left alone, focus and the
 * active set never change. It refuses a missing path and one that holds a
 * different repo (manifest name or GitHub remote). --dry-run writes nothing.
 *
 * register -w: writes that workspace (active or not) and leaves focus alone.
 *
 * Real bin/den in a throwaway distribution.
 */
import {
  afterAll,
  beforeEach,
  beforeAll,
  describe,
  expect,
  it,
} from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let root = "";
let repos = "";

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function den(...args: string[]): { code: number; out: string } {
  const r = spawnSync(path.join(ENGINE, "bin", "den"), args, {
    cwd: root,
    encoding: "utf-8",
    input: "",
    env: {
      ...process.env,
      DEN_ROOT: root,
      DEN_HOME: path.join(tmp, "home"),
      DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const WS_FILE = () => path.join(root, "config", "local", "workspaces.yml");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const workspaces = (): any => yaml.parse(fs.readFileSync(WS_FILE(), "utf-8"));

function manifest(dir: string, name: string): void {
  write(
    path.join(dir, ".den.yml"),
    `name: ${name}\nservices:\n  api:\n    commands:\n      local:\n        up: "true"\n`,
  );
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-relocate-"));
  root = path.join(tmp, "den");
  repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    "shop:\n  gh: acme/shop\nsite:\n  gh: acme/site\n",
  );
  manifest(path.join(repos, "old", "shop"), "shop");
  manifest(path.join(repos, "new", "shop"), "shop");
  manifest(path.join(repos, "site"), "site");
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const OLD = () => path.join(repos, "old", "shop");
const NEW = () => path.join(repos, "new", "shop");

beforeEach(() => {
  write(
    WS_FILE(),
    yaml.stringify({
      active: ["default"],
      focus: "default",
      workspaces: {
        default: {
          services: {
            shop: { mode: "dev-managed", path: OLD(), autostart: false },
            site: { mode: "dev-managed", path: path.join(repos, "site") },
          },
        },
        "ws-b": {
          services: {
            "shop/api": { mode: "dev-managed", path: OLD() },
          },
        },
        "ws-c": { services: { shop: { mode: "managed", branch: "main" } } },
      },
    }),
  );
});

describe("relocate", () => {
  it("rewrites every workspace's dev-managed entries; managed, focus and active untouched", () => {
    const r = den("relocate", "shop", NEW());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Pointed at .*new\/shop/);
    const w = workspaces();
    expect(w.workspaces.default.services.shop).toEqual({
      mode: "dev-managed",
      path: NEW(),
      autostart: false,
    });
    expect(w.workspaces["ws-b"].services["shop/api"].path).toBe(NEW());
    expect(w.workspaces["ws-c"].services.shop).toEqual({
      mode: "managed",
      branch: "main",
    });
    expect(w.workspaces.default.services.site.path).toBe(
      path.join(repos, "site"),
    );
    expect([w.focus, w.active]).toEqual(["default", ["default"]]);
    expect(r.out).toMatch(/managed \(Den's clone\): left alone/);
  });

  it("--dry-run reports and writes nothing", () => {
    const before = fs.readFileSync(WS_FILE(), "utf-8");
    const r = den("relocate", "shop", NEW(), "--dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Would point at/);
    expect(fs.readFileSync(WS_FILE(), "utf-8")).toBe(before);
  });

  it("-w limits it to that workspace, even an inactive one", () => {
    const r = den("relocate", "shop", NEW(), "-w", "ws-b");
    expect(r.code).toBe(0);
    const w = workspaces();
    expect(w.workspaces["ws-b"].services["shop/api"].path).toBe(NEW());
    expect(w.workspaces.default.services.shop.path).toBe(OLD());
    expect(w.focus).toBe("default");
  });

  it("refuses a missing path, a different repo, and an unknown repo", () => {
    const before = fs.readFileSync(WS_FILE(), "utf-8");
    const missing = den("relocate", "shop", path.join(repos, "nope"));
    expect(missing.code).toBe(1);
    expect(missing.out).toMatch(/Path does not exist/);
    const other = den("relocate", "shop", path.join(repos, "site"));
    expect(other.code).toBe(1);
    expect(other.out).toMatch(/holds "site", not "shop"/);
    const unknown = den("relocate", "ghost", NEW());
    expect(unknown.code).toBe(1);
    expect(unknown.out).toMatch(/"ghost" is not in any project/);
    expect(fs.readFileSync(WS_FILE(), "utf-8")).toBe(before);
  });

  it("refuses a checkout whose GitHub remote names another repo", () => {
    const clone = path.join(repos, "fork", "shop");
    manifest(clone, "shop");
    spawnSync("git", ["init", "-q", clone]);
    spawnSync("git", [
      "-C",
      clone,
      "remote",
      "add",
      "origin",
      "https://github.com/other/shop.git",
    ]);
    const r = den("relocate", "shop", clone);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(
      /checkout of other\/shop; the catalog has "shop" as acme\/shop/,
    );
  });
});

describe("relocate needs something that names the repo", () => {
  it("refuses an empty folder; --force accepts it", () => {
    const empty = path.join(repos, "empty-dir");
    fs.mkdirSync(empty, { recursive: true });
    const before = fs.readFileSync(WS_FILE(), "utf-8");
    const r = den("relocate", "shop", empty, "--dry-run");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Nothing at .*empty-dir says it is "shop"/);
    // The hint keeps the preview a preview, and the workspace.
    expect(r.out).toMatch(/relocate shop \S+ --force --dry-run\n/);
    const ws = den("relocate", "shop", empty, "-n", "-w", "ws-b");
    expect(ws.out).toMatch(/relocate shop \S+ --force --dry-run -w ws-b\n/);
    const forced = den("relocate", "shop", empty, "--force");
    expect(forced.code).toBe(0);
    expect(workspaces().workspaces.default.services.shop.path).toBe(empty);
    write(WS_FILE(), before);
  });

  it("a matching GitHub remote alone is enough", () => {
    const clone = path.join(repos, "bare-clone");
    fs.mkdirSync(clone, { recursive: true });
    spawnSync("git", ["init", "-q", clone]);
    spawnSync("git", [
      "-C",
      clone,
      "remote",
      "add",
      "origin",
      "https://github.com/acme/shop.git",
    ]);
    const r = den("relocate", "shop", clone, "--dry-run");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Would point at .*bare-clone/);
  });
});

describe("relocate with no gh in the catalog", () => {
  it("the remote's repo name must match the repo; another name is refused", () => {
    const cat = path.join(root, "config", "local", "service-catalog.yml");
    const catBefore = fs.readFileSync(cat, "utf-8");
    fs.writeFileSync(cat, 'shop:\n  gh: ""\nsite:\n  gh: acme/site\n');
    const clone = (dir: string, slug: string): string => {
      const p = path.join(repos, dir);
      fs.mkdirSync(p, { recursive: true });
      spawnSync("git", ["init", "-q", p]);
      spawnSync("git", [
        "-C",
        p,
        "remote",
        "add",
        "origin",
        `https://github.com/${slug}.git`,
      ]);
      return p;
    };
    try {
      const ok = den(
        "relocate",
        "shop",
        clone("nogh-shop", "anyone/shop"),
        "-n",
      );
      expect(ok.code).toBe(0);
      expect(ok.out).toMatch(/Would point at .*nogh-shop/);
      const bad = den(
        "relocate",
        "shop",
        clone("nogh-blog", "anyone/blog"),
        "-n",
      );
      expect(bad.code).toBe(1);
      expect(bad.out).toMatch(/Nothing at .*nogh-blog says it is "shop"/);
    } finally {
      fs.writeFileSync(cat, catBefore);
    }
  });
});

describe("register -w", () => {
  it("writes the named workspace (inactive) and leaves focus alone", () => {
    const dir = path.join(repos, "blog");
    manifest(dir, "blog");
    const r = den("register", dir, "-w", "ws-b");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Added to project "ws-b"/);
    const w = workspaces();
    expect(w.workspaces["ws-b"].services.blog).toEqual({
      mode: "dev-managed",
      path: dir,
    });
    expect(w.workspaces.default.services.blog).toBeUndefined();
    expect([w.focus, w.active]).toEqual(["default", ["default"]]);
  });

  it("an unknown -w is refused", () => {
    const r = den("register", path.join(repos, "site"), "-w", "nope");
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/Project "nope" does not exist/);
  });
});
