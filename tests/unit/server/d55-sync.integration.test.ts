/**
 * D55: a workspace sync finishes on the server whatever its page does, as
 * a restart does. On the real web server (helpers/agents-page-server.ts),
 * north's repo (notes) is a managed clone one commit behind its remote (a
 * bare repo in the test's temp dir), and its `down` takes a moment:
 *
 *   - the page's stream closes during the down: the pull still lands;
 *   - Stop (POST /api/exec/jobs/:id/stop) during the down: no pull.
 *
 * Invented names only; git runs on local paths, never a network remote.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";

let s: AgentsPageServer;
let tmp: string;
let work: string;
let clone: string;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    "/usr/bin/git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

/** One more commit on the remote: the clone is behind it by one. */
function advanceRemote(n: number): string {
  fs.writeFileSync(path.join(work, "notes.txt"), `change ${n}\n`);
  git(work, "commit", "-qam", `change ${n}`);
  git(work, "push", "-q", "origin", "main");
  return git(work, "rev-parse", "HEAD");
}

beforeAll(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-d55s-")));
  const origin = path.join(tmp, "origin.git");
  work = path.join(tmp, "work");
  git(tmp, "init", "-q", "--bare", origin);
  git(tmp, "clone", "-q", origin, work);
  fs.writeFileSync(
    path.join(work, ".acme.yml"),
    [
      "name: notes",
      "services:",
      "  notes:",
      "    commands:",
      "      local:",
      '        up: "true"',
      '        down: "sleep 2"',
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(work, "notes.txt"), "start\n");
  git(work, "add", "-A");
  git(work, "commit", "-qm", "start");
  git(work, "push", "-q", "origin", "main");
  // The managed clone, where the server looks for it.
  clone = path.join(tmp, "dist", ".acme-services", "notes", "main");
  fs.mkdirSync(path.dirname(clone), { recursive: true });
  git(tmp, "clone", "-q", "-b", "main", origin, clone);
  s = await startAgentsPageServer({ root: tmp, managed: ["notes"] });
}, 60_000);

afterAll(async () => {
  await s?.stop();
});

type Ev = Record<string, unknown>;

function stream(p: string, until: (ev: Ev) => boolean): Promise<Ev[]> {
  return new Promise((resolve, reject) => {
    const events: Ev[] = [];
    const req = http.get(
      {
        host: "localhost",
        port: s.port,
        path: p,
        agent: false,
        headers: { ...denAuth(s.stateDir), accept: "text/event-stream" },
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          buf += c;
          let i;
          while ((i = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame
              .split("\n")
              .filter((l) => l.startsWith("data: "))
              .map((l) => l.slice(6))
              .join("\n");
            if (!data) continue;
            const ev = JSON.parse(data) as Ev;
            events.push(ev);
            if (until(ev)) {
              req.destroy();
              resolve(events);
              return;
            }
          }
        });
        res.on("end", () => resolve(events));
        res.on("error", reject);
      },
    );
    req.on("error", (e) => (events.length ? resolve(events) : reject(e)));
    req.setTimeout(30_000, () => {
      req.destroy();
      reject(new Error(`timed out on ${p}: ${JSON.stringify(events)}`));
    });
  });
}

async function waitFor(ok: () => boolean, ms = 20_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

const sync = "/api/workspace/sync?repo=notes";
const inDown = (ev: Ev) =>
  ev.type === "line" && /down → pull → setup/.test(String(ev.text));
const head = () => git(clone, "rev-parse", "HEAD");

describe("D55: a workspace sync goes on when its page goes", () => {
  it("the stream closes during the down; the pull still lands", async () => {
    const want = advanceRemote(1);
    const seen = await stream(sync, inDown);
    if (!seen.some(inDown))
      throw new Error(`no down → pull: ${JSON.stringify(seen)}`);
    expect(head()).not.toBe(want);
    expect(await waitFor(() => head() === want)).toBe(true);
  }, 40_000);

  it("Stop during the down: no pull", async () => {
    const before = head();
    const want = advanceRemote(2);
    const seen = await stream(sync, inDown);
    const id = String(seen.find((e) => e.type === "job")?.id);
    const r = await fetch(`${s.base}/api/exec/jobs/${id}/stop`, {
      method: "POST",
      headers: {
        ...denAuth(s.stateDir),
        "content-type": "application/json",
      },
      body: "{}",
    });
    expect(r.status).toBe(200);
    // Longer than the down's sleep: nothing went on to the pull.
    await new Promise((res) => setTimeout(res, 3500));
    expect(head()).toBe(before);
    expect(head()).not.toBe(want);
  }, 40_000);
});
