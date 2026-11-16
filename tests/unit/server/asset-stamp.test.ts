/**
 * Issue 231: after Den updates, a tab left open or Safari's back-forward
 * cache must not keep an old stylesheet or script. The real server: every
 * page it serves (from its own route list), and every Den script those
 * pages reach through imports, names each same-origin .css/.js/.mjs with
 * `?v=<the running version>`. The UI kit's scripts too.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { spawnServer, stopServer } from "../../child-servers.js";
import { ROUTES } from "../../../src/ui/server/route-classes.js";
import { KIT_FILES } from "../../../src/ui/server/ui-assets.js";
import { stampAssetUrls } from "../../../src/ui/server/asset-stamp.js";

const PORT = 21876 + Math.floor(Math.random() * 1000);
const VERSION = (
  JSON.parse(fs.readFileSync("package.json", "utf-8")) as { version: string }
).version;
const STAMP = `?v=${encodeURIComponent(VERSION)}`;

let server: ReturnType<typeof spawnServer> | null = null;
let tmp = "";

interface Got {
  status: number;
  type: string;
  body: string;
}

function get(p: string, accept = "text/html"): Promise<Got> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      `http://localhost:${PORT}${p}`,
      { timeout: 10_000, headers: { Accept: accept } },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString()));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers["content-type"] ?? ""),
            body,
          }),
        );
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}

/** Every quoted same-origin asset URL in `text`, with what follows it. */
function assetRefs(text: string): { url: string; stamped: boolean }[] {
  const re =
    /(["'`])((?:\.{1,2})?\/(?!\/)[A-Za-z0-9_\-./]*\.(?:css|m?js))(\?[^"'`\s]*)?(?=\1|\$\{)/g;
  const out: { url: string; stamped: boolean }[] = [];
  for (const m of text.matchAll(re)) {
    const query = m[3] ?? "";
    // /theme.css?t=… is a fresh sheet on a theme switch: already its own URL.
    if (query && !query.startsWith("?v=")) continue;
    out.push({ url: m[2], stamped: query === STAMP });
  }
  return out;
}

/** The page paths in the server's route list. */
const PAGES = ROUTES.filter(
  (r) =>
    r.methods.includes("GET") &&
    !/[:*]/.test(r.path) &&
    !r.path.startsWith("/api/") &&
    !r.path.startsWith("/_den/") &&
    (r.path.endsWith(".html") || !/\.[a-z0-9]+$/i.test(r.path)),
)
  .map((r) => r.path)
  // Not Den's pages: the test runner's own report, the theme favicon.
  .filter((p) => !["/report", "/theme-favicon"].includes(p));

beforeAll(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-asset-stamp-"));
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

describe("stampAssetUrls", () => {
  it("stamps same-origin css and js, never external, data, or ones with a query", () => {
    const v = "1.2.3-dev.4";
    const src = [
      `<link rel="stylesheet" href="/kit/base.css">`,
      `<script type="module" src="/shell.js"></script>`,
      `import { a } from "./topbar.js";`,
      `import("/report-dialog.js")`,
      `s.src = '/vendor/elk.bundled.js';`,
      `<script src="https://cdn.example.test/x.js"></script>`,
      `<script src="//cdn.example.test/x.js"></script>`,
      `<link href="data:text/css,a.css">`,
      `l.href = \`/theme.css?t=\${Date.now()}\`;`,
      `<img src="/favicon.ico">`,
    ].join("\n");
    const out = stampAssetUrls(src, v);
    expect(out).toContain(`href="/kit/base.css?v=${v}"`);
    expect(out).toContain(`src="/shell.js?v=${v}"`);
    expect(out).toContain(`from "./topbar.js?v=${v}"`);
    expect(out).toContain(`import("/report-dialog.js?v=${v}")`);
    expect(out).toContain(`'/vendor/elk.bundled.js?v=${v}'`);
    expect(out).toContain(`"https://cdn.example.test/x.js"`);
    expect(out).toContain(`"//cdn.example.test/x.js"`);
    expect(out).toContain(`"data:text/css,a.css"`);
    expect(out).toContain("`/theme.css?t=${Date.now()}`");
    expect(out).toContain(`"/favicon.ico"`);
  });
});

describe("served pages and scripts carry the running version", () => {
  it("lists the pages from the server's routes", () => {
    expect(PAGES).toEqual(
      expect.arrayContaining(["/", "/agents", "/settings", "/logs"]),
    );
    expect(PAGES.length).toBeGreaterThan(10);
  });

  it("every page, and every Den script it reaches, names each css and js with ?v=<version>", async () => {
    const bad: string[] = [];
    const seen = new Set<string>();
    const queue: string[] = [];
    const scan = (where: string, text: string) => {
      for (const r of assetRefs(text)) {
        if (!r.stamped) bad.push(`${where}: ${r.url}`);
        const abs = r.url.startsWith("/")
          ? r.url
          : new URL(r.url, `http://x${where}`).pathname;
        // Den's own scripts: follow their imports. Vendored libraries are
        // third-party bytes, served as they are.
        if (/\.m?js$/.test(abs) && !abs.startsWith("/vendor/"))
          if (!seen.has(abs)) {
            seen.add(abs);
            queue.push(abs);
          }
      }
    };
    let pages = 0;
    // Each page, and an error page (a 404 a browser navigates to).
    for (const p of [...PAGES, "/no-such-page"]) {
      const r = await get(p);
      if (!r.type.startsWith("text/html")) continue;
      pages++;
      scan(p, r.body);
    }
    expect(pages).toBeGreaterThan(10);
    for (const f of KIT_FILES.filter((f) => /\.m?js$/.test(f)))
      if (!seen.has(`/kit/${f}`)) {
        seen.add(`/kit/${f}`);
        queue.push(`/kit/${f}`);
      }
    while (queue.length) {
      const js = queue.shift()!;
      const r = await get(`${js}${STAMP}`, "*/*");
      if (r.status !== 200) {
        bad.push(`${js}: ${r.status}`);
        continue;
      }
      scan(js, r.body);
    }
    expect(seen.size).toBeGreaterThan(30);
    expect(bad).toEqual([]);
  }, 120_000);
});
