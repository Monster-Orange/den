/**
 * MODE-5 (0.4.46): Settings › the install's address, Check and save
 * (web-url-routes.ts). The address must answer as this Den before it is
 * saved; one that doesn't answer, or answers as another server, is not
 * saved and the old one stays; a loopback name is refused; an agent is
 * refused. The probe answers 204 only for a token this server just made.
 *
 * A server in this process; "the edge" is a fake ping that sends the
 * address's request to it. Invented names only.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  handleWebUrlRoutes,
  isLoopbackName,
  type WebUrlRouteDeps,
} from "../../../src/ui/server/web-url-routes.js";
import type { WebUrl } from "../../../src/shared/web-url.js";

let saved: WebUrl | null = null;
let server: http.Server;
let base = "";
/** Where each address goes: this server ("us"), another, or nowhere. */
const names: Record<string, "us" | "other" | "none"> = {
  "https://acme.local.example.com": "us",
  "https://other.local.example.com": "other",
  "https://gone.local.example.com": "none",
};

const deps: WebUrlRouteDeps = {
  isAgent: (r) => r.headers["x-den-actor"] === "agent",
  read: () => saved,
  set: (url) => {
    saved = { url, confirmed: true };
    return url;
  },
  ping: async (url) => {
    const u = new URL(url);
    const where = names[u.origin];
    if (where === "none" || !where) return { error: "timeout" };
    if (where === "other") return { status: 404 };
    const r = await fetch(`${base}${u.pathname}${u.search}`);
    return { status: r.status };
  },
  checkMs: () => 2000,
  readBody: (req) =>
    new Promise((ok) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => ok(b));
    }),
  sendJson: (res, body, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  },
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://den.invalid").pathname;
    if (!handleWebUrlRoutes(req, res, pathname, deps)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const post = async (url: string, agent = false) => {
  const r = await fetch(`${base}/api/web-url`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(agent ? { "x-den-actor": "agent" } : {}),
    },
    body: JSON.stringify({ url }),
  });
  return {
    status: r.status,
    body: (await r.json()) as Record<string, unknown>,
  };
};

describe("MODE-5: Check and save the install's address", () => {
  it("an address that answers as this Den is saved", async () => {
    const r = await post("https://acme.local.example.com/");
    expect(r).toEqual({
      status: 200,
      body: {
        ok: true,
        url: "https://acme.local.example.com",
        confirmed: true,
      },
    });
    expect(saved?.url).toBe("https://acme.local.example.com");
    const g = await (await fetch(`${base}/api/web-url`)).json();
    expect(g).toMatchObject({
      ok: true,
      url: "https://acme.local.example.com",
    });
  });

  it("one that doesn't answer, or answers as another server, is not saved; the old one stays", async () => {
    const gone = await post("https://gone.local.example.com");
    expect(gone.status).toBe(422);
    expect(gone.body.error).toMatch(
      /nothing at https:\/\/gone\.local\.example\.com answered within 2 s\. Not saved\./,
    );
    const other = await post("https://other.local.example.com");
    expect(other.status).toBe(422);
    expect(other.body.error).toMatch(/answered, but not as this Den \(404\)/);
    expect(saved?.url).toBe("https://acme.local.example.com");
  });

  it("a loopback name is refused with its reason, before any check", async () => {
    for (const u of [
      "http://localhost:7001",
      "http://acme.localhost",
      "http://127.0.0.1:7001",
      "http://[::1]:7001",
    ]) {
      const r = await post(u);
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/names this machine only/);
    }
    expect(saved?.url).toBe("https://acme.local.example.com");
    expect(isLoopbackName("acme.local.example.com")).toBe(false);
  });

  it("an agent is refused", async () => {
    const r = await post("https://acme.local.example.com", true);
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/only a person/);
  });

  it("the probe: 404 and no-store for a token it didn't make", async () => {
    const r = await fetch(`${base}/api/web-url/probe?n=deadbeef`);
    expect(r.status).toBe(404);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(await r.text()).toBe("");
  });
});
