/**
 * Issue 487: Den's server never holds the person's GitHub token. The CI
 * watcher asks GitHub through `gh api -i`, once per poll: gh reads its own
 * stored sign-in, so no token enters Den's process. ETags still make an
 * unchanged answer a free 304, which gh reports as exit 1 with the headers
 * on stdout. A fake gh on PATH in a temp dir; never the real one.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GithubBudget } from "../../../src/shared/github-budget/budget.js";
import { createGhCliHttp } from "../../../src/shared/github-budget/client.js";
import { CiWatcher } from "../../../src/shared/github-budget/ci-watcher.js";
import { FakeGitHub, fakeGh } from "./fake-gh.js";

const gh = new FakeGitHub();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-ghcli-"));
let fake: ReturnType<typeof fakeGh>;
beforeAll(async () => {
  await gh.start();
  fake = fakeGh(dir, gh.base);
});
afterAll(() => {
  gh.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

const client = () => createGhCliHttp({ env: fake.env, timeoutMs: () => 10_000 });

describe("the watcher asks through gh, and never holds a token", () => {
  it("each poll is one `gh api -i`, with no auth call and no Authorization header from Den", async () => {
    gh.runs.set("o/r#1", { status: "in_progress", conclusion: null });
    const c = client();
    const first = await c.get("/repos/o/r/actions/runs/1");
    expect(first.status).toBe(200);
    expect(first.etag).toMatch(/^W\//);
    expect((first.body as { status: string }).status).toBe("in_progress");
    expect(first.rate).toMatchObject({ limit: 5000, reset: gh.reset });
    const calls = fake.calls();
    expect(calls.length).toBe(1);
    expect(calls[0].slice(0, 2)).toEqual(["api", "-i"]);
    for (const argv of calls) {
      expect(argv[0]).not.toBe("auth");
      expect(argv.join(" ")).not.toMatch(/authorization|bearer|token/i);
    }
    expect(gh.requests.every((r) => r.auth === null)).toBe(true);
  });

  it("a 304 (gh exits 1) is unchanged and free", async () => {
    gh.runs.set("o/r#2", { status: "queued", conclusion: null });
    const c = client();
    const a = await c.get("/repos/o/r/actions/runs/2");
    const before = gh.spent;
    const b = await c.get("/repos/o/r/actions/runs/2", a.etag);
    expect(b.status).toBe(304);
    expect(b.body).toBeNull();
    expect(gh.spent).toBe(before);
    const last = fake.calls().at(-1)!;
    expect(last).toContain("-H");
    expect(last).toContain(`If-None-Match: ${a.etag}`);
  });

  it("401 and 403 come back as their status, and the watcher ends the wait with it", async () => {
    gh.runs.set("o/r#3", { status: "queued", conclusion: null });
    gh.fail.set("/repos/o/r/actions/runs/3", 401);
    gh.fail.set("/repos/o/r/actions/runs/4", 403);
    const c = client();
    expect((await c.get("/repos/o/r/actions/runs/3")).status).toBe(401);
    expect((await c.get("/repos/o/r/actions/runs/4")).status).toBe(403);
    const budget = new GithubBudget({ reserve: () => 1000 });
    const w = new CiWatcher({ http: c, budget, pollSeconds: () => 60 });
    const r = await w.wait({
      repo: "o/r",
      run: 3,
      timeoutSeconds: 30,
      actor: "agent:a1",
    });
    expect(r.error).toMatch(/401/);
  });

  it("rate_limit through gh, free", async () => {
    gh.remaining = 4100;
    const r = await client().rateLimit();
    expect(r).toEqual({ remaining: 4100, limit: 5000, reset: gh.reset });
    expect(gh.remaining).toBe(4100);
  });

  it("no gh at all is an error the watcher survives, never a token prompt", async () => {
    const c = createGhCliHttp({
      env: { PATH: path.join(dir, "nowhere") },
      timeoutMs: () => 2000,
    });
    await expect(c.get("/repos/o/r/actions/runs/1")).rejects.toThrow(/gh/);
  });

  it("the server's own service has no token reader left", () => {
    const src = [
      "src/ui/server/github-budget-service.ts",
      "src/shared/github-budget/client.ts",
      "src/shared/github-budget/ci-watcher.ts",
    ]
      .map((f) => fs.readFileSync(path.resolve(f), "utf-8"))
      .join("\n");
    expect(src).not.toMatch(/auth["', ]+token/);
    expect(src).not.toMatch(/authorization:/i);
  });
});
