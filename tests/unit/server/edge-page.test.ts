/**
 * The Edge page's view (public/edge-page.js, PL-SPEC §10): HTML from
 * /api/edge's JSON. The TLS strategy with where it came from (edge.tls, the
 * legacy keys, or implicit), CA trust, the included routers marked by
 * source file, and nothing to click but links.
 */
import { describe, expect, it } from "@jest/globals";
import {
  certHeading,
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
      '<a href="https://web.acme.vpn.example" target="_blank" rel="noopener noreferrer">https://web.acme.vpn.example</a>',
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

describe("the cert-names card under tls files (a consumer's nit, 0.3.0-dev.32)", () => {
  it("files: the names the included certs should cover; mkcert keeps its heading", () => {
    expect(certHeading("files", false)).toBe(
      "Names the included certs should cover",
    );
    expect(certHeading("files", true)).toBe(
      "Names the included certs should cover",
    );
    expect(certHeading("mkcert", false)).toBe("Certificate names (planned)");
    expect(certHeading("mkcert", true)).toBe("Certificate names");
    const files = edgeView({
      ...st,
      certIssued: false,
      tls: { strategy: "files", implicit: false, from: "explicit", ca: null },
    });
    expect(files).toContain(
      '<h2 class="sec" id="edge-h-cert">Names the included certs should cover</h2>',
    );
    expect(files).not.toContain("Certificate names");
    expect(edgeView({ ...st, certIssued: false })).toContain(
      '<h2 class="sec" id="edge-h-cert">Certificate names (planned)</h2>',
    );
  });
});

describe("the stacks' routes (a consumer's finding, 0.3.0-dev.32)", () => {
  it("lists the routers in stack-*.yml, source stack, marked with the file", () => {
    const html = edgeView({
      ...st,
      stacks: [
        {
          name: "stack-shop-web",
          file: "stack-shop-main.yml",
          rule: "Host(`web.shop.acme.localhost`)",
          service: "stack-shop-web",
          entryPoints: ["websecure"],
          hosts: ["web.shop.acme.localhost"],
          tls: true,
        },
      ],
      stackErrors: [{ file: "stack-bad.yml", error: "bad indent" }],
    });
    expect(html).toContain(
      '<a href="https://web.shop.acme.localhost" target="_blank" rel="noopener noreferrer">https://web.shop.acme.localhost</a>',
    );
    expect(html).toMatch(
      /<td><span class="src" title="written by stack up">stack<\/span> <span class="mono sub">stack-shop-main\.yml<\/span><\/td>/,
    );
    // After Den's own and the included routers.
    expect(html.indexOf("stack-shop-web")).toBeGreaterThan(
      html.indexOf("vpn-web"),
    );
    expect(html).toMatch(/stack-bad\.yml<\/span>: not read \(bad indent\)/);
  });
});

describe("stack routes: the scheme and the upstream (a consumer's dogfood finding, 0.3.0-dev.33)", () => {
  const row = (html: string, name: string) =>
    html
      .split("<tr>")
      .find((r) => r.includes(`<span class="mono">${name}</span>`)) ?? "";
  const html = edgeView({
    ...st,
    stacks: [
      // websecure, no tls block: https, like Den's own rows.
      {
        name: "stack-shop-web",
        file: "stack-shop-main.yml",
        rule: "Host(`web.shop.acme.localhost`)",
        service: "stack-shop-web",
        entryPoints: ["websecure"],
        hosts: ["web.shop.acme.localhost"],
        tls: false,
        secure: true,
        upstream: "http://shop-main-web-1:3000",
      },
      // web, no tls: http; no loadBalancer in its file: the name.
      {
        name: "stack-shop-admin",
        file: "stack-shop-main.yml",
        rule: "Host(`admin.shop.acme.localhost`)",
        service: "shop-admin-svc",
        entryPoints: ["web"],
        hosts: ["admin.shop.acme.localhost"],
        tls: false,
        secure: false,
        upstream: "shop-admin-svc",
      },
    ],
  });

  it("shows the URL with https:// when the router is secure, else http://", () => {
    expect(row(html, "stack-shop-web")).toContain(
      '<a href="https://web.shop.acme.localhost" target="_blank" rel="noopener noreferrer">https://web.shop.acme.localhost</a>',
    );
    expect(row(html, "stack-shop-admin")).toContain(
      '<a href="http://admin.shop.acme.localhost" target="_blank" rel="noopener noreferrer">http://admin.shop.acme.localhost</a>',
    );
    // As Den's own rows do.
    expect(row(html, "acme")).toContain(">https://acme.acme.localhost</a>");
  });

  it("shows the upstream URL when the file defines it, else the service name", () => {
    expect(row(html, "stack-shop-web")).toContain(
      '<span class="mono">http://shop-main-web-1:3000</span>',
    );
    expect(row(html, "stack-shop-web")).not.toContain(
      '<span class="mono">stack-shop-web</span></td><td><span class="src"',
    );
    expect(row(html, "stack-shop-admin")).toContain(
      '<span class="mono">shop-admin-svc</span>',
    );
  });
});

describe("CA trust when fronted (a consumer's finding, 0.3.0-dev.32)", () => {
  it("edge.publish false (no host ports): not needed, neutral, never not trusted", () => {
    const html = edgeView({ ...st, ports: null, caTrusted: false });
    expect(html).toMatch(
      /<div class="tile"><div class="k">CA trust<\/div><div class="v">not needed: fronted<\/div>/,
    );
    expect(html).not.toContain("not trusted");
    expect(html).not.toMatch(/tile bad"><div class="k">CA trust/);
  });

  it("published: an untrusted CA is still a bad tile", () => {
    expect(edgeView(st)).toMatch(
      /<div class="tile bad"><div class="k">CA trust<\/div><div class="v">not trusted<\/div>/,
    );
  });
});
