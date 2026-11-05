/**
 * The Edge page's view (public/edge-page.js, PL-SPEC §10): HTML from
 * /api/edge's JSON. The TLS strategy with where it came from (edge.tls, the
 * legacy keys, or implicit), CA trust, the included routers marked by
 * source file, and nothing to click but links.
 */
import { describe, expect, it } from "@jest/globals";
import {
  edgeSub,
  edgeView,
  tlsNote,
} from "../../../src/ui/server/public/edge-page.js";

const st = {
  configured: true,
  org: "acme",
  container: "acme-edge",
  state: "running",
  up: true,
  ports: { http: 80, https: 443 },
  network: "acme-edge",
  domains: ["acme.localhost"],
  routes: [
    {
      name: "acme",
      url: "https://acme.acme.localhost",
      upstream: "http://x:1",
    },
  ],
  certNames: ["acme.localhost", "*.acme.localhost"],
  certIssued: true,
  caTrusted: false,
  tls: {
    strategy: "mkcert",
    implicit: true,
    from: "implicit",
    ca: "/s/ca",
  },
  included: [
    {
      name: "vpn-web",
      file: "vpn-routes.yml",
      rule: "Host(`web.acme.vpn.example`)",
      service: "vpn-web",
      entryPoints: ["websecure"],
      hosts: ["web.acme.vpn.example"],
      tls: true,
    },
    {
      name: "<b>odd</b>",
      file: "x.yml",
      rule: "PathPrefix(`/p`)",
      service: "s",
      entryPoints: [],
      hosts: [],
      tls: false,
    },
  ],
  includedErrors: [{ file: "broken.yml", error: "bad indent" }],
};

describe("tlsNote", () => {
  it("names where the strategy came from", () => {
    expect(
      tlsNote({ strategy: "mkcert", implicit: true, from: "implicit" }),
    ).toMatch(/^implicit: edge\.tls is not set/);
    expect(
      tlsNote({ strategy: "files", implicit: false, from: "legacy" }),
    ).toMatch(/legacy keys \(caroot \/ issue_cert\)/);
    expect(
      tlsNote({ strategy: "none", implicit: false, from: "explicit" }),
    ).toBe("set in edge.tls");
  });
});

describe("edgeView", () => {
  const html = edgeView(st);

  it("CA not trusted is a bad tile, with the CA's directory", () => {
    expect(html).toMatch(
      /<div class="tile bad"><div class="k">CA trust<\/div><div class="v">not trusted<\/div><div class="s"><span class="mono">\/s\/ca<\/span>/,
    );
  });

  it("lists the included routers with their source file, links for their hosts", () => {
    expect(html).toContain(
      '<a href="https://web.acme.vpn.example" target="_blank" rel="noopener noreferrer">web.acme.vpn.example</a>',
    );
    expect(html).toContain(
      '<span class="src" title="included dynamic file">vpn-routes.yml</span>',
    );
    // No hosts: the rule, as text. Names are escaped.
    expect(html).toContain("PathPrefix(`/p`)");
    expect(html).toContain("&lt;b&gt;odd&lt;/b&gt;");
    expect(html).toMatch(/broken\.yml<\/span>: not read \(bad indent\)/);
  });

  it("is read-only: no buttons, no forms", () => {
    expect(html).not.toMatch(/<button|<form|trust\(/i);
  });

  it("no edge: the reason, no tiles", () => {
    const none = edgeView({ configured: false, error: "no `edge:` block" });
    expect(none).toContain("No edge configured.");
    expect(none).not.toContain("tile");
    expect(edgeSub({ configured: false })).toBe("Not configured");
    expect(edgeSub(st)).toBe("acme / acme-edge · running");
  });
});
