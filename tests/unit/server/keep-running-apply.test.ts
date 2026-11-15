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
