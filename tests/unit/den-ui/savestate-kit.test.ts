/**
 * den-ui: the save-state line's scheduler (savestate.js), the checks that
 * need no browser. Fake timers stand in for the clock:
 *
 *   - a save 800 ms after the last change, never before;
 *   - flush (blur, hidden) saves at once, and only when something changed;
 *   - "saving" only when the save takes more than 400 ms, else straight
 *     to "saved"; "saved" stays until the next save shows "saving";
 *   - a failure is "error" at once, then retries at 2, 4 and 8 s, then
 *     every 30 s; retry() (online) tries at once; success is "saved";
 *   - only the error and its recovery are announced.
 *   - the words: en, es and ja, from the FINAL table; "Saved" with no stop.
 *
 * The browser half (the element, its words, title, Copy text, the live
 * region, blur, hidden, online, colours) is savestate-kit.browser.test.ts.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  RETRY_EVERY_MS,
  RETRY_MS,
  SAVE_AFTER_MS,
  SAVING_AFTER_MS,
  saveScheduler,
} from "../../../packages/den-ui/src/savestate.js";
import * as strings from "../../../packages/den-ui/src/strings.js";

type Change = { state: string; at?: Date; announce?: string | null };

/** A save that answers after `ms` (ok, or rejects), counting its calls. */
function stubSave(plan: { ms: number; ok: boolean }[]) {
  const calls: number[] = [];
  let i = 0;
  const save = () => {
    const step = plan[Math.min(i, plan.length - 1)]!;
    i++;
    calls.push(Date.now());
    // ms 0: answers at once (no timer of its own).
    if (step.ms === 0)
      return step.ok ? Promise.resolve() : Promise.reject(new Error("down"));
    return new Promise<void>((res, rej) =>
      setTimeout(() => (step.ok ? res() : rej(new Error("down"))), step.ms),
    );
  };
  return { save, calls };
}

function setup(plan: { ms: number; ok: boolean }[]) {
  const s = stubSave(plan);
  const seen: Change[] = [];
  const sch = saveScheduler({ save: s.save, onChange: (c) => seen.push(c) });
  const states = () => seen.map((c) => c.state);
  const announced = () => seen.filter((c) => c.announce).map((c) => c.announce);
  return { ...s, seen, sch, states, announced };
}

/** Runs the clock and lets each settled promise's callbacks run. */
async function tick(ms: number) {
  await jest.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

let t0 = 0;
beforeEach(() => {
  jest.useFakeTimers({ now: new Date("2026-11-18T10:42:00Z") });
  t0 = Date.now();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("savestate: the timings", () => {
  it("are 800 ms, 400 ms, 2/4/8 s then every 30 s", () => {
    expect(SAVE_AFTER_MS).toBe(800);
    expect(SAVING_AFTER_MS).toBe(400);
    expect(RETRY_MS).toEqual([2000, 4000, 8000]);
    expect(RETRY_EVERY_MS).toBe(30_000);
  });
});

describe("savestate: save 800 ms after the last change", () => {
  it("waits 800 ms after the last change, restarting on each change", async () => {
    const { sch, calls } = setup([{ ms: 10, ok: true }]);
    sch.changed();
    await tick(500);
    sch.changed();
    await tick(799);
    expect(calls).toEqual([]);
    await tick(1);
    expect(calls).toEqual([t0 + 1300]);
  });

  it("flush (blur, hidden) saves at once, and only when something changed", async () => {
    const { sch, calls } = setup([{ ms: 10, ok: true }]);
    await sch.flush();
    expect(calls).toEqual([]);
    sch.changed();
    await tick(100);
    const done = sch.flush();
    expect(calls).toEqual([t0 + 100]);
    await tick(10);
    await done;
    // The pending 800 ms save was taken by the flush: no second save.
    await tick(2000);
    expect(calls.length).toBe(1);
  });

  it("a change during a save saves again after it", async () => {
    const { sch, calls } = setup([{ ms: 1000, ok: true }]);
    sch.changed();
    await tick(800);
    sch.changed();
    await tick(800); // the second debounce fires while the first save runs
    expect(calls.length).toBe(1);
    await tick(200); // the first save ends: the second starts at once
    expect(calls).toEqual([t0 + 800, t0 + 1800]);
  });
});

describe("savestate: Saving… only past 400 ms", () => {
  it("a save under 400 ms goes straight to saved", async () => {
    const { sch, states } = setup([{ ms: 399, ok: true }]);
    sch.changed();
    await tick(800 + 399);
    expect(states()).toEqual(["saved"]);
  });

  it("a save over 400 ms shows saving at 400 ms, then saved", async () => {
    const { sch, states } = setup([{ ms: 900, ok: true }]);
    sch.changed();
    await tick(800 + 399);
    expect(states()).toEqual([]);
    await tick(1);
    expect(states()).toEqual(["saving"]);
    await tick(500);
    expect(states()).toEqual(["saving", "saved"]);
  });

  it("saved stays until the next save, and carries the time it saved", async () => {
    const { sch, seen, states } = setup([{ ms: 50, ok: true }]);
    sch.changed();
    await tick(850);
    expect(states()).toEqual(["saved"]);
    expect(seen[0]!.at!.getTime()).toBe(t0 + 850);
    await tick(60_000);
    expect(states()).toEqual(["saved"]);
    expect(sch.state()).toBe("saved");
  });
});

describe("savestate: failure and the retries", () => {
  it("error at once, then 2 s, 4 s, 8 s, then every 30 s", async () => {
    const { sch, calls, states } = setup([{ ms: 0, ok: false }]);
    sch.changed();
    await tick(800);
    expect(states()).toEqual(["error"]);
    await tick(2000 + 4000 + 8000 + 30_000 + 30_000);
    expect(calls.map((c) => c - t0)).toEqual([
      800,
      800 + 2000,
      800 + 6000,
      800 + 14_000,
      800 + 44_000,
      800 + 74_000,
    ]);
    // Error once: each failed retry leaves it as it is.
    expect(states()).toEqual(["error"]);
  });

  it("a retry while in error never shows saving", async () => {
    const { sch, states } = setup([
      { ms: 0, ok: false },
      { ms: 1500, ok: true },
    ]);
    sch.changed();
    await tick(800 + 2000 + 1500);
    expect(states()).toEqual(["error", "saved"]);
  });

  it("success puts it back to saved, and the ladder starts again", async () => {
    const { sch, calls, states } = setup([
      { ms: 0, ok: false },
      { ms: 0, ok: true },
      { ms: 0, ok: false },
    ]);
    sch.changed();
    await tick(800 + 2000);
    expect(states()).toEqual(["error", "saved"]);
    sch.changed();
    await tick(800 + 2000);
    expect(calls.map((c) => c - t0)).toEqual([800, 2800, 3600, 5600]);
  });

  it("retry() (online) tries at once, and the ladder goes on from there", async () => {
    const { sch, calls } = setup([{ ms: 0, ok: false }]);
    sch.changed();
    await tick(800 + 500);
    await sch.retry();
    expect(calls.map((c) => c - t0)).toEqual([800, 1300]);
    // The 2 s retry was replaced; the next is the 4 s one.
    await tick(3999);
    expect(calls.length).toBe(2);
    await tick(1);
    expect(calls.map((c) => c - t0)).toEqual([800, 1300, 5300]);
  });

  it("retry() does nothing when nothing failed", async () => {
    const { sch, calls } = setup([{ ms: 0, ok: true }]);
    await sch.retry();
    sch.changed();
    await tick(900);
    await sch.retry();
    expect(calls.length).toBe(1);
  });

  it("destroy stops every timer", async () => {
    const { sch, calls, states } = setup([{ ms: 0, ok: false }]);
    sch.changed();
    await tick(800);
    sch.destroy();
    await tick(120_000);
    expect(calls.length).toBe(1);
    expect(states()).toEqual(["error"]);
  });
});

describe("savestate: what is announced", () => {
  it("only the error and its recovery; routine saves are silent", async () => {
    const { sch, announced, states } = setup([
      { ms: 0, ok: true },
      { ms: 0, ok: false },
      { ms: 0, ok: false },
      { ms: 0, ok: true },
      { ms: 0, ok: true },
    ]);
    sch.changed();
    await tick(800);
    expect(announced()).toEqual([]);
    sch.changed();
    await tick(800 + 2000 + 4000);
    sch.changed();
    await tick(800);
    expect(states()).toEqual(["saved", "error", "saved", "saved"]);
    expect(announced()).toEqual(["error", "recovered"]);
  });
});

describe("savestate: the words (strings.js)", () => {
  const { kitT } = strings as unknown as {
    kitT: (l: string, k: string, v?: object) => string;
  };
  const FINAL: Record<string, Record<string, string>> = {
    en: {
      saving: "Saving…",
      saved: "Saved",
      error: "Not saved. Retrying…",
      copy: "Copy text",
      savedAt: "Saved at 10:42",
    },
    es: {
      saving: "Guardando…",
      saved: "Guardado",
      error: "No se guardó. Reintentando…",
      copy: "Copiar texto",
      savedAt: "Guardado a las 10:42",
    },
    ja: {
      saving: "保存しています…",
      saved: "保存しました",
      error: "保存できていません。再試行しています…",
      copy: "テキストをコピー",
      savedAt: "10:42 に保存しました",
    },
  };
  it("has the FINAL words in en, es and ja", () => {
    for (const [lang, words] of Object.entries(FINAL))
      for (const [k, v] of Object.entries(words))
        expect([
          lang,
          k,
          kitT(lang, `kit.savestate.${k}`, { time: "10:42" }),
        ]).toEqual([lang, k, v]);
  });
  it('"Saved" has no closing stop in any language', () => {
    for (const lang of ["en", "es", "ja"])
      expect(kitT(lang, "kit.savestate.saved")).not.toMatch(/[.。]$/);
  });
  it("savestate.js names no product", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "../../../packages/den-ui/src/savestate.js"),
      "utf-8",
    );
    const rest = src.replace(/den-savestate/g, "");
    expect([...rest.matchAll(/\b[dD]en(?:[A-Z_$][\w$]*)?\b/g)]).toEqual([]);
  });
});
