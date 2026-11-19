/**
 * Issue 455, after 0.4.68 (a live check against the approved mock v3):
 *
 * - The Edge page's sub line said "· running" above a card that says Den's
 *   proxy isn't running. The sub line follows the same state as the card:
 *   /api/edge/address's answer, once it is known.
 * - When nothing answers at Den's address, the Edge page says so the way
 *   the command line does: "Not reachable yet: nothing answers at …".
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { edgeSub, mountEdge } from "../../../src/ui/server/public/edge-page.js";
import {
  addressCardView,
  cardShown,
} from "../../../src/ui/server/public/address-card.js";
import { installEnShell } from "./helpers/en-catalog.js";

installEnShell();

const EDGE = {
  configured: true,
  org: "acme",
  container: "acme-edge",
  state: "running",
  up: true,
  ports: { http: 80, https: 443 },
  network: "acme-edge",
  domains: ["acme.localhost"],
  routes: [],
  certNames: [],
  tls: { strategy: "none", implicit: false, from: "explicit", ca: null },
};

// eslint-disable-next-line no-restricted-syntax -- the browser's origin Den shows
const DIRECT = "http://localhost:7777";
const HELD = {
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
  routes: null,
  routeKind: "nginx",
  edge: { container: "acme-edge", state: "running", publish: true, ports: [] },
};
const NOTHING = {
  ...HELD,
  wantedAnswer: "nothing",
  owner: null,
  answeredAs: null,
};

describe("the Edge page's sub line follows the card's state", () => {
  it("held by another server: not running, as the card says", () => {
    expect(edgeSub(EDGE, HELD)).toBe(
      "acme / acme-edge · not running: port 80 is in use",
    );
    expect(edgeSub(EDGE, HELD)).not.toMatch(/running$/);
  });

  it("nothing answers: not reachable yet", () => {
    expect(edgeSub(EDGE, NOTHING)).toBe("acme / acme-edge · not reachable yet");
  });

  it("the address works (no card): the container's state, as before", () => {
    const works = { ...HELD, wantedAnswer: "den", address: HELD.wanted };
    expect(edgeSub(EDGE, works)).toBe("acme / acme-edge · running");
    expect(edgeSub(EDGE)).toBe("acme / acme-edge · running");
  });

  it("mountEdge waits for the address state before it writes the sub line", async () => {
    const root = {
      innerHTML: "",
      removeAttribute: () => {},
    };
    const sub = { textContent: "Reading the edge…" };
    const fetchFn = async () => ({ json: async () => EDGE });
    await mountEdge(root, sub, fetchFn, Promise.resolve(HELD));
    expect(sub.textContent).toBe(
      "acme / acme-edge · not running: port 80 is in use",
    );
  });

  it("edge.html gives mountEdge the card's state, and redraws the sub line on Check again", () => {
    const html = fs.readFileSync(
      path.join(process.cwd(), "src", "ui", "server", "public", "edge.html"),
      "utf-8",
    );
    const script = html.slice(html.indexOf('<script type="module">'));
    // One fetch of /api/edge/address feeds both: the card's state.
    expect(script).toMatch(/mountEdge\([\s\S]*?card[\s\S]*?\)/);
    expect(script).toMatch(/mountAddressCard\([\s\S]*?onState/);
  });
});

describe("nothing answers at Den's address: the page says it isn't reachable yet", () => {
  it("the card is shown", () => {
    expect(cardShown(NOTHING)).toBe(true);
  });

  it("its line says what the command line says", () => {
    const html = addressCardView(NOTHING);
    expect(html).toContain(
      'Not reachable yet: nothing answers at <code translate="no">http://den.acme.localhost</code>.',
    );
  });

  it("still no card when the address works, or nothing was proven", () => {
    expect(
      cardShown({ ...NOTHING, wantedAnswer: "den", address: NOTHING.wanted }),
    ).toBe(false);
    expect(cardShown({ ...NOTHING, address: null })).toBe(false);
  });
});
