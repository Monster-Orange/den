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
  "settings.html": { page: "settings" },
  "index.html": { page: "tests" },
  "edge.html": { page: "edge" },
  // The Agents tab (AG-4a-term).
  "agents.html": { page: "agents" },
  // The server agent's page (ON-6).
  "server-agent.html": { page: "server-agent" },
  // The error page (R26a): a failed page request's, in the frame.
  "error.html": { page: "error" },
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
      // Content may have its own nav (the Settings page's categories); not
      // the pages. Local Dev's old settings panel and its nav are gone (R21).
      expect(
        (html.match(/<nav[\s>][^>]*/g) ?? []).map((n) =>
          n.replace(/\s+/g, " ").trim(),
        ),
      ).toEqual(
        file === "settings.html"
          ? [
              '<nav class="set-nav" id="set-nav" aria-label="Settings categories"',
            ]
          : [],
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
    // Black alone is allowed, for a modal scrim (as ui-color-tokens says).
    const scrim = /rgb\(0 0 0 \/ 0?\.\d+\)/g;
    expect(SHELL.replace(scrim, "")).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(SHELL.replace(scrim, "")).not.toMatch(/rgb\(0 0 0/);
  });
  it("draws the scope as the prototype's .ib menus, one Workspace control (R4)", () => {
    // / ORG / WORKSPACE ▾ / ENV ▾: no View select, no Focus pill, no menu
    // of header.js's own (the old pill and its .ws-menu are gone).
    expect(SHELL).toMatch(
      /<span id="org-crumb"[\s\S]*?scopeButton\("ws-pill", "ws"[\s\S]*?scopeButton\("env-btn", "env"/,
    );
    expect(SHELL).not.toMatch(/scope-sel|scope-wrap|den-ws-pill/);
    const header = read("header.js");
    expect(header).not.toMatch(
      /ws-menu|_renderPickerPill|key\.textContent = "Focus"/,
    );
    expect(read("workspace-picker.js")).not.toMatch(
      /buildWorkspacePillModel|buildWorkspaceMenuModel/,
    );
  });
  it("lists pages only in its NAV registry (R11a)", () => {
    // Every page href in shell.js is one registry entry's `href:`, and the
    // pages themselves draw no rail links.
    const all = [...SHELL.matchAll(/href: "(\/[^"]*)"/g)].map((m) => m[1]);
    // A link into a page's section (SEC-2a's identity chip opens
    // /settings#access) is no page of its own: its page is a registry entry.
    // D73: an entry that opens a page asking it to do something (the rail's
    // Terminal: /agents?terminal=1) is that page's, too.
    const hrefs = all.filter((h) => !h.includes("#") && !h.includes("?"));
    for (const h of all.filter((x) => x.includes("#") || x.includes("?")))
      expect([h, hrefs.includes(h.split(/[#?]/)[0])]).toEqual([h, true]);
    expect(all.filter((h) => h.includes("#"))).toEqual(["/settings#access"]);
    expect(all.filter((h) => h.includes("?"))).toEqual(["/agents?terminal=1"]);
    expect(hrefs.sort()).toEqual(
      [
        "/agents",
        "/edge",
        "/environments",
        "/graph",
        "/local-dev",
        "/logs",
        "/settings",
        "/release",
        "/services",
        "/tests",
        // ON-6: the server agent.
        "/server-agent",
      ].sort(),
    );
    expect(SHELL).not.toMatch(
      /href="\/(local-dev|services|logs|tests|environments|release)"/,
    );
    for (const f of Object.keys(PAGES))
      expect(read(f)).not.toMatch(/class="den-(ni|rail-link)"/);
  });
});

describe("one main landmark per page (SA's dev.17 run)", () => {
  it.each(Object.keys(PAGES))(
    '%s wraps its content in <main id="den-content">, its only main',
    (file) => {
      const html = read(file);
      expect(html.match(/<main[\s>][^>]*>/g)).toEqual([
        '<main id="den-content">',
      ]);
      expect(html).not.toMatch(/role="main"/);
      // It opens right after the shell and closes at the end of the body.
      expect(html).toMatch(
        /<script src="\/shell\.js"><\/script>\s*(<!--[^\n]*-->\s*)?<main id="den-content">/,
      );
      expect(html).toMatch(/<\/main>\s*<\/body>/);
    },
  );
  it("the skip link goes to it", () => {
    expect(SHELL).toContain('href="#den-content"');
    expect(SHELL).toMatch(/getElementById\("den-content"\)/);
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

describe("the old settings entry points go to the Settings page (R21)", () => {
  const local = read("local-dev.html");
  it("Workspaces' ⋯ menu links to the workspace's settings; the list's ⚙ footer is gone (R24b/c)", () => {
    expect(local).not.toContain("sidebar-settings-btn");
    expect(local).toMatch(
      /<a role="menuitem" href="\/settings\?ws=\$\{enc\}#workspace">Project setup<\/a>/,
    );
    expect(local).toContain("const enc = encodeURIComponent(wsName);");
    // No editor or terminal set: the open actions send you there too.
    expect(local.match(/location\.href = "\/settings#editor"/g)).toHaveLength(
      2,
    );
  });
  it("the old panel is gone, not left as a second UI", () => {
    for (const gone of [
      "showSettingsPanel",
      "renderSettingsCategory",
      "loadWsEditorSettings",
      "settings-nav",
      "data-settings-cat",
      "ctab-ws-settings",
      "lang-override",
      "postSettings",
    ])
      expect([gone, local.includes(gone)]).toEqual([gone, false]);
  });
  it("the rail's Settings item and the user menu's All settings", () => {
    expect(SHELL).toMatch(/href: "\/settings",/);
    expect(read("appearance.js")).toContain(
      'const settings = "/settings#appearance";',
    );
  });
  it("Den's rows live only in the registry (settings-registry.js)", () => {
    // The page draws rows from denShell.settings(); no other page or
    // module defines a setting row.
    const page = read("settings-page.js");
    expect(page).toMatch(/shell\.settings\(\)/);
    expect(page).not.toMatch(/registerSetting\(/);
    for (const f of fs.readdirSync(PUBLIC))
      if (
        !["settings-registry.js", "shell.js"].includes(f) &&
        fs.statSync(path.join(PUBLIC, f)).isFile()
      )
        expect([f, /registerSetting\(/.test(read(f))]).toEqual([f, false]);
  });
});
