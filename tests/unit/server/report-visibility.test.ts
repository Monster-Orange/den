/**
 * Issue 415: GET /api/report says each destination's visibility on GitHub
 * (report-visibility.ts), read with the person's `gh`, so the Report form
 * says who can see a report.
 *
 * - private and internal repos say so; public says public;
 * - when the person's `gh` can't say (no sign-in, a failure, no answer),
 *   GitHub's tokenless answer is asked: a public repo is public there;
 * - still not known: "unknown", never "public" (the form then neither says
 *   public nor claims private). With no sign-in, `gh` is not asked;
 * - a real answer is kept for feedback.visibility_cache_hours: a second
 *   open within it makes no second call; after it, one more; kept on disk
 *   too. A failure is held feedback.visibility_retry_seconds (60; 0: asked
 *   again on every open), then asked again;
 * - a slow GitHub never holds the form past
 *   feedback.visibility_timeout_seconds: unknown now, the real answer on
 *   the next open, from the same one call.
 *
 * `gh` is a fake: never the real one, no network. Invented names only; a
 * temp state directory per test.
 */
import { beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import { Writable } from "stream";
import {
  handleReportRoutes,
  type GhResult,
  type ReportRouteDeps,
} from "../../../src/ui/server/report-routes.js";
import { feedbackSettings } from "../../../src/shared/report-store.js";
import { visibilityOf } from "../../../src/ui/server/report-visibility.js";

/** What GitHub says for each repo: its JSON, a failure, or a wait. */
let answers: Record<string, GhResult | (() => Promise<GhResult>)> = {};
let signedIn = true;
let user: Record<string, unknown> = {};
let state = "";
let clock = 1_000_000;
const lookups: string[] = [];
/** GitHub's answer without a sign-in (only a public repo shows there). */
let anon: Record<string, "public"> = {};
const anonLookups: string[] = [];

const ok = (o: unknown): GhResult => ({
  code: 0,
  stdout: JSON.stringify(o),
  stderr: "",
});

const gh = async (args: string[]): Promise<GhResult> => {
  if (args[0] === "auth")
    return { code: signedIn ? 0 : 1, stdout: "", stderr: "" };
  const m = /^repos\/([^/]+\/[^/]+)$/.exec(args[1] ?? "");
  if (args[0] === "api" && m) {
    lookups.push(m[1]!);
    const a = answers[m[1]!];
    if (typeof a === "function") return a();
    return a ?? { code: 1, stdout: "", stderr: "HTTP 404: Not Found" };
  }
  return { code: 1, stdout: "", stderr: "unknown" };
};

const deps = (): ReportRouteDeps => ({
  settings: () =>
    feedbackSettings(
      { bugs: { url: "https://github.com/acme-eng/engine/issues" } },
      { repo: "acme-eng/notes" },
      user,
    ),
  stateDir: () => state,
  gh,
  publicRepo: async (repo: string) => {
    anonLookups.push(repo);
    return anon[repo] ?? null;
  },
  names: () => ({ home: "/Users/pat", hosts: [], projects: [] }),
  diagnostics: async () => ({}),
  agentOf: () => null,
  personOf: () => "person",
  readBody: async () => "",
  sendJson: (res, body, status = 200) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  },
  now: () => clock,
});

/** GET /api/report through the real handler, no socket. */
async function info(): Promise<{
  repos: { repo: string; visibility?: string; audience?: string }[];
}> {
  const req = Object.assign(new http.IncomingMessage(null as never), {
    method: "GET",
    url: "/api/report",
    headers: {},
  });
  let body = "";
  const done = new Promise<void>((r) => {
    const sink = new Writable({
      write(c, _e, cb) {
        body += c;
        cb();
      },
    });
    const res = {
      writeHead: () => res,
      end: (b?: string) => {
        if (b) sink.write(b);
        r();
      },
    } as unknown as http.ServerResponse;
    expect(handleReportRoutes(req, res, "/api/report", deps())).toBe(true);
  });
  await done;
  return JSON.parse(body);
}

const visOf = (i: Awaited<ReturnType<typeof info>>) =>
  Object.fromEntries(i.repos.map((r) => [r.repo, r.visibility]));

beforeEach(() => {
  answers = {};
  signedIn = true;
  user = {};
  clock = 1_000_000;
  lookups.length = 0;
  anon = {};
  anonLookups.length = 0;
  state = fs.mkdtempSync(path.join(os.tmpdir(), "den-report-vis-"));
});

describe("GET /api/report: each destination's visibility (issue 415)", () => {
  it("private and internal say so; public says public; no audience", async () => {
    answers = {
      "acme-eng/engine": ok({ private: false, visibility: "public" }),
      "acme-eng/notes": ok({ private: true, visibility: "private" }),
    };
    const i = await info();
    expect(visOf(i)).toEqual({
      "acme-eng/engine": "public",
      "acme-eng/notes": "private",
    });
    expect(i.repos.every((r) => !("audience" in r))).toBe(true);
    answers["acme-eng/notes"] = ok({ private: true, visibility: "internal" });
    clock += 25 * 3_600_000;
    expect(visOf(await info())["acme-eng/notes"]).toBe("internal");
  });

  it("an unknown answer or a failure reads as unknown, never public", async () => {
    answers = {
      "acme-eng/engine": ok({ name: "engine" }),
      "acme-eng/notes": { code: 1, stdout: "", stderr: "HTTP 404" },
    };
    expect(visOf(await info())).toEqual({
      "acme-eng/engine": "unknown",
      "acme-eng/notes": "unknown",
    });
  });

  it("a failure, but GitHub shows the repo to anyone: public", async () => {
    answers = {
      "acme-eng/engine": { code: 1, stdout: "", stderr: "HTTP 502" },
      "acme-eng/notes": { code: 1, stdout: "", stderr: "HTTP 404" },
    };
    anon = { "acme-eng/engine": "public" };
    expect(visOf(await info())).toEqual({
      "acme-eng/engine": "public",
      "acme-eng/notes": "unknown",
    });
  });

  it("no GitHub sign-in: GitHub's tokenless answer, else unknown; gh is not asked", async () => {
    signedIn = false;
    answers = { "acme-eng/notes": ok({ private: true }) };
    anon = { "acme-eng/engine": "public" };
    expect(visOf(await info())).toEqual({
      "acme-eng/engine": "public",
      "acme-eng/notes": "unknown",
    });
    expect(lookups).toEqual([]);
    expect(anonLookups.sort()).toEqual(["acme-eng/engine", "acme-eng/notes"]);
  });

  it("a second open within the hours kept makes no second call; after them, one more", async () => {
    user = { visibility_cache_hours: 2 };
    answers = {
      "acme-eng/engine": ok({ visibility: "public" }),
      "acme-eng/notes": ok({ private: true }),
    };
    expect(visOf(await info())["acme-eng/notes"]).toBe("private");
    expect(lookups.sort()).toEqual(["acme-eng/engine", "acme-eng/notes"]);
    clock += 3_600_000;
    expect(visOf(await info())["acme-eng/notes"]).toBe("private");
    expect(lookups).toHaveLength(2);
    // Kept on disk too, for the next start.
    const kept = JSON.parse(
      fs.readFileSync(path.join(state, "report-visibility.json"), "utf-8"),
    );
    expect(kept["acme-eng/notes"].v).toBe("private");
    // After the hours kept: asked again.
    clock += 2 * 3_600_000;
    await info();
    expect(lookups).toHaveLength(4);
  });

  it("a failure is not kept for the hours: the next open asks again and shows the real answer", async () => {
    answers = {
      "acme-eng/engine": ok({ visibility: "public" }),
      "acme-eng/notes": { code: 1, stdout: "", stderr: "HTTP 502" },
    };
    expect(visOf(await info())["acme-eng/notes"]).toBe("unknown");
    // Within a minute: held, so repeated opens don't storm GitHub.
    clock += 30_000;
    await info();
    expect(lookups.filter((r) => r === "acme-eng/notes")).toHaveLength(1);
    // After it, well within the hours kept: asked again, now private.
    clock += 31_000;
    answers["acme-eng/notes"] = ok({ private: true, visibility: "private" });
    expect(visOf(await info())["acme-eng/notes"]).toBe("private");
    expect(lookups.filter((r) => r === "acme-eng/notes")).toHaveLength(2);
    // The real answer is kept for the hours; public stayed kept too.
    clock += 3_600_000;
    await info();
    expect(lookups).toHaveLength(3);
  });

  it("feedback.visibility_retry_seconds: 0 asks again on every open; 5 holds a failure 5 s", async () => {
    user = { visibility_retry_seconds: 0 };
    answers = {
      "acme-eng/engine": ok({ visibility: "public" }),
      "acme-eng/notes": { code: 1, stdout: "", stderr: "HTTP 502" },
    };
    await info();
    await info();
    expect(lookups.filter((r) => r === "acme-eng/notes")).toHaveLength(2);
    user = { visibility_retry_seconds: 5 };
    clock += 1000;
    await info();
    clock += 3000;
    await info();
    // 4 s after the last failure: still held.
    expect(lookups.filter((r) => r === "acme-eng/notes")).toHaveLength(2);
    clock += 3000;
    await info();
    // 7 s after it: asked again.
    expect(lookups.filter((r) => r === "acme-eng/notes")).toHaveLength(3);
    // The real answer is still kept for the hours.
    expect(lookups.filter((r) => r === "acme-eng/engine")).toHaveLength(1);
  });

  it("no sign-in, then a sign-in: the next open looks it up", async () => {
    signedIn = false;
    answers = { "acme-eng/notes": ok({ private: true }) };
    expect(visOf(await info())["acme-eng/notes"]).toBe("unknown");
    signedIn = true;
    expect(visOf(await info())["acme-eng/notes"]).toBe("private");
  });

  it("a slow GitHub: unknown within the wait, the answer on the next open, one call", async () => {
    user = { visibility_timeout_seconds: 0.5 };
    let release: (r: GhResult) => void = () => undefined;
    answers = {
      "acme-eng/engine": ok({ visibility: "public" }),
      "acme-eng/notes": () => new Promise<GhResult>((r) => (release = r)),
    };
    const t0 = Date.now();
    expect(visOf(await info())["acme-eng/notes"]).toBe("unknown");
    expect(Date.now() - t0).toBeLessThan(3000);
    // Still running: a second open waits again, with no second call.
    const second = info();
    release(ok({ private: true }));
    expect(visOf(await second)["acme-eng/notes"]).toBe("private");
    expect(lookups.filter((r) => r === "acme-eng/notes")).toHaveLength(1);
  });
});

describe("visibilityOf: GitHub's repo answer", () => {
  it("reads visibility, else private, else unknown", () => {
    expect(visibilityOf('{"visibility":"internal","private":true}')).toBe(
      "internal",
    );
    expect(visibilityOf('{"private":true}')).toBe("private");
    expect(visibilityOf('{"private":false}')).toBe("public");
    expect(visibilityOf('{"visibility":"secret"}')).toBeNull();
    expect(visibilityOf("not json")).toBeNull();
  });
});
