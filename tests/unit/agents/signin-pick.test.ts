/**
 * Issue 340 (slice 3 of the always-on accounts design, issue 163): when an
 * agent starts under the always-on service, Den picks the sign-in whose
 * token it gets:
 *
 *   1. the one a sign-in source maps to the agent's folder, if a source is
 *      set and Den has that token;
 *   2. otherwise the one the source reports active;
 *   3. otherwise the first in Den's own order that is not capped.
 *
 * A capped sign-in is skipped at every step. With none, nothing is picked
 * and each sign-in says why (never a token, never an email).
 *
 * Invented tokens only; the "store" is a map of ref name to token.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import {
  accountLabel,
  vendorName,
  addAccount,
  pickAccount,
  setAccountOrder,
  type AccountSource,
} from "../../../src/shared/agents/signin-accounts.js";
import { cleanupRigs, rig } from "./helpers/rig.js";

afterEach(cleanupRigs);

const T1 = "fake-pick-one-0123456789abcdef";
const T2 = "fake-pick-two-0123456789abcdef";
const T3 = "fake-pick-three-0123456789abcdef";

/** A store of ref name to token; counts its reads. */
function store(values: Record<string, string>) {
  const reads: string[] = [];
  return {
    reads,
    read: async (name: string) => {
      reads.push(name);
      return values[name]
        ? { token: values[name]! }
        : { token: null, reason: "not set" };
    },
  };
}

// The default labels, in whatever words the product uses for them.
const A = accountLabel({ id: "1" }, vendorName("den-claude"));
const B = accountLabel({ id: "2" }, vendorName("den-claude"));

const ALL = {
  agent_signin_token: T1,
  agent_signin_token__2: T2,
  agent_signin_token__3: T3,
};

async function threeAccounts() {
  const r = await rig();
  addAccount(r.stateDir, "den-claude");
  addAccount(r.stateDir, "den-claude", "Work");
  return r;
}

describe("with no source: Den's own order", () => {
  it("the first sign-in in the order is used", async () => {
    const r = await threeAccounts();
    const s = store(ALL);
    const p = await pickAccount({
      stateDir: r.stateDir,
      runtimeId: "den-claude",
      read: s.read,
    });
    expect(p.picked).toMatchObject({
      token: T1,
      from: "order",
      label: A,
    });
    expect(p.picked!.account.id).toBe("1");
    // Only the one it used is read.
    expect(s.reads).toEqual(["agent_signin_token"]);
    setAccountOrder(r.stateDir, "den-claude", ["3", "1", "2"]);
    const q = await pickAccount({
      stateDir: r.stateDir,
      runtimeId: "den-claude",
      read: store(ALL).read,
    });
    expect(q.picked).toMatchObject({ token: T3, label: "Work" });
  });

  it("a capped sign-in is skipped", async () => {
    const r = await threeAccounts();
    const s = store(ALL);
    const p = await pickAccount({
      stateDir: r.stateDir,
      runtimeId: "den-claude",
      read: s.read,
      capped: (_rt, id) => id === "1",
    });
    expect(p.picked).toMatchObject({ token: T2, label: B });
    // A capped one isn't even read.
    expect(s.reads).toEqual(["agent_signin_token__2"]);
    expect(p.misses).toEqual([{ id: "1", label: A, reason: "capped" }]);
  });

  it("a sign-in with no token is passed over for the next", async () => {
    const r = await threeAccounts();
    const p = await pickAccount({
      stateDir: r.stateDir,
      runtimeId: "den-claude",
      read: store({ agent_signin_token__3: T3 }).read,
    });
    expect(p.picked).toMatchObject({ token: T3, from: "order" });
    expect(p.misses.map((m) => [m.label, m.reason])).toEqual([
      [A, "not set"],
      [B, "not set"],
    ]);
  });
});

describe("with a source", () => {
  /** A source that maps a folder to a sign-in and reports one active. */
  const source = (
    folders: Record<string, string>,
    active: string | null,
  ): AccountSource => ({
    forFolder: (_rt, folder) => folders[folder] ?? null,
    active: () => active,
  });

  it("the sign-in mapped to the agent's folder comes first", async () => {
    const r = await threeAccounts();
    const p = await pickAccount({
      stateDir: r.stateDir,
      runtimeId: "den-claude",
      folder: "/w/south",
      read: store(ALL).read,
      source: source({ "/w/south": "3" }, "2"),
    });
    expect(p.picked).toMatchObject({ token: T3, from: "folder" });
  });

  it("two agents in different projects run on different sign-ins", async () => {
    const r = await threeAccounts();
    const src = source({ "/w/north": "2", "/w/south": "3" }, null);
    const pick = (folder: string) =>
      pickAccount({
        stateDir: r.stateDir,
        runtimeId: "den-claude",
        folder,
        read: store(ALL).read,
        source: src,
      });
    expect((await pick("/w/north")).picked!.token).toBe(T2);
    expect((await pick("/w/south")).picked!.token).toBe(T3);
  });

  it("no mapping, or a mapped one Den has no token for: the active one", async () => {
    const r = await threeAccounts();
    const src = source({ "/w/south": "3" }, "2");
    const a = await pickAccount({
      stateDir: r.stateDir,
      runtimeId: "den-claude",
      folder: "/w/north",
      read: store(ALL).read,
      source: src,
    });
    expect(a.picked).toMatchObject({ token: T2, from: "active" });
    const b = await pickAccount({
      stateDir: r.stateDir,
      runtimeId: "den-claude",
      folder: "/w/south",
      read: store({ agent_signin_token: T1, agent_signin_token__2: T2 }).read,
      source: src,
    });
    expect(b.picked).toMatchObject({ token: T2, from: "active" });
    expect(b.misses).toEqual([{ id: "3", label: "Work", reason: "not set" }]);
  });

  it("neither usable: Den's order, capped ones skipped; an id that is no sign-in is ignored", async () => {
    const r = await threeAccounts();
    const s = store(ALL);
    const p = await pickAccount({
      stateDir: r.stateDir,
      runtimeId: "den-claude",
      folder: "/w/north",
      read: s.read,
      source: source({ "/w/north": "9" }, "2"),
      capped: (_rt, id) => id === "2",
    });
    expect(p.picked).toMatchObject({ token: T1, from: "order" });
    // Each sign-in is read at most once.
    expect(s.reads).toEqual(["agent_signin_token"]);
  });

  it("a source that throws is no source", async () => {
    const r = await threeAccounts();
    const p = await pickAccount({
      stateDir: r.stateDir,
      runtimeId: "den-claude",
      folder: "/w/north",
      read: store(ALL).read,
      source: {
        forFolder: () => {
          throw new Error("source down");
        },
        active: () => {
          throw new Error("source down");
        },
      },
    });
    expect(p.picked).toMatchObject({ token: T1, from: "order" });
  });
});

describe("no sign-in with a token", () => {
  it("nothing is picked, and each says why", async () => {
    const r = await threeAccounts();
    const p = await pickAccount({
      stateDir: r.stateDir,
      runtimeId: "den-claude",
      read: store({ agent_signin_token__2: T2 }).read,
      capped: (_rt, id) => id === "2",
    });
    expect(p.picked).toBeNull();
    expect(p.misses).toEqual([
      { id: "1", label: A, reason: "not set" },
      { id: "2", label: B, reason: "capped" },
      { id: "3", label: "Work", reason: "not set" },
    ]);
    expect(JSON.stringify(p)).not.toContain("fake-pick");
  });
});
