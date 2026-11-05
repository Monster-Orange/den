/**
 * The header's health row on one line (0.3.0-dev.9, a slice-1b regression:
 * the 36–42px header cut the row off mid-word with no sign of what it hid).
 * Problems first, whole items only, and a "+N" chip that names what it hides
 * and opens the full list.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  closeMoreList,
  fitUnits,
  moreChip,
  mountMoreChip,
  orderByProblem,
} from "../../../src/ui/server/public/health-fit.js";

type U = { repo: string; state: string; repos?: number; down?: number };
const u = (repo: string, state: string): U => ({
  repo,
  state,
  repos: 1,
  ...(state === "err" ? { down: 1 } : {}),
});

/** What the row shows for these units, widths and room. */
function row(units: U[], widths: Record<string, number>, avail: number) {
  const ordered = orderByProblem(units) as U[];
  const n = fitUnits(
    ordered.map((x) => widths[x.repo]),
    avail,
    { gap: 8, chipWidth: 60 },
  );
  const hidden = ordered.slice(n);
  return {
    shown: ordered.slice(0, n).map((x) => x.repo),
    chip: hidden.length ? moreChip(hidden) : null,
  };
}

describe("orderByProblem", () => {
  it("down, degraded, unknown, then healthy; otherwise as given", () => {
    const order = orderByProblem([
      u("a", "ok"),
      u("b", ""),
      u("c", "err"),
      u("d", "running"),
      u("e", "ok"),
      u("f", "err"),
    ]) as U[];
    expect(order.map((x) => x.repo)).toEqual(["c", "f", "d", "b", "a", "e"]);
  });
});

describe("fitUnits and the chip", () => {
  const ten = Array.from({ length: 10 }, (_, i) => u(`repo-${i}`, "ok"));
  const w = Object.fromEntries(ten.map((x) => [x.repo, 90]));

  it("shows everything, with no chip, when it all fits", () => {
    expect(row(ten.slice(0, 3), w, 300)).toEqual({
      shown: ["repo-0", "repo-1", "repo-2"],
      chip: null,
    });
  });

  it("fits whole items only, keeping room for the chip", () => {
    // 3 × (90 + 8) + 60 = 354 ≤ 400; a 4th would need 452.
    expect(row(ten, w, 400)).toEqual({
      shown: ["repo-0", "repo-1", "repo-2"],
      chip: { text: "+7", label: "7 more repos", problem: false },
    });
  });

  it("never hides a problem behind a healthy repo", () => {
    const units = [...ten, u("late-down", "err"), u("late-slow", "running")];
    const widths = { ...w, "late-down": 90, "late-slow": 90 };
    const r = row(units, widths, 400);
    expect(r.shown.slice(0, 2)).toEqual(["late-down", "late-slow"]);
    // Narrower: the problems are still what stays.
    expect(row(units, widths, 170).shown).toEqual(["late-down"]);
  });

  it("a later, smaller item never jumps ahead of one that didn't fit", () => {
    const units = [u("down-long-name", "err"), u("ok", "ok")];
    const r = row(units, { "down-long-name": 300, ok: 20 }, 200);
    expect(r.shown).toEqual([]);
    expect(r.chip).toEqual({
      text: "+2, 1 down",
      label: "2 more repos, 1 down",
      problem: true,
    });
  });

  it("says what the hidden repos hold: counts across app boxes", () => {
    expect(
      moreChip([{ repos: 3, down: 1, degraded: 1 }, { repos: 1 }]),
    ).toEqual({
      text: "+4, 1 down, 1 degraded",
      label: "4 more repos, 1 down, 1 degraded",
      problem: true,
    });
    expect(moreChip([{ repos: 1 }]).label).toBe("1 more repo");
  });
});

// ── The chip in a fake DOM: aria and Escape ──────────────────────────────────

type Listener = (e: {
  key?: string;
  target?: unknown;
  stopPropagation(): void;
}) => void;
class El {
  id = "";
  type = "";
  className = "";
  textContent = "";
  innerHTML = "";
  style: Record<string, string> = {};
  attrs: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  children: El[] = [];
  parent: El | null = null;
  setAttribute(k: string, v: string) {
    this.attrs[k] = String(v);
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  addEventListener(t: string, f: Listener) {
    (this.listeners[t] ??= []).push(f);
  }
  fire(t: string, e: Partial<Parameters<Listener>[0]> = {}) {
    for (const f of this.listeners[t] ?? [])
      f({ target: this, stopPropagation() {}, ...e });
  }
  appendChild(c: El) {
    c.parent = this;
    this.children.push(c);
    return c;
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  contains(o: unknown) {
    for (let x = o as El | null; x; x = x.parent) if (x === this) return true;
    return false;
  }
  focus() {
    doc.activeElement = this;
  }
}
const body = new El();
const header = body.appendChild(new El());
const doc = {
  body,
  documentElement: { clientWidth: 1024 },
  activeElement: null as El | null,
  listeners: {} as Record<string, Listener[]>,
  createElement: () => new El(),
  getElementById(id: string): El | null {
    const walk = (e: El): El | null =>
      e.id === id ? e : (e.children.map(walk).find(Boolean) ?? null);
    return walk(body);
  },
  addEventListener(t: string, f: Listener) {
    (this.listeners[t] ??= []).push(f);
  },
  removeEventListener(t: string, f: Listener) {
    this.listeners[t] = (this.listeners[t] ?? []).filter((x) => x !== f);
  },
  fire(t: string, e: Partial<Parameters<Listener>[0]>) {
    for (const f of [...(this.listeners[t] ?? [])])
      f({ stopPropagation() {}, ...e });
  },
};

describe("the +N chip", () => {
  const hidden = [{ repos: 1, down: 1 }, { repos: 2 }];
  const mount = () => {
    const chip = mountMoreChip(doc, hidden, (list: El) => {
      list.innerHTML = "<div>the hidden repos</div>";
    }) as unknown as El;
    header.appendChild(chip);
    return chip;
  };

  it("is a button named for what it hides, controlling a list", () => {
    const chip = mount();
    expect(chip.textContent).toBe("+3, 1 down");
    expect(chip.attrs).toMatchObject({
      "aria-label": "3 more repos, 1 down",
      "aria-haspopup": "true",
      "aria-controls": "health-more-list",
      "aria-expanded": "false",
    });
    expect(chip.className).toContain("problem");
    chip.remove();
  });

  it("opens the full list; Escape closes it and returns focus", () => {
    const chip = mount();
    chip.fire("click");
    const list = doc.getElementById("health-more-list");
    expect(list?.innerHTML).toContain("the hidden repos");
    expect(list?.attrs["aria-label"]).toBe("3 more repos, 1 down");
    expect(chip.attrs["aria-expanded"]).toBe("true");
    doc.activeElement = null;
    doc.fire("keydown", { key: "Escape" });
    expect(doc.getElementById("health-more-list")).toBeNull();
    expect(chip.attrs["aria-expanded"]).toBe("false");
    expect(doc.activeElement).toBe(chip);
    chip.remove();
  });

  it("closes on a click elsewhere, and on a second click of the chip", () => {
    const chip = mount();
    chip.fire("click");
    doc.fire("click", { target: header });
    expect(doc.getElementById("health-more-list")).toBeNull();
    chip.fire("click");
    chip.fire("click");
    expect(doc.getElementById("health-more-list")).toBeNull();
    closeMoreList(doc);
    chip.remove();
  });

  it("stays open, with the new contents, across a repaint", () => {
    const first = mount();
    first.fire("click");
    first.remove();
    const second = mount();
    expect(second.attrs["aria-expanded"]).toBe("true");
    expect(doc.getElementById("health-more-list")).not.toBeNull();
    closeMoreList(doc);
    second.remove();
  });
});

describe("the header uses it", () => {
  const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
  const header = fs.readFileSync(path.join(PUBLIC, "header.js"), "utf-8");
  it("fits the row after every paint and on resize", () => {
    expect(header).toMatch(/from "\.\/health-fit\.js"/);
    expect(header).toMatch(/_fitHealthRow\(container\);\n\}/);
    expect(header).toMatch(/addEventListener\("resize"/);
  });
  it("is served", async () => {
    const { UI_MODULES } = await import("../../../src/ui/server/ui-assets.js");
    expect(UI_MODULES).toContain("/health-fit.js");
  });
});
