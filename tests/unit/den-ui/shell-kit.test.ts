/**
 * Issue 95 (UI kit slice 1): the kit's shell, its words and its parity
 * gate, the checks that need no browser.
 *
 *   - strings.js: en, es and ja have the same keys, every one `kit.`, with
 *     the same {placeholders}; DenUI.strings adds a product's words.
 *   - shell-html.js runs in Node and draws markup with no inline style or
 *     handler (clean under `script-src 'self'; style-src 'self'`), the
 *     product's parts in their slots: Report · bell · account on the right.
 *   - den-ui-parity fails on a product's own copy of a kit component and
 *     passes when DIVERGE.md names it with a reason.
 *   - Every kit file is exported, packed and served by Den (KIT_FILES).
 *
 * The browser half is shell-kit-parity.browser.test.ts (no visible change)
 * and kit-csp.browser.test.ts (a kit page under a strict CSP).
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as strings from "../../../packages/den-ui/src/strings.js";
import {
  accountHtml,
  accountMenuHtml,
  reportButtonHtml,
  searchHtml,
  shellHtml,
  topBarHtml,
} from "../../../packages/den-ui/src/shell-html.js";
import { KIT_FILES, KIT_PAGE_CSS } from "../../../src/ui/server/ui-assets.js";

const PKG = path.join(process.cwd(), "packages", "den-ui");
const GATE = path.join(PKG, "bin", "den-ui-parity.mjs");
type Table = Record<string, string>;
const { en, es, ja } = strings as unknown as Record<string, Table>;
const holes = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("the kit's words (strings.js)", () => {
  it("has the same keys in en, es and ja, every one kit.", () => {
    const base = (t: Table) =>
      Object.keys(t)
        .map((k) => k.replace(/\.(one|other)$/, ""))
        .filter((k, i, a) => a.indexOf(k) === i)
        .sort();
    expect(Object.keys(en).length).toBeGreaterThan(80);
    for (const k of Object.keys(en)) expect(k).toMatch(/^kit\./);
    expect(base(es)).toEqual(base(en));
    expect(base(ja)).toEqual(base(en));
    // A plural form (.one) is en's and es's; ja has one form.
    for (const k of Object.keys(en).filter((x) => !/\.one$/.test(x))) {
      expect([k, holes(es[k] ?? "")]).toEqual([k, holes(en[k])]);
      expect([k, holes(ja[k] ?? "")]).toEqual([k, holes(en[k])]);
    }
  });

  it("fills {product}, falls back to en, and takes a product's words", () => {
    const { kitT, setProduct, addStrings } = strings as unknown as {
      kitT: (l: string, k: string, v?: object) => string;
      setProduct: (n: string) => void;
      addStrings: (l: string, t: Table) => void;
    };
    setProduct("Acme");
    expect(kitT("xx", "kit.report.word")).toBe(en["kit.report.word"]);
    expect(kitT("ja", "kit.report.word")).toBe(ja["kit.report.word"]);
    addStrings("es", { "kit.report.word": "Avisar" });
    expect(kitT("es", "kit.report.word")).toBe("Avisar");
    const filed = kitT("en", "kit.report.filed", { n: 12 });
    expect(filed).toContain("12");
  });
});

describe("shellHtml (shell-html.js), in Node", () => {
  const model = {
    product: { name: "Acme <b>", version: "1.2.3" },
    lang: "ja",
    groups: [{ id: "work", label: "Work" }],
    nav: [
      { id: "a", label: "Alpha", href: "/a", group: "work", current: true },
      { id: "b", label: "Beta", href: "/b", group: "work", pin: "b" },
    ],
    slots: {
      start: '<span id="s-start"></span>',
      end: '<span id="s-end"></span>',
      bell: '<button id="s-bell"></button>',
      account: '<span id="s-account"></span>',
    },
  };
  const html = shellHtml(model);

  it("is clean under script-src 'self'; style-src 'self'", () => {
    expect(html).not.toMatch(/\sstyle\s*=/i);
    expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).not.toMatch(/<script|<style|javascript:/i);
  });

  it("puts the product's parts in their slots: Report · bell · account", () => {
    const at = (s: string) => html.indexOf(s);
    const order = [
      'class="den-brand"',
      'id="s-start"',
      'id="s-end"',
      "data-den-report",
      'id="s-bell"',
      'id="version-pill"',
      'id="s-account"',
      'id="den-rail"',
    ].map(at);
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("escapes the product's text and marks the current page and pins", () => {
    expect(html).toContain("Acme &lt;b&gt;");
    expect(html).toContain(">v1.2.3<");
    // A group's entries are host content for the nav inventory.
    expect(html).toMatch(
      /href="\/a" data-nav="a" data-nav-role="page" aria-current="page"/,
    );
    expect(html).toMatch(
      // 0.7.3: a pin row's Delete shortcut is the kit's own.
      /<div class="den-pin-row" data-nav-role="page"><a class="den-ni" href="\/b" data-nav="b" aria-keyshortcuts="Delete" title/,
    );
    // The kit's words in the page's language.
    expect(html).toContain(ja["kit.pages"]);
    expect(html).toContain(ja["kit.report.word"]);
  });

  const label = (h: string) => /aria-label="([^"]*)"/.exec(h)![1];
  const ph = (h: string) => /class="den-search-ph"[^>]*>([^<]*)</.exec(h)![1];

  it("the search's placeholder and name are the kit's words by default, in en, es and ja", () => {
    for (const [lang, word, name] of [
      ["en", "Search…", "Search"],
      ["es", "Buscar…", "Buscar"],
      ["ja", "検索…", "検索"],
    ] as const) {
      const h = searchHtml({ lang });
      expect(ph(h)).toBe(word);
      expect(label(h)).toBe(name);
    }
    // They are the kit's words: the nav inventory compares them.
    expect(searchHtml({})).not.toContain("data-nav-name");
    expect(searchHtml({})).not.toContain("data-nav-role");
  });

  // Issue 560: the host may set the placeholder (per locale). The name
  // follows it (WCAG 2.5.3, label in name): "Find work…" is named "Find
  // work", so a voice user's "click Find work" works. No host placeholder:
  // the kit's "Search", as before.
  it("issue 560: a host's placeholder shows, per locale, and names the search", () => {
    // One word, already in the page's language.
    const one = searchHtml({ lang: "es", placeholder: "Buscar agentes…" });
    expect(ph(one)).toBe("Buscar agentes…");
    expect(label(one)).toBe("Buscar agentes");
    // Words per locale: the page's, then its base language's.
    const per = { en: "Find work…", es: "Buscar trabajo…", ja: "仕事を探す…" };
    const ja = searchHtml({ lang: "ja", placeholder: per });
    expect(ph(ja)).toBe("仕事を探す…");
    expect(label(ja)).toBe("仕事を探す");
    expect(ph(searchHtml({ lang: "es-MX", placeholder: per }))).toBe(
      "Buscar trabajo…",
    );
    // Three dots trim too; text without them is the name as it is.
    expect(label(searchHtml({ placeholder: "Find work..." }))).toBe(
      "Find work",
    );
    expect(label(searchHtml({ placeholder: "Jump to" }))).toBe("Jump to");
    // A locale it doesn't name, or a blank word: the kit's words.
    const none = searchHtml({ lang: "ja", placeholder: { en: "Find…" } });
    expect(ph(none)).toBe("検索…");
    expect(label(none)).toBe("検索");
    expect(ph(searchHtml({ lang: "en", placeholder: "  " }))).toBe("Search…");
    // Host text is escaped.
    expect(searchHtml({ placeholder: '<b>"x"</b>' })).toContain(
      "&lt;b&gt;&quot;x&quot;&lt;/b&gt;",
    );
    // A host's own label is ignored: the name comes from what shows.
    expect(
      label(
        searchHtml({ lang: "en", label: "Mine" } as Parameters<
          typeof searchHtml
        >[0]),
      ),
    ).toBe("Search");
  });

  // 0.7.1: the account is data ({ name?, login, role? }); the kit owns
  // its format, the same in the rail's entry and the menu's header.
  const lines = (h: string) =>
    [...h.matchAll(/<span class="den-acct-(n|l|r)">([^<]*)<\/span>/g)].map(
      (m) => `${m[1]}:${m[2]}`,
    );
  it("the account entry: the name, then @login; @login alone with no name", () => {
    const both = accountHtml({
      name: "Ada Lovelace",
      login: "ada",
      href: "/me",
    });
    expect(lines(both)).toEqual(["n:Ada Lovelace", "l:@ada"]);
    expect(both).toContain('data-nav-shape="name,login"');
    expect(both).toContain('title="Ada Lovelace · @ada"');
    const login = accountHtml({ login: "ada", href: "/me" });
    expect(lines(login)).toEqual(["n:@ada"]);
    expect(login).toContain('data-nav-shape="login"');
    // The role is never in the rail's entry: its shape is name, login.
    const role = accountHtml({
      name: "Ada Lovelace",
      login: "ada",
      role: "Owner",
      href: "/me",
    });
    // (Issue 656: a name that is just the login, "Ada" for "ada", is no
    // name; account-name-parity.test.ts has those.)
    expect(lines(role)).toEqual(["n:Ada Lovelace", "l:@ada"]);
    expect(role).toContain('data-nav-shape="name,login"');
    expect(role).not.toContain("Owner");
    expect(
      lines(accountHtml({ login: "ada", role: "Owner", href: "/me" })),
    ).toEqual(["n:@ada"]);
    // The words are host data: the nav inventory compares their shape.
    expect(both).toContain('data-nav-role="account-name"');
    expect(both).not.toContain("data-nav-legacy");
  });

  it("no identity known: the kit's own word for this computer (local)", () => {
    const h = accountHtml({ local: true, href: "/me" });
    expect(lines(h)).toEqual(["n:Local"]);
    expect(h).toContain('data-nav-shape="local"');
    expect(
      lines(accountHtml({ local: true, lang: "ja", href: "/me" })),
    ).toEqual(["n:ローカル"]);
    // Data wins over the local word.
    expect(
      lines(accountHtml({ local: true, login: "ada", href: "/me" })),
    ).toEqual(["n:@ada"]);
  });

  it("the account menu's header: the name, @login, then the role on its own line", () => {
    const m = accountMenuHtml({
      name: "Ada Lovelace",
      login: "ada",
      role: "Owner",
      items: [],
    });
    expect(lines(m)).toEqual(["n:Ada Lovelace", "l:@ada", "r:Owner"]);
    expect(
      lines(accountMenuHtml({ login: "ada", role: "Owner", items: [] })),
    ).toEqual(["n:@ada", "r:Owner"]);
    expect(lines(accountMenuHtml({ login: "ada", items: [] }))).toEqual([
      "n:@ada",
    ]);
  });

  it("label and detail still work for one release, marked for the nav inventory", () => {
    const h = accountHtml({
      label: "Signed in",
      detail: "this device",
      href: "/me",
    } as Parameters<typeof accountHtml>[0]);
    // The old words, as they were given (no @ added).
    expect(lines(h)).toEqual(["n:Signed in", "l:this device"]);
    expect(h).toContain('data-nav-legacy="account"');
    const m = accountMenuHtml({
      detail: "this device",
      items: [],
    } as Parameters<typeof accountMenuHtml>[0]);
    expect(m).toContain('data-nav-legacy="account"');
  });

  it("draws the default mark from its file: Den's markup exactly (the nav reference's #den-mark)", () => {
    const ref = JSON.parse(
      fs.readFileSync(
        path.join(
          __dirname,
          "../../../packages/den-ui/inventory/reference/den-chromium-1280.json",
        ),
        "utf-8",
      ),
    ) as {
      elements: { key: string; role: string; tag: string; classes: string[] }[];
    };
    const want = ref.elements.find((e) => e.key === "#den-mark")!;
    const img = ref.elements.find((e) => e.key === "#den-mark > img")!;
    const html = shellHtml({
      ...model,
      product: {
        name: "Acme",
        mark: { src: "/kit/marks/den.svg", label: "Den" },
      },
    });
    const m =
      /<span class="([^"]*)" id="den-mark"([^>]*)>(<img [^>]*>)<\/span>/.exec(
        html,
      );
    expect(m).not.toBeNull();
    expect(m![1]!.split(" ")).toEqual(want.classes);
    expect(want.tag).toBe("span");
    // No role: the reference's mark is a plain span, named by its title.
    expect(m![2]).toBe(' aria-hidden="true" title="Den"');
    expect(img.tag).toBe("img");
    expect(m![3]).toBe(
      '<img src="/kit/marks/den.svg" alt="" width="18" height="18">',
    );
    // The file is the default theme's own mark, byte for byte.
    expect(
      fs.readFileSync(
        path.join(__dirname, "../../../packages/den-ui/src/marks/den.svg"),
      ),
    ).toEqual(
      fs.readFileSync(path.join(__dirname, "../../../themes/den/mark.svg")),
    );
  });

  it("draws a product mark: escaped text, or the product's svg, named by its label", () => {
    const text = shellHtml({
      ...model,
      product: { name: "Acme", mark: { text: "<H>", label: "Acme home" } },
    });
    expect(text).toContain(
      '<span class="den-mark" id="den-mark" role="img" aria-label="Acme home">&lt;H&gt;</span>',
    );
    const svg = '<svg viewBox="0 0 8 8"><circle cx="4" cy="4" r="4"/></svg>';
    expect(
      shellHtml({
        ...model,
        product: { name: "Acme", mark: { svg, label: "Acme" } },
      }),
    ).toContain(
      `<span class="den-mark" id="den-mark" role="img" aria-label="Acme">${svg}</span>`,
    );
    // No mark: as before (Den fills the empty slot itself).
    expect(html).toContain(
      '<span class="den-mark" id="den-mark" aria-hidden="true"></span>',
    );
  });

  it("leaves Report out when reports are off", () => {
    expect(shellHtml({ ...model, report: false })).not.toContain(
      "data-den-report",
    );
    expect(reportButtonHtml({ inFoot: true })).toContain("den-rb-in");
  });
});

// Issue 694: a page with no rail draws the bar without ☰.
describe("topBarHtml({ rail: false }) (issue 694)", () => {
  const model = {
    product: { name: "Acme", version: "1.2.3" },
    lang: "en",
    slots: { end: '<span id="s-end"></span>' },
  };
  const MENU = /<button class="den-ib den-menu-btn"[^>]*>☰<\/button>/;

  it("by default draws ☰, wired to the rail (unchanged)", () => {
    const h = topBarHtml(model);
    expect(h).toMatch(MENU);
    expect(h).toContain('aria-controls="den-rail"');
    expect(h).toContain('<header class="den-top">');
    expect(topBarHtml({ ...model, rail: true })).toBe(h);
  });

  it("with rail: false draws no ☰ and nothing that points at the rail", () => {
    const h = topBarHtml({ ...model, rail: false });
    expect(h).not.toContain("☰");
    expect(h).not.toContain("den-menu-btn");
    expect(h).not.toContain("aria-controls");
    expect(h).not.toContain("den-rail");
  });

  it("with rail: false is otherwise the same bar, stamped for the parity gate", () => {
    const def = topBarHtml(model);
    const want = def
      .replace(MENU, "")
      .replace(
        '<header class="den-top">',
        '<header class="den-top" data-nav-shape="no-rail">',
      );
    expect(topBarHtml({ ...model, rail: false })).toBe(want);
  });

  it("shellHtml with rail: false draws the bar without ☰ and no rail", () => {
    const h = shellHtml({ ...model, rail: false });
    expect(h).toContain(topBarHtml({ ...model, rail: false }));
    expect(h).not.toContain("den-rail");
    expect(h).toContain('class="den-skip"');
  });
});

describe("den-ui-parity (bin)", () => {
  const run = (root: string) =>
    spawnSync(process.execPath, [GATE, "--root", root, "--src", "src"], {
      encoding: "utf-8",
    });
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "den-ui-parity-"));

  it("fails on a product's own copy of a kit component", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "frame.js"),
      "el.innerHTML = '<header class=\"den-top\"></header>';\n",
    );
    fs.writeFileSync(
      path.join(root, "src", "frame.css"),
      ".den-rb { color: red; }\n",
    );
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/shell: .*1 copy/);
    expect(r.stdout).toMatch(/report: .*1 copy/);
  });

  it("passes when DIVERGE.md names the component with a reason", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "frame.css"),
      ".den-rb { color: red; }\n",
    );
    fs.writeFileSync(
      path.join(root, "DIVERGE.md"),
      "| component | reason |\n|---|---|\n| report |  |\n",
    );
    expect(run(root).status).toBe(1); // no reason: does not count
    fs.writeFileSync(
      path.join(root, "DIVERGE.md"),
      "| component | reason |\n|---|---|\n| report | a ticket desk |\n",
    );
    const r = run(root);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("report diverges");
  });

  it("checks through a symlink too (npx, node_modules/.bin)", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "frame.css"),
      ".den-rb { color: red; }\n",
    );
    const bin = path.join(tmp(), "den-ui-parity");
    fs.symlinkSync(GATE, bin);
    const r = spawnSync(
      process.execPath,
      [bin, "--root", root, "--src", "src"],
      { encoding: "utf-8" },
    );
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/report: .*1 copy/);
  });

  // 0.7.0: the scope crumbs, the search, the bell and the account entry.
  it("fails on a product's own scope crumbs, search, bell or account entry", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "bar.js"),
      [
        'const a = \'<div class="den-scope" role="group"></div>\';',
        "const b = '<button class=\"den-search\"></button>';",
        'pop.className = "den-bell-pop";',
        "function identityEntry() { return null; }",
        'btn.className = "den-ib appearance-btn";',
        'pill.className = "stale-pill";',
      ].join("\n") + "\n",
    );
    const r = run(root);
    expect(r.status).toBe(1);
    for (const c of [
      "scope",
      "search",
      "bell",
      "account",
      "appearance",
      "version",
    ])
      expect(r.stdout).toMatch(new RegExp(`${c}: .*1 copy`));
  });

  // Issue 673: a product's own button (.btn) is a copy of the kit's.
  it("fails on a product's own .btn button, its look or its markup", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "own.css"),
      ".btn { padding: 6px 12px; }\n.btn.primary:hover { color: red; }\n",
    );
    fs.writeFileSync(
      path.join(root, "src", "own.js"),
      "el.innerHTML = '<button class=\"btn primary\">Go</button>';\n",
    );
    const r = run(root);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/button: .*2 copies/);
  });

  it("the kit's .den-btn, a host's layout of it, and other -btn names are not copies", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "ok.js"),
      [
        "const a = '<button class=\"den-btn primary sm\">Go</button>';",
        "const b = '<button class=\"appearance-btn-x copy-btn\">x</button>';",
        "row.querySelector('.btn');",
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(root, "src", "ok.css"),
      ".acts .den-btn { margin-left: 8px; }\n.copy-btn { color: red; }\n",
    );
    expect(run(root).status).toBe(0);
  });

  it("a product's own words in the kit's options, or its rows in the bell, are not copies", () => {
    const root = tmp();
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(
      path.join(root, "src", "bar.js"),
      [
        "const s = DUI.scopeHtml({ crumbs: [{ key: 'env', label: 'Env' }] });",
        "const row = '<div class=\"den-bell-row\"><a>x</a></div>';",
        "btn.querySelector('.den-bell-n');",
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(root, "src", "bar.css"),
      ".den-bell-row a { color: red; }\n.den-scope .den-k { display: none; }\n",
    );
    expect(run(root).status).toBe(0);
  });

  it("finds no copy in Den", () => {
    const r = run(process.cwd());
    // No DIVERGE.md: Den keeps no copy of any of them.
    expect(fs.existsSync(path.join(process.cwd(), "DIVERGE.md"))).toBe(false);
    expect([r.status, r.stdout.trim()]).toEqual([
      0,
      "den-ui-parity: ok, no copies of the kit's 12 components in src",
    ]);
  });
});

describe("the package ships every kit file", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(PKG, "package.json"), "utf-8"),
  ) as {
    version: string;
    files: string[];
    bin: Record<string, string>;
  };
  it("Den links the kit's stylesheets in every page with the shell", () => {
    // No component injects a <style> (CSP): the page has its sheet first.
    for (const f of ["shell.css", "busy.css", "dialog.css"])
      expect(KIT_PAGE_CSS).toContain(`/kit/${f}`);
  });

  it("Den serves each one at /kit/ (KIT_FILES)", () => {
    // den-ui 0.7.5: the Markdown editor is for a host's bundler only (it
    // imports CodeMirror by package name), and Den's own pages never load
    // it: never served (markdown-editor-kit.test.ts checks it is not).
    const bundlerOnly = ["markdown-editor.js", "markdown-editor.css"];
    const src = fs
      .readdirSync(path.join(PKG, "src"))
      .filter((f) => /\.(js|css)$/.test(f) && !bundlerOnly.includes(f));
    for (const f of src) expect([f, KIT_FILES.includes(f)]).toEqual([f, true]);
    for (const f of bundlerOnly)
      expect(fs.existsSync(path.join(PKG, "src", f))).toBe(true);
  });
  it("packs src/ and bin/, with den-ui-parity as its bin", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.files).toEqual(expect.arrayContaining(["src/", "bin/"]));
    expect(pkg.bin["den-ui-parity"]).toBe("bin/den-ui-parity.mjs");
    expect(fs.existsSync(path.join(PKG, pkg.bin["den-ui-parity"]))).toBe(true);
  });
});
