/**
 * Issue 310: Den draws the kit's Account area (den-ui account-area.js) from
 * its own records: the rail-foot account entry opens it, ?account=<section>
 * opens it on any page, and Settings › Access keeps a link "Your account →".
 * This file checks Den's side with no browser:
 *
 *   - denAccountData maps what Den knows (GET /api/session's identity, the
 *     linked browsers, the owner, the pair hostnames) to the kit's fields
 *   - a GitHub sign-in: the name, @login, Owner, Edit on GitHub, how and
 *     since when this browser signed in, Sign out (Den's own action: its
 *     csrf is a header) and Sign out everywhere
 *   - a local browser on this machine: the owner's identity, "on this
 *     computer", no Sign out; a device signed in with a link: no person,
 *     a paired device
 *   - the devices: Den's device words, This device, its address, last seen;
 *     a list Den can't read is the kit's can't-list state
 *   - the kit draws all of it (accountAreaHtml), and Settings › Access's
 *     first row links to the Account area
 */
import { describe, expect, it } from "@jest/globals";
import { denAccountData } from "../../../src/ui/server/public/account-den.js";
import { placeOf } from "../../../src/ui/server/public/device-words.js";
import {
  accountAreaHtml,
  type AccountAreaData,
} from "../../../packages/den-ui/src/account-area.js";
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
  clientId: true,
};

describe("issue 310: denAccountData", () => {
  it("a GitHub sign-in: the person, how and since when, and both sign-outs", () => {
    const d = denAccountData({
      identity: { kind: "github", via: "github", login: "sam", name: "Sam" },
      owner: OWNER,
      sessions: SESSIONS,
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
      signOutAll: true,
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
          where: "Local network",
          lastSeen: "2026-11-19T18:00:00.000Z",
        },
        {
          id: "d4e5f6",
          name: "Unknown browser",
          current: false,
          where: "",
          lastSeen: "2026-11-13T18:00:00.000Z",
        },
      ],
      pair: true,
      signOutAll: true,
    });
    expect(d.settingsHref).toBe("/settings#access");
  });

  it("Hub's name when GitHub has none and Hub's login is the same one", () => {
    const d = denAccountData({
      identity: { kind: "github", via: "github", login: "sam" },
      owner: OWNER,
      sessions: SESSIONS,
      hub: { name: "Sam Example", login: "SAM" },
    });
    expect(d.profile.name).toBe("Sam Example");
    const other = denAccountData({
      identity: { kind: "github", via: "github", login: "sam" },
      sessions: SESSIONS,
      hub: { name: "Someone", login: "someone" },
    });
    expect(other.profile.name).toBeUndefined();
  });

  it("a local browser: the owner's identity, on this computer, no Sign out", () => {
    const d = denAccountData({
      identity: { kind: "local", owner: { login: "sam", role: "owner" } },
      owner: OWNER,
      sessions: SESSIONS.map((s) => ({ ...s, current: false })),
    });
    expect(d.profile).toMatchObject({
      login: "sam",
      role: "Owner",
      how: "local",
      signOut: null,
    });
    expect(d.profile.since).toBeUndefined();
  });

  it("a device signed in with a link or a code: no person, a paired device", () => {
    const d = denAccountData({
      identity: { kind: "device", via: "code" },
      owner: OWNER,
      sessions: [{ ...SESSIONS[1], current: true }],
    });
    expect(d.profile).toEqual({
      how: "paired",
      since: "2026-11-10T09:00:00.000Z",
      signOut: true,
      signOutAll: true,
    });
    // No person: the kit's profile needs a login, so the heading is the
    // kit's how line alone (no @undefined).
    const html = accountAreaHtml({ ...d, lang: "en" } as AccountAreaData);
    expect(html).not.toContain("undefined");
  });

  it("devices Den can't read: the kit's can't-list state", () => {
    const d = denAccountData({
      identity: { kind: "github", via: "github", login: "sam" },
      sessions: null,
    });
    expect(d.devices).toEqual({ error: true });
    expect(d.profile.signOut).toBeNull();
  });

  it("the kit draws it: This device, Sign out as Den's action, no form", () => {
    const d = denAccountData({
      identity: { kind: "github", via: "github", login: "sam", name: "Sam" },
      owner: OWNER,
      sessions: SESSIONS,
      pairHosts: ["den.example.test"],
    });
    const html = accountAreaHtml({ ...d, lang: "en" } as AccountAreaData);
    expect(html).toContain('data-aa-act="sign-out"');
    expect(html).not.toContain("<form");
    expect(html).toContain("This device");
    expect(html).toContain('data-aa-act="sign-out-device" data-aa-id="d4e5f6"');
    expect(html).toContain('data-aa-act="unlink"');
  });
});

describe("issue 310 review: a device's place, never its address", () => {
  it("placeOf: this computer, the local network, or nothing", () => {
    expect(placeOf("127.0.0.1")).toBe("This computer");
    expect(placeOf("::1")).toBe("This computer");
    expect(placeOf("::ffff:127.0.0.1")).toBe("This computer");
    for (const a of [
      "192.168.1.20",
      "10.0.0.7",
      "172.20.1.1",
      "100.101.102.103",
      "169.254.1.1",
      "fd12:3456::1",
      "fe80::1",
      "::ffff:10.1.2.3",
    ])
      expect(placeOf(a)).toBe("Local network");
    for (const a of [
      "203.0.113.9",
      "172.32.0.1",
      "8.8.8.8",
      "2001:db8::1",
      "",
      undefined,
    ])
      expect(placeOf(a)).toBe("");
  });

  it("the Devices pane shows the place; the address never reaches the page", () => {
    const d = denAccountData({
      identity: { kind: "github", via: "github", login: "sam" },
      owner: OWNER,
      sessions: [SESSIONS[0], { ...SESSIONS[1], client: "203.0.113.9" }],
    });
    expect(d.devices.list!.map((x: { where: string }) => x.where)).toEqual([
      "Local network",
      "",
    ]);
    const html = accountAreaHtml({ ...d, lang: "en" } as AccountAreaData);
    expect(html).toContain("Local network");
    expect(html).not.toContain("192.168.1.20");
    expect(html).not.toContain("203.0.113.9");
  });
});

describe("issue 310: Settings › Access links to the Account area", () => {
  it("its first row is Your account →", () => {
    const access = SETTINGS.filter((s) => s.category === "access");
    expect(access[0].id).toBe("access.account");
    const host = { innerHTML: "" };
    (access[0].control as { render: (h: typeof host) => void }).render(host);
    expect(host.innerHTML).toContain('href="?account=profile"');
    expect(host.innerHTML).toContain("data-den-aa-open");
    expect(host.innerHTML).toContain("Your account →");
  });
});
