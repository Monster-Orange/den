/**
 * The header's health row on one line: problems first, whole items only,
 * and a "+N" chip that names what it hides and opens the full list.
 * 0.3.0-dev.9 fixed the silent cut-off; 0.3.0-dev.10 fits repos one by one
 * when application boxes don't fit (a 7-repo box no longer hides
 * everything), always places problems first, and gives the row the free
 * header width.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  buildRow,
  closeMoreList,
  fitPlan,
  moreChip,
  mountMoreChip,
  planRow,
} from "../../../src/ui/server/public/health-fit.js";

type Row = {
  repo: string;
  service: string;
  ok: boolean | null;
  isEntrypoint?: boolean;
  focused?: boolean;
};
const one = (repo: string, ok: boolean | null, focused = false): Row => ({
  repo,
  service: repo,
  ok,
  focused,
});

/** What the row shows, given widths per repo and per box. */
function show(
  rows: Row[],
  groups: { app: { name: string } | null; repos: string[] }[],
  widths: Record<string, number>,
  avail: number,
  boxPad = 40,
) {
  const { units, flat } = buildRow(rows, groups);
  const gap = 8;
  const unitW = (u: (typeof units)[number]) =>
    u.repos.reduce(
      (a: number, r: { repo: string }) => a + widths[r.repo] + gap,
      0,
    ) -
    gap +
    (u.app ? boxPad : 0);
  const boxed =
    units.reduce((a: number, u: (typeof units)[number]) => a + unitW(u), 0) +
    gap * (units.length - 1);
  const plan = planRow({
    boxed,
    flat: flat.map((r: { repo: string; state: string }) => ({
      key: r.repo,
      state: r.state,
      width: widths[r.repo],
    })),
    avail,
    gap,
    chipWidth: 70,
  });
  const hidden = flat.filter((r: { repo: string }) => !plan.show.has(r.repo));
  return {
    mode: plan.mode,
    shown: flat
      .filter((r: { repo: string }) => plan.show.has(r.repo))
      .map((r: { repo: string }) => r.repo),
    chip: hidden.length ? moreChip(hidden).text : null,
  };
}

describe("buildRow", () => {
  it("orders down, degraded, ok, then unknown; focused first, then by name", () => {
    const { flat } = buildRow(
      [
        one("zeta", true, true),
        one("alpha", true),
        one("beta", true, true),
        one("down-b", false),
        one("down-a", false),
        one("quiet", null),
        { repo: "multi", service: "web", ok: true, isEntrypoint: true },
        { repo: "multi", service: "mailpit", ok: false },
      ],
      null,
    );
    expect(
      flat.map((r: { repo: string; state: string }) => [r.repo, r.state]),
    ).toEqual([
      ["down-a", "down"],
      ["down-b", "down"],
      ["multi", "degraded"],
      ["beta", "ok"],
      ["zeta", "ok"],
      ["alpha", "ok"],
      ["quiet", "unknown"],
    ]);
  });

  it("a box sorts by its worst repo, and keeps problems first inside", () => {
    const { units } = buildRow(
      [one("a", true), one("b", false), one("c", true)],
      [
        { app: { name: "fine" }, repos: ["a"] },
        { app: { name: "hurt" }, repos: ["c", "b"] },
      ],
    );
    expect(
      units.map((u: { app: { name: string }; repos: { repo: string }[] }) => [
        u.app.name,
        u.repos.map((r) => r.repo),
      ]),
    ).toEqual([
      ["hurt", ["b", "c"]],
      ["fine", ["a"]],
    ]);
  });
});

describe("planRow", () => {
  // SA's shape: a 7-repo box and a 3-repo box, 2 down.
  const big = ["b1", "b2", "b3", "b4", "b5", "b6", "b7"];
  const small = ["s1", "s2", "s3"];
  const rows = [
    ...big.map((r, i) => one(r, i === 5 ? false : true)),
    ...small.map((r, i) => one(r, i === 2 ? false : true)),
  ];
  const groups = [
    { app: { name: "smb" }, repos: big },
    { app: { name: "core" }, repos: small },
  ];
  const widths = Object.fromEntries([...big, ...small].map((r) => [r, 90]));

  it("everything boxed when it all fits", () => {
    expect(show(rows, groups, widths, 2000)).toMatchObject({
      mode: "boxed",
      chip: null,
    });
  });

  it("a box too big for the row never hides everything: repos fit one by one", () => {
    // 500px: room for 4 items and the chip, though neither box fits whole.
    const r = show(rows, groups, widths, 500);
    expect(r.mode).toBe("flat");
    expect(r.shown.length).toBe(4);
    expect(r.chip).toBe("+6");
  });

  it("problems are always items before the chip, healthy only after them", () => {
    const r = show(rows, groups, widths, 500);
    expect(r.shown.slice(0, 2).sort()).toEqual(["b6", "s3"]);
    // Room for one item only: a problem, and the chip names the other.
    const tight = show(rows, groups, widths, 170);
    expect(tight.shown).toHaveLength(1);
    expect(["b6", "s3"]).toContain(tight.shown[0]);
    expect(tight.chip).toBe("+9, 1 down");
  });

  it("a problem too wide to fit never blocks a later one", () => {
    const r = show(
      [one("long-down", false), one("short-down", false), one("ok", true)],
      null as never,
      { "long-down": 400, "short-down": 60, ok: 40 },
      200,
    );
    expect(r.shown).toEqual(["short-down"]);
    expect(r.chip).toBe("+2, 1 down");
  });

  it("all flat when that fits, even if the boxes don't", () => {
    const r = show(rows, groups, widths, 1000, 200);
    expect(r).toMatchObject({ mode: "flat", chip: null });
    expect(r.shown).toHaveLength(10);
  });
});

describe("planRow: 7+3+1 repos at 1920 (the flat fallback)", () => {
  // Two boxes and a lone repo: the boxes don't fit, every repo flat does.
  const big = ["b1", "b2", "b3", "b4", "b5", "b6", "b7"];
  const small = ["s1", "s2", "s3"];
  const rows = [...big, ...small, "lone"].map((r) => one(r, r !== "b6"));
  const groups = [
    { app: { name: "smb" }, repos: big },
    { app: { name: "core" }, repos: small },
    { app: null, repos: ["lone"] },
  ];
  const widths = Object.fromEntries(rows.map((r) => [r.repo, 80]));
  it("shows all 11 flat with no chip when the boxes are too wide", () => {
    const r = show(rows, groups, widths, 1000, 120);
    expect(r).toMatchObject({ mode: "flat", chip: null });
    expect(r.shown).toHaveLength(11);
    expect(r.shown[0]).toBe("b6");
  });
  it("boxed when it all fits", () => {
    expect(show(rows, groups, widths, 1100, 40).mode).toBe("boxed");
  });
});

describe("planRow: a 6+3 workspace with measured widths", () => {
  // Widths measured in a browser at 1920 (a consumer theme's font; names
  // here stand in for the real ones, the widths are theirs). The
  // row's geometry is the header's: 10px between units, 8px inside a box,
  // a box adds its label, 14px padding and a 2px border; the row loses 4px
  // padding a side, the refresh button (17px) and one gap.
  const smb = [
    "platform-client",
    "feature-whatsapp",
    "feature-voice",
    "platform-infra",
    "platform-base",
    "ai-platform",
  ];
  const ent = [
    "demo-webapp",
    "demo-graphrag-server",
    "demo-knowledge-graph-builder",
  ];
  const width: Record<string, number> = {
    "ai-platform": 71.5,
    "feature-voice": 84.5,
    "feature-whatsapp": 109.0,
    "platform-infra": 86.9,
    "platform-base": 86.3,
    "platform-client": 109.6,
    "demo-graphrag-server": 135.7,
    "demo-knowledge-graph-builder": 182.4,
    "demo-webapp": 88.9,
  };
  // Checked: everything but ai-platform; the smb workspace is focused.
  const rows = [...smb, ...ent].map((r) =>
    one(r, r === "ai-platform" ? null : true, smb.includes(r)),
  );
  const groups = [
    { app: { name: "smb" }, repos: smb },
    { app: { name: "enterprise" }, repos: ent },
  ];
  const GAP = 10;
  const BOX_GAP = 8;
  const label: Record<string, number> = { smb: 22, enterprise: 55 };
  const fit = (rowWidth: number) => {
    const row = buildRow(rows, groups);
    const boxW = (u: { app: { name: string }; repos: { repo: string }[] }) =>
      label[u.app.name] +
      u.repos.reduce((a, r) => a + width[r.repo] + BOX_GAP, 0) +
      14 +
      2;
    const boxed =
      row.units.reduce((a: number, u: never) => a + boxW(u), 0) +
      GAP * (row.units.length - 1);
    const avail = rowWidth - 8 - 17 - GAP;
    const plan = fitPlan(row, {
      avail,
      boxed,
      widths: row.flat.map((r: { repo: string }) => width[r.repo]),
      gap: GAP,
      chipWidth: 30 + GAP,
    });
    const hidden = row.flat.filter(
      (r: { repo: string }) => !plan.show.has(r.repo),
    );
    return {
      mode: plan.mode,
      shown: row.flat
        .filter((r: { repo: string }) => plan.show.has(r.repo))
        .map((r: { repo: string }) => r.repo),
      chip: hidden.length ? moreChip(hidden).short : null,
      boxed,
      flatTotal:
        Object.values(width).reduce((a, w) => a + w, 0) +
        GAP * 8 +
        8 +
        17 +
        GAP,
    };
  };

  it("needs about 1070px for all nine flat, as measured", () => {
    expect(fit(1000).flatTotal).toBeCloseTo(1069.8, 0);
  });

  it("about 1000px: 7 items flat and +2, healthy before unchecked", () => {
    const r = fit(1001.7);
    expect(r.mode).toBe("flat");
    expect(r.shown).toEqual([
      "feature-voice",
      "feature-whatsapp",
      "platform-base",
      "platform-client",
      "platform-infra",
      "demo-graphrag-server",
      "demo-knowledge-graph-builder",
    ]);
    expect(r.chip).toBe("+2");
  });

  it("about 1280px: both boxes whole, no chip", () => {
    const r = fit(1281.7);
    expect(r).toMatchObject({ mode: "boxed", chip: null });
    expect(r.shown).toHaveLength(9);
  });
});

describe("fitPlan: the first frames of a cold load", () => {
  const rows = [one("api", true), one("web", false), one("jobs", null)];
  const row = buildRow(rows, null);
  const real = { avail: 400, boxed: 260, widths: [80, 80, 80], gap: 8 };
  // Something always shows: items, the chip, or the placeholder.
  const visible = (plan: { mode: string; show: Set<string> }) =>
    plan.mode === "placeholder" ||
    plan.show.size > 0 ||
    row.flat.some((r: { repo: string }) => !plan.show.has(r.repo));

  it("before data: a placeholder, not an empty row", () => {
    expect(fitPlan(null, real).mode).toBe("placeholder");
  });

  it("before layout or fonts (zero widths): everything, and a retry", () => {
    for (const early of [
      { ...real, avail: 0 },
      { ...real, avail: -33 },
      { ...real, boxed: 0 },
      { ...real, widths: [0, 0, 0] },
      { ...real, widths: [] },
    ]) {
      const plan = fitPlan(row, early);
      expect(plan).toMatchObject({ mode: "boxed", retry: true });
      expect(plan.show.size).toBe(3);
    }
  });

  it("zero widths first, then real ones: the row ends with items or a chip", () => {
    const frames = [
      { ...real, avail: 0, boxed: 0, widths: [0, 0, 0] },
      { ...real, widths: [0, 0, 0] },
      real,
      { ...real, avail: 120, boxed: 300 },
      { ...real, avail: 20, boxed: 300 },
    ];
    for (const m of frames) expect(visible(fitPlan(row, m))).toBe(true);
    const last = fitPlan(row, real);
    expect(last).toMatchObject({ mode: "boxed", retry: false });
    const tight = fitPlan(row, { ...real, avail: 120, boxed: 300 });
    expect(tight.mode).toBe("flat");
    expect([...tight.show]).toEqual(["web"]);
  });
});

describe("moreChip", () => {
  it("says what the hidden repos hold", () => {
    expect(
      moreChip([
        { state: "down" },
        { state: "degraded" },
        { state: "unknown" },
        { state: "ok" },
      ]),
    ).toEqual({
      text: "+4, 1 down, 1 degraded",
      forms: ["+4, 1 down, 1 degraded", "+4, 1 down", "+4"],
      short: "+4",
      label: "4 more repos, 1 down, 1 degraded",
      problem: true,
    });
    expect(moreChip([{ state: "unknown" }]).label).toBe("1 more repo");
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
  const hidden = [{ state: "down" }, { state: "ok" }, { state: "unknown" }];
  const mount = () => {
    const chip = mountMoreChip(doc, hidden, (list: El) => {
      list.innerHTML = "<div>the hidden repos</div>";
    }) as unknown as El;
    header.appendChild(chip);
    return chip;
  };

  it("is short when the row has no room for the detail, never in its name", () => {
    const chip = mountMoreChip(doc, hidden, () => {}, {
      form: 2,
    }) as unknown as El;
    expect(chip.textContent).toBe("+3");
    expect(chip.attrs["aria-label"]).toBe("3 more repos, 1 down");
    expect((chip as unknown as { title: string }).title).toBe(
      "3 more repos, 1 down",
    );
  });

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
  it("lays the row out after every paint, on resize and on its own resize", () => {
    expect(header).toMatch(/from "\.\/health-fit\.js"/);
    expect(header).toMatch(/_layoutHealthRow\(container\);/);
    expect(header).toMatch(/addEventListener\("resize"/);
    expect(header).toMatch(/new ResizeObserver/);
  });
  it("never paints an empty row: a placeholder before data, retried fits", () => {
    expect(header).toMatch(/class="health-pending"/);
    expect(header).toMatch(/fitPlan\(row, \{/);
    expect(header).toMatch(/if \(plan\.retry\)/);
    // Laid out before the application and editor lookups resolve.
    const body = header.slice(
      header.indexOf("async function renderHealthDots"),
    );
    expect(body.indexOf("_layoutHealthRow(container)")).toBeLessThan(
      body.indexOf("await Promise.all([_loadEditorKey(), _loadApps()])"),
    );
    expect(header).toMatch(/document\.fonts\?\.ready\?\.then\(_queueFit\)/);
  });
  it("never squeezes the brand or the version badge", () => {
    const css = fs.readFileSync(path.join(PUBLIC, "appearance.js"), "utf-8");
    expect(css).toMatch(
      /header:has\(> \.health\) > :not\(\.health\):not\(nav\):not\(\.h-spacer\):not\(\.spacer\),\s*\.topbar:has\(> \.health\) > :not\(\.health\):not\(nav\):not\(\.h-spacer\):not\(\.spacer\) \{\s*flex-shrink: 0; min-width: max-content;/,
    );
  });
  it("takes the header's free space, not its content's width", () => {
    const css = fs.readFileSync(path.join(PUBLIC, "appearance.js"), "utf-8");
    expect(css).toMatch(
      /header > \.health, \.topbar > \.health \{ min-width: 0; flex: 1 1 0; overflow: hidden; \}/,
    );
  });
  it("is served", async () => {
    const { UI_MODULES } = await import("../../../src/ui/server/ui-assets.js");
    expect(UI_MODULES).toEqual(
      expect.arrayContaining(["/health-fit.js", "/health-rollup.js"]),
    );
  });
});
