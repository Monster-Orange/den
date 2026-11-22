/**
 * Issue 625 with issue 1033: a browser run with no --box never goes
 * "anywhere" with only a box that is turned off or outside its window.
 * Such a box is skipped with its reason; with no other box the run stays
 * here, saying why, instead of waiting for a slot that won't come.
 */
import { describe, expect, it } from "@jest/globals";
import { defaultPlace, type GateBox } from "../../../src/shared/gates/boxes.js";

const box = (name: string, extra: Partial<GateBox> = {}): GateBox => ({
  name,
  playwright: `ws://${name}:3000/`,
  playwright_version: "1.61.0",
  browser_slots: 2,
  ...extra,
});

/** A window that excludes `now`: it opens two hours on, for an hour. */
function closedWindowAt(now: number): { window: string; opens: string } {
  const d = new Date(now);
  const h = (d.getHours() + 2) % 24;
  const hh = (n: number) => String(n).padStart(2, "0");
  return {
    window: `${hh(h)}:00-${hh((h + 1) % 24)}:00`,
    opens: `${hh(h)}:00`,
  };
}

const run = (boxes: GateBox[], now: number) =>
  defaultPlace({
    setting: "any",
    hostOnly: "",
    label: "browser run",
    boxes,
    baseUrl: true,
    pwVersion: "1.61.0",
    now,
  });

describe("the default pick and boxes that are off or closed", () => {
  const now = new Date(2026, 10, 22, 10, 0, 0).getTime();

  it("only an out-of-window box of the right version: stays here, naming its window and when it opens", () => {
    const w = closedWindowAt(now);
    const p = run([box("winbox", { window: w.window })], now);
    expect(p.where).toBeUndefined();
    expect(p.why).toContain("box winbox");
    expect(p.why).toContain(`outside its window (opens ${w.opens})`);
  });

  it("only a box turned off: stays here, saying so", () => {
    const p = run([box("offbox", { enabled: false })], now);
    expect(p.where).toBeUndefined();
    expect(p.why).toContain("box offbox: turned off");
  });

  it("one off box and one on box: only the on box", () => {
    const p = run([box("offbox", { enabled: false }), box("onbox")], now);
    expect(p.where).toBe("any");
    expect(p.only).toEqual(["onbox"]);
    expect(p.skipped).toContain("box offbox: turned off");
  });

  it("a box inside its window counts as before", () => {
    const d = new Date(now);
    const hh = (n: number) => String(n).padStart(2, "0");
    const open = `${hh(d.getHours())}:00-${hh((d.getHours() + 1) % 24)}:00`;
    const p = run([box("winbox", { window: open })], now);
    expect(p).toEqual({ where: "any" });
  });
});
