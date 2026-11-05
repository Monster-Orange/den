/**
 * The shell (0.3.0-dev.14): one top bar and one left rail, drawn by
 * public/shell.js on every page. Pages hold only their content: no page
 * keeps its own header, nav or env picker.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");
const SHELL = read("shell.js");

/** Page file → the rail entry it marks current, and its health pin. */
const PAGES: Record<string, { page: string; healthEnv?: string }> = {
  "local-dev.html": { page: "local-dev", healthEnv: "local" },
  "services.html": { page: "services" },
  "environments.html": { page: "environments" },
  "release.html": { page: "release", healthEnv: "local" },
  "logs.html": { page: "logs" },
  "index.html": { page: "tests" },
};

describe("every page mounts the shell", () => {
  it.each(Object.keys(PAGES))("%s names its page in the title", (file) => {
    expect(read(file)).toMatch(/<title>__DEN_TITLE__ · [A-Z][\w ]+<\/title>/);
  });

  it("covers every page in public/", () => {
    expect(
      fs
        .readdirSync(PUBLIC)
        .filter((f) => f.endsWith(".html"))
        .sort(),
    ).toEqual(Object.keys(PAGES).sort());
  });

  it.each(Object.entries(PAGES))(
    "%s starts its body with the shell, then shell.js",
    (file, { page, healthEnv }) => {
      const html = read(file);
      const body = html.slice(html.indexOf("<body"));
      const first = body.slice(body.indexOf(">") + 1).trimStart();
      const pin = healthEnv ? ` data-health-env="${healthEnv}"` : "";
      expect(first).toMatch(
        new RegExp(
          `^<!--[^\\n]*-->\\s*<div id="den-shell" data-page="${page}"${pin}></div>\\s*<script src="/shell.js"></script>`,
        ),
      );
    },
  );

  it.each(Object.keys(PAGES))(
    "%s keeps no header, nav, env picker or header CSS of its own",
    (file) => {
      const html = read(file);
      expect(html).not.toMatch(/<header[\s>]/);
      expect(html).not.toMatch(/class="topbar"/);
      // Content may have its own nav (Local Dev's settings); not the pages.
      expect(html.match(/<nav[\s>][^>]*/g) ?? []).toEqual(
        file === "local-dev.html" ? ['<nav class="settings-nav"'] : [],
      );
      for (const id of [
        "env-sel",
        "version-pill",
        "health",
        "den-mark",
        "ws-pill",
      ])
        expect(html).not.toContain(`id="${id}"`);
      expect(html).not.toMatch(/^\s*(header|nav a|\.topbar)\s*\{/m);
      // Nothing fills an env picker of its own (Environments still lists
      // every env as its columns).
      expect(html).not.toMatch(/envSel\.innerHTML = envs/);
    },
  );

  it("is served", async () => {
    const { UI_MODULES } = await import("../../../src/ui/server/ui-assets.js");
    expect(UI_MODULES).toContain("/shell.js");
  });
});

describe("the shell's source", () => {
  it("draws the title in the theme's display face", () => {
    expect(SHELL).toMatch(/\.den-title \{ font: 600 15px var\(--display\);/);
  });
  it("uses no color literal (theme tokens only, R2)", () => {
    expect(SHELL).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
  it("lists pages only in its NAV registry (R11a)", () => {
    // Every page href in shell.js is one registry entry's `href:`, and the
    // pages themselves draw no rail links.
    const hrefs = [...SHELL.matchAll(/href: "(\/[^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.sort()).toEqual(
      [
        "/environments",
        "/local-dev",
        "/local-dev?settings=1",
        "/logs",
        "/release",
        "/services",
        "/tests",
      ].sort(),
    );
    expect(SHELL).not.toMatch(
      /href="\/(local-dev|services|logs|tests|environments|release)"/,
    );
    for (const f of Object.keys(PAGES))
      expect(read(f)).not.toMatch(/class="den-(ni|rail-link)"/);
  });
});

describe("frame leftovers are gone", () => {
  it("Logs' layout toggle is in its toolbar, not a band of its own", () => {
    const html = read("logs.html");
    expect(html).not.toContain('class="subbar"');
    const bar = html.slice(
      html.indexOf('<div class="logs-toolbar" id="logs-toolbar">'),
      html.indexOf('<div class="logs-area'),
    );
    expect(bar).toContain('id="log-dir-seg"');
  });
});

describe("header.js drives one env for every page", () => {
  const header = read("header.js");
  it("fills the shell's picker and restores the last env", () => {
    expect(header).toMatch(/export function envReady\(\)/);
    expect(header).toMatch(/localStorage\.setItem\(LS_ENV, sel\.value\)/);
  });
  it("switching the env view is a browser preference: no request at all", () => {
    // Criterion 5: switching the view never touches edge routes, containers
    // or the service. The picker's own handler only remembers the choice;
    // pages then re-read (GET) what they show.
    const body = header.slice(
      header.indexOf("export function envReady()"),
      header.indexOf("export function currentEnv()"),
    );
    const onChange = body.slice(body.indexOf('sel.addEventListener("change"'));
    expect(onChange).not.toMatch(/fetch\(/);
    expect(onChange).toMatch(/localStorage\.setItem/);
  });
  it.each(["index.html", "services.html", "logs.html"])(
    "%s waits for it instead of filling its own",
    (f) => {
      expect(read(f)).toMatch(/await envReady\(\);/);
    },
  );
  it("Local Dev and Releases check local health, whatever the picker says", () => {
    expect(header).toMatch(/dataset\?\.healthEnv \|\| currentEnv\(\)/);
    expect(read("local-dev.html")).not.toMatch(/getElementById\("env-sel/);
  });
});

describe("Environments groups services by their repo's org", () => {
  const env = read("environments.html");
  it("reads each repo's org from /api/orgs?repos=1, not from health rows", () => {
    // /api/health rows carry no org: reading r.org put every service under
    // "no org".
    expect(env).toContain('fetch("/api/orgs?repos=1")');
    expect(env).toMatch(/org: orgOfRepo\[r\.repo\] \|\| ""/);
    expect(env).not.toMatch(/org: r\.org/);
  });
  it("loads the shell's behaviour like every other page", () => {
    expect(env).toMatch(/from "\/header\.js"/);
  });
});
