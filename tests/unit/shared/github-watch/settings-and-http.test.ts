/**
 * The shared GitHub watcher's Settings (user.yml github.*, a person's only)
 * and how Den reads GitHub's answer with its headers (`gh api -i`). No
 * network.
 */
import { describe, expect, it } from "@jest/globals";
import { githubWatchSettings } from "../../../../src/shared/github-watch/settings.js";
import { parseGhInclude } from "../../../../src/shared/github-watch/gh-http.js";
import {
  PERSON_ONLY_SETTINGS,
  patchCliRows,
} from "../../../../src/shared/settings-cli-rows.js";

describe("github.* Settings", () => {
  it("has sane defaults", () => {
    expect(githubWatchSettings({})).toEqual({
      intervalSeconds: 60,
      maxIntervalSeconds: 300,
      budgetFloor: 500,
      watchesMax: 50,
    });
  });

  it("reads user.yml github.*", () => {
    expect(
      githubWatchSettings({
        github: {
          watch_interval_seconds: 30,
          watch_max_interval_seconds: 600,
          api_budget_floor: 200,
          watches_max: 10,
        },
      }),
    ).toEqual({
      intervalSeconds: 30,
      maxIntervalSeconds: 600,
      budgetFloor: 200,
      watchesMax: 10,
    });
  });

  it("a value out of range falls back to its default; the cap is never under the start", () => {
    expect(
      githubWatchSettings({
        github: { watch_interval_seconds: -1, watches_max: "lots" },
      }),
    ).toMatchObject({ intervalSeconds: 60, watchesMax: 50 });
    expect(
      githubWatchSettings({
        github: { watch_interval_seconds: 600, watch_max_interval_seconds: 60 },
      }),
    ).toMatchObject({ intervalSeconds: 600, maxIntervalSeconds: 600 });
  });

  it("is a person's only, and Settings writes user.yml github.*", () => {
    expect(PERSON_ONLY_SETTINGS).toContain("github");
    const user: Record<string, unknown> = {};
    expect(
      patchCliRows(user, {
        github: { watch_interval_seconds: 90, api_budget_floor: 1000 },
      }),
    ).toEqual({ ok: true });
    expect(user.github).toEqual({
      watch_interval_seconds: 90,
      api_budget_floor: 1000,
    });
    expect(
      patchCliRows(user, { github: { watch_interval_seconds: null } }),
    ).toEqual({ ok: true });
    expect(user.github).toEqual({ api_budget_floor: 1000 });
    const bad = patchCliRows(user, { github: { watches_max: 0 } });
    expect(bad.ok).toBe(false);
    expect(patchCliRows(user, { github: { nope: 1 } }).ok).toBe(false);
  });
});

describe("gh api -i", () => {
  it("reads the status, the headers (lower case) and the JSON body", () => {
    const out = [
      "HTTP/2.0 200 OK",
      "Content-Type: application/json; charset=utf-8",
      "X-Ratelimit-Remaining: 4321",
      "X-Ratelimit-Reset: 1900000000",
      "",
      '{"total_count":0,"check_runs":[]}',
    ].join("\r\n");
    const r = parseGhInclude(out, 0);
    expect(r.status).toBe(200);
    expect(r.headers["x-ratelimit-remaining"]).toBe("4321");
    expect(r.headers["x-ratelimit-reset"]).toBe("1900000000");
    expect(r.body).toEqual({ total_count: 0, check_runs: [] });
  });

  it("reads an error answer: gh exits 1 but prints the headers", () => {
    const out =
      'HTTP/2.0 403 Forbidden\nRetry-After: 60\n\n{"message":"secondary rate limit"}';
    const r = parseGhInclude(out, 1, "gh: secondary rate limit (HTTP 403)");
    expect(r.status).toBe(403);
    expect(r.headers["retry-after"]).toBe("60");
  });

  it("no answer at all (gh missing, not signed in): status 0 with why", () => {
    const r = parseGhInclude("", 1, "gh: To get started with GitHub CLI");
    expect(r.status).toBe(0);
    expect(r.error).toContain("gh");
  });
});
