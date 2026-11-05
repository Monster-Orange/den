/**
 * The shell (0.3.0-dev.14): one top bar and one left rail, drawn by
 * public/shell.js on every page. Pages hold only their content: no page
 * keeps its own header, nav or env picker.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";

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
const RAIL = [
  "local-dev",
  "services",
  "environments",
  "release",
  "logs",
  "tests",
];

type Link = { attrs: Record<string, string>; focus(): void };

/** Run shell.js against a fake document for one page. */
function mountShell(page: string) {
  const links: Link[] = [];
  let onKey: ((e: { key: string; preventDefault(): void }) => void) | null =
    null;
  const doc: {
    activeElement: unknown;
    getElementById(id: string): unknown;
    body: unknown;
    head: unknown;
    createElement(): unknown;
  } = {
    activeElement: null,
    getElementById: (id: string) => (id === "den-shell" ? host : null),
    body: { classList: { add() {} } },
    head: { appendChild() {} },
    createElement: () => ({}),
  };
  const nav = {
    addEventListener: (t: string, f: typeof onKey) => {
      if (t === "keydown") onKey = f;
    },
    querySelectorAll: () => links,
  };
  let html = "";
  const host = {
    dataset: { page } as Record<string, string>,
    className: "",
    set innerHTML(h: string) {
      html = h;
      links.length = 0;
      for (const m of h.matchAll(/<a ([^>]*)>/g)) {
        const attrs = Object.fromEntries(
          [...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], a[2]]),
        );
        const el: Link = {
          attrs,
          focus() {
            doc.activeElement = el;
          },
        };
        if (attrs.class === "den-rail-link") links.push(el);
      }
    },
    get innerHTML() {
      return html;
    },
    querySelector: (sel: string) => (sel === ".den-rail" ? nav : null),
  };
  vm.runInNewContext(SHELL, { document: doc });
  const key = (k: string) => {
    let prevented = false;
    onKey?.({
      key: k,
      preventDefault() {
        prevented = true;
      },
    });
    return prevented;
  };
  return { html: () => html, links, key, doc };
}

describe("every page mounts the shell", () => {
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

describe("the top bar", () => {
  const { html } = mountShell("services");
  it("has the mark, the title, version, health, workspace, env", () => {
    const top = html().slice(0, html().indexOf("</header>"));
    const order = [
      'class="den-mark" id="den-mark"',
      'class="den-title"',
      'id="version-pill"',
      'id="health"',
      'id="ws-pill"',
      'id="env-sel"',
    ].map((s) => top.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
  it("one env picker for the whole shell", () => {
    expect(html().match(/<select/g)).toHaveLength(1);
    expect(html().match(/id="env-sel"/g)).toHaveLength(1);
  });
  it("draws the title in the theme's display face", () => {
    expect(SHELL).toMatch(/\.den-title \{ font-family: var\(--display\);/);
  });
  it("the sudo lock only on Local Dev", () => {
    expect(mountShell("local-dev").html()).toContain('id="sudo-lock"');
    expect(html()).not.toContain('id="sudo-lock"');
  });
  it("uses no color literal (theme tokens only)", () => {
    expect(SHELL).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
  });
});

describe("the rail", () => {
  it.each(RAIL)("on %s: every page in order, that one aria-current", (page) => {
    const { links } = mountShell(page);
    expect(links.map((l) => l.attrs["data-page"])).toEqual(RAIL);
    const current = links.filter((l) => l.attrs["aria-current"] === "page");
    expect(current.map((l) => l.attrs["data-page"])).toEqual([page]);
    for (const l of links) expect(l.attrs.title).toBeTruthy();
  });

  it("↑/↓ move along it and wrap; Home and End jump; other keys pass", () => {
    const { links, key, doc } = mountShell("logs");
    links[4].focus();
    expect(key("ArrowDown")).toBe(true);
    expect(doc.activeElement).toBe(links[5]);
    key("ArrowDown");
    expect(doc.activeElement).toBe(links[0]);
    key("ArrowUp");
    expect(doc.activeElement).toBe(links[5]);
    key("Home");
    expect(doc.activeElement).toBe(links[0]);
    key("End");
    expect(doc.activeElement).toBe(links[5]);
    expect(key("Tab")).toBe(false);
    expect(key("a")).toBe(false);
  });

  it("collapses to icons below 1100px, labels kept for assistive tech", () => {
    expect(SHELL).toMatch(
      /@media \(max-width: 1100px\) \{ body\.den-has-shell \{ --den-rail-w: 52px; \} \}/,
    );
    expect(SHELL).toMatch(
      /\.den-rail-label \{ position: absolute; width: 1px;/,
    );
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
