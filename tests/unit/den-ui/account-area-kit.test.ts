/**
 * den-ui issue 310 (rescoped 11-19): the Account area, the person's own
 * place, drawn by the kit in every product from data. Copied from the
 * approved mock "Account area: Den and Den Hub" v2 (in Hub, Den project),
 * itself an existing product's Account pop-up value for value. The checks that need no
 * browser: accountAreaHtml is pure and runs in Node.
 *
 *   - the rail: a search box, then the groups (Account, Sign-in and
 *     access, Devices, Notifications), one row per section, the open one
 *     marked; the foot link to the install's settings; a section with no
 *     data is left out; the phone's select lists the same sections
 *   - every pane is drawn (search finds rows in all of them); only the
 *     open one shows; ?account=<section> picks it
 *   - Profile: the name (or @login), "@login · role", how this browser is
 *     signed in (github | local | paired) in the kit's words, Sign out as a
 *     POST form with its csrf (none without signOut), Sign out everywhere
 *   - Access and security: GitHub with Unlink, Pair a device, personal
 *     tokens "Created … · Last used …" or "Never used" with Revoke
 *   - Devices and sessions: "This device", last seen, Sign out per row;
 *     No other devices; Can't list your devices with Try again; Waiting to
 *     be approved with Approve
 *   - Your notifications: one switch per choice
 *   - the words: en, es and ja; the host's data escaped; no inline style
 *     or handler (strict CSP); the look (240 px rail, 960 wide, phone under
 *     768 px with 44 px controls) is account-area.css
 *
 * The browser half (switching, search, keys, the address) is
 * account-area-kit.browser.test.ts.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as strings from "../../../packages/den-ui/src/strings.js";
import {
  ACCOUNT_SECTIONS,
  accountAreaHtml,
  accountAreaSections,
  accountSectionOf,
} from "../../../packages/den-ui/src/account-area.js";

type Table = Record<string, string>;
const { en, es, ja } = strings as unknown as Record<string, Table>;
const SRC = path.join(__dirname, "../../../packages/den-ui/src");

const NOW = "2026-11-20T18:00:00Z";
const FULL = {
  now: NOW,
  settingsHref: "/settings",
  profile: {
    name: "Ada Example",
    login: "ada",
    role: "Owner",
    how: "github",
    since: "2026-11-18T09:00:00Z",
    editHref: "https://github.com/settings/profile",
    signOut: { url: "/auth/logout", csrf: "c5rf" },
    signOutAll: true,
  },
  access: {
    github: { login: "ada", linkedAt: "2026-11-12T10:00:00Z", unlink: true },
    pair: true,
    tokens: [
      {
        id: "t1",
        name: "laptop cli",
        createdAt: "2026-11-14T10:00:00Z",
        lastUsedAt: "2026-11-20T16:00:00Z",
      },
      { id: "t2", name: "ci", createdAt: "2026-11-02T10:00:00Z" },
    ],
    newToken: true,
  },
  devices: {
    list: [
      {
        id: "d1",
        name: "Safari on Mac",
        where: "Local network",
        lastSeen: NOW,
        current: true,
      },
      { id: "d2", name: "Chrome on Linux", lastSeen: "2026-11-14T10:00:00Z" },
    ],
    waiting: [{ code: "K7QX-92MD", minutes: 10 }],
    pair: true,
    signOutAll: true,
  },
  notifications: [
    {
      id: "needs-me",
      label: "An agent needs me",
      help: "Allow or Deny",
      on: true,
    },
    { id: "releases", label: "New releases", on: false },
  ],
};

/** The text of the first element with `cls`, tags dropped. */
const textOf = (html: string, sel: RegExp) => {
  const m = html.match(sel);
  return m
    ? m[1]!
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim()
    : null;
};
/** One pane's markup. */
const pane = (html: string, s: string) => {
  const i = html.indexOf(`data-aa-pane="${s}"`);
  if (i < 0) return "";
  const j = html.indexOf("data-aa-pane=", i + 10);
  return html.slice(i, j < 0 ? undefined : j);
};

describe("issue 310: the Account area's rail", () => {
  it("the sections in order, under their groups; the open one marked", () => {
    const html = accountAreaHtml({ ...FULL, current: "devices" });
    expect(ACCOUNT_SECTIONS).toEqual([
      "profile",
      "access",
      "devices",
      "notifications",
    ]);
    const rows = [
      ...html.matchAll(/<a class="den-aa-row"[^>]*data-aa-section="(\w+)"/g),
    ].map((m) => m[1]);
    expect(rows).toEqual(ACCOUNT_SECTIONS);
    const groups = [
      ...html.matchAll(/<div class="den-aa-grp"[^>]*>([^<]+)</g),
    ].map((m) => m[1]);
    expect(groups).toEqual([
      "Account",
      "Sign-in and access",
      "Devices",
      "Notifications",
    ]);
    expect(html).toMatch(
      /data-aa-section="devices"[^>]*aria-current="page"|aria-current="page"[^>]*data-aa-section="devices"/,
    );
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('href="?account=access"');
  });
  it("a search box first, with / as its key, and the foot link to settings", () => {
    const html = accountAreaHtml(FULL);
    expect(html).toMatch(
      /<input type="search" class="den-aa-search"[^>]*aria-label="Search account"/,
    );
    expect(html).toContain('<kbd aria-hidden="true">/</kbd>');
    expect(html).toMatch(
      /<a class="den-aa-cross" href="\/settings">Install settings →<\/a>/,
    );
    expect(accountAreaHtml({ ...FULL, settingsHref: undefined })).not.toContain(
      "den-aa-cross",
    );
  });
  it("a section with no data is left out (rail, select and pane)", () => {
    const { notifications: _n, access: _a, ...some } = FULL;
    expect(accountAreaSections(some)).toEqual(["profile", "devices"]);
    const html = accountAreaHtml(some);
    expect(html).not.toContain('data-aa-section="notifications"');
    expect(html).not.toContain('data-aa-pane="access"');
    expect(html).not.toContain('<option value="access"');
  });
  it("the phone's select lists the same sections, the open one selected", () => {
    const html = accountAreaHtml({ ...FULL, current: "access" });
    const opts = [...html.matchAll(/<option value="(\w+)"( selected)?>/g)];
    expect(opts.map((m) => m[1])).toEqual(ACCOUNT_SECTIONS);
    expect(opts.filter((m) => m[2]).map((m) => m[1])).toEqual(["access"]);
    expect(html).toMatch(
      /<select class="den-aa-select"[^>]*aria-label="Section"/,
    );
  });
});

describe("issue 310: the panes and the address", () => {
  it("every pane is drawn; only the open one shows", () => {
    const html = accountAreaHtml({ ...FULL, current: "access" });
    const panes = [
      ...html.matchAll(/<section class="den-aa-pane"([^>]*)>/g),
    ].map((m) => [
      m[1]!.match(/data-aa-pane="(\w+)"/)![1],
      / hidden/.test(m[1]!),
    ]);
    expect(panes).toEqual([
      ["profile", true],
      ["access", false],
      ["devices", true],
      ["notifications", true],
    ]);
  });
  it("no current, or one not drawn: the first section", () => {
    expect(accountAreaHtml(FULL)).toMatch(
      /data-aa-section="profile"[^>]*aria-current="page"/,
    );
    const { notifications: _n, ...some } = FULL;
    expect(accountAreaHtml({ ...some, current: "notifications" })).toMatch(
      /data-aa-section="profile"[^>]*aria-current="page"/,
    );
  });
  it("?account=<section> names the section; anything else is null", () => {
    expect(accountSectionOf("?account=devices")).toBe("devices");
    expect(accountSectionOf("?x=1&account=access")).toBe("access");
    expect(accountSectionOf("?account=")).toBe("profile");
    expect(accountSectionOf("?account=nope")).toBe("profile");
    expect(accountSectionOf("?other=1")).toBeNull();
    expect(accountSectionOf("")).toBeNull();
  });
});

describe("issue 310: Profile", () => {
  it("name, then @login · role, then how this browser is signed in", () => {
    const p = pane(accountAreaHtml(FULL), "profile");
    expect(textOf(p, /<h2[^>]*>([\s\S]*?)<\/h2>/)).toBe("Profile");
    expect(textOf(p, /<b class="den-aa-who">([\s\S]*?)<\/b>/)).toBe(
      "Ada Example",
    );
    expect(textOf(p, /<small class="den-aa-login">([\s\S]*?)<\/small>/)).toBe(
      "@ada · Owner",
    );
    expect(textOf(p, /<b data-aa-how="github">([\s\S]*?)<\/b>/)).toBe(
      "Signed in with GitHub",
    );
    expect(p).toContain('href="https://github.com/settings/profile"');
  });
  it("no name (or the name is the login): @login is the heading", () => {
    for (const name of [undefined, "", "ADA", "@ada"]) {
      const p = pane(
        accountAreaHtml({ ...FULL, profile: { ...FULL.profile, name } }),
        "profile",
      );
      expect(textOf(p, /<b class="den-aa-who">([\s\S]*?)<\/b>/)).toBe("@ada");
    }
  });
  it("local and paired say so in the kit's words", () => {
    const of = (how: string) =>
      textOf(
        pane(
          accountAreaHtml({ ...FULL, profile: { ...FULL.profile, how } }),
          "profile",
        ),
        /<b data-aa-how="\w+">([\s\S]*?)<\/b>/,
      );
    expect(of("local")).toBe("Signed in on this computer");
    expect(of("paired")).toBe("Signed in with a paired device");
  });
  it("Sign out: a POST form with its csrf; none without signOut", () => {
    const p = pane(accountAreaHtml(FULL), "profile");
    expect(p).toMatch(
      /<form class="den-aa-out" method="post" action="\/auth\/logout"><input type="hidden" name="csrf" value="c5rf"><button type="submit" class="den-btn">Sign out<\/button><\/form>/,
    );
    expect(p).toMatch(
      /<button type="button" class="den-btn ghost" data-aa-act="sign-out-all">Sign out everywhere<\/button>/,
    );
    const local = pane(
      accountAreaHtml({
        ...FULL,
        profile: { ...FULL.profile, signOut: undefined, signOutAll: false },
      }),
      "profile",
    );
    expect(local).not.toContain("<form");
    expect(local).not.toContain("sign-out-all");
  });
});

describe("issue 310: Access and security", () => {
  it("GitHub with Unlink, Pair a device, tokens with Revoke, New token", () => {
    const p = pane(accountAreaHtml(FULL), "access");
    expect(textOf(p, /<h2[^>]*>([\s\S]*?)<\/h2>/)).toBe("Access and security");
    expect(p).toMatch(/data-aa-act="unlink"[^>]*>Unlink</);
    expect(p).toMatch(/data-aa-act="pair"[^>]*>Pair a device</);
    expect(p).toMatch(/data-aa-act="revoke-token" data-aa-id="t1"/);
    expect(p).toMatch(/data-aa-act="new-token"[^>]*>New token</);
    const t1 = p.slice(p.indexOf("laptop cli"));
    expect(textOf(t1, /<small>([\s\S]*?)<\/small>/)).toMatch(
      /^Created .+ · Last used .+ ago$/,
    );
    const t2 = p.slice(p.indexOf(">ci<"));
    expect(textOf(t2, /<small>([\s\S]*?)<\/small>/)).toMatch(
      /^Created .+ · Never used$/,
    );
    // Dates are <time> in the viewer's zone, never a UTC string.
    expect(t1).toContain('<time datetime="2026-11-14T10:00:00.000Z"');
  });
  it("no tokens: Personal access tokens says none yet", () => {
    const p = pane(
      accountAreaHtml({ ...FULL, access: { ...FULL.access, tokens: [] } }),
      "access",
    );
    expect(p).toContain("No personal access tokens yet.");
  });
});

describe("issue 310: Devices and sessions", () => {
  it("This device marked; last seen and Sign out on each row; Waiting with Approve", () => {
    const p = pane(accountAreaHtml(FULL), "devices");
    expect(textOf(p, /<h2[^>]*>([\s\S]*?)<\/h2>/)).toBe("Devices and sessions");
    const mac = p.slice(p.indexOf("Safari on Mac"));
    expect(mac.indexOf("This device")).toBeLessThan(mac.indexOf("Chrome"));
    expect(textOf(mac, /<small>([\s\S]*?)<\/small>/)).toMatch(
      /^Local network · Last seen /,
    );
    expect(p.match(/data-aa-act="sign-out-device"/g)).toHaveLength(2);
    expect(p).toMatch(/data-aa-act="approve" data-aa-id="K7QX-92MD"/);
    expect(p).toContain("Waiting to be approved");
    expect(p).toContain("It lasts 10 minutes.");
    expect(p).toMatch(/data-aa-act="pair"/);
    expect(p).toMatch(/data-aa-act="sign-out-all"/);
  });
  it("only this device: No other devices", () => {
    const p = pane(
      accountAreaHtml({
        ...FULL,
        devices: { list: [FULL.devices.list[0]] },
      }),
      "devices",
    );
    expect(p).toContain("No other devices");
    expect(p).not.toContain("Waiting to be approved");
  });
  it("the list can't be read: Can't list your devices, with Try again", () => {
    const p = pane(
      accountAreaHtml({ ...FULL, devices: { error: true } }),
      "devices",
    );
    expect(p).toContain("Can’t list your devices");
    expect(p).toMatch(/data-aa-act="retry-devices"[^>]*>Try again</);
  });
});

describe("issue 310: Your notifications", () => {
  it("one switch per choice, its state pressed", () => {
    const p = pane(accountAreaHtml(FULL), "notifications");
    expect(p).toMatch(
      /role="switch" aria-checked="true" data-aa-act="notify" data-aa-id="needs-me"/,
    );
    expect(p).toMatch(
      /role="switch" aria-checked="false" data-aa-act="notify" data-aa-id="releases"/,
    );
  });
});

describe("issue 310: words, escaping, CSP and the look", () => {
  it("every kit.aa.* word in en, es and ja", () => {
    const keys = (t: Table) =>
      Object.keys(t)
        .filter((k) => k.startsWith("kit.aa."))
        .sort();
    expect(keys(en).length).toBeGreaterThan(30);
    expect(keys(es)).toEqual(keys(en));
    expect(keys(ja)).toEqual(keys(en));
    const html = accountAreaHtml({ ...FULL, lang: "ja" });
    expect(html).toContain(ja["kit.aa.profile"]);
    expect(html).not.toContain(">Profile<");
  });
  it("the host's data is escaped", () => {
    const html = accountAreaHtml({
      ...FULL,
      profile: { ...FULL.profile, name: '<img src=x onerror="1">' },
      devices: { list: [{ id: '"x', name: "<b>", lastSeen: NOW }] },
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b><b>");
    expect(html).toContain("&lt;b&gt;");
    expect(html).toContain("&lt;img");
    expect(html).toContain('data-aa-id="&quot;x"');
  });
  it("no inline style or handler (a strict CSP page)", () => {
    const html = accountAreaHtml(FULL);
    expect(html).not.toMatch(/\sstyle=|\son[a-z]+=/);
  });
  it("account-area.css: 240 px rail, the source size, phone under 768 px, 44 px", () => {
    const css = fs.readFileSync(path.join(SRC, "account-area.css"), "utf-8");
    expect(css).toMatch(/grid-template-columns:\s*240px 1fr/);
    expect(css).toMatch(/width:\s*min\(960px,\s*100vw - var\(--space-6\)\)/);
    expect(css).toMatch(/height:\s*min\(88vh,\s*760px\)/);
    expect(css).toMatch(/@media \(max-width:\s*767px\)/);
    expect(css).toMatch(/min-height:\s*var\(--tap\)/);
    expect(css).toMatch(/box-shadow:\s*inset 3px 0 0 var\(--accent\)/);
  });
});
