/**
 * #267: the Den agent's hub_connect: the same check as Settings › Hub,
 * Den's own agent only, disconnect first when connected, then save and
 * restart. A token never stays beside a different address. Issue 1632: a
 * connected install moving to another Hub waits for the sign-in instead.
 */
import { describe, expect, it } from "@jest/globals";
import {
  checkHubAddress,
  runHubAddress,
} from "../../../src/ui/server/hub-address.js";

const deps = (user: Record<string, unknown>) => {
  const calls: string[] = [];
  let saved: Record<string, unknown> = structuredClone(user);
  return {
    calls,
    saved: () => saved,
    d: {
      readUser: () => structuredClone(saved),
      writeUser: (u: Record<string, unknown>) => {
        calls.push("write");
        saved = u;
      },
      disconnect: async (force: boolean) => {
        calls.push(force ? "disconnect force" : "disconnect");
        return { ok: true };
      },
      restart: async (reason: string) => {
        calls.push(`restart ${reason}`);
        return { ok: true };
      },
      // Issue 1632: a switch to another Hub (hub-switch-1632.test.ts).
      switching: (s: { to: string }) => void calls.push(`switching ${s.to}`),
    },
  };
};

describe("hub_connect (#267)", () => {
  it("a project's agent is refused: the address is the whole install's", () => {
    const { d } = deps({});
    const c = checkHubAddress(
      d,
      { url: "https://hub.example.com" },
      {
        agent: "a1",
        project: "web",
      },
    );
    expect(c.ok).toBe(false);
  });

  it("checks the address as Settings does, and says nothing to change", () => {
    const { d } = deps({ hub: { url: "https://hub.example.com" } });
    expect(checkHubAddress(d, { url: "http://hub.example.com" }).ok).toBe(
      false,
    );
    expect(checkHubAddress(d, { url: "https://hub.example.com/" }).ok).toBe(
      false,
    );
    const c = checkHubAddress(d, { url: "https://other.example.com" });
    expect(c).toMatchObject({
      ok: true,
      personOnly: true,
      args: { url: "https://other.example.com" },
    });
  });

  it("connected, clearing: disconnects first, drops the token, saves and restarts", async () => {
    const x = deps({
      hub: { url: "https://hub.example.com", token: { kind: "file" } },
    });
    const r = await runHubAddress(x.d, { url: "none" });
    expect(r).toMatchObject({ ok: true, url: null });
    expect(x.calls).toEqual([
      "disconnect",
      "write",
      "restart Hub's address cleared",
    ]);
    expect(x.saved().hub).toBeUndefined();
  });

  it("connected, to another Hub: issue 1632's switch, nothing written yet", async () => {
    const x = deps({
      hub: { url: "https://hub.example.com", token: { kind: "file" } },
    });
    const r = await runHubAddress(x.d, { url: "https://other.example.com" });
    expect(r).toMatchObject({ ok: true, connect: true });
    expect(x.calls).toEqual(["switching https://other.example.com"]);
  });

  it("none clears it", async () => {
    const x = deps({ hub: { url: "https://hub.example.com" } });
    expect(checkHubAddress(x.d, { url: "none" })).toMatchObject({
      ok: true,
      args: { url: null },
    });
    const r = await runHubAddress(x.d, { url: "none" });
    expect(r.ok).toBe(true);
    expect(x.saved().hub).toBeUndefined();
    expect(x.calls).toEqual(["write", "restart Hub's address cleared"]);
  });
});

describe("issue 726: hub_connect archives the old Hub's state", () => {
  it("after the write and before the restart", async () => {
    // Not connected yet: the address is written at once (issue 1632 waits
    // for a sign-in only when there's a Hub in use to keep).
    const { d, calls } = deps({ hub: { url: "https://hub.example.com" } });
    const r = await runHubAddress(
      {
        ...d,
        changed: async (url: string | null) =>
          void calls.push(`changed ${url}`),
      },
      { url: "https://other.example.com" },
    );
    expect(r.ok).toBe(true);
    expect(calls).toEqual([
      "write",
      "changed https://other.example.com",
      "restart Hub's address set to https://other.example.com",
    ]);
  });
});
