/**
 * den-ui, issue 310: the Account area (account-area.js), the checks that
 * need no browser. The approved Account area mock (v2) is the spec: one
 * place for "me", a pop-up drawn by the kit from data in every product.
 *
 *   - the shell: a 240px rail with a search box ("/"), four groups and
 *     their sections in the mock's order, the selected row marked, the
 *     cross-link "Install settings →" at the rail's foot; a phone strip
 *     with ✕, "Account" and a select of the sections; every pane drawn
 *     (each stays mounted), only the current one shown
 *   - ?account=<section> in the address: read and written by helpers
 *   - Profile: the avatar, the name (or @login), "@login · Role", Edit on
 *     GitHub; how this browser signed in and since when; Sign out and Sign
 *     out everywhere at the foot (no Sign out when there's no session)
 *   - Access and security: GitHub (linked: Unlink; not: Link), Another way
 *     in (Pair a device), personal tokens (name, created, last used or
 *     never, Revoke) and New token, only when the host has tokens
 *   - Devices and sessions: each device with "This device", last seen and
 *     Sign out; the only-this-device and can't-list states; Waiting to be
 *     approved (Code …, Approve); Pair a device and Sign out everywhere
 *   - Your notifications: one switch per choice, saved when changed
 *   - the host's words are data (escaped); the kit's words in en, es, ja
 *   - the look: the mock's sizes, value for value, in account-area.css
 *
 * The browser half (search, "/", Escape, the select, the address, Sign out
 * everywhere asking first, the sizes at 1280 and 390) is
 * account-area-kit.browser.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import {
  ACCOUNT_SECTIONS,
  accountAreaHref,
  accountAreaHtml,
  accountSectionOf,
  accessPaneHtml,
  devicesPaneHtml,
  notificationsPaneHtml,
  profilePaneHtml,
} from "../../../packages/den-ui/src/account-area.js";
import * as strings from "../../../packages/den-ui/src/strings.js";

type Table = Record<string, string>;
const { en, es, ja } = strings as unknown as Record<string, Table>;

const NOW = "2026-11-19T18:00:00.000Z";
const T = { lang: "en", now: NOW, zone: "UTC", product: "Den" };

const PROFILE = {
  name: "Sam Example",
  login: "sam",
  role: "Owner",
  editHref: "https://github.com/settings/profile",
  how: "github",
  since: "2026-11-18T09:00:00.000Z",
  signOut: true,
  signOutEverywhere: true,
};
const ACCESS = {
  github: { login: "sam", linkedAt: "2026-11-12T09:00:00.000Z", unlink: true },
  pair: true,
  tokens: [
    {
      id: "t1",
      name: "laptop cli",
      createdAt: "2026-11-14T09:00:00.000Z",
      lastUsedAt: "2026-11-19T16:00:00.000Z",
    },
    { id: "t2", name: "ci", createdAt: "2026-11-02T09:00:00.000Z" },
  ],
  newToken: true,
};
const DEVICES = {
  list: [
    {
      id: "a1",
      name: "Safari on Mac",
      current: true,
      where: "Local network",
      lastSeenAt: NOW,
    },
    {
      id: "b2",
      name: "Safari on iPhone",
      where: "Local network",
      lastSeenAt: "2026-11-19T16:00:00.000Z",
    },
    {
      id: "c3",
      name: "Chrome on Linux",
      lastSeenAt: "2026-11-13T18:00:00.000Z",
    },
  ],
  waiting: [{ code: "K7QX-92MD", minutes: 10 }],
  pair: true,
  signOutEverywhere: true,
};
const ALL = {
  ...T,
  current: "profile",
  settings: { href: "/settings" },
  profile: PROFILE,
  access: ACCESS,
  devices: DEVICES,
  notifications: {
    items: [
      {
        id: "waiting",
        label: "An agent needs me",
        help: "Allow, Deny or a question waiting for you.",
        on: true,
      },
      { id: "release", label: "New releases", help: "", on: false },
    ],
  },
};

/** The text a person reads: tags out, entities back, spaces folded. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
/** Every opening tag carrying a class. */
const tags = (html: string, cls: string) =>
  [...html.matchAll(/<[a-z0-9]+\b[^>]*>/g)]
    .map((m) => m[0])
    .filter((t) =>
      new RegExp(`class="(?:[^"]*\\s)?${cls}(?:\\s[^"]*)?"`).test(t),
    );
const attr = (tag: string, name: string) =>
  tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1] ?? null;
/** The row texts of a pane, in order. */
const rows = (html: string) =>
  [
    ...html.matchAll(
      /<div class="den-acct-row"[^>]*>([\s\S]*?)<\/div><!--row-->/g,
    ),
  ].map((m) => text(m[1]));

describe("the shell (accountAreaHtml)", () => {
  const h = accountAreaHtml(ALL);

  it("is one region named Account, with every pane mounted and only the current one shown", () => {
    expect(h).toMatch(/^<div class="den-acct" id="den-acct" data-den-acct/);
    expect(attr(tags(h, "den-acct")[0], "data-current")).toBe("profile");
    const panes = tags(h, "den-acct-pane");
    expect(panes.map((t) => attr(t, "data-section"))).toEqual([
      "profile",
      "access",
      "devices",
      "notifications",
    ]);
    expect(panes.map((t) => / hidden/.test(t))).toEqual([
      false,
      true,
      true,
      true,
    ]);
    // Each pane is named by its title, an h2.
    expect(h).toContain(
      '<h2 class="den-acct-h" id="den-acct-profile-h">Profile</h2>',
    );
  });

  it("draws the rail: the search box with /, the groups and sections in the mock's order, and the cross-link last", () => {
    const rail = h.slice(
      h.indexOf('class="den-acct-rail"'),
      h.indexOf('class="den-acct-panes"'),
    );
    // The phone's select is the same list again; the words, without it.
    expect(text(rail.replace(/<select[\s\S]*?<\/select>/, ""))).toBe(
      "Search account / Account Profile Sign-in and access Access and security Devices Devices and sessions Notifications Your notifications Install settings →",
    );
    const search = tags(rail, "den-acct-search-in")[0];
    expect(attr(search, "type")).toBe("search");
    expect(attr(search, "placeholder")).toBe("Search account");
    expect(attr(search, "aria-keyshortcuts")).toBe("/");
    const sec = tags(rail, "den-acct-sec");
    expect(sec.map((t) => attr(t, "data-section"))).toEqual([
      "profile",
      "access",
      "devices",
      "notifications",
    ]);
    // The selected row is marked, the others aren't.
    expect(sec.map((t) => attr(t, "aria-current"))).toEqual([
      "true",
      null,
      null,
      null,
    ]);
    // The cross-link goes to the host's settings.
    expect(attr(tags(rail, "den-acct-cross")[0], "href")).toBe("/settings");
  });

  it("draws the phone strip: ✕ named Close, the title, and a select of the sections", () => {
    const top = h.slice(h.indexOf('class="den-acct-top"'), h.indexOf('class="den-acct-rail"'));
    expect(text(top)).toBe("Account");
    expect(attr(tags(h, "den-acct")[0], "aria-labelledby")).toBe("den-acct-title");
    const close = tags(top, "den-acct-close")[0];
    expect(attr(close, "aria-label")).toBe("Close");
    const sel = h.match(/<select class="den-acct-sel"[\s\S]*?<\/select>/)![0];
    expect(attr(sel, "aria-label")).toBe("Sections");
    expect(
      [...sel.matchAll(/<option value="([a-z]+)"( selected)?>([^<]*)</g)].map(
        (m) => [m[1], !!m[2], m[3]],
      ),
    ).toEqual([
      ["profile", true, "Profile"],
      ["access", false, "Access and security"],
      ["devices", false, "Devices and sessions"],
      ["notifications", false, "Your notifications"],
    ]);
  });

  it("draws only the sections the host gives, in the kit's order", () => {
    const h2 = accountAreaHtml({
      ...T,
      current: "devices",
      profile: PROFILE,
      devices: DEVICES,
    });
    expect(
      tags(h2, "den-acct-sec").map((t) => attr(t, "data-section")),
    ).toEqual(["profile", "devices"]);
    expect(text(h2)).not.toContain("Sign-in and access");
    expect(text(h2)).not.toContain("Install settings");
    // The current section must be one it draws; else the first.
    const h3 = accountAreaHtml({ ...T, current: "access", profile: PROFILE });
    expect(attr(tags(h3, "den-acct")[0], "data-current")).toBe("profile");
  });

  it("lists the sections, their groups and order as data", () => {
    expect(ACCOUNT_SECTIONS.map((s) => [s.id, s.group])).toEqual([
      ["profile", "account"],
      ["access", "signin"],
      ["devices", "devices"],
      ["notifications", "notifications"],
    ]);
  });
});

describe("the address: ?account=<section>", () => {
  it("reads the section, or null", () => {
    expect(accountSectionOf("?account=devices")).toBe("devices");
    expect(accountSectionOf("?x=1&account=access")).toBe("access");
    expect(accountSectionOf("?account=")).toBe("profile");
    expect(accountSectionOf("?account=nope")).toBe("profile");
    expect(accountSectionOf("?x=1")).toBeNull();
    expect(accountSectionOf("")).toBeNull();
  });

  it("writes it into any page's address, and takes it out on close", () => {
    expect(accountAreaHref("/agents?x=1#a", "devices")).toBe(
      "/agents?x=1&account=devices#a",
    );
    expect(accountAreaHref("/agents?account=profile", "access")).toBe(
      "/agents?account=access",
    );
    expect(accountAreaHref("/agents?account=profile&x=1#a", null)).toBe(
      "/agents?x=1#a",
    );
    expect(accountAreaHref("/agents?account=profile", null)).toBe("/agents");
  });
});

describe("Profile (profilePaneHtml)", () => {
  it("draws the person, then how this browser signed in, then Sign out and Sign out everywhere", () => {
    const h = profilePaneHtml(PROFILE, T);
    expect(rows(h)).toEqual([
      "S Sam Example @sam · Owner Edit on GitHub ↗",
      "Signed in with GitHub This browser, since Nov 18 linked",
    ]);
    const edit = h.match(/<a [^>]*>Edit on GitHub ↗<\/a>/)![0];
    expect(attr(edit, "href")).toBe("https://github.com/settings/profile");
    expect(attr(edit, "target")).toBe("_blank");
    expect(attr(edit, "class")).toBe("den-btn ghost sm");
    const foot = h.slice(h.indexOf('class="den-acct-foot"'));
    expect(text(foot)).toBe("Sign out Sign out everywhere");
    expect(tags(foot, "den-btn").map((t) => attr(t, "class"))).toEqual([
      "den-btn",
      "den-btn ghost",
    ]);
    expect(
      tags(foot, "den-btn").map((t) => attr(t, "data-den-acct-act")),
    ).toEqual(["signout", "signout-all"]);
  });

  it("shows @login as the heading when there's no name, and leaves out what isn't given", () => {
    const h = profilePaneHtml(
      { login: "sam", how: "link", since: PROFILE.since },
      T,
    );
    expect(rows(h)).toEqual([
      "@ @sam",
      "Signed in with a one-time link This browser, since Nov 18",
    ]);
    expect(h).not.toContain("Edit on GitHub");
    expect(h).not.toContain("den-acct-foot");
  });

  it("names each way in, in the kit's words", () => {
    const how = (h: string) => rows(profilePaneHtml({ login: "s", how: h }, T))[1];
    expect(how("code")).toBe("Approved with a code This browser");
    expect(how("claim")).toBe("Signed in with a setup link This browser");
    expect(how("local")).toBe("On this computer This browser, on this computer");
  });

  it("shows the avatar picture when the host gives one", () => {
    const h = profilePaneHtml({ ...PROFILE, avatar: "/a.png" }, T);
    expect(h).toContain('<img class="den-acct-av" src="/a.png" alt="">');
  });
});

describe("Access and security (accessPaneHtml)", () => {
  it("draws GitHub, Another way in, then the tokens and New token", () => {
    const h = accessPaneHtml(ACCESS, T);
    expect(rows(h)).toEqual([
      "GitHub @sam · linked Nov 12. Den keeps its id, never a token. Unlink",
      "Another way in A one-time link and QR code for a device without GitHub. Pair a device",
      "laptop cli Created Nov 14 · Last used 2 hours ago Revoke",
      "ci Created Nov 2 · Never used Revoke",
    ]);
    expect(text(h)).toContain("Personal access tokens");
    expect(
      tags(h, "den-btn").map((t) => [
        attr(t, "data-den-acct-act"),
        attr(t, "data-id"),
        attr(t, "class"),
      ]),
    ).toEqual([
      ["unlink", null, "den-btn ghost sm"],
      ["pair", null, "den-btn sm"],
      ["revoke-token", "t1", "den-btn ghost sm"],
      ["revoke-token", "t2", "den-btn ghost sm"],
      ["new-token", null, "den-btn"],
    ]);
  });

  it("offers Link when GitHub isn't linked, and no tokens part when the host has none", () => {
    const h = accessPaneHtml({ github: null, pair: false }, T);
    expect(rows(h)).toEqual([
      "GitHub Not linked. Link it to sign in from any device. Link GitHub",
    ]);
    expect(text(h)).not.toContain("Personal access tokens");
    expect(text(h)).not.toContain("Another way in");
  });
});

describe("Devices and sessions (devicesPaneHtml)", () => {
  it("draws each device with This device, last seen and Sign out; then the waiting codes; then the foot", () => {
    const h = devicesPaneHtml(DEVICES, T);
    expect(rows(h)).toEqual([
      "Safari on Mac This device Local network · Last seen now Sign out",
      "Safari on iPhone Local network · Last seen 2 hours ago Sign out",
      "Chrome on Linux Last seen 6 days ago Sign out",
      "Code K7QX-92MD A computer’s sign-in page is showing this code. It lasts 10 minutes. Approve",
    ]);
    expect(text(h)).toContain("Waiting to be approved");
    const foot = h.slice(h.indexOf('class="den-acct-foot"'));
    expect(text(foot)).toBe("Pair a device Sign out everywhere");
    expect(
      tags(h, "den-btn").map((t) => [
        attr(t, "data-den-acct-act"),
        attr(t, "data-id"),
        attr(t, "class"),
      ]),
    ).toEqual([
      ["device-signout", "a1", "den-btn ghost sm"],
      ["device-signout", "b2", "den-btn ghost sm"],
      ["device-signout", "c3", "den-btn ghost sm"],
      ["approve", "K7QX-92MD", "den-btn sm"],
      ["pair", null, "den-btn"],
      ["signout-all", null, "den-btn ghost"],
    ]);
    // The device's name rides on its Sign out, for the toast and its name.
    expect(attr(tags(h, "den-btn")[1], "data-name")).toBe("Safari on iPhone");
  });

  it("says when this is the only device", () => {
    const h = devicesPaneHtml({ list: [DEVICES.list[0]] }, T);
    expect(text(h)).toContain(
      "No other devices When you sign in on another browser or phone, it appears here.",
    );
    expect(text(h)).not.toContain("Waiting to be approved");
  });

  it("says when it can't list the devices, with Try again", () => {
    const h = devicesPaneHtml({ error: true }, T);
    expect(text(h)).toBe(
      "Devices and sessions Can’t list your devices Den can’t reach its sign-in records right now. Try again",
    );
    expect(attr(tags(h, "den-btn")[0], "data-den-acct-act")).toBe("retry");
  });
});

describe("Your notifications (notificationsPaneHtml)", () => {
  it("draws one kit switch per choice, on or off", () => {
    const h = notificationsPaneHtml(ALL.notifications, T);
    const sw = tags(h, "den-switch-input");
    expect(sw.map((t) => [attr(t, "id"), / checked/.test(t)])).toEqual([
      ["den-acct-n-waiting", true],
      ["den-acct-n-release", false],
    ]);
    expect(text(h)).toContain(
      "An agent needs me Allow, Deny or a question waiting for you.",
    );
  });
});

describe("the host's words are data", () => {
  it("escapes names, logins, codes and hrefs", () => {
    const h = accountAreaHtml({
      ...T,
      profile: { name: '<b>x</b>"', login: "a&b", how: "github" },
      devices: {
        list: [{ id: '"x', name: "<i>Chrome</i>", lastSeenAt: NOW }],
        waiting: [{ code: "<C>" }],
      },
      settings: { href: 'javascript:"' },
    });
    expect(h).not.toContain("<b>x</b>");
    expect(h).not.toContain("<i>Chrome</i>");
    expect(h).not.toContain("<C>");
    expect(h).toContain("&lt;b&gt;x&lt;/b&gt;&quot;");
    expect(h).not.toMatch(/ on[a-z]+=/);
    expect(h).not.toContain(' style="');
  });
});

describe("the kit's words", () => {
  const keys = Object.keys(en).filter((k) => k.startsWith("kit.acct."));

  it("has every Account area word in en, es and ja", () => {
    expect(keys.length).toBeGreaterThan(30);
    for (const k of keys) {
      expect(es[k]).toBeTruthy();
      expect(ja[k]).toBeTruthy();
      expect(es[k]).not.toBe(en[k]);
    }
  });

  it("draws the area in es and ja", () => {
    const e = text(accountAreaHtml({ ...ALL, lang: "es" }));
    const j = text(accountAreaHtml({ ...ALL, lang: "ja" }));
    expect(e).toContain(es["kit.acct.sec.devices"]);
    expect(j).toContain(ja["kit.acct.sec.devices"]);
    expect(e).not.toContain("Devices and sessions");
    expect(j).not.toContain("Devices and sessions");
  });
});

describe("the look (account-area.css): the mock's values", () => {
  const css = fs.readFileSync(
    path.join(__dirname, "../../../packages/den-ui/src/account-area.css"),
    "utf-8",
  );
  const rule = (sel: string) => {
    const i = css.indexOf(sel + " {");
    expect(i).toBeGreaterThanOrEqual(0);
    return css.slice(i, css.indexOf("}", i));
  };

  it("is 960 wide by up to 640, with a 240px rail beside the pane", () => {
    expect(rule(".den-acct-dlg")).toContain("width: min(960px, 100vw - 32px)");
    expect(rule(".den-acct-dlg")).toContain("height: min(88vh, 640px)");
    expect(rule(".den-acct")).toContain("grid-template-columns: 240px 1fr");
  });

  it("draws the rail on the sunken surface, the selected row with a 3px accent bar", () => {
    expect(rule(".den-acct-rail")).toContain("background: var(--sunken)");
    expect(rule('.den-acct-sec[aria-current="true"]')).toContain(
      "box-shadow: inset 3px 0 0 var(--accent)",
    );
    expect(rule(".den-acct-grp")).toContain("text-transform: uppercase");
    expect(rule(".den-acct-h")).toContain("font: 400 22px/1.2 var(--display)");
    expect(rule(".den-acct-pane")).toContain("padding: 20px 24px 24px 32px");
  });

  it("turns the rail into a strip with a select under 768px, and every control is 44px", () => {
    const i = css.indexOf("@media (max-width: 767px)");
    expect(i).toBeGreaterThan(0);
    const phone = css.slice(i);
    expect(phone).toMatch(/\.den-acct-dlg \{[^}]*width: calc\(100vw - 16px\)/);
    expect(phone).toMatch(/\.den-acct-sel \{[^}]*min-height: var\(--tap\)/);
    expect(phone).toMatch(/\.den-acct-nav \{[^}]*display: none/);
    expect(phone).toMatch(/max-height: 45vh/);
  });
});
