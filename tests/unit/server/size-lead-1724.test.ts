import { describe, expect, it } from "@jest/globals";
import { SizeLead } from "../../../src/ui/server/term-size-lead.js";

const S = { cols: 120, rows: 40 };
const T = { cols: 80, rows: 30 };

function lead(graceMs = 30_000) {
  let t = 0;
  const l = new SizeLead<string>({ graceMs, now: () => t });
  return { l, at: (ms: number) => (t = ms) };
}

describe("issue 1724: the view that holds the size keeps it through a blip", () => {
  it("the lead's socket goes and comes back within the grace: still the lead, and another view's refit is ignored meanwhile", () => {
    const { l, at } = lead();
    l.attach("A");
    l.attach("B");
    expect(l.resize("A", S, true)).toEqual(S);
    l.detach("A");
    at(5_000);
    expect(l.leader()).toBe("A");
    expect(l.resize("B", T)).toBeNull();
    l.attach("A");
    expect(l.leader()).toBe("A");
    expect(l.resize("A", S)).toEqual(S);
  });

  it("a view that attaches or reattaches while another holds it follows; its refit is ignored", () => {
    const { l } = lead();
    l.attach("A");
    expect(l.resize("A", S, true)).toEqual(S);
    l.attach("B");
    expect(l.resize("B", T)).toBeNull();
    l.detach("B");
    l.attach("B");
    expect(l.resize("B", T)).toBeNull();
    expect(l.leader()).toBe("A");
  });

  it("gone past the grace: the view left takes it", () => {
    const { l, at } = lead(30_000);
    l.attach("A");
    l.attach("B");
    l.resize("A", S, true);
    l.detach("A");
    at(29_999);
    expect(l.expire()).toBe(false);
    expect(l.leader()).toBe("A");
    at(30_000);
    expect(l.expire()).toBe(true);
    expect(l.leader()).toBe("B");
    expect(l.resize("B", T)).toEqual(T);
  });

  it("a new view that comes while the holder is gone and nobody else is here takes it; one seen before still waits out the grace", () => {
    const { l } = lead();
    l.attach("A");
    l.attach("B");
    l.resize("A", S, true);
    l.detach("B");
    l.detach("A");
    l.attach("B");
    expect(l.leader()).toBe("A");
    l.detach("B");
    l.attach("C");
    expect(l.leader()).toBe("C");
    expect(l.resize("C", T)).toEqual(T);
  });

  it("a new view while someone else is still here follows the gone holder", () => {
    const { l } = lead();
    l.attach("A");
    l.attach("B");
    l.resize("A", S, true);
    l.detach("A");
    l.attach("C");
    expect(l.leader()).toBe("A");
    expect(l.resize("C", T)).toBeNull();
  });

  it("a pane closed on purpose hands it on at once, grace or not", () => {
    const { l } = lead(30_000);
    l.attach("A");
    l.attach("B");
    l.resize("A", S, true);
    l.detach("A", false);
    expect(l.leader()).toBe("B");
    expect(l.expire()).toBe(false);
  });

  it("a claim (a person's key, Take over, a deliberate open) moves it at once, gone lead or not", () => {
    const { l } = lead();
    l.attach("A");
    l.attach("B");
    l.resize("A", S, true);
    expect(l.resize("B", T, true)).toEqual(T);
    expect(l.leader()).toBe("B");
    l.input("A");
    expect(l.leader()).toBe("A");
  });

  it("the first view of a session leads; a non-lead's detach changes nothing", () => {
    const { l, at } = lead();
    l.attach("A");
    expect(l.leader()).toBe("A");
    l.attach("B");
    l.detach("B");
    at(60_000);
    expect(l.expire()).toBe(false);
    expect(l.leader()).toBe("A");
  });

  it("a grace of 0 releases at once, as before", () => {
    const { l } = lead(0);
    l.attach("A");
    l.attach("B");
    l.resize("A", S, true);
    l.detach("A");
    expect(l.leader()).toBe("B");
    expect(l.expire()).toBe(false);
    expect(l.resize("B", T)).toEqual(T);
  });

  it("whether a view holds it, for the frame each view hears", () => {
    const { l } = lead();
    l.attach("A");
    l.attach("B");
    expect(l.holds("A")).toBe(true);
    expect(l.holds("B")).toBe(false);
    expect(l.held()).toBe(true);
  });
});
