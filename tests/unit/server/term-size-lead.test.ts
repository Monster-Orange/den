import { describe, expect, it } from "@jest/globals";
import { SizeLead } from "../../../src/ui/server/term-size-lead.js";

type Size = { cols: number; rows: number };

function rig() {
  const lead = new SizeLead<string>();
  const pty: Size[] = [];
  return {
    lead,
    pty,
    resize: (v: string, z: Size, claim = false) => {
      const got = lead.resize(v, z, claim);
      if (got) pty.push(got);
    },
    typed: (v: string) => lead.input(v),
    detach: (v: string) => lead.detach(v),
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

  it("the one typed in becomes active: its refits apply, the other's no longer do", () => {
    const r = rig();
    r.lead.attach("main");
    r.resize("main", { cols: 160, rows: 40 });
    r.lead.attach("peek");
    r.typed("peek");
    expect(r.lead.leader()).toBe("peek");
    expect(r.pty).toEqual([{ cols: 160, rows: 40 }]);
    r.resize("peek", { cols: 80, rows: 24 });
    r.resize("main", { cols: 170, rows: 40 });
    expect(r.pty).toEqual([
      { cols: 160, rows: 40 },
      { cols: 80, rows: 24 },
    ]);
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

  it("when the active viewer goes, the one left leads and its size applies", () => {
    const r = rig();
    r.lead.attach("main");
    r.resize("main", { cols: 160, rows: 40 });
    r.lead.attach("peek");
    r.resize("peek", { cols: 80, rows: 24 }, true);
    r.detach("peek");
    expect(r.lead.leader()).toBe("main");
    r.resize("main", { cols: 160, rows: 40 });
    expect(r.pty.at(-1)).toEqual({ cols: 160, rows: 40 });
  });

  it("closing a peek that never led leaves the main pane's size alone", () => {
    const r = rig();
    r.lead.attach("main");
    r.resize("main", { cols: 160, rows: 40 });
    r.lead.attach("peek");
    r.resize("peek", { cols: 80, rows: 24 });
    r.detach("peek");
    expect(r.pty).toEqual([{ cols: 160, rows: 40 }]);
    expect(r.lead.leader()).toBe("main");
  });
});
