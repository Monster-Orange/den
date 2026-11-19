// A fake bed for gate/95.mjs (tests/unit/test-infra/gate-95-runner.test.ts):
// Den's pages drawn by the UI kit, the kit installed inside the engine
// (node_modules/@acme/den/packages/den-ui) and served at /kit/. `den`:
//   "good":     as Den is;
//   "ownShell": the pages draw a shell of their own (no kit shell script);
//   "noDrawer": ☰ doesn't open the rail on a phone;
//   "oldChip":  the version chip never learns the version;
//   "noReport": Settings has no Report button;
//   "changed":  /kit/report.js is served changed from the installed kit;
//   "busyOwn":  Den's busy wrapper defines its own <den-busy>;
//   "copy":     one of Den's public files is a byte copy of a kit file;
//   "stale":    a newer Den waits, and the update pill shows;
//   "noEngine": the bed's package.json names no engine.
// Invented names only.
const ENGINE = "node_modules/@acme/den";
const KIT = `${ENGINE}/packages/den-ui/src`;
const PUB = `${ENGINE}/src/ui/server/public`;
const VERSION = "1.2.3";
const kitFile = (f) => `/* kit ${f} */\n`;

export function fakeBed({ den = "good" } = {}) {
  const st = { path: null, whatsNew: false, report: false, drawer: false };
  const shell = () => ({
    tokens: true,
    fonts: true,
    base: true,
    sans: '"Rubik", sans-serif',
    shellScript: den !== "ownShell",
    kitShell: den !== "ownShell",
    top: true,
    rail: true,
    railItems: 6,
    collapse: true,
    menuBtn: true,
    chip: den === "oldChip" ? "v…" : `v${VERSION}`,
    report: !(den === "noReport" && st.path === "/settings"),
    bell: true,
    appearance: true,
    update: den === "stale",
    brand: "Acme",
  });

  const selOpen = (sel) =>
    (sel.includes("#cl-overlay.open") && st.whatsNew) ||
    (sel.includes("dialog.fb-dlg[open]") && st.report) ||
    sel.includes("menuitemradio") ||
    sel === "header.den-top";
  const locator = (sel) => ({
    async count() {
      if (sel === "#cl-overlay.open") return st.whatsNew ? 1 : 0;
      if (sel === "dialog.fb-dlg[open]") return st.report ? 1 : 0;
      if (sel.startsWith("dialog.fb-dlg"))
        return st.report && !sel.includes("discard") ? 1 : 0;
      if (sel.includes("menuitemradio")) return 3;
      return 0;
    },
    first() {
      return locator(sel);
    },
    async click() {
      if (sel.startsWith("button.den-rb")) st.report = true;
    },
    async textContent() {
      return sel === "#cl-title" ? "What's new in 1.2.3" : "";
    },
  });

  const page = {
    async waitForSelector(sel, o) {
      const open = selOpen(sel);
      if (o?.state === "detached") {
        if (open) throw new Error("still there");
        return;
      }
      if (!open) throw new Error(`no ${sel}`);
    },
    locator,
    async click(sel) {
      if (sel === "#version-pill") st.whatsNew = true;
      if (sel === "#cl-close-btn") st.whatsNew = false;
      if (sel === "#den-menu-btn" && den !== "noDrawer") st.drawer = true;
    },
    keyboard: {
      async press(k) {
        if (k === "Escape") {
          st.report = false;
          st.drawer = false;
        }
      },
    },
    async waitForTimeout() {},
    async evaluate(fn) {
      if (fn.name === "drawerState")
        return { expanded: String(st.drawer), shown: st.drawer };
      return shell();
    },
  };

  const files = {
    "package.json":
      den === "noEngine"
        ? JSON.stringify({ dependencies: {} })
        : JSON.stringify({ dependencies: { "@acme/den": "1.2.3" } }),
    [`${ENGINE}/packages/den-ui/package.json`]: JSON.stringify({
      name: "@acme/den-ui",
      version: "0.7.6",
    }),
  };
  const kitNames = [
    "tokens.css",
    "fonts.css",
    "base.css",
    "busy.js",
    "report.js",
    "whatsnew.js",
    "shell.css",
    "kit.js",
    "update-pill.js",
    "dialog.js",
  ];
  for (const f of kitNames) files[`${KIT}/${f}`] = kitFile(f);
  const pubNames = ["shell.js", "busy-den.js", "settings-page.js"];
  for (const f of pubNames) files[`${PUB}/${f}`] = `/* den ${f} */\n`;
  if (den === "copy") files[`${PUB}/dialog-den.js`] = kitFile("dialog.js");

  const ctx = {
    url: "http://bed.invalid",
    newPage: () => page,
    async goto(_p, path) {
      st.path = path;
    },
    async shot() {},
    async until(f) {
      for (let i = 0; i < 20; i++) if (await f()) return i * 100;
      return null;
    },
    async fetch(path) {
      if (path === "/api/server-info")
        return {
          status: 200,
          body: { pid: 1, version: VERSION, engineStale: den === "stale" },
        };
      if (path === "/busy-den.js")
        return {
          status: 200,
          body:
            'import { busyAction } from "/kit/busy.js";\n' +
            (den === "busyOwn"
              ? 'customElements.define("den-busy", class extends HTMLElement {});\n'
              : ""),
        };
      const m = /^\/kit\/(.+)$/.exec(path);
      if (m && kitNames.includes(m[1]))
        return {
          status: 200,
          body:
            den === "changed" && m[1] === "report.js"
              ? "/* edited */"
              : kitFile(m[1]),
        };
      return { status: 404, body: null };
    },
    readBed(rel) {
      return files[rel] ?? null;
    },
    listBed(rel) {
      const pre = `${rel}/`;
      const out = Object.keys(files)
        .filter((k) => k.startsWith(pre) && !k.slice(pre.length).includes("/"))
        .map((k) => k.slice(pre.length))
        .sort();
      return out.length ? out : null;
    },
  };
  return {
    ctx,
    state: () => ({ report: st.report, whatsNew: st.whatsNew }),
  };
}
