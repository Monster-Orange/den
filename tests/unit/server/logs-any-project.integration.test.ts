/**
 * Issue 235: the log routes (/api/service/taillog, /api/logs/search, what
 * the MCP tools logs_tail and logs_search read) find a service in any
 * project, not only the focused one. Against the real server in a
 * throwaway distribution (helpers/error-frame-server.ts). Three projects:
 * alpha (focused), beta holding repo r, and repo dup in beta and gamma.
 * Nothing real runs: the manifests' log commands are printf then sleep
 * (the route shows a command's lines once it has lived 3 s), and docker is
 * a shim that knows one invented container.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as path from "path";
import { denAuth } from "./helpers/den-auth.js";
import {
  removeFrameTmp,
  startFrameServer,
  type FrameServer,
} from "./helpers/error-frame-server.js";

let s: FrameServer | null = null;

const DOCKER = `#!/bin/sh
case "$*" in
  *"name=r-box-1"*) echo r-box-1; exit 0 ;;
  "logs --timestamps r-box-1")
    echo "2026-11-16T00:00:00.000000000Z needle from the box"; exit 0 ;;
  ps*) exit 0 ;;
esac
echo "docker: not here (test shim)" >&2
exit 1
`;

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/** A manifest whose `svc` logs print `said`, then wait. */
function manifest(said: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    services: {
      svc: {
        logs: {
          local: { type: "shell", cmd: `printf '${said}\\n'; exec sleep 20` },
        },
        health: { local: { type: "shell", cmd: "true" } },
      },
      ...extra,
    },
  });
}

beforeAll(async () => {
  s = await startFrameServer({
    prefix: "den-logs235-",
    shims: { docker: DOCKER },
  });
  const repos = path.join(s.tmp, "repos");
  const repo = (name: string, body: string): string => {
    const dir = path.join(repos, name);
    write(path.join(dir, ".den.yml"), body);
    return dir;
  };
  const r = repo(
    "r",
    manifest("line from beta", {
      box: {
        logs: {
          local: { type: "shell", cmd: "docker ps -q --filter name=r-box-1" },
        },
      },
    }),
  );
  const dup = repo("dup", manifest("line from dup"));
  const bothA = repo("both-a", manifest("both from alpha"));
  const bothB = repo("both-b", manifest("both from beta"));
  const local = path.join(s.tmp, "dist", "config", "local");
  write(path.join(local, "service-catalog.yml"), "r: {}\ndup: {}\nboth: {}\n");
  const entry = (p: string) => ({ mode: "dev-managed", path: p });
  write(
    path.join(local, "workspaces.yml"),
    JSON.stringify({
      active: ["alpha", "beta", "gamma"],
      focus: "alpha",
      workspaces: {
        alpha: { services: { both: entry(bothA) } },
        beta: {
          services: { r: entry(r), dup: entry(dup), both: entry(bothB) },
        },
        gamma: { services: { dup: entry(dup) } },
      },
    }),
  );
  // r/svc's daemon log: what a search of a host-run service reads.
  write(
    path.join(s.tmp, "den-home", "logs", "r", "svc.log"),
    "boot\nneedle in svc\n",
  );
}, 40_000);

afterAll(async () => {
  await s?.stop();
  removeFrameTmp(s);
});

/**
 * Read a taillog stream until `want` shows, the fallback marker shows, or
 * a few seconds pass. The status, and every line seen.
 */
function tail(
  query: Record<string, string>,
  want: RegExp,
): Promise<{ status: number; lines: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const req = http.get(
      `${s!.base}/api/service/taillog?${new URLSearchParams(query)}`,
      {
        agent: false,
        // 0.4.71: a log route runs a command: the CLI's token.
        headers: denAuth(path.join(s!.tmp, "den-home")),
      },
      (res) => {
        let buf = "";
        let body = "";
        const done = () => {
          clearTimeout(timer);
          res.destroy();
          resolve({ status: res.statusCode ?? 0, lines, body });
        };
        const timer = setTimeout(done, 8_000);
        res.on("data", (d: Buffer) => {
          if (res.statusCode !== 200) {
            body += d.toString();
            return;
          }
          buf += d.toString();
          let i: number;
          while ((i = buf.indexOf("\n\n")) !== -1) {
            const chunk = buf.slice(0, i).replace(/^data: /, "");
            buf = buf.slice(i + 2);
            try {
              const e = JSON.parse(chunk) as { text?: string };
              if (typeof e.text === "string") lines.push(e.text);
            } catch {
              /* not an event */
            }
          }
          if (lines.some((l) => want.test(l) || /log unavailable/.test(l)))
            done();
        });
        res.on("end", done);
      },
    );
    req.on("error", reject);
  });
}

async function search(
  targets: string[],
  extra: Record<string, string> = {},
): Promise<
  {
    system: string;
    matches: { text?: string; line?: string }[];
    error?: string;
    skipped?: boolean;
  }[]
> {
  const r = await s!.req(
    "GET",
    `/api/logs/search?${new URLSearchParams({ q: "needle", targets: targets.join(","), ...extra })}`,
    { headers: denAuth(path.join(s!.tmp, "den-home")) },
  );
  expect(r.status).toBe(200);
  return (JSON.parse(r.body) as { results: never[] }).results;
}

describe("a service in another project (issue 235)", () => {
  it("taillog runs its manifest's log command, whichever project is focused", async () => {
    const t = await tail({ repo: "r", service: "svc" }, /line from beta/);
    expect(t.status).toBe(200);
    expect(t.lines).toContain("line from beta");
    expect(t.lines.join("\n")).not.toMatch(/container log unavailable/);
  }, 20_000);

  it("search finds its history: its container, and its daemon log", async () => {
    const results = await search(["r/svc", "r/box"]);
    for (const res of results) {
      expect(res.error ?? "").not.toMatch(/no running container or daemon/);
      expect(res.skipped).toBeUndefined();
      expect(JSON.stringify(res.matches)).toMatch(/needle/);
    }
    expect(results.map((x) => x.system)).toEqual(["r/svc", "r/box"]);
  }, 20_000);
});

describe("a repo in two projects, none named (issue 235)", () => {
  it("taillog answers an error naming both projects", async () => {
    const t = await tail({ repo: "dup", service: "svc" }, /line from dup/);
    expect(t.status).toBe(400);
    expect(t.body).toMatch(/more than one project \(beta, gamma\)/);
    expect(t.lines).toEqual([]);
  }, 20_000);

  it("search answers the same error for that target", async () => {
    const [res] = await search(["dup/svc"]);
    expect(res.error).toMatch(/more than one project \(beta, gamma\)/);
  }, 20_000);
});

describe("a named project (issue 235)", () => {
  it("wins over the focused one; without it the focused one answers", async () => {
    const named = await tail(
      { repo: "both", service: "svc", workspace: "beta" },
      /both from/,
    );
    expect(named.lines).toContain("both from beta");
    expect(named.lines).not.toContain("both from alpha");
    const focused = await tail({ repo: "both", service: "svc" }, /both from/);
    expect(focused.lines).toContain("both from alpha");
  }, 30_000);
});
