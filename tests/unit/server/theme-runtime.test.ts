/**
 * The theme runtime: which theme the web UI draws with (the user's, then the
 * distribution's, then den), /theme.css for it, the files /theme/<id>/<file>
 * may serve, and /api/themes.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  APPEARANCE_DEFAULTS,
  appearancePrefs,
  mergeAppearancePrefs,
  storedAppearance,
  type AppearancePrefs,
} from "../../../src/ui/server/appearance-prefs.js";
import {
  handleThemeRoutes,
  type ThemeRouteDeps,
} from "../../../src/ui/server/theme-routes.js";
import {
  COLOR_TOKENS,
  listThemes,
  renderThemeCss,
  resetThemeWarnings,
  resolveActiveTheme,
  type ThemeRoots,
} from "../../../src/ui/server/theme-runtime.js";

const ENGINE = process.cwd();
const DEN_DIR = path.join(ENGINE, "themes", "den");
const den = JSON.parse(
  fs.readFileSync(path.join(DEN_DIR, "den-theme.json"), "utf-8"),
) as { modes: Record<"dark" | "light", Record<string, string>> };

let tmp: string;
let roots: ThemeRoots;

/** A copy of den as plugins/<id>/, optionally edited. */
function plugin(
  id: string,
  edit: (m: Record<string, unknown>) => void = () => {},
) {
  const dir = path.join(tmp, "dist", "plugins", id);
  fs.cpSync(DEN_DIR, dir, { recursive: true });
  const file = path.join(dir, "den-theme.json");
  const m = JSON.parse(fs.readFileSync(file, "utf-8")) as Record<
    string,
    unknown
  >;
  Object.assign(m, { id, name: id[0].toUpperCase() + id.slice(1) });
  edit(m);
  fs.writeFileSync(file, JSON.stringify(m, null, 2));
  return dir;
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-theme-rt-"));
  fs.mkdirSync(path.join(tmp, "dist"));
  roots = { distRoot: path.join(tmp, "dist"), engineRoot: ENGINE };
  plugin("paper", (m) => {
    m.default_mode = "light";
    m.fonts = [
      {
        family: "Paper Sans",
        license: "OFL-1.1",
        files: [{ path: "fonts/paper-400.woff2", weight: "400" }],
      },
    ];
  });
  const fonts = path.join(roots.distRoot, "plugins", "paper", "fonts");
  fs.mkdirSync(fonts);
  fs.writeFileSync(path.join(fonts, "paper-400.woff2"), "wOF2 not really");
  fs.writeFileSync(path.join(fonts, "OFL.txt"), "SIL OFL 1.1");
  fs.writeFileSync(path.join(fonts, "secret.woff2"), "wOF2 unnamed");
  fs.writeFileSync(
    path.join(roots.distRoot, "plugins", "paper", "notes.txt"),
    "not a theme file",
  );
  // A locked theme (vendored by `theme add`).
  plugin("ink");
  fs.writeFileSync(
    path.join(roots.distRoot, "plugins.lock.json"),
    JSON.stringify({
      plugins: {
        ink: {
          id: "ink",
          name: "Ink",
          version: "2.0.0",
          source: "https://example.test/themes.git",
          ref: "v1",
          commit: "0".repeat(40),
          sha256: "x",
          kinds: ["theme"],
          approved_capabilities: [],
        },
      },
    }),
  );
  // Invalid: unreadable text (contrast fails).
  plugin("broken", (m) => {
    const modes = m.modes as Record<string, Record<string, string>>;
    modes.dark.text = modes.dark.bg;
  });
  fs.writeFileSync(path.join(tmp, "outside.svg"), "<svg/>");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe("resolveActiveTheme", () => {
  const pick = (user: string | null, distribution: string | null) => {
    resetThemeWarnings();
    const warnings: string[] = [];
    const a = resolveActiveTheme(roots, { user, distribution }, (l) =>
      warnings.push(l),
    );
    return { id: a?.id, by: a?.chosenBy, source: a?.source, warnings };
  };

  it("is den with no choice", () => {
    expect(pick(null, null)).toEqual({
      id: "den",
      by: "default",
      source: "built-in",
      warnings: [],
    });
  });

  it("takes the user's theme over the distribution's", () => {
    expect(pick("paper", "ink")).toMatchObject({ id: "paper", by: "user" });
    expect(pick(null, "ink")).toMatchObject({
      id: "ink",
      by: "distribution",
      source: "locked",
    });
    expect(pick("paper", null)).toMatchObject({ source: "local" });
  });

  it("falls back past an unknown or invalid id, warning once", () => {
    const r = pick("nope", null);
    expect(r).toMatchObject({ id: "den", by: "default" });
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/"nope".*not installed/);
    const b = pick("broken", "nope");
    expect(b).toMatchObject({ id: "den" });
    expect(b.warnings).toHaveLength(2);
    expect(b.warnings[0]).toMatch(/"broken".*not valid/);
    // A bad user choice falls through to the distribution's.
    expect(pick("broken", "paper")).toMatchObject({
      id: "paper",
      by: "distribution",
    });
  });

  it("warns once per bad choice, however often it resolves", () => {
    resetThemeWarnings();
    const w: string[] = [];
    for (let i = 0; i < 5; i++)
      resolveActiveTheme(roots, { user: "nope" }, (l) => w.push(l));
    expect(w).toHaveLength(1);
  });

  it("never throws, even for an id that is not a plugin id", () => {
    expect(pick("../../etc", "Den!")).toMatchObject({ id: "den" });
  });
});

describe("renderThemeCss (den)", () => {
  let css = "";
  beforeAll(() => {
    css = renderThemeCss(
      "den",
      listThemes(roots).find((t) => t.id === "den")!.theme!,
    );
  });
  const block = (mode: string) => {
    const m = css.match(
      new RegExp(`:root\\[data-mode="${mode}"\\] \\{([^}]*)\\}`),
    );
    if (!m) throw new Error(`no ${mode} block`);
    return m[1];
  };

  it("has a block per mode with every color token from the manifest", () => {
    for (const mode of ["dark", "light"] as const) {
      const b = block(mode);
      expect(b).toContain(`color-scheme: ${mode};`);
      for (const t of COLOR_TOKENS)
        expect(b).toContain(`--${t}: ${den.modes[mode][t]};`);
      expect(b).toMatch(/--shadow: /);
      expect(b).toMatch(/--bar: /);
    }
    expect(COLOR_TOKENS).toHaveLength(17);
  });

  it("applies the default mode with no data-mode, and sets type and shape", () => {
    expect(css).toContain(':root,\n:root[data-mode="dark"] {');
    for (const v of [
      "--sans",
      "--mono",
      "--display",
      "--ja",
      "--radius",
      "--radius-button",
    ])
      expect(css).toMatch(new RegExp(`${v}: [^;]+;`));
  });

  it("writes @font-face for a theme's fonts, from its own asset route", () => {
    const paper = listThemes(roots).find((t) => t.id === "paper")!;
    const p = renderThemeCss("paper", paper.theme!);
    expect(p).toContain(
      '@font-face { font-family: "Paper Sans"; src: url("/theme/paper/fonts/paper-400.woff2") format("woff2"); font-weight: 400;',
    );
    expect(p).toContain(':root,\n:root[data-mode="light"] {');
  });
});

describe("appearance prefs", () => {
  const usable = (id: string) => ["den", "paper"].includes(id);
  it("defaults to system and no theme; keeps a stored id", () => {
    expect(appearancePrefs(undefined)).toEqual(APPEARANCE_DEFAULTS);
    expect(appearancePrefs({ theme: "gone", mode: "light" })).toEqual({
      theme: "gone",
      mode: "light",
    });
    expect(appearancePrefs({ theme: "../x", mode: "blue" })).toEqual(
      APPEARANCE_DEFAULTS,
    );
  });
  it("accepts only installed, valid themes and known modes", () => {
    const cur: AppearancePrefs = { theme: null, mode: "system" };
    expect(mergeAppearancePrefs(cur, { theme: "paper" }, usable)).toEqual({
      ok: true,
      value: { theme: "paper", mode: "system" },
    });
    expect(mergeAppearancePrefs(cur, { theme: "broken" }, usable).ok).toBe(
      false,
    );
    expect(mergeAppearancePrefs(cur, { mode: "sepia" }, usable).ok).toBe(false);
    expect(mergeAppearancePrefs(cur, { edge: 1 }, usable).ok).toBe(false);
    expect(storedAppearance({ theme: null, mode: "system" })).toBeUndefined();
  });
});

describe("theme routes", () => {
  let server: http.Server;
  let base: string;
  let port: number;
  let prefs: AppearancePrefs = { theme: null, mode: "system" };
  const warnings: string[] = [];
  const deps: ThemeRouteDeps = {
    roots: () => roots,
    prefs: () => prefs,
    distributionTheme: () => null,
    warn: (l) => warnings.push(l),
  };
  const get = (p: string) =>
    new Promise<{
      status: number;
      headers: http.IncomingHttpHeaders;
      body: string;
    }>((resolve, reject) =>
      // The path is sent as written (no client-side URL normalising), so
      // the server sees every dot segment and escape.
      http
        .get({ host: "127.0.0.1", port, path: p }, (res) => {
          let body = "";
          res.on("data", (c: Buffer) => (body += c.toString("latin1")));
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body,
            }),
          );
        })
        .on("error", reject),
    );

  beforeAll(async () => {
    resetThemeWarnings();
    server = http.createServer((req, res) => {
      const pathname = (req.url ?? "/").split("?")[0];
      if (!handleThemeRoutes(req, res, pathname, deps)) {
        res.writeHead(418);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("GET /theme.css is the active theme, never cached", async () => {
    prefs = { theme: null, mode: "system" };
    const r = await get("/theme.css");
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/^text\/css/);
    expect(r.headers["cache-control"]).toBe("no-store");
    expect(r.body).toContain(`--bg: ${den.modes.dark.bg};`);
    prefs = { theme: "paper", mode: "light" };
    expect((await get("/theme.css")).body).toMatch(/Paper .*\(paper,/);
    prefs = { theme: "broken", mode: "light" };
    expect((await get("/theme.css")).body).toMatch(/^\/\* Den .*\(den,/);
  });

  it("serves the files a manifest names, with their types", async () => {
    const svg = await get("/theme/den/mark.svg");
    expect(svg.status).toBe(200);
    expect(svg.headers["content-type"]).toBe("image/svg+xml");
    expect(svg.headers["content-security-policy"]).toBe(
      "default-src 'none'; style-src 'unsafe-inline'",
    );
    const font = await get("/theme/paper/fonts/paper-400.woff2");
    expect(font.status).toBe(200);
    expect(font.headers["content-type"]).toBe("font/woff2");
  });

  it("refuses traversal, unnamed files, other types and invalid themes", async () => {
    for (const p of [
      "/theme/den/den-theme.json",
      "/theme/paper/notes.txt",
      "/theme/paper/fonts/secret.woff2",
      "/theme/paper/fonts/OFL.txt",
      "/theme/paper/../../outside.svg",
      "/theme/den/../paper/notes.txt",
      "/theme/paper/..%2F..%2Foutside.svg",
      "/theme/paper/%2e%2e/%2e%2e/outside.svg",
      "/theme/paper/fonts%2Fpaper-400.woff2",
      "/theme/paper/fonts/paper-400.woff2%00.svg",
      "/theme/..%2Fplugins%2Fpaper/mark.svg",
      "/theme/broken/mark.svg",
      "/theme/nope/mark.svg",
      "/theme/den/",
      "/theme/den/%E0%A4%A",
    ])
      expect([p, (await get(p)).status]).toEqual([p, 404]);
  });

  it("GET /api/themes lists every theme and the active one", async () => {
    prefs = { theme: "paper", mode: "dark" };
    const r = await get("/api/themes");
    expect(r.status).toBe(200);
    const data = JSON.parse(r.body) as {
      active: Record<string, unknown>;
      prefs: AppearancePrefs;
      themes: { id: string; source: string; ok: boolean }[];
    };
    expect(data.active).toMatchObject({
      id: "paper",
      source: "local",
      chosen_by: "user",
      default_mode: "light",
      mark: { svg: "/theme/paper/mark.svg" },
    });
    expect(data.prefs).toEqual({ theme: "paper", mode: "dark" });
    expect(data.themes.map((t) => [t.id, t.source, t.ok])).toEqual([
      ["den", "built-in", true],
      ["broken", "local", false],
      ["ink", "locked", true],
      ["paper", "local", true],
    ]);
  });

  it("is read-only", async () => {
    const status = await new Promise<number>((resolve) => {
      const req = http.request(base + "/theme.css", { method: "POST" }, (res) =>
        resolve(res.statusCode ?? 0),
      );
      req.end();
    });
    expect(status).toBe(405);
  });
});
