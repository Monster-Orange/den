/**
 * Issue 163: the page side of Settings › Keep agents running after logout
 * › Apply (applyKeepRunning in settings-registry.js). The server decides
 * when sudo needs the password (needsSudo); only then does the page ask,
 * then apply again. No password: nothing more is sent. Applied: Den
 * restarts, and the page waits for it to come back.
 */
import { describe, expect, it } from "@jest/globals";
// @ts-expect-error plain browser module
import { applyKeepRunning } from "../../../src/ui/server/public/settings-registry.js";

function world(answers: unknown[], password: boolean) {
  const posted: unknown[] = [];
  const asked: unknown[] = [];
  let waited = 0;
  return {
    posted,
    asked,
    waited: () => waited,
    deps: {
      post: async (body: unknown) => {
        posted.push(body);
        return answers.shift();
      },
      askSudo: async (need: unknown) => {
        asked.push(need);
        return password;
      },
      waitBack: async () => {
        waited++;
      },
    },
  };
}

describe("Apply: the page", () => {
  it("needs sudo: asks with the server's command, then applies again and waits for Den", async () => {
    const need = { command: "acme service install --mode always" };
    const w = world(
      [
        { ok: false, needsSudo: need },
        { ok: true, applied: true, mode: "always" },
      ],
      true,
    );
    expect(await applyKeepRunning(true, w.deps)).toEqual({
      state: "applied",
      mode: "always",
    });
    expect(w.asked).toEqual([need]);
    expect(w.posted).toEqual([{ on: true }, { on: true }]);
    expect(w.waited()).toBe(1);
  });

  it("no password given: nothing more is sent, nothing waits", async () => {
    const w = world([{ ok: false, needsSudo: { command: "x" } }], false);
    expect(await applyKeepRunning(true, w.deps)).toEqual({ state: "refused" });
    expect(w.posted).toEqual([{ on: true }]);
    expect(w.waited()).toBe(0);
  });

  it("off over login: never asks; saved, nothing to restart", async () => {
    const w = world([{ ok: true, applied: false, mode: "login" }], false);
    expect(await applyKeepRunning(false, w.deps)).toEqual({
      state: "saved",
      mode: "login",
    });
    expect(w.asked).toEqual([]);
    expect(w.waited()).toBe(0);
  });

  it("a failure says so", async () => {
    const w = world([null], true);
    expect(await applyKeepRunning(true, w.deps)).toEqual({ state: "failed" });
  });
});

// @ts-expect-error plain browser module
import { keepTokenLine } from "../../../src/ui/server/public/settings-registry.js";

/** Issue 163 (b): the row's sign-in token line (never the token). */
describe("Keep agents running after logout: the sign-in token line", () => {
  const t = (k: string, v?: Record<string, unknown>) =>
    `${k}${v ? ` ${JSON.stringify(v)}` : ""}`;

  it("none configured: agents will not be able to sign in after logout", () => {
    expect(keepTokenLine({ configured: false }, t)).toEqual({
      state: "missing",
      text: "keep.noToken",
    });
    expect(keepTokenLine(null, t).state).toBe("missing");
  });

  it("old: says how many days, to make a new one", () => {
    expect(
      keepTokenLine({ configured: true, old: true, age_days: 340 }, t),
    ).toEqual({ state: "old", text: 'keep.tokenOld {"n":340}' });
  });

  it("set: says when; unknown when: names the store", () => {
    const set = keepTokenLine(
      { configured: true, old: false, set_at: "2026-11-16T10:00:00Z" },
      t,
    );
    expect(set.state).toBe("set");
    expect(set.text).toMatch(/^keep\.tokenSet \{"date":".*2026.*"\}$/);
    expect(
      keepTokenLine({ configured: true, set_at: null, store: "Doppler" }, t),
    ).toEqual({ state: "set", text: 'keep.tokenStore {"store":"Doppler"}' });
  });
});
