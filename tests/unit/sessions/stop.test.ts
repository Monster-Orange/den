/**
 * stopSession: HUP, then KILL after the grace. A host started before
 * 0.4.40 refuses HUP (bad-request); it gets TERM, then KILL, so an
 * upgrade needs no host restart (the 0.4.40 gate's item g).
 */
import { describe, expect, it } from "@jest/globals";
import { HostError } from "../../../src/shared/sessions/client.js";
import { stopSession } from "../../../src/shared/sessions/stop.js";

function fakeHost(o: { knowsHup: boolean; endsOn: string[] }) {
  const sent: string[] = [];
  let alive = true;
  return {
    sent,
    c: {
      list: async () => [{ ref: { id: "s1" }, exited: !alive }] as never,
      kill: async (_id: string, sig: string) => {
        if (sig === "HUP" && !o.knowsHup)
          throw new HostError(
            "bad-request",
            "signal must be one of INT, TERM, KILL",
          );
        sent.push(sig);
        if (o.endsOn.includes(sig)) alive = false;
      },
    },
  };
}
const nap = async () => {};

describe("stopSession", () => {
  it("a shell that ends on HUP: stopped, no KILL", async () => {
    const h = fakeHost({ knowsHup: true, endsOn: ["HUP"] });
    const first: string[] = [];
    expect(
      await stopSession(h.c, "s1", 50, nap, (sig) => first.push(sig)),
    ).toBe("stopped");
    expect(h.sent).toEqual(["HUP"]);
    expect(first).toEqual(["HUP"]);
  });

  it("a host from before 0.4.40 refuses HUP: TERM, then KILL after the grace", async () => {
    const h = fakeHost({ knowsHup: false, endsOn: ["KILL"] });
    const first: string[] = [];
    expect(
      await stopSession(h.c, "s1", 20, nap, (sig) => first.push(sig)),
    ).toBe("killed");
    expect(h.sent).toEqual(["TERM", "KILL"]);
    expect(first).toEqual(["TERM"]);
  });

  it("an older host, a process that ends on TERM: stopped", async () => {
    const h = fakeHost({ knowsHup: false, endsOn: ["TERM"] });
    expect(await stopSession(h.c, "s1", 50, nap)).toBe("stopped");
    expect(h.sent).toEqual(["TERM"]);
  });

  it("any other refusal still fails", async () => {
    const c = {
      list: async () => [{ ref: { id: "s1" }, exited: false }] as never,
      kill: async () => {
        throw new HostError("exited", "s1 has already exited");
      },
    };
    await expect(stopSession(c, "s1", 20, nap)).rejects.toThrow(/exited/);
  });
});
