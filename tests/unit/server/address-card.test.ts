/**
 * Issue 455: Edge's card against mock v3 (approved), clause by
 * clause, in English: the title, the status line naming the owner, "What
 * would you like to do?" with its two options in the approved order, the
 * three proxies, Copy, the after-reload line, Check again and its result,
 * and "Now". The banner's words (shell.js) are checked here too.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import {
  addressCardView,
  cardShown,
  checkResult,
} from "../../../src/ui/server/public/address-card.js";
import { proxyRoutes } from "../../../src/shared/edge/proxy-route.js";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");

/** shell.js's en catalog (it stops at its first DOM use, after the catalog). */
function enCatalog(): Record<string, string> {
  const window: Record<string, unknown> = {};
  const document = {
    getElementById: () => null,
    documentElement: { lang: "en" },
    addEventListener: () => {},
  };
  const ctx = vm.createContext({ window, document, Intl });
  try {
    vm.runInContext(
      fs.readFileSync(path.join(PUBLIC, "shell.js"), "utf-8"),
      ctx,
    );
  } catch {
    /* the DOM it needs isn't here */
  }
  return (window.denMessages as Record<string, Record<string, string>>).en;
}

const EN = enCatalog();
const t = (k: string, vars: Record<string, unknown> = {}) =>
  String(EN[k] ?? k)
    .replace(/__DEN_TITLE__/g, "Den")
    .replace(/\{(\w+)\}/g, (m, n: string) => (n in vars ? String(vars[n]) : m));

const g = globalThis as unknown as { window?: unknown };
// Set before the describe blocks draw (they draw at collection time).
const before: unknown = g.window;
g.window = { denShell: { t } };
afterAll(() => {
  g.window = before;
});

// eslint-disable-next-line no-restricted-syntax -- the browser's origin Den shows
const DIRECT = "http://localhost:7777";
const STATE = {
  ok: true,
  checkedAt: "2026-11-18T05:48:00.000Z",
  wanted: "http://den.acme.localhost",
  wantedAnswer: "other",
  direct: DIRECT,
  directOk: true,
  address: DIRECT,
  port: 80,
  owner: {
    owner: "nginx",
    kind: "container",
    name: "web-proxy-1",
    denEdge: false,
  },
  answeredAs: "nginx",
  // As the server builds them: to the port Den states (7777).
  routes: proxyRoutes({
    host: "den.acme.localhost",
    listen: 80,
    upstreamHost: "host.docker.internal",
    upstreamPort: 7777,
    name: "den",
  }),
  routeKind: "nginx",
  edge: {
    container: "acme-edge",
    state: "absent",
    publish: true,
    ports: [
      {
        port: 80,
        held: true,
        by: {
          owner: "nginx",
          kind: "container",
          name: "web-proxy-1",
          denEdge: false,
        },
      },
      { port: 443, held: false, by: null },
    ],
  },
};

/** The card's visible text, tags dropped, spaces collapsed. */
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

describe("Edge's card (mock v3)", () => {
  const html = addressCardView(STATE);
  const words = text(html);
  it("the title names the port", () => {
    expect(words).toContain("Den's proxy is not running: port 80 is in use");
  });
  it("the status line names the owner and where Den serves instead, with the check's time", () => {
    expect(words).toMatch(
      /Held by nginx , Docker container web-proxy-1 \(not Den\)\. Den is serving at http:\/\/localhost:7777 instead\. Checked \d\d:\d\d\./,
    );
    expect(html).toContain("<b>nginx</b>");
    expect(html).toContain("<b>web-proxy-1</b>");
  });
  it("What would you like to do? Add Den to that proxy, then Free port 80 (the approved order)", () => {
    expect(words).toContain("What would you like to do?");
    const a = html.indexOf('data-opt="proxy"');
    const b = html.indexOf('data-opt="free"');
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(words).toContain("Add Den to that proxy");
    expect(words).toContain("Free port 80");
  });
  it("the proxy option: its words, nginx / Caddy / Traefik, the route and Copy", () => {
    expect(words).toContain(
      "Your proxy stays in charge of port 80 and sends den.acme.localhost to Den. Den changes nothing in your other project; you paste this where your proxy's config lives.",
    );
    expect(
      [...html.matchAll(/data-kind="(\w+)"[^>]*>(\w+)</g)].map((m) => m[2]),
    ).toEqual(["nginx", "Caddy", "Traefik"]);
    expect(html).toContain(
      "server {\n  listen 80;\n  server_name den.acme.localhost;",
    );
    // The card's stated address and its snippet: one port.
    expect(html).toContain("proxy_pass http://host.docker.internal:7777;");
    expect(words).toContain("Copy");
    expect(words).toContain(
      "After you reload that proxy, Den checks http://den.acme.localhost reaches Den and switches its links to it. Den's own proxy stays off (edge.publish: false, set for you).",
    );
  });
  it("Check again, and what the last check found", () => {
    expect(words).toContain(
      "Check again Not there yet: still answers as nginx.",
    );
  });
  it("Free port 80: one paragraph, the owner and the one action, no command", () => {
    const free = text(addressCardView(STATE, { option: "free" }));
    expect(free).toContain(
      "Stop the container web-proxy-1 in Docker, or move it off port 80. Then press Check again; Den starts its own proxy.",
    );
  });
  it("an old Den edge: the button is Take over", () => {
    const old = { ...STATE, owner: { ...STATE.owner, denEdge: true } };
    const h = addressCardView(old, { option: "free" });
    expect(h).toContain('id="addr-take-over"');
    expect(text(h)).toContain("Take over");
  });
  it("Now: the container, the ports, Den's address and the wanted one", () => {
    expect(words).toContain("Now Container acme-edge not created");
    expect(words).toContain("Ports 80 held by nginx · 443 free");
    expect(words).toContain(
      "Den's address http://localhost:7777 checked: this Den",
    );
    expect(words).toContain(
      "Wanted address http://den.acme.localhost answers as nginx",
    );
  });
  it("44px targets, a snippet that scrolls inside itself", () => {
    const css = fs.readFileSync(path.join(PUBLIC, "edge.html"), "utf-8");
    expect(css).toMatch(/\.addr-copy,[\s\S]*?min-height: 44px/);
    expect(css).toMatch(/\.addr-snip pre \{[\s\S]*?overflow: auto/);
  });
  it("nothing to say when the address works, or nothing was proven", () => {
    expect(
      cardShown({ ...STATE, wantedAnswer: "den", address: STATE.wanted }),
    ).toBe(false);
    expect(cardShown({ ...STATE, address: null })).toBe(false);
    expect(addressCardView({ ...STATE, address: null })).toBe("");
  });
  it("Check again's result when it now reaches Den", () => {
    expect(checkResult({ ...STATE, wantedAnswer: "den" })).toBe(
      "Done. Den is now at http://den.acme.localhost.",
    );
  });
});

describe("the page banner's words (mock v3)", () => {
  it("title and why, as the mock words them", () => {
    expect(t("edgeAddr.banner.title", { address: DIRECT })).toBe(
      "Den is at http://localhost:7777 for now.",
    );
    expect(
      t("edgeAddr.banner.held", {
        port: 80,
        owner: "nginx",
        name: "web-proxy-1",
        host: "den.acme.localhost",
      }),
    ).toBe(
      "Port 80 is held by nginx (web-proxy-1), so den.acme.localhost goes to nginx instead.",
    );
    expect(t("edgeAddr.banner.fix")).toBe("Fix it in Edge");
    expect(t("edgeAddr.banner.dismiss")).toBe("Dismiss");
  });
});
