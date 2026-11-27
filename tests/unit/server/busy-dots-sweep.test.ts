/**
 * Issue 698: a Den button that sends a request and waits for the server
 * shows the kit's pulsing dots in place of its label until the answer
 * (den-ui issue 699). This sweep reads every Den page script (*.js and
 * *.html under public/) and fails on:
 *
 *   1. a busyAction call that hands the kit no button (so no dots), unless
 *      it is named in NO_BUTTON with the reason no button stays on screen;
 *   2. `dots: false` (the old hold, without dots);
 *   3. a page that writes its own in-progress words ("Saving…",
 *      "Checking…") over a button's label;
 *   4. a plain POST form with no watchForms (the kit's listener that holds
 *      its submitter).
 *
 * Writes that don't yet go through busyAction at all are BUSY-1's count
 * (busy-writes-ratchet.test.ts), which only shrinks.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");

/**
 * busyAction calls with no button, by "file action", each with why no
 * button stays on screen to hold. The pop-up still says what is happening.
 */
// Issue 1054: the drag's save holds its row (holdRow) and Delete project
// holds its last dialog's button; neither goes through busyAction now
// (busy-button-sweep-1054.test.ts checks both). Restart alone stays.
const NO_BUTTON: Record<string, string> = {
  "restart-den.js restart-den":
    "asked from a confirm dialog, the menu or the update pill; reconnect mode's pop-up opens at once",
};

/** The page scripts Den serves. */
function pages(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of fs.readdirSync(PUBLIC))
    if (/\.(js|html)$/.test(f))
      out[f] = fs.readFileSync(path.join(PUBLIC, f), "utf-8");
  return out;
}

/** The call's text from its opening paren to the matching close. */
function callAt(src: string, open: number): string {
  let d = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "(") d++;
    else if (c === ")" && --d === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Each busyAction("name", …) call: its action and whether it holds a button. */
export function busyCalls(
  src: string,
): { action: string; line: number; button: boolean; dotsOff: boolean }[] {
  const out = [];
  const re = /\b(?:busyAction|busy)\s*\(\s*"([\w-]+)"/g;
  for (const m of src.matchAll(re)) {
    const open = src.indexOf("(", m.index!);
    const call = callAt(src, open);
    out.push({
      action: m[1]!,
      line: src.slice(0, m.index!).split("\n").length,
      // `button: x` or the shorthand `button,`; never `button: null`.
      button:
        /\bbutton\s*:\s*(?!null\b|undefined\b)[\w$]/.test(call) ||
        /[{,]\s*button\s*[,}]/.test(call),
      dotsOff: /\bdots\s*:\s*false\b/.test(call),
    });
  }
  return out;
}

/** en words that say "in progress" ("Saving…"), from every catalog. */
function progressWords(all: Record<string, string>): Set<string> {
  const keys = new Set<string>();
  for (const src of Object.values(all))
    for (const m of src.matchAll(/"([\w.-]+)":\s*"([^"\n]*)"/g))
      if (/(…|\.\.\.)\s*$/.test(m[2]!)) keys.add(m[1]!);
  return keys;
}

const BUTTONISH = /^(b|btn|go|button|\w*Btn|\w*Button)$/;

/** A page writing in-progress words over a button's label. */
export function labelSwaps(src: string, progress: Set<string>): string[] {
  const out: string[] = [];
  const re =
    /\b([\w$]+)\.(?:textContent|innerText|innerHTML)\s*=\s*t\(\s*"([\w.-]+)"/g;
  for (const m of src.matchAll(re))
    if (BUTTONISH.test(m[1]!) && progress.has(m[2]!))
      out.push(`${m[1]}.textContent = t("${m[2]}")`);
  return out;
}

/** A plain POST form in markup, with no watchForms on the page or shell. */
export function postFormsUnwatched(src: string, shellWatches: boolean) {
  const forms = src.match(/<form\b[^>]*\bmethod\s*=\s*["']?post\b/gi) ?? [];
  return shellWatches || /\bwatchForms\s*\(/.test(src) ? [] : forms;
}

describe("issue 698: the sweep can fail (planted buttons)", () => {
  it("a busyAction with no button fails; one with a button passes", () => {
    const planted = `x.busyAction("save", (headers) => api("POST", "/a", {}, { headers }), { vars: {} });`;
    expect(busyCalls(planted)).toEqual([
      { action: "save", line: 1, button: false, dotsOff: false },
    ]);
    expect(
      busyCalls(
        `sh.busyAction("save", run, { button, toastFast: false });\nbusy("open-terminal", run, { button: b })`,
      ).map((c) => c.button),
    ).toEqual([true, true]);
    expect(
      busyCalls(`busyAction("save", run, { button: null })`)[0]!.button,
    ).toBe(false);
  });
  it("dots: false is found", () => {
    expect(
      busyCalls(`busyAction("save", run, { button: b, dots: false })`)[0]!
        .dotsOff,
    ).toBe(true);
  });
  it("a button's label swapped to an in-progress word is found", () => {
    const words = new Set(["busy.saveW"]);
    expect(
      labelSwaps(`btn.textContent = t("busy.saveW");`, words),
    ).toHaveLength(1);
    expect(labelSwaps(`go.textContent = t("busy.saveW");`, words)).toHaveLength(
      1,
    );
    // A status line may say it; a button's own label may come back.
    expect(labelSwaps(`msg.textContent = t("busy.saveW");`, words)).toEqual([]);
    expect(labelSwaps(`btn.textContent = t("addr.check");`, words)).toEqual([]);
  });
  it("a POST form with nobody watching is found", () => {
    const html = `<form method="post" action="/x"><button>Go</button></form>`;
    expect(postFormsUnwatched(html, false)).toHaveLength(1);
    expect(postFormsUnwatched(html, true)).toEqual([]);
    expect(postFormsUnwatched(`<form method="get">`, false)).toEqual([]);
  });
});

describe("issue 698: every Den button that waits shows the kit's dots", () => {
  const all = pages();

  it("1, 2. every busyAction holds its button with dots (or says why it has none)", () => {
    const bad: string[] = [];
    const used = new Set<string>();
    for (const [f, src] of Object.entries(all)) {
      if (f === "busy-den.js") continue;
      for (const c of busyCalls(src)) {
        const key = `${f} ${c.action}`;
        if (c.dotsOff) bad.push(`${f}:${c.line} ${c.action}: dots: false`);
        if (c.button) continue;
        if (NO_BUTTON[key]) used.add(key);
        else bad.push(`${f}:${c.line} ${c.action}: no button`);
      }
    }
    expect(bad).toEqual([]);
    // An exemption whose call is gone (or now has its button) goes too.
    expect([...used].sort()).toEqual(Object.keys(NO_BUTTON).sort());
  });

  it("3. no page writes its own in-progress words over a button's label", () => {
    const progress = progressWords(all);
    expect(progress.has("busy.saveW")).toBe(true);
    const bad: string[] = [];
    for (const [f, src] of Object.entries(all))
      for (const s of labelSwaps(src, progress)) bad.push(`${f}: ${s}`);
    expect(bad).toEqual([]);
  });

  it("4. a plain POST form is watched by the kit (watchForms)", () => {
    const shellWatches = /\bwatchForms\s*\(/.test(all["shell.js"] ?? "");
    const bad: string[] = [];
    for (const [f, src] of Object.entries(all))
      for (const form of postFormsUnwatched(src, shellWatches))
        bad.push(`${f}: ${form}`);
    expect(bad).toEqual([]);
  });

  it("Den's shell hands the kit's holdDots on, for a wait with its own words", () => {
    expect(all["shell.js"]).toMatch(/holdDots\s*:\s*function/);
    expect(all["busy-den.js"]).toMatch(/export\s*\{[^}]*\bholdDots\b/);
  });
});

describe("issue 698: the approval buttons hold the dots", () => {
  const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");
  const body = (src: string, start: RegExp, end: RegExp) => {
    const a = src.search(start);
    expect(a).toBeGreaterThanOrEqual(0);
    const rest = src.slice(a);
    const b = rest.search(end);
    return b > 0 ? rest.slice(0, b) : rest;
  };

  it("the Allow card's Allow and Deny (apDecide) hold the pressed button's dots", () => {
    const f = body(read("shell.js"), /function apDecide\(/, /\n {2}function /);
    expect(f).toMatch(/holdDots\(/);
    // shell.js's $ helper isn't in apDecide's scope: a bare $( throws before
    // the decision is sent, and the dialog never closes.
    expect(f).not.toMatch(/[^\w.$]\$\(/);
  });

  it("the Account area's Approve and Deny for a computer hold the button's dots (issue 310 moved them)", () => {
    const src = read("account-den.js");
    // answer() goes through ask(), the kit's busyAction with the button held.
    const f = body(
      src,
      /const answer = \(name, path, body, button\) =>/,
      /\n {4}\}\);\n/,
    );
    expect(f).toMatch(/ask\(name, path, body, button\)/);
    const a = body(src, /const ask = \(/, /\n {4}\);\n/);
    expect(a).toMatch(/busyAction\(/);
    expect(a).toMatch(/\{\s*button,/);
    // Both buttons go through it.
    expect(src).toMatch(/case "approve":\s*return answer\(/);
    expect(src).toMatch(/case "deny":\s*return answer\(/);
  });
});
