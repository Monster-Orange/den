/**
 * Switching theme or mode is a UI preference and nothing else (a consumer's
 * acceptance criterion 5): through the real server's API, it writes the
 * `appearance` block of config/local/user.yml and changes no other file,
 * not the edge config, not the routes, not services, and not the web
 * service process (same pid, no restart). Pinning to the rail and
 * collapsing it (0.3.0-dev.17, R14) are held to the same rule: only
 * user.yml's `shell` block changes; so is switching the view scope
 * (0.3.0-dev.18, R4): only user.yml's `view` changes.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as yaml from "yaml";

const ENGINE = process.cwd();
const PORT = 21876 + Math.floor(Math.random() * 1000);
let tmp: string;
let dist: string;
let server: ChildProcess | null = null;

function request(
  method: string,
  p: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: p,
        method,
        timeout: 10_000,
        headers: data
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(data),
            }
          : {},
      },
      (res) => {
        let out = "";
        res.on("data", (c: Buffer) => (out += c.toString()));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: out }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end(data);
  });
}

/** Every file under tmp (the distribution and the state home) → sha256. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile())
        out[path.relative(tmp, abs)] = createHash("sha256")
          .update(fs.readFileSync(abs))
          .digest("hex");
    }
  };
  walk(tmp);
  return out;
}

const USER_YML = path.join("dist", "config", "local", "user.yml");

beforeAll(async () => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-theme-iso-")),
  );
  dist = path.join(tmp, "dist");
  fs.mkdirSync(path.join(dist, "config", "local"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "home"));
  fs.writeFileSync(path.join(dist, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(dist, "config", "den.yml"),
    "brand:\n  theme: den\nedge:\n  org: acme\n  domain: acme.test\n  routes:\n    web: 7777\n",
  );
  fs.writeFileSync(
    path.join(dist, "config", "local", "user.yml"),
    yaml.stringify({
      editor: "vim",
      graph: { direction: "right" },
      edge: { aliases: ["mine.acme.test"] },
    }),
  );
  // Three active workspaces, for the view scope.
  fs.writeFileSync(
    path.join(dist, "config", "local", "workspaces.yml"),
    yaml.stringify({
      active: ["ws-a", "ws-b", "ws-c"],
      focus: "ws-a",
      workspaces: {
        "ws-a": { services: {} },
        "ws-b": { services: {} },
        "ws-c": { services: {} },
      },
    }),
  );
  // A local theme to switch to.
  fs.cpSync(
    path.join(ENGINE, "themes", "den"),
    path.join(dist, "plugins", "paper"),
    {
      recursive: true,
    },
  );
  const mf = path.join(dist, "plugins", "paper", "den-theme.json");
  fs.writeFileSync(
    mf,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(mf, "utf-8")),
      id: "paper",
      name: "Paper",
    }),
  );

  server = spawn(
    process.execPath,
    [
      path.join(ENGINE, "node_modules", ".bin", "tsx"),
      path.join(ENGINE, "src", "ui", "server", "index.ts"),
    ],
    {
      cwd: dist,
      env: {
        ...process.env,
        DEN_ROOT: dist,
        DEN_ENGINE_ROOT: ENGINE,
        DEN_HOME: path.join(tmp, "home", ".den"),
        HOME: path.join(tmp, "home"),
        PORT: String(PORT),
        DEN_NO_OPEN: "1",
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    try {
      if ((await request("GET", "/api/server-info")).status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("server did not start within 20s");
}, 30_000);

afterAll(() => {
  server?.kill("SIGTERM");
  server = null;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("switching theme or mode (criterion 5)", () => {
  it("changes nothing but the appearance block of the settings file", async () => {
    const info = JSON.parse(
      (await request("GET", "/api/server-info")).body,
    ) as {
      pid: number;
      startedAt: string;
    };
    const edgeBefore = (await request("GET", "/api/edge")).body;
    const daemonsBefore = (await request("GET", "/api/service/daemons")).body;
    const userBefore = yaml.parse(
      fs.readFileSync(path.join(tmp, USER_YML), "utf-8"),
    ) as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 500)); // let start-up writes settle
    const before = snapshot();

    for (const appearance of [
      { theme: "paper", mode: "light" },
      { mode: "dark" },
      { theme: "den", mode: "system" },
      { theme: "paper" },
    ]) {
      const r = await request("POST", "/api/settings", { appearance });
      expect([appearance, r.status]).toEqual([appearance, 200]);
    }
    // The UI then re-fetches the CSS: it follows the new choice.
    expect((await request("GET", "/theme.css")).body).toMatch(
      /Paper .*\(paper,/,
    );
    const themes = JSON.parse((await request("GET", "/api/themes")).body) as {
      active: { id: string };
      prefs: { theme: string; mode: string };
    };
    expect(themes.active.id).toBe("paper");
    expect(themes.prefs).toEqual({ theme: "paper", mode: "system" });
    // Each page's pre-paint script gets the saved mode and the theme's default.
    await request("POST", "/api/settings", { appearance: { mode: "light" } });
    const page = (await request("GET", "/services")).body;
    expect(page).toContain('var m = "light"');
    expect(page).toContain('"dark";'); // paper (a copy of den) defaults to dark
    expect(page).not.toMatch(/@@DEN_/);
    await request("POST", "/api/settings", { appearance: { mode: "system" } });

    await new Promise((r) => setTimeout(r, 500));
    const after = snapshot();
    const changed = Object.keys({ ...before, ...after }).filter(
      (f) => before[f] !== after[f],
    );
    expect(changed).toEqual([USER_YML]);

    const userAfter = yaml.parse(
      fs.readFileSync(path.join(tmp, USER_YML), "utf-8"),
    ) as Record<string, unknown>;
    const { appearance, ...rest } = userAfter;
    expect(appearance).toEqual({ theme: "paper" });
    expect(rest).toEqual(userBefore);

    // Same edge, same services, same process (no restart).
    expect((await request("GET", "/api/edge")).body).toBe(edgeBefore);
    expect((await request("GET", "/api/service/daemons")).body).toBe(
      daemonsBefore,
    );
    const infoAfter = JSON.parse(
      (await request("GET", "/api/server-info")).body,
    ) as typeof info;
    expect(infoAfter.pid).toBe(info.pid);
    expect(infoAfter.startedAt).toBe(info.startedAt);
  }, 30_000);

  it("Org default stores null; the org's theme by name is pinned", async () => {
    const settings = async () =>
      (
        JSON.parse((await request("GET", "/api/settings")).body) as {
          appearance: { theme: string | null };
        }
      ).appearance.theme;
    const themes = async () =>
      JSON.parse((await request("GET", "/api/themes")).body) as {
        org_default: { id: string; name: string };
        active: { id: string; chosen_by: string };
      };
    const stored = () =>
      (
        yaml.parse(fs.readFileSync(path.join(tmp, USER_YML), "utf-8")) as {
          appearance?: { theme?: string };
        }
      ).appearance?.theme;
    // The org config's brand.theme is den: the menu's "Org default (Den)".
    expect((await themes()).org_default).toEqual({ id: "den", name: "Den" });
    for (const [theme, kept, chosenBy] of [
      [null, null, "distribution"],
      ["den", "den", "user"],
    ] as const) {
      expect(
        (
          await request("POST", "/api/settings", {
            appearance: { theme: "paper" },
          })
        ).status,
      ).toBe(200);
      expect(await settings()).toBe("paper");
      expect(
        (await request("POST", "/api/settings", { appearance: { theme } }))
          .status,
      ).toBe(200);
      // Org default (null) follows a later brand.theme change; den picked
      // by name is a pin that keeps den.
      expect(await settings()).toBe(kept);
      expect((await themes()).active).toEqual(
        expect.objectContaining({ id: "den", chosen_by: chosenBy }),
      );
      expect(stored()).toBe(kept ?? undefined);
    }
    // Leave no pin for the tests after this one.
    await request("POST", "/api/settings", { appearance: { theme: null } });
  });

  it("refuses a theme that is not installed, writing nothing", async () => {
    const before = snapshot();
    const r = await request("POST", "/api/settings", {
      appearance: { theme: "nope" },
    });
    expect(r.status).toBe(400);
    expect(snapshot()).toEqual(before);
  });
});

describe("switching the view scope", () => {
  it("changes nothing but the view block of the settings file", async () => {
    const info = JSON.parse(
      (await request("GET", "/api/server-info")).body,
    ) as { pid: number; startedAt: string };
    const edgeBefore = (await request("GET", "/api/edge")).body;
    const daemonsBefore = (await request("GET", "/api/service/daemons")).body;
    // Active set and focus (GET /api/workspaces itself lays out workspace
    // folders for a terminal editor, so not its whole body).
    const workspaces = async () => {
      const w = JSON.parse((await request("GET", "/api/workspaces")).body) as {
        active: string[];
        focus: string;
        workspaces: unknown;
      };
      return [w.active, w.focus, w.workspaces];
    };
    const wsBefore = await workspaces();
    const userBefore = yaml.parse(
      fs.readFileSync(path.join(tmp, USER_YML), "utf-8"),
    ) as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 500));
    const before = snapshot();

    for (const scope of ["ws-b", "all", "ws-c", "ws-a", "ws-b"]) {
      const r = await request("POST", "/api/scope", { scope });
      expect([scope, r.status]).toEqual([scope, 200]);
      // The pages and the health row read the new view right away.
      const view = JSON.parse((await request("GET", "/api/scope")).body) as {
        scope: string;
        focus: string;
      };
      expect([scope, view.scope, view.focus]).toEqual([scope, scope, "ws-a"]);
      expect((await request("GET", "/api/health")).status).toBe(200);
      expect((await request("GET", "/api/services")).status).toBe(200);
    }

    await new Promise((r) => setTimeout(r, 500));
    const after = snapshot();
    const changed = Object.keys({ ...before, ...after }).filter(
      (f) => before[f] !== after[f],
    );
    expect(changed).toEqual([USER_YML]);
    const { view, ...rest } = yaml.parse(
      fs.readFileSync(path.join(tmp, USER_YML), "utf-8"),
    ) as Record<string, unknown>;
    expect(view).toEqual({ scope: "ws-b" });
    expect(rest).toEqual(userBefore);

    // Same edge, same services, same workspaces and focus, same process.
    expect((await request("GET", "/api/edge")).body).toBe(edgeBefore);
    expect((await request("GET", "/api/service/daemons")).body).toBe(
      daemonsBefore,
    );
    expect(await workspaces()).toEqual(wsBefore);
    const infoAfter = JSON.parse(
      (await request("GET", "/api/server-info")).body,
    ) as typeof info;
    expect([infoAfter.pid, infoAfter.startedAt]).toEqual([
      info.pid,
      info.startedAt,
    ]);
    await request("POST", "/api/scope", { scope: "all" });
  }, 30_000);
});

describe("pinning and collapsing the rail (R14)", () => {
  it("changes nothing but the shell block of the settings file", async () => {
    const info = JSON.parse(
      (await request("GET", "/api/server-info")).body,
    ) as { pid: number; startedAt: string };
    const edgeBefore = (await request("GET", "/api/edge")).body;
    const daemonsBefore = (await request("GET", "/api/service/daemons")).body;
    const userBefore = yaml.parse(
      fs.readFileSync(path.join(tmp, USER_YML), "utf-8"),
    ) as Record<string, unknown>;
    await new Promise((r) => setTimeout(r, 500));
    const before = snapshot();

    for (const shell of [
      { pins: ["shop"] },
      { pins: ["shop", "billing/api"] },
      { collapsed: true },
      { pins: ["billing/api"], collapsed: false },
    ]) {
      const r = await request("POST", "/api/settings", { shell });
      expect([shell, r.status]).toEqual([shell, 200]);
    }
    const got = JSON.parse((await request("GET", "/api/settings")).body) as {
      shell: unknown;
    };
    expect(got.shell).toEqual({ pins: ["billing/api"], collapsed: false });
    // A bad pin is refused and writes nothing.
    const bad = await request("POST", "/api/settings", {
      shell: { pins: ["../etc"] },
    });
    expect(bad.status).toBe(400);

    await new Promise((r) => setTimeout(r, 500));
    const after = snapshot();
    const changed = Object.keys({ ...before, ...after }).filter(
      (f) => before[f] !== after[f],
    );
    expect(changed).toEqual([USER_YML]);
    const { shell, ...rest } = yaml.parse(
      fs.readFileSync(path.join(tmp, USER_YML), "utf-8"),
    ) as Record<string, unknown>;
    expect(shell).toEqual({ pins: ["billing/api"] });
    expect(rest).toEqual(userBefore);

    expect((await request("GET", "/api/edge")).body).toBe(edgeBefore);
    expect((await request("GET", "/api/service/daemons")).body).toBe(
      daemonsBefore,
    );
    const infoAfter = JSON.parse(
      (await request("GET", "/api/server-info")).body,
    ) as typeof info;
    expect([infoAfter.pid, infoAfter.startedAt]).toEqual([
      info.pid,
      info.startedAt,
    ]);
    await request("POST", "/api/settings", { shell: { pins: [] } });
  }, 30_000);
});
