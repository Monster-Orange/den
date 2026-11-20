/**
 * Issue 644: the real server. Every page it serves (from its own route
 * list) carries the kit's one head snippet (packages/den-ui/src/site/
 * head.html), and every file the snippet and the manifest name answers
 * 200 with its type, from the kit's folder. The Hub callback page too.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { spawnServer, stopServer } from "../../child-servers.js";
import { SERVED_PAGES } from "./helpers/served-pages.js";
import { ROUTES } from "../../../src/ui/server/route-classes.js";
import { callbackPage } from "../../../src/ui/server/hub-connect.js";
import { sitePage } from "../../../src/ui/server/ui-assets.js";

const PORT = 23876 + Math.floor(Math.random() * 1000);
const SITE = path.join(process.cwd(), "packages", "den-ui", "src", "site");
const SNIPPET = fs.readFileSync(path.join(SITE, "head.html"), "utf-8").trim();

let server: ReturnType<typeof spawnServer> | null = null;
let tmp = "";

interface Got {
  status: number;
  type: string;
  body: Buffer;
}

function get(p: string, accept = "text/html"): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `http://localhost:${PORT}${p}`,
      { timeout: 10_000, headers: { Accept: accept } },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers["content-type"] ?? ""),
            body: Buffer.concat(parts),
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

const TYPES: Record<string, string> = {
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-site-head-"));
  const dist = path.join(tmp, "dist");
  fs.mkdirSync(path.join(dist, "config"), { recursive: true });
  fs.writeFileSync(path.join(dist, "den.yml"), "product:\n  name: den\n");
  fs.writeFileSync(
    path.join(dist, "config", "den.yml"),
    "environments: [local]\n",
  );
  server = spawnServer("npx", ["tsx", "src/ui/server/index.ts"], {
    env: {
      ...process.env,
      DEN_ROOT: dist,
      DEN_ENGINE_ROOT: process.cwd(),
      DEN_HOME: path.join(tmp, "home", ".den"),
      HOME: path.join(tmp, "home"),
      PORT: String(PORT),
      DEN_NO_OPEN: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const start = Date.now();
  while (Date.now() - start < 20_000) {
    try {
      await get("/api/environments", "application/json");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("server did not start within 20s");
}, 30_000);

afterAll(async () => {
  await stopServer(server ?? undefined);
  server = null;
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the kit's head snippet on every page (issue 644)", () => {
  it("every page Den serves has the snippet in its <head>", async () => {
    expect(SERVED_PAGES.length).toBeGreaterThan(10);
    const missing: string[] = [];
    let pages = 0;
    for (const p of SERVED_PAGES) {
      const r = await get(p);
      if (!r.type.startsWith("text/html")) continue;
      pages++;
      const html = r.body.toString("utf-8");
      const head = html.slice(0, html.indexOf("</head>"));
      if (!head.includes(SNIPPET)) missing.push(`${p} (${r.status})`);
    }
    expect(pages).toBeGreaterThan(10);
    expect(missing).toEqual([]);
  }, 120_000);

  it("a page made in code gets it too, once", () => {
    const html = sitePage(
      callbackPage("Den", { ok: true, message: "Connected." }),
    );
    expect(html.split(SNIPPET).length).toBe(2);
    expect(sitePage(html)).toBe(html);
  });

  it("each file the snippet and the manifest name answers 200 with its type", async () => {
    const urls = new Set<string>();
    for (const m of SNIPPET.matchAll(/href="([^"]+)"/g)) urls.add(m[1]!);
    const mf = await get("/site.webmanifest", "*/*");
    expect([mf.status, mf.type]).toEqual([200, TYPES[".webmanifest"]]);
    const manifest = JSON.parse(mf.body.toString("utf-8")) as {
      icons: { src: string }[];
      start_url: string;
    };
    for (const i of manifest.icons) urls.add(i.src);
    // Every file in the kit's folder but the snippet itself.
    for (const f of fs.readdirSync(SITE))
      if (f !== "head.html") urls.add(`/${f}`);
    expect(urls.size).toBeGreaterThanOrEqual(7);
    for (const u of urls) {
      const r = await get(u, "*/*");
      expect([u, r.status, r.type]).toEqual([u, 200, TYPES[path.extname(u)]]);
      // A file is the kit's own bytes (the manifest is filled in by Den).
      if (u !== "/site.webmanifest")
        expect([u, r.body.equals(fs.readFileSync(path.join(SITE, u)))]).toEqual(
          [u, true],
        );
      // The same class as Den's other static files: no new sign-in-free route.
      expect(ROUTES.some((x) => x.path === u && x.cls === "readonly")).toBe(
        true,
      );
    }
    // A phone's home screen opens the agents.
    expect(manifest.start_url).toBe("/agents");
    // The old manifest URL answers the same.
    const old = await get("/manifest.webmanifest", "*/*");
    expect(old.body.equals(mf.body)).toBe(true);
  });
});
