/**
 * Hardening: a GitHub sign-in start replaces only the same browser's
 * pending one. Its start sets a browser tag (an HttpOnly cookie Den signs);
 * two people behind one address each keep their own sign-in. An address
 * still can't fill every slot: past its share, its oldest makes room.
 */
import { describe, expect, it } from "@jest/globals";
import {
  DeviceFlows,
  MAX_PENDING_FLOWS,
  browserTagFor,
} from "../../../src/ui/server/device-flows.js";
import type { GithubDeviceClient } from "../../../src/shared/github-device.js";

function rig() {
  let n = 0;
  const client: GithubDeviceClient = {
    start: async () => {
      n++;
      return {
        deviceCode: `dc-${n}`,
        userCode: `CODE-${n}`,
        expiresIn: 900,
        interval: 5,
      };
    },
    poll: async () => ({ kind: "pending" }),
    user: async () => ({ id: 1, login: "octo" }),
    orgMember: async () => "not_member" as const,
  };
  return new DeviceFlows({
    client,
    clientId: () => "Iv23liAcme",
    decide: () => "refused",
    now: () => 1_000_000,
    schedule: () => () => undefined,
  });
}

async function start(f: DeviceFlows, client: string, browser?: string) {
  const r = await f.start("signin", {
    client,
    ...(browser ? { browser } : {}),
  });
  if ("error" in r) throw new Error(r.error);
  return r.id;
}

describe("hardening: a sign-in start replaces its own browser's only", () => {
  const ip = "100.64.0.9";

  it("two browsers behind one address: both sign-ins stay", async () => {
    const f = rig();
    const a = await start(f, ip, f.browserTag());
    const b = await start(f, ip, f.browserTag());
    expect(f.get(a)).toMatchObject({ state: "pending" });
    expect(f.get(b)).toMatchObject({ state: "pending" });
  });

  it("the same browser again (a reload): its old one is replaced", async () => {
    const f = rig();
    const tag = f.browserTag();
    const a = await start(f, ip, tag);
    const b = await start(f, ip, tag);
    expect(f.get(a)).toBeNull();
    expect(f.get(b)).toMatchObject({ state: "pending" });
  });

  it("a tag Den didn't sign counts as none", async () => {
    const f = rig();
    const a = await start(f, ip);
    const b = await start(f, ip, "forged.tag");
    expect(f.get(a)).toBeNull();
    expect(f.get(b)).toMatchObject({ state: "pending" });
  });

  it("one address past all slots but one: a new browser's start is busy, none is cancelled", async () => {
    const f = rig();
    const ids: string[] = [];
    for (let i = 0; i < MAX_PENDING_FLOWS - 1; i++)
      ids.push(await start(f, ip, f.browserTag()));
    expect(
      await f.start("signin", { client: ip, browser: f.browserTag() }),
    ).toEqual({ error: "busy" });
    for (const id of ids) expect(f.get(id)).toMatchObject({ state: "pending" });
    expect(
      "error" in (await f.start("signin", { client: "100.64.0.10" })),
    ).toBe(false);
  });

  it("a peer at the person's address, fresh tags each start, never cancels the person's sign-in", async () => {
    const f = rig();
    const person = await start(f, ip, f.browserTag());
    const peer1 = await f.start("signin", {
      client: ip,
      browser: f.browserTag(),
    });
    const peer2 = await f.start("signin", {
      client: ip,
      browser: f.browserTag(),
    });
    expect("error" in peer1).toBe(false);
    expect(peer2).toEqual({ error: "busy" });
    expect(f.get(person)).toMatchObject({ state: "pending" });
  });

  it("at the address's share, the same browser still replaces its own (a reload)", async () => {
    const f = rig();
    const tag = f.browserTag();
    await start(f, ip, f.browserTag());
    const a = await start(f, ip, tag);
    const b = await start(f, ip, tag);
    expect(f.get(a)).toBeNull();
    expect(f.get(b)).toMatchObject({ state: "pending" });
  });
});

describe("hardening: the browser tag cookie", () => {
  it("none sent: a new signed tag, set HttpOnly and SameSite=Strict on the GitHub routes", () => {
    const f = rig();
    const r = browserTagFor(undefined, f);
    expect(f.browserOk(r.tag)).toBe(true);
    expect(r.setCookie).toMatch(/^den_gh_b=[^;]+; /);
    expect(r.setCookie).toContain("HttpOnly");
    expect(r.setCookie).toContain("SameSite=Strict");
    expect(r.setCookie).toContain("Path=/api/github");
  });

  it("over https: the cookie is Secure too", () => {
    const f = rig();
    expect(browserTagFor(undefined, f, true).setCookie).toMatch(/; Secure$/);
    expect(browserTagFor(undefined, f, false).setCookie).not.toContain(
      "Secure",
    );
  });

  it("a signed one sent: kept, no new cookie", () => {
    const f = rig();
    const tag = f.browserTag();
    const r = browserTagFor(`a=1; den_gh_b=${tag}`, f);
    expect(r).toEqual({ tag });
  });

  it("a forged one sent: replaced with a signed one", () => {
    const f = rig();
    const r = browserTagFor("den_gh_b=forged.tag", f);
    expect(r.tag).not.toBe("forged.tag");
    expect(f.browserOk(r.tag)).toBe(true);
    expect(r.setCookie).toBeDefined();
  });
});
