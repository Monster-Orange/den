/**
 * Issue 487 test helpers: a fake GitHub on 127.0.0.1, and a fake `gh`
 * executable (a node script, first on PATH in a temp dir) that answers
 * `gh api -i [-H …] <path>` from it the way the real gh does:
 *
 *   - stdout: the status line, the headers, a blank line, the body;
 *   - exit 0 on a 2xx, else exit 1 with "gh: HTTP <status>" on stderr
 *     (the real gh's answer to a 304, checked once by hand);
 *   - it logs every argv it gets, so a test sees each call Den made.
 *
 * `gh auth …` (a token) is logged and refused: Den must never ask for it.
 * Never the real gh, never the real GitHub API.
 */
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as path from "path";

const FAKE_GH = `#!/usr/bin/env node
const fs = require("fs");
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(argv) + "\\n");
if (argv[0] !== "api") {
  process.stderr.write("fake gh: only api\\n");
  process.exit(4);
}
const headers = { "x-via-fake-gh": "1" };
let include = false;
let p = null;
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === "-i" || a === "--include") include = true;
  else if (a === "-H" || a === "--header") {
    const h = argv[++i];
    const at = h.indexOf(":");
    headers[h.slice(0, at).trim().toLowerCase()] = h.slice(at + 1).trim();
  } else if (!a.startsWith("-")) p = a;
}
const url = process.env.FAKE_GH_BASE + "/" + String(p).replace(/^\\/+/, "");
fetch(url, { headers }).then(async (r) => {
  const body = r.status === 304 ? "" : await r.text();
  if (include) {
    let out = "HTTP/2.0 " + r.status + " X\\r\\n";
    r.headers.forEach((v, k) => (out += k + ": " + v + "\\r\\n"));
    process.stdout.write(out + "\\r\\n");
  }
  process.stdout.write(body);
  if (r.status >= 300) {
    process.stderr.write("gh: HTTP " + r.status + "\\n");
    process.exit(1);
  }
}, () => process.exit(2));
`;

/** Writes the fake gh into dir/bin; returns the env that puts it first. */
export function fakeGh(
  dir: string,
  base: string,
): { env: NodeJS.ProcessEnv; log: string; calls: () => string[][] } {
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const exe = path.join(bin, "gh");
  fs.writeFileSync(exe, FAKE_GH);
  fs.chmodSync(exe, 0o755);
  const log = path.join(dir, "gh-calls.jsonl");
  return {
    log,
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      FAKE_GH_BASE: base,
      FAKE_GH_LOG: log,
    },
    calls: () => {
      try {
        return fs
          .readFileSync(log, "utf-8")
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l) as string[]);
      } catch {
        return [];
      }
    },
  };
}

/** A fake GitHub: runs, PRs and check runs; ETags; a budget it spends. */
export class FakeGitHub {
  requests: {
    path: string;
    status: number;
    inm: string | null;
    auth: string | null;
  }[] = [];
  remaining = 5000;
  readonly limit = 5000;
  reset = Math.floor(Date.now() / 1000) + 1800;
  runs = new Map<string, { status: string; conclusion: string | null }>();
  prs = new Map<string, string>();
  checks = new Map<string, { status: string; conclusion: string | null }[]>();
  /** A path answered with this status instead (401, 403, …). */
  fail = new Map<string, number>();
  server = http.createServer((req, res) => this.handle(req, res));
  base = "";

  async start() {
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() {
    this.server.close();
  }
  /** Calls that cost (not rate_limit, not a 304). */
  get spent() {
    return this.requests.filter(
      (r) => r.path !== "/rate_limit" && r.status !== 304,
    ).length;
  }
  get polls() {
    return this.requests.filter((r) => r.path !== "/rate_limit").length;
  }

  private body(p: string): unknown | null {
    let m = /^\/repos\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)$/.exec(p);
    if (m) {
      const r = this.runs.get(`${m[1]}#${m[2]}`);
      return r
        ? { id: Number(m[2]), html_url: `https://x/${m[2]}`, ...r }
        : null;
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(p);
    if (m) {
      const sha = this.prs.get(`${m[1]}#${m[2]}`);
      return sha ? { number: Number(m[2]), head: { sha } } : null;
    }
    m = /^\/repos\/([^/]+\/[^/]+)\/commits\/([0-9a-f]+)\/check-runs$/.exec(p);
    if (m) {
      const c = this.checks.get(m[2]) ?? [];
      return {
        total_count: c.length,
        check_runs: c.map((x, i) => ({ name: `c${i}`, ...x })),
      };
    }
    return null;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const p = new URL(req.url ?? "/", this.base).pathname;
    const inm = (req.headers["if-none-match"] as string | undefined) ?? null;
    const auth = (req.headers.authorization as string | undefined) ?? null;
    const send = (status: number, body?: unknown, etag?: string) => {
      this.requests.push({ path: p, status, inm, auth });
      res.writeHead(status, {
        "content-type": "application/json",
        "x-ratelimit-limit": String(this.limit),
        "x-ratelimit-reset": String(this.reset),
        "x-ratelimit-remaining": String(this.remaining),
        ...(etag ? { etag } : {}),
      });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    // Only gh reaches here: it marks its requests; Den sends no credential.
    if (req.headers["x-via-fake-gh"] !== "1")
      return send(400, { message: "not through gh" });
    if (p === "/rate_limit")
      return send(200, {
        resources: {
          core: {
            limit: this.limit,
            remaining: this.remaining,
            reset: this.reset,
          },
        },
      });
    const failing = this.fail.get(p);
    if (failing) {
      this.remaining--;
      return send(failing, { message: `HTTP ${failing}` });
    }
    const body = this.body(p);
    if (body === null) {
      this.remaining--;
      return send(404, { message: "Not Found" });
    }
    const etag = `W/"${Buffer.from(JSON.stringify(body)).toString("base64url")}"`;
    // GitHub answers a weak ETag, and takes it back (with or without W/).
    if (inm && inm.replace(/^W\//, "") === etag.replace(/^W\//, ""))
      return send(304, undefined, etag.replace(/^W\//, ""));
    this.remaining--;
    send(200, body, etag);
  }
}
