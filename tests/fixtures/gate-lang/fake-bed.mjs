#!/usr/bin/env node
/**
 * A fake bed for a live check's language clause: no Den, no browser. It
 * keeps the bed's language (GET and POST /api/settings), and its page
 * answers each read with what a Settings page in that language would show.
 * The check runs as the harness runs it: setup once, run per cell,
 * teardown always, then expect.
 *
 *   node fake-bed.mjs <gate file> '<scenario json>'
 *
 * Scenario: { start, englishIn?, choresIn?, throwIn?, refuse? }
 *   start      the bed's language before the check ("en", "es", "ja")
 *   englishIn  this language's push labels stay English (367)
 *   choresIn   this language's rows tell the person to run a command (393)
 *   throwIn    the page's read throws while the bed is in this language
 *   refuse     the switch to this language is refused (403)
 *
 * Prints { rows, error, posts, final }: expect's rows (when run finished),
 * the first error, the languages POSTed in order, and the bed's language
 * at the end.
 */
import * as path from "node:path";
import { pathToFileURL } from "node:url";

const [file, json] = process.argv.slice(2);
const sc = JSON.parse(json || "{}");
const mod = await import(pathToFileURL(path.resolve(file)).href);

const LABELS = {
  en: {
    "notifications.push_timeout": "Push wait",
    "notifications.push_ttl": "Push kept for",
  },
  es: {
    "notifications.push_timeout": "Espera del push",
    "notifications.push_ttl": "Push guardado durante",
  },
  ja: {
    "notifications.push_timeout": "プッシュの待ち時間",
    "notifications.push_ttl": "プッシュの保持時間",
  },
};
const BOUNDS = {
  "notifications.push_timeout": [30, 1, 3600],
  "notifications.push_ttl": [86400, 0, 2419200],
};

let language = sc.start ?? "en";
const posts = [];

function response(status, body) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

async function api(p, init) {
  if (p !== "/api/settings") return response(404, {});
  if (!init || !init.method || init.method === "GET")
    return response(200, { language });
  const body = JSON.parse(init.body);
  if (!("language" in body)) return response(200, {});
  posts.push(body.language);
  if (sc.refuse && body.language === sc.refuse)
    return response(403, { error: "refused" });
  language =
    body.language === null || body.language === "" ? "en" : body.language;
  return response(200, {});
}

/** What a Settings page in the bed's language shows, as the check reads it. */
function snapshot(arg) {
  if (sc.throwIn && language === sc.throwIn)
    throw new Error(`page read failed in ${language}`);
  const labels =
    sc.englishIn === language ? LABELS.en : (LABELS[language] ?? LABELS.en);
  const rows = Object.keys(BOUNDS).map((id) => ({
    id,
    shown: true,
    value: BOUNDS[id][0],
    min: BOUNDS[id][1],
    max: BOUNDS[id][2],
    label: labels[id],
  }));
  const chores =
    sc.choresIn === language ? ["cli.signin: …ejecuta den login"] : [];
  // One answer for either check's read: 367 passes the row ids and reads
  // rows, 393 passes nothing and reads chores; both read lang. (A check
  // from before the language clause read the bare array.)
  const base = Array.isArray(arg) ? [...rows] : [...chores];
  return Object.assign(base, { lang: language, rows, chores });
}

const locator = (sel) => ({
  first() {
    return this;
  },
  async waitFor() {},
  async scrollIntoViewIfNeeded() {},
  async count() {
    if (sel === "#set-signout") return 1;
    if (sel === "#set-signin") return 0;
    if (sel.startsWith(".set-row")) return 6;
    return 1;
  },
});

const page = {
  async waitForSelector() {},
  async evaluate(_fn, arg) {
    return snapshot(arg);
  },
  locator,
};

const out = { rows: null, error: null, posts, final: null };
const cells = [];
const base = {
  url: "http://bed.invalid",
  api,
  cli: () => ({
    code: 0,
    out: "  push ✓ push services are given https://bed.invalid as the contact\n",
    err: "",
  }),
  goto: async () => {},
  sleep: async () => {},
  shot: async () => {},
  evidence: (n) => n,
};
let state;
try {
  state = await mod.setup({ ...base });
  for (const browser of mod.matrix?.browsers ?? ["chromium"])
    for (const width of mod.matrix?.widths ?? [1280]) {
      const ctx = { ...base, page, browser, width };
      cells.push({
        cell: { browser, width },
        result: await mod.run(ctx, state),
      });
    }
} catch (e) {
  out.error = String(e?.message ?? e);
} finally {
  try {
    await mod.teardown?.({ ...base }, state);
  } catch (e) {
    out.error ??= String(e?.message ?? e);
  }
}
if (!out.error) out.rows = mod.expect(cells);
out.final = language;
console.log(JSON.stringify(out));
