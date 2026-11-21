/**
 * Issue 791, clause 3: a second view of the same terminal (a peek over
 * the page, another browser) never fights the main pane over its size.
 * The last active viewer sets the size: the one the person typed in, or
 * the one that claimed it (Take over, the pane the person just opened);
 * a lone viewer leads. Another viewer's refit (its window resized, a font
 * that loaded late, a layout change) never resizes the PTY while it does
 * not lead; it is told the size in use and follows it.
 *
 * The rules without a server: src/ui/server/term-size-lead.ts, which the
 * io route (session-routes.ts) asks before each resize.
 */
import { describe, expect, it } from "@jest/globals";
import { SizeLead } from "../../../src/ui/server/term-size-lead.js";

type Size = { cols: number; rows: number };

/** A fake PTY behind one lead: every size it was given, in order. */
function rig() {
  const lead = new SizeLead<string>();
  const pty: Size[] = [];
  const apply = (z: Size | null) => {
    if (z) pty.push(z);
  };
  return {
    lead,
    pty,
    resize: (v: string, z: Size, claim = false) =>
      apply(lead.resize(v, z, claim)),
    typed: (v: string) => apply(lead.input(v)),
    detach: (v: string) => apply(lead.detach(v)),
  };
}

describe("issue 791: the last active viewer sets the size", () => {
  it("a lone viewer sizes the PTY", () => {
    const r = rig();
    r.lead.attach("main");
    r.resize("main", { cols: 160, rows: 40 });
    expect(r.pty).toEqual([{ cols: 160, rows: 40 }]);
    expect(r.lead.leader()).toBe("main");
  });

  it("two viewers: a second view's refit never resizes the PTY while the main pane leads", () => {
    const r = rig();
    r.lead.attach("main");
    r.resize("main", { cols: 160, rows: 40 });
    r.lead.attach("peek");
    // The peek's box is small: its refit is not a claim.
    r.resize("peek", { cols: 80, rows: 24 });
    expect(r.pty).toEqual([{ cols: 160, rows: 40 }]);
    expect(r.lead.leader()).toBe("main");
  });

  it("the other is never resized mid-typing: typing in the main pane keeps its size whatever the peek says", () => {
    const r = rig();
    r.lead.attach("main");
    r.resize("main", { cols: 160, rows: 40 });
    r.lead.attach("peek");
    for (let i = 0; i < 5; i++) {
      r.typed("main");
      r.resize("peek", { cols: 80 + i, rows: 24 });
    }
    expect(r.pty).toEqual([{ cols: 160, rows: 40 }]);
  });

  it("the one typed in becomes active and its size wins, with no resize message of its own", () => {
    const r = rig();
    r.lead.attach("main");
    r.resize("main", { cols: 160, rows: 40 });
    r.lead.attach("peek");
    r.resize("peek", { cols: 80, rows: 24 });
    r.typed("peek");
    expect(r.pty).toEqual([
      { cols: 160, rows: 40 },
      { cols: 80, rows: 24 },
    ]);
    expect(r.lead.leader()).toBe("peek");
    // Now the main pane's refit is the follower's: ignored.
    r.resize("main", { cols: 170, rows: 40 });
    expect(r.pty).toHaveLength(2);
  });

  it("a claim (Take over, the pane just opened) takes the size at once", () => {
    const r = rig();
    r.lead.attach("main");
    r.resize("main", { cols: 160, rows: 40 });
    r.lead.attach("other");
    r.resize("other", { cols: 100, rows: 30 }, true);
    expect(r.pty.at(-1)).toEqual({ cols: 100, rows: 30 });
    expect(r.lead.leader()).toBe("other");
  });

  it("when the active viewer goes, the one left takes its own size back", () => {
    const r = rig();
    r.lead.attach("main");
    r.resize("main", { cols: 160, rows: 40 });
    r.lead.attach("peek");
    r.resize("peek", { cols: 80, rows: 24 });
    r.typed("peek");
    r.detach("peek");
    expect(r.pty.at(-1)).toEqual({ cols: 160, rows: 40 });
    expect(r.lead.leader()).toBe("main");
  });

  it("closing a peek that never led leaves the main pane's size alone", () => {
    const r = rig();
    r.lead.attach("main");
    r.resize("main", { cols: 160, rows: 40 });
    r.lead.attach("peek");
    r.resize("peek", { cols: 80, rows: 24 });
    r.detach("peek");
    expect(r.pty).toEqual([{ cols: 160, rows: 40 }]);
  });

  it("typing that only repeats the active viewer's size resizes nothing", () => {
    const r = rig();
    r.lead.attach("main");
    r.resize("main", { cols: 160, rows: 40 });
    r.typed("main");
    r.typed("main");
    expect(r.pty).toEqual([{ cols: 160, rows: 40 }]);
  });
});
