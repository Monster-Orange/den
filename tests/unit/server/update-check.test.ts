/**
 * SRV-P6 (0.4.48): each Den keeps itself current. Every
 * server_agent.update_check_minutes Den looks at npm:
 *
 *   - The lead install (solo is the lead) targets npm's latest. With
 *     self_update: auto it updates at an idle moment (the server agent
 *     idle, no Allow open, no update under way); with ask, one held
 *     "update to X" for the person and a bell notice, once per version.
 *   - A follower install targets the distribution's pin and never moves
 *     it: a newer npm version is the lead's to take.
 *   - A version that rolled back isn't tried again on every pass (the
 *     failure is already in the bell).
 *   - A Den run from a checkout (not npm) is updated with git: skipped.
 *
 * Fakes for npm, the pin, idle and the update. Invented versions only.
 */
import { describe, expect, it } from "@jest/globals";
import {
  updateCheck,
  type UpdateCheckDeps,
} from "../../../src/ui/server/update-check.js";

function fake(over: Partial<UpdateCheckDeps> = {}) {
  const calls: string[] = [];
  const d: UpdateCheckDeps = {
    running: () => "1.2.0",
    latest: async () => "1.3.0",
    pinned: () => "1.2.0",
    role: () => "lead",
    mode: () => "ask",
    cantUpdate: () => null,
    last: () => null,
    idle: async () => true,
    update: async (v) => {
      calls.push(`update ${v}`);
      return { ok: true };
    },
    ask: (v) => {
      calls.push(`ask ${v}`);
      return true;
    },
    notice: (v, text) => calls.push(`notice ${v}: ${text}`),
    ...over,
  };
  return { d, calls };
}

describe("the lead install", () => {
  it("ask: one held update for the person and a bell notice, once per version", async () => {
    const { d, calls } = fake();
    const c = updateCheck(d);
    expect(await c.tick()).toEqual({ did: "asked", version: "1.3.0" });
    expect(await c.tick()).toEqual({ did: "asked", version: "1.3.0" });
    expect(calls).toEqual([
      "ask 1.3.0",
      expect.stringMatching(/^notice 1\.3\.0: Den 1\.3\.0 is out/),
    ]);
  });

  it("auto: updates when idle; busy, it waits and tries on a later pass", async () => {
    let idle = false;
    const { d, calls } = fake({ mode: () => "auto", idle: async () => idle });
    const c = updateCheck(d);
    expect(await c.tick()).toEqual({ did: "waiting", version: "1.3.0" });
    expect(calls).toEqual([]);
    idle = true;
    expect(await c.tick()).toEqual({ did: "updating", version: "1.3.0" });
    expect(calls).toEqual(["update 1.3.0"]);
  });

  it("on the newest already, or npm can't say: nothing", async () => {
    expect(
      await updateCheck(fake({ latest: async () => "1.2.0" }).d).tick(),
    ).toEqual({ did: "current" });
    expect(
      await updateCheck(fake({ latest: async () => "1.1.9" }).d).tick(),
    ).toEqual({ did: "current" });
    expect(
      await updateCheck(fake({ latest: async () => null }).d).tick(),
    ).toEqual({ did: "current" });
  });

  it("a version that rolled back isn't tried again; a newer one is", async () => {
    const last = {
      state: "rolled_back" as const,
      from: "1.2.0",
      to: "1.3.0",
      at: "2026-11-14T10:00:00Z",
      why: "1.3.0 wasn't up in 180 s",
    };
    const { d, calls } = fake({ mode: () => "auto", last: () => last });
    expect(await updateCheck(d).tick()).toEqual({
      did: "skipped",
      version: "1.3.0",
      why: expect.stringMatching(/rolled back/),
    });
    expect(calls).toEqual([]);
    const next = fake({
      mode: () => "auto",
      last: () => last,
      latest: async () => "1.3.1",
    });
    expect(await updateCheck(next.d).tick()).toEqual({
      did: "updating",
      version: "1.3.1",
    });
  });

  it("an update that fails says so in the bell", async () => {
    const { d, calls } = fake({
      mode: () => "auto",
      update: async () => ({ ok: false, error: "npm has no 1.3.0" }),
    });
    expect(await updateCheck(d).tick()).toEqual({
      did: "failed",
      version: "1.3.0",
      why: "npm has no 1.3.0",
    });
    expect(calls).toEqual([
      expect.stringMatching(/^notice 1\.3\.0: .*npm has no 1\.3\.0/),
    ]);
  });
});

describe("a follower install", () => {
  it("applies the distribution's pin, never npm's newer version", async () => {
    const { d, calls } = fake({
      role: () => "follower",
      pinned: () => "1.2.5",
      latest: async () => "1.3.0",
      mode: () => "auto",
    });
    expect(await updateCheck(d).tick()).toEqual({
      did: "updating",
      version: "1.2.5",
    });
    expect(calls).toEqual(["update 1.2.5"]);
  });

  it("on the pin already: nothing, whatever npm has", async () => {
    const { d, calls } = fake({ role: () => "follower" });
    expect(await updateCheck(d).tick()).toEqual({ did: "current" });
    expect(calls).toEqual([]);
  });
});

describe("a Den run from a checkout", () => {
  it("is skipped: it is updated with git", async () => {
    const { d, calls } = fake({
      cantUpdate: () => "Den runs from a checkout here; update it with git",
    });
    expect(await updateCheck(d).tick()).toEqual({
      did: "skipped",
      why: "Den runs from a checkout here; update it with git",
    });
    expect(calls).toEqual([]);
  });
});

describe("the settings (SRV-P6)", () => {
  it("update_check_minutes: 30 by default, 0 is never, under 5 is refused; role: lead by default, or follower", async () => {
    const { readServerAgentConfig } =
      await import("../../../src/shared/den-config.js");
    const cfg = (uc?: unknown) =>
      (uc === undefined
        ? {}
        : { server_agent: { update_check_minutes: uc } }) as never;
    const r = readServerAgentConfig(cfg(), undefined, {});
    expect([r.updateCheckMs, r.role]).toEqual([30 * 60_000, "lead"]);
    expect(readServerAgentConfig(cfg(0), undefined, {}).updateCheckMs).toBe(0);
    expect(readServerAgentConfig(cfg(60), undefined, {}).updateCheckMs).toBe(
      3_600_000,
    );
    for (const bad of [3, -1, "30", Number.NaN])
      expect(() => readServerAgentConfig(cfg(bad), undefined, {})).toThrow(
        /server_agent\.update_check_minutes/,
      );
    expect(
      readServerAgentConfig(cfg(), undefined, {
        server_agent: { role: "follower" },
      }).role,
    ).toBe("follower");
    expect(() =>
      readServerAgentConfig(cfg(), undefined, {
        server_agent: { role: "boss" },
      }),
    ).toThrow(/server_agent\.role/);
  });
});
