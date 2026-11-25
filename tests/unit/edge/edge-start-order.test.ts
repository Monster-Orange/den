/**
 * What the server does with the edge at its start (edge/start.ts), in this
 * order, so a running edge with Traefik's API on is never handed a proof
 * that stays valid:
 *
 *   - this state dir's running edge serves the API: stop it before any
 *     proof is written, recreate it without the API with a new proof
 *     (`edge up --rotate-proof`), then release the hold;
 *   - it doesn't: sync the proof (syncEdgeProof), then release;
 *   - a stop or recreate that fails holds edge trust back (no proof
 *     proves, edgeTrustHeld), with the reason doctor shows, and writes no
 *     proof.
 *
 * And the hold itself: while it stands no proof proves, and doctor says
 * why and what to run. Fake steps, temp folders.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  edgeProofChecker,
  EDGE_PROOF_HEADER,
  edgeTrustHeld,
  ensureEdgeProof,
  holdEdgeTrust,
  releaseEdgeTrust,
} from "../../../src/shared/edge/proof.js";
import {
  edgeStart,
  edgeStartRetrying,
  unsureHold,
} from "../../../src/shared/edge/start.js";
import { edgeProofLines } from "../../../src/ui/cli/doctor-command.js";

let dir = "";
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-edge-start-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function steps(o: {
  api: boolean;
  check?: Error;
  stop?: Error;
  recreate?: Error;
}) {
  const order: string[] = [];
  const run = edgeStart({
    servesApi: async () => {
      order.push("servesApi");
      if (o.check) throw o.check;
      return o.api;
    },
    stop: async () => {
      order.push("stop");
      if (o.stop) throw o.stop;
    },
    recreate: async () => {
      order.push("recreate");
      if (o.recreate) throw o.recreate;
    },
    sync: () => order.push("sync"),
    hold: (reason) => order.push(`hold: ${reason}`),
    unsure: (reason) => order.push(`unsure: ${reason}`),
    release: () => order.push("release"),
    log: () => undefined,
  });
  return { order, run };
}

describe("the edge at server start", () => {
  it("no API edge: sync the proof, then release", async () => {
    const s = steps({ api: false });
    expect(await s.run).toBe("synced");
    expect(s.order).toEqual(["servesApi", "sync", "release"]);
  });

  it("an API edge: stopped before anything is written, recreated with a new proof, then released; never synced first", async () => {
    const s = steps({ api: true });
    expect(await s.run).toBe("recreated");
    expect(s.order).toEqual(["servesApi", "stop", "recreate", "release"]);
  });

  it("the API check errors (Docker there but not answering): trust held back for this run, no proof synced", async () => {
    const s = steps({ api: false, check: new Error("timed out") });
    expect(await s.run).toBe("unsure");
    expect(s.order).toEqual([
      "servesApi",
      "unsure: couldn't tell whether the running edge has Traefik's API on (timed out)",
    ]);
  });

  it("unsure: asked again later, and once Docker answers, synced and released", async () => {
    const order: string[] = [];
    let answers = 0;
    const later: { fn: () => void; ms: number }[] = [];
    const deps = {
      servesApi: async () => {
        order.push("servesApi");
        if (answers++ === 0) throw new Error("permission denied");
        return false;
      },
      stop: async () => undefined,
      recreate: async () => undefined,
      sync: () => order.push("sync"),
      hold: (reason: string) => order.push(`hold: ${reason}`),
      unsure: () => order.push("unsure"),
      release: () => order.push("release"),
      log: () => undefined,
    };
    const first = await edgeStartRetrying(deps, {
      everyMs: 60_000,
      later: (fn, ms) => later.push({ fn, ms }),
    });
    expect(first).toBe("unsure");
    expect(order).toEqual(["servesApi", "unsure"]);
    expect(later.map((l) => l.ms)).toEqual([60_000]);
    later[0].fn();
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual([
      "servesApi",
      "unsure",
      "servesApi",
      "sync",
      "release",
    ]);
    // Answered: nothing more is scheduled.
    expect(later).toHaveLength(1);
  });

  /** A check that errors `n` times, then answers no API. */
  const flaky = (n: number) => {
    const order: string[] = [];
    let asked = 0;
    const later: { fn: () => void; ms: number }[] = [];
    const deps = {
      servesApi: async () => {
        order.push("servesApi");
        if (asked++ < n) throw new Error("timed out");
        return false;
      },
      stop: async () => undefined,
      recreate: async () => undefined,
      sync: () => order.push("sync"),
      hold: (reason: string) => order.push(`hold: ${reason}`),
      unsure: () => order.push("unsure"),
      release: () => order.push("release"),
      log: () => undefined,
    };
    const next = async () => {
      later[later.length - 1].fn();
      await new Promise((r) => setImmediate(r));
    };
    return { order, later, deps, next };
  };

  it("unsure stays held through every error: trust comes back only on an answer of no API", async () => {
    const f = flaky(3);
    await edgeStartRetrying(f.deps, {
      everyMs: 60_000,
      later: (fn, ms) => f.later.push({ fn, ms }),
    });
    await f.next();
    await f.next();
    expect(f.order).not.toContain("release");
    expect(f.order).not.toContain("sync");
    expect(f.order.filter((o) => o === "unsure")).toHaveLength(3);
    await f.next();
    expect(f.order.slice(-2)).toEqual(["sync", "release"]);
  });

  it("never asks faster than edge.address_recheck_seconds, one wait at a time (and never under a second)", async () => {
    const f = flaky(3);
    await edgeStartRetrying(f.deps, {
      everyMs: 45_000,
      later: (fn, ms) => f.later.push({ fn, ms }),
    });
    await f.next();
    await f.next();
    // One wait scheduled per unsure answer, each the setting's length.
    expect(f.later.map((l) => l.ms)).toEqual([45_000, 45_000, 45_000]);
    const g = flaky(1);
    await edgeStartRetrying(g.deps, {
      everyMs: 0,
      later: (fn, ms) => g.later.push({ fn, ms }),
    });
    expect(g.later.map((l) => l.ms)).toEqual([1000]);
  });

  it("stops asking once Den stops", async () => {
    const f = flaky(5);
    let stopped = false;
    await edgeStartRetrying(f.deps, {
      everyMs: 60_000,
      later: (fn, ms) => f.later.push({ fn, ms }),
      stopped: () => stopped,
    });
    expect(f.later).toHaveLength(1);
    stopped = true;
    await f.next();
    // The wait that was due does nothing, and nothing more is scheduled.
    expect(f.order).toEqual(["servesApi", "unsure"]);
    expect(f.later).toHaveLength(1);
  });

  it("the stop fails: trust held back, nothing recreated or written", async () => {
    const s = steps({ api: true, stop: new Error("no docker") });
    expect(await s.run).toBe("held");
    expect(s.order).toEqual([
      "servesApi",
      "stop",
      "hold: the running edge has Traefik's API on and couldn't be stopped (no docker)",
    ]);
  });

  it("the recreate fails: trust held back, no proof synced", async () => {
    const s = steps({ api: true, recreate: new Error("port 80 in use") });
    expect(await s.run).toBe("held");
    expect(s.order).toEqual([
      "servesApi",
      "stop",
      "recreate",
      "hold: the edge was stopped (it had Traefik's API on) and couldn't be recreated (port 80 in use)",
    ]);
  });
});

describe("the unsure hold (Reviewer C): its own, never another's", () => {
  it("held while unsure, said once per reason, and released once Docker answers", () => {
    const trust = { held: null as string | null };
    const h = unsureHold(trust);
    expect(h.unsure("no answer")).toBe(true);
    expect(h.unsure("no answer")).toBe(false);
    expect(trust.held).toBe("no answer");
    h.release();
    expect(trust.held).toBeNull();
  });

  it("a hold something else set first is never replaced or ended by it", () => {
    const trust = { held: "edge up failed" as string | null };
    const h = unsureHold(trust);
    h.unsure("no answer");
    expect(trust.held).toBe("edge up failed");
    h.release();
    expect(trust.held).toBe("edge up failed");
  });

  it("a hold set after it (the edge-up route failing meanwhile) survives its release", () => {
    const trust = { held: null as string | null };
    const h = unsureHold(trust);
    h.unsure("no answer");
    trust.held = "edge up failed";
    h.release();
    expect(trust.held).toBe("edge up failed");
  });

  it("released with nothing held: nothing to end", () => {
    const trust = { held: null as string | null };
    unsureHold(trust).release();
    expect(trust.held).toBeNull();
  });
});

describe("holding edge trust back", () => {
  const asks = (proof: string) => ({
    headers: { [EDGE_PROOF_HEADER]: proof } as Record<string, string>,
  });

  it("while held no proof proves; released, the proof proves again", () => {
    const p = ensureEdgeProof(dir);
    const check = () => edgeProofChecker(() => dir)(asks(p));
    expect(check()).toBe(true);
    holdEdgeTrust(dir, "a reason");
    expect(edgeTrustHeld(dir)).toBe("a reason");
    expect(check()).toBe(false);
    releaseEdgeTrust(dir);
    expect(edgeTrustHeld(dir)).toBeNull();
    expect(check()).toBe(true);
  });

  it("doctor says it is held, why, and what to run; never the proof", () => {
    const p = ensureEdgeProof(dir);
    fs.mkdirSync(path.join(dir, "dynamic"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "dynamic", "000-den.yml"),
      `X-Den-Edge-Proof: ${p}\n`,
    );
    holdEdgeTrust(dir, "the edge couldn't be recreated (port 80 in use)");
    const r = edgeProofLines("Acme", "acme", () => dir);
    expect(r.check).toMatchObject({ id: "edge_proof", status: "warn" });
    expect(r.check?.detail).toMatch(
      /Acme holds back the edge's trust: the edge couldn't be recreated \(port 80 in use\)/,
    );
    expect(r.check?.detail).toMatch(/everyone signs in through it/);
    expect(r.check?.detail).toMatch(/acme edge up/);
    expect(JSON.stringify(r)).not.toContain(p);
  });
});
