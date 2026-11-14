/**
 * 0.4.45: the two Hub editions under the Connect button (Settings ›
 * Agents › Hub), gone once connected. Where they are is the
 * distribution's (den.yml hub_editions): Den's source names no host. "Talk
 * to us" goes to the distribution's page; never an email address.
 */
import { describe, expect, it } from "@jest/globals";
import { hubEditions } from "../../../src/shared/hub-editions.js";
import { hubHtml } from "../../../src/ui/server/public/settings-registry.js";

const editions = {
  teamsHost: "hub.example.test",
  enterpriseDomain: "example.test",
  talkUrl: "https://example.test/den#enterprise",
};

describe("Hub editions under Connect", () => {
  it("not connected: Teams and Enterprise, and Talk to us to the page", () => {
    const html = hubHtml({ configured: false, editions });
    expect(html).toContain(
      "<b>Den Hub for Teams:</b> a shared Hub at hub.example.test.</p>",
    );
    expect(html).toContain(
      "<b>Den Hub for Enterprise:</b> your own isolated runtime, at your own domain or a unique subdomain on example.test.</p>",
    );
    expect(html).toMatch(
      /<a href="https:\/\/example\.test\/den#enterprise"[^>]*>Talk to us ↗<\/a>/,
    );
    // Plain text: the Teams host is not a link.
    expect(html).not.toContain('href="https://hub.example.test');
    expect(html).not.toMatch(/mailto:/);
  });

  it("a distribution's own note follows its line; none by default", () => {
    const html = hubHtml({
      configured: false,
      editions: {
        ...editions,
        teamsNote: "Run by Acme. Closed beta, <by invite>.",
        enterpriseNote: "Coming.",
      },
    });
    expect(html).toContain(
      "a shared Hub at hub.example.test. Run by Acme. Closed beta, &lt;by invite&gt;.</p>",
    );
    expect(html).toContain("a unique subdomain on example.test. Coming.</p>");
    expect(
      hubEditions({
        teams_host: "hub.example.test",
        teams_note: "  Closed beta, by invite.  ",
        enterprise_domain: "example.test",
        enterprise_note: "",
      }),
    ).toEqual({
      teamsHost: "hub.example.test",
      teamsNote: "Closed beta, by invite.",
      enterpriseDomain: "example.test",
    });
    // Never an email address, a second line, or a note with no line.
    expect(
      hubEditions({
        teams_host: "hub.example.test",
        teams_note: "write to sales@example.test",
      }),
    ).toEqual({ teamsHost: "hub.example.test" });
    expect(
      hubEditions({ teams_host: "hub.example.test", teams_note: "a\nb" }),
    ).toEqual({ teamsHost: "hub.example.test" });
    expect(hubEditions({ teams_note: "Closed beta." })).toBeNull();
    expect(
      hubEditions({
        teams_host: "hub.example.test",
        teams_note: "x".repeat(201),
      }),
    ).toEqual({ teamsHost: "hub.example.test" });
  });

  it("no hub_editions: no lines; connected: none either", () => {
    expect(hubHtml({ configured: false })).not.toContain("Den Hub for");
    const html = hubHtml({
      configured: true,
      connected: true,
      state: "connected",
      url: "https://hub.example.test",
      editions,
    });
    expect(html).not.toContain("Den Hub for");
  });

  it("den.yml: good values only; a bad one drops its line", () => {
    expect(
      hubEditions({
        teams_host: "hub.example.test",
        enterprise_domain: "example.test",
        talk_url: "https://example.test/den#enterprise",
      }),
    ).toEqual(editions);
    expect(
      hubEditions({
        teams_host: "not a host",
        enterprise_domain: "example.test",
        talk_url: "javascript:alert(1)",
      }),
    ).toEqual({ enterpriseDomain: "example.test" });
    expect(hubEditions({ talk_url: "http://example.test/" })).toBeNull();
    for (const bad of [null, "x", [], 3]) expect(hubEditions(bad)).toBeNull();
    // Talk to us only beside a line.
    expect(
      hubHtml({ configured: false, editions: { talkUrl: editions.talkUrl } }),
    ).not.toContain("Talk to us");
  });
});
