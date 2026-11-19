/**
 * Issue 310: Den draws the kit's Account area (den-ui account-area.js) from
 * its own records, as the approved Account area mock (v2) says: the
 * rail-foot account entry opens it, and Settings › Access keeps a link
 * "Your account →". This file checks Den's side with no browser:
 *
 *   - denAccountData maps what Den knows (GET /api/session's identity, the
 *     linked browsers, the waiting codes, the owner, the pair hostnames)
 *     to the kit's fields: Profile, Access and security, Devices and
 *     sessions, and the cross-link to Settings
 *   - a GitHub sign-in: the name, @login, Owner, Edit on GitHub, how and
 *     since when this browser signed in, Sign out and Sign out everywhere
 *   - a local browser on this machine: the owner's identity, "on this
 *     computer"; a device signed in with a link: no person, how it came in
 *   - the devices: Den's device words, This device, its address, last seen;
 *     a list Den can't read is the kit's can't-list state
 *   - Settings › Access's first row links to the Account area
 */
import { describe, expect, it } from "@jest/globals";
import { denAccountData } from "../../../src/ui/server/public/account-den.js";
import { DEN_SETTINGS as SETTINGS } from "../../../src/ui/server/public/settings-registry.js";

const SESSIONS = [
  {
    id: "a1b2c3",
    name: "Safari on macOS",
    via: "github",
    login: "sam",
    client: "192.168.1.20",
    createdAt: "2026-11-18T09:00:00.000Z",
    lastSeenAt: "2026-11-19T18:00:00.000Z",
    current: true,
  },
  {
    id: "d4e5f6",
    name: "Unknown browser",
    via: "code",
    createdAt: "2026-11-10T09:00:00.000Z",
    lastSeenAt: "2026-11-13T18:00:00.000Z",
  },
];
const OWNER = {
  owner: { login: "sam", id: 42, linkedAt: "2026-11-12T09:00:00.000Z" },
  clientId: "Iv1.x",
};

describe("denAccountData", () => {
  it("a GitHub sign-in: the person, how and since when, and both sign-outs", () => {
    const d = denAccountData({
      identity: { kind: "github", via: "github", login: "sam", name: "Sam" },
      owner: OWNER,
      sessions: SESSIONS,
      waiting: [{ code: "K7QX-92MD", device: "Chrome on Linux" }],
      pairHosts: ["den.example.test"],
    });
    expect(d.profile).toEqual({
      name: "Sam",
      login: "sam",
      role: "Owner",
      editHref: "https://github.com/settings/profile",
      how: "github",
      since: "2026-11-18T09:00:00.000Z",
      signOut: true,
      signOutEverywhere: true,
    });
    expect(d.access).toEqual({
      github: {
        login: "sam",
        linkedAt: "2026-11-12T09:00:00.000Z",
        unlink: true,
      },
      pair: true,
    });
    expect(d.devices).toEqual({
      list: [
        {
          id: "a1b2c3",
          name: "Safari on macOS",
          current: true,
          where: "192.168.1.20",
          lastSeenAt: "2026-11-19T18:00:00.000Z",
        },
        {
          id: "d4e5f6",
          name: "Unknown browser",
          current: false,
          where: "",
          lastSeenAt: "2026-11-13T18:00:00.000Z",
        },
      ],
      waiting: [{ code: "K7QX-92MD", minutes: 10 }],
      pair: true,
      signOutEverywhere: true,
    });
    expect(d.settings).toEqual({ href: "/settings#access" });
  });

  it("a local browser on this machine: the owner, on this computer", () => {
    const d = denAccountData({
      identity: {
        kind: "local",
        owner: { login: "sam", name: "Sam", role: "owner" },
      },
      owner: OWNER,
      sessions: [],
      waiting: [],
      pairHosts: [],
    });
    expect(d.profile).toMatchObject({
      name: "Sam",
      login: "sam",
      role: "Owner",
      how: "local",
    });
    expect(d.profile.signOut).toBe(false);
    expect(d.access.pair).toBe(false);
  });

  it("GitHub has no name: Hub's, when Hub's login is the same (as the rail entry)", () => {
    const base = {
      identity: { kind: "github", via: "github", login: "sam" },
      owner: OWNER,
      sessions: SESSIONS,
      waiting: [],
      pairHosts: [],
    };
    expect(
      denAccountData({ ...base, hub: { name: "Sam Hub", login: "SAM" } })
        .profile.name,
    ).toBe("Sam Hub");
    expect(
      denAccountData({ ...base, hub: { name: "Other", login: "other" } })
        .profile.name,
    ).toBeUndefined();
  });

  it("a device signed in with a code: no person, how it came in", () => {
    const d = denAccountData({
      identity: { kind: "device", via: "code" },
      owner: { owner: null, clientId: "Iv1.x" },
      sessions: [{ ...SESSIONS[1], current: true }],
      waiting: [],
      pairHosts: [],
    });
    expect(d.profile).toEqual({
      how: "code",
      since: "2026-11-10T09:00:00.000Z",
      signOut: true,
      signOutEverywhere: true,
    });
    expect(d.access.github).toBeNull();
  });

  it("can't read the devices: the kit's can't-list state", () => {
    const d = denAccountData({
      identity: { kind: "github", via: "github", login: "sam" },
      owner: OWNER,
      sessions: null,
      waiting: null,
      pairHosts: [],
    });
    expect(d.devices).toEqual({ error: true });
  });
});

describe("Settings › Access", () => {
  it("starts with a link to the Account area", () => {
    const access = SETTINGS.filter(
      (s: { category: string }) => s.category === "access",
    );
    expect(access[0]).toMatchObject({
      id: "access.account",
      label: "Your profile and devices",
    });
  });
});
