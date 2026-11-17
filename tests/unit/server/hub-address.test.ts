/**
 * #267: the Den agent's hub_connect: the same check as Settings › Hub,
 * Den's own agent only, disconnect first when connected, then save and
 * restart. A token never stays beside a different address.
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

  it("connected: disconnects first, drops the token, saves and restarts", async () => {
    const x = deps({
      hub: { url: "https://hub.example.com", token: { kind: "file" } },
    });
    const r = await runHubAddress(x.d, { url: "https://other.example.com" });
    expect(r).toMatchObject({ ok: true, url: "https://other.example.com" });
    expect(x.calls).toEqual([
      "disconnect",
      "write",
      "restart Hub's address set to https://other.example.com",
    ]);
    expect(x.saved().hub).toEqual({ url: "https://other.example.com" });
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
