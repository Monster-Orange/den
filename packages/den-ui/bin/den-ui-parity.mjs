#!/usr/bin/env node
/**
 * den-ui-parity: fails when a product keeps its own copy of a kit
 * component, instead of the kit's.
 *
 *   den-ui-parity [--root <dir>] [--src <dir>]... [--json]
 *
 * --root   the product's repository (default: the working directory); its
 *          DIVERGE.md is read from there.
 * --src    a folder of UI source to scan, relative to --root (repeatable;
 *          default: src). node_modules, dist, build, .git and the kit's
 *          own package (packages/den-ui) are never scanned.
 *
 * What counts as a copy (per component, see COMPONENTS below):
 *   - markup: a string that draws the kit's element (class="den-top", …);
 *   - CSS: a rule whose selector starts with the kit's class or id;
 *   - code: a function with the name of the kit's own builder;
 *   - files: a file named as a kit file, or with the same bytes as one.
 * Reading the kit's elements (querySelector(".den-rail"), say) is not a
 * copy: only drawing or styling them is.
 *
 * DIVERGE.md at the root lets a product keep a copy on purpose: a
 * markdown table or list naming the component and a reason,
 *
 *   | component | reason |
 *   |---|---|
 *   | report | our reports go to a ticket desk, not an issue tracker |
 *
 *   - report: our reports go to a ticket desk, not an issue tracker
 *
 * A row with an empty reason does not count. Exit 0: no copies (or each
 * one diverges by name); 1: copies found; 2: bad arguments.
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const KIT_SRC = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
);

/** Markup that draws an element with this class (an attribute or className). */
const cls = (name) =>
  new RegExp(
    `(class(Name)?\\s*[=:]\\s*\\\\?["'\`]|classList\\.add\\(\\s*["'])[^"'\`]*\\b${name}(?![\\w-])`,
  );
/** Markup that draws an element with this id. */
const id = (name) =>
  new RegExp(`\\bid\\s*[=:]\\s*\\\\?["'\`]${name}(?![\\w-])`);

/** Each component: what drawing, styling or building it looks like. */
export const COMPONENTS = {
  shell: {
    label: "global shell (top bar, left rail, pins, collapse, ☰ drawer)",
    markup: [
      cls("den-top"),
      cls("den-rail"),
      cls("den-rail-box"),
      cls("den-rail-group"),
      cls("den-ni"),
      cls("den-gh"),
      cls("den-skip"),
      cls("den-brand"),
      cls("den-menu-btn"),
      cls("den-collapse-btn"),
      cls("den-pin-row"),
      id("den-rail"),
    ],
    css: [
      "den-top",
      "den-rail",
      "den-rail-box",
      "den-rail-group",
      "den-ni",
      "den-gh",
      "den-skip",
      "den-brand",
      "den-menu-btn",
      "den-collapse-btn",
      "den-pin-row",
      "den-scrim",
      // 0.7.1: the 44px tap on touch, for any control.
      "den-hit",
      // Not here: den-has-shell, den-rail-collapsed and den-rail-open are
      // the body's state classes, for a page to lay its own content out by.
    ],
    code: [
      "shellHtml",
      "topBarHtml",
      "railHtml",
      "railGroupHtml",
      "navItemHtml",
      "hydrateShell",
      "applyCollapsed",
      "unpinFromRail",
      "syncPinToggles",
    ],
    files: ["shell-html.js", "shell-client.js", "shell.css", "icons.js"],
  },
  version: {
    label: "version chip",
    // 0.7.0: and the update-waiting pill beside it.
    markup: [
      id("version-pill"),
      cls("v-pill"),
      cls("v-pip"),
      cls("stale-pill"),
      id("stale-pill"),
    ],
    css: [
      "v-pill",
      "v-pip",
      "v-txt",
      "version-pill",
      "stale-pill",
      "stale-lbl",
    ],
    code: ["versionChipHtml", "waitingHtml", "setWaiting"],
    files: ["version.js", "version-label.js"],
  },
  whatsnew: {
    label: "What's new (release notes pop-up)",
    // Issue 793: now the kit's dialog frame (.cl-dlg); the old overlay's
    // names still count as a copy.
    markup: [id("cl-overlay"), cls("cl-dlg"), cls("cl-overlay"), cls("cl-box")],
    css: [
      "cl-overlay",
      "cl-box",
      "cl-hdr",
      "cl-body",
      "cl-footer",
      "cl-got-it",
      "cl-dlg",
      "cl-ver",
      "cl-items",
    ],
    code: ["changelogView", "whatsNewHtml"],
    files: ["whatsnew.js", "whatsnew.css", "changelog-view.js"],
  },
  update: {
    label: "update pill",
    markup: [cls("den-upd"), cls("upd-pill")],
    css: ["den-upd", "upd-pill"],
    code: ["showUpdate"],
    files: ["update-pill.js", "update-pill.css"],
  },
  report: {
    label: "Report button and form",
    // The form's own dialog (class exactly "fb-dlg"); a product's other
    // dialog may wear the class for its look ("fb-dlg fb-my").
    markup: [cls("den-rb"), /class(Name)?\s*[=:]\s*\\?["'`]fb-dlg["'`\\]/],
    css: ["den-rb", "den-rb-top", "fb-dlg", "fb-b", "fb-btns"],
    code: ["reportButtonHtml", "openReportForm", "clientSections"],
    files: ["report.js", "report.css", "report-shot.js", "report-dialog.js"],
  },
  working: {
    label: "working pop-up",
    markup: [cls("bz-dlg")],
    css: ["bz-dlg"],
    code: ["configureBusy", "registerActions"],
    files: ["busy.js", "busy-words.js", "busy.css"],
  },
  // Issue 673: the one button. A product's own `.btn` (its class drawn, or
  // a rule for it) is a copy; the kit's `.den-btn`, and a host's layout of
  // it (`.acts .den-btn { margin… }`), are not.
  button: {
    label: "button (.den-btn: secondary, primary, danger, sm)",
    markup: [
      /(class(Name)?\s*[=:]\s*\\?["'`]|classList\.add\(\s*["'])([^"'`]*\s)?btn(?![\w-])/,
    ],
    css: ["btn"],
    code: [],
    files: [],
  },
  // 0.7.0: pieces of the top bar and rail a product drew itself before.
  // Its words and values go in the kit's options; its own HTML in a crumb's
  // menu or the bell's rows (classes of its own) is not a copy.
  scope: {
    label: "scope crumbs (COMPANY / PROJECT / ENV, each with its ▾)",
    markup: [
      cls("den-scope"),
      cls("den-scope-btn"),
      cls("den-scope-menu"),
      cls("den-mfilter"),
      cls("den-mnone"),
    ],
    css: ["den-scope", "den-scope-btn", "den-scope-menu", "den-mfilter"],
    code: ["scopeHtml", "scopeCrumbHtml", "scopeButton", "hydrateScope"],
    files: [],
  },
  search: {
    label: "search field with ⌘K inside",
    markup: [cls("den-search"), cls("den-search-ph"), cls("den-search-ic")],
    css: ["den-search", "den-search-ph", "den-search-ic", "den-kbd"],
    code: ["searchHtml", "hydrateSearch"],
    files: [],
  },
  bell: {
    label: "bell (its button, count and panel)",
    markup: [
      cls("den-bell"),
      cls("den-bell-n"),
      cls("den-bell-pop"),
      cls("den-bell-hd"),
      cls("den-bell-empty"),
    ],
    css: [
      "den-bell",
      "den-bell-n",
      "den-bell-pop",
      "den-bell-hd",
      "den-bell-empty",
    ],
    code: ["bellButtonHtml", "bellPanelHtml", "hydrateBell"],
    files: [],
  },
  appearance: {
    label: "appearance menu (◐ ▾: mode, theme, language)",
    markup: [cls("appearance-btn"), id("appearance-btn")],
    css: ["appearance-btn"],
    code: [
      "appearanceButtonHtml",
      "appearanceMenuHtml",
      "hydrateAppearance",
      "userMenu",
    ],
    files: [],
  },
  account: {
    label: "account entry in the rail's foot",
    markup: [/\bdata-den-account\b/, cls("den-acct-d"), cls("den-mform")],
    css: ["den-acct-d", "den-mform"],
    code: ["accountHtml", "accountMenuHtml", "hydrateAccount", "identityEntry"],
    files: [],
  },
};

const SCAN_EXT = /\.(m?[jt]sx?|css|html?)$/;
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git"]);

function args(argv) {
  const o = { root: process.cwd(), src: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") o.root = argv[++i];
    else if (a === "--src") o.src.push(argv[++i]);
    else if (a === "--json") o.json = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`unknown argument: ${a}`);
    if (o.root === undefined || o.src.includes(undefined))
      throw new Error(`${a} needs a value`);
  }
  if (!o.src.length) o.src = ["src"];
  return o;
}

function* walk(dir, kitDir) {
  let ents = [];
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (path.resolve(p) === kitDir) continue;
      yield* walk(p, kitDir);
    } else if (e.isFile()) yield p;
  }
}

const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A CSS rule for the kit's element itself: the class (or id) is the
 * selector's subject, alone or with a state (.den-ni:hover,
 * .den-ni[aria-current], body.den-has-shell). A product styling what it
 * puts inside the kit's element (.den-top kbd) or its own element that
 * carries a kit class beside its own (.den-scrim.den-svp-scrim) is not a
 * copy.
 */
function cssRule(name) {
  return new RegExp(
    `(^|[}\\s"'\`,;>+~])([a-z]+)?[.#]${reEsc(name)}((:{1,2}[\\w-]+(\\([^)]*\\))?)|\\[[^\\]]*\\])*\\s*[,{]`,
    "m",
  );
}
function codeDef(name) {
  return new RegExp(
    `(function\\s+${name}\\s*\\(|(const|let|var)\\s+${name}\\s*=\\s*(async\\s*)?(function|\\())`,
  );
}

/** DIVERGE.md: component → reason (rows with a reason only). */
export function readDiverge(root) {
  const file = path.join(root, "DIVERGE.md");
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    let m = /^\s*\|\s*([\w-]+)\s*\|\s*(.*?)\s*\|\s*$/.exec(line);
    if (!m) m = /^\s*[-*]\s*`?([\w-]+)`?\s*[:|]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const [, comp, reason] = m;
    if (!COMPONENTS[comp]) continue;
    if (!reason || /^-+$/.test(reason) || /^reason$/i.test(reason)) continue;
    out[comp] = reason;
  }
  return out;
}

/** Every copy in the product's source: [{ component, file, line, what }]. */
export function scan(root, srcDirs) {
  const kitDir = path.resolve(KIT_SRC, "..");
  const kitFiles = new Map();
  for (const f of walk(KIT_SRC, null)) {
    const rel = path.relative(KIT_SRC, f);
    if (!SCAN_EXT.test(f)) continue;
    kitFiles.set(sha(fs.readFileSync(f)), rel);
  }
  const found = [];
  for (const src of srcDirs) {
    const dir = path.resolve(root, src);
    for (const file of walk(dir, kitDir)) {
      if (!SCAN_EXT.test(file)) continue;
      const rel = path.relative(root, file);
      const buf = fs.readFileSync(file);
      const text = buf.toString("utf-8");
      const base = path.basename(file);
      const copyOf = kitFiles.get(sha(buf));
      for (const [comp, c] of Object.entries(COMPONENTS)) {
        if (
          c.files.includes(base) ||
          (copyOf && c.files.includes(path.basename(copyOf)))
        )
          found.push({
            component: comp,
            file: rel,
            line: 1,
            what: copyOf
              ? `a copy of the kit's ${copyOf}`
              : `a file named as the kit's ${base}`,
          });
        const lines = text.split("\n");
        const at = (re) => {
          for (let i = 0; i < lines.length; i++)
            if (re.test(lines[i])) return i + 1;
          return 0;
        };
        for (const re of c.markup) {
          const n = at(re);
          if (n)
            found.push({
              component: comp,
              file: rel,
              line: n,
              what: `draws the kit's markup (${(lines[n - 1] || "").trim().slice(0, 70)})`,
            });
        }
        for (const name of c.css) {
          const re = cssRule(name);
          const n = at(re);
          if (n)
            found.push({
              component: comp,
              file: rel,
              line: n,
              what: `styles .${name}`,
            });
        }
        for (const name of c.code) {
          const n = at(codeDef(name));
          if (n)
            found.push({
              component: comp,
              file: rel,
              line: n,
              what: `defines ${name}()`,
            });
        }
      }
    }
  }
  return found;
}

function main() {
  let o;
  try {
    o = args(process.argv.slice(2));
  } catch (e) {
    console.error(`den-ui-parity: ${e.message}`);
    return 2;
  }
  if (o.help) {
    console.log("den-ui-parity [--root <dir>] [--src <dir>]... [--json]");
    return 0;
  }
  const diverge = readDiverge(o.root);
  const found = scan(o.root, o.src);
  const bad = found.filter((f) => !diverge[f.component]);
  if (o.json) {
    console.log(
      JSON.stringify(
        {
          copies: bad,
          diverged: found.filter((f) => diverge[f.component]),
          diverge,
        },
        null,
        2,
      ),
    );
    return bad.length ? 1 : 0;
  }
  for (const [comp, why] of Object.entries(diverge))
    console.log(`den-ui-parity: ${comp} diverges (DIVERGE.md): ${why}`);
  if (!bad.length) {
    console.log(
      `den-ui-parity: ok, no copies of the kit's ${Object.keys(COMPONENTS).length} components in ${o.src.join(", ")}`,
    );
    return 0;
  }
  const by = {};
  for (const f of bad) (by[f.component] ??= []).push(f);
  for (const [comp, list] of Object.entries(by)) {
    console.log(
      `\n✗ ${comp}: ${COMPONENTS[comp].label}: ${list.length} cop${list.length === 1 ? "y" : "ies"}`,
    );
    for (const f of list) console.log(`  ${f.file}:${f.line}  ${f.what}`);
  }
  console.log(
    `\nden-ui-parity: ${bad.length} cop${bad.length === 1 ? "y" : "ies"} of kit components. Use the kit's, or name the component and a reason in DIVERGE.md (| component | reason |).`,
  );
  return 1;
}

/**
 * Run as a command: through npx or node_modules/.bin, argv[1] is a
 * symlink to this file, so both sides are compared as real paths.
 */
function isMain() {
  if (!process.argv[1]) return false;
  try {
    return (
      fs.realpathSync(path.resolve(process.argv[1])) ===
      fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = main();
