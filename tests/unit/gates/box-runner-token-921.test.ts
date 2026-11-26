/**
 * Issue 921, clause 4: a box runner's registration token is minted from the
 * project's GitHub App, in memory only. The App's id and private key come
 * from Den's secrets layer (a SecretRef the project's setting names); the
 * installation is found from the repo. A missing, unreadable or wrong part
 * fails closed and says which part, never a value.
 */
import { describe, expect, it } from "@jest/globals";
import { generateKeyPairSync } from "crypto";
import {
  boxRunnerAppRefs,
  mintBoxRunnerToken,
  type BoxRunnerTokenDeps,
} from "../../../src/shared/gates/box-runner-token.js";
import type { SecretRef } from "../../../src/shared/secrets/types.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const NOW = Date.parse("2026-11-22T20:00:00Z");
const INSTALL_TOKEN = "ghs_installSECRETvalue000000000000000000";
const REG_TOKEN = "AREGSECRETvalue0000000000000000";
const SECRETS = [PEM, INSTALL_TOKEN, REG_TOKEN];

const refs = boxRunnerAppRefs({ vault: "ci", item: "Runner App" })!;

type Call = { method: string; url: string; auth: string };

/** A fake secrets provider over `vals` (field → value). */
function provider(vals: Record<string, string | undefined>) {
  return {
    tryGetWithReason: async (ref: SecretRef) =>
      vals[ref.field] === undefined
        ? { value: null, reason: "not found" }
        : { value: vals[ref.field]! },
  };
}

/** A fake GitHub API; `fail` names a step to answer with a status. */
function github(
  fail: Partial<
    Record<"install" | "access" | "repo" | "reg" | "revoke", number>
  > = {},
  repo: { private?: unknown } = { private: true },
) {
  const calls: Call[] = [];
  const res = (status: number, body: unknown) =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response;
  const fetch = (async (url: string, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method: init?.method ?? "GET", url, auth: h.Authorization });
    if (url.endsWith("/repos/acme/app/installation"))
      return fail.install
        ? res(fail.install, { message: "Not Found" })
        : res(200, { id: 77 });
    if (url.endsWith("/app/installations/77/access_tokens"))
      return fail.access
        ? res(fail.access, { message: "Bad credentials" })
        : res(201, { token: INSTALL_TOKEN });
    if (url.endsWith("/repos/acme/app"))
      return fail.repo
        ? res(fail.repo, { message: "Not Found" })
        : res(200, repo);
    if (url.endsWith("/installation/token"))
      return fail.revoke
        ? res(fail.revoke, { message: "no" })
        : ({
            ok: true,
            status: 204,
            json: async () => {
              throw new Error("no body");
            },
          } as unknown as Response);
    if (url.endsWith("/repos/acme/app/actions/runners/registration-token"))
      return fail.reg
        ? res(fail.reg, { message: `no: ${INSTALL_TOKEN}` })
        : res(201, { token: REG_TOKEN, expires_at: "2026-11-22T21:00:00Z" });
    return res(404, {});
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const deps = (
  vals: Record<string, string | undefined>,
  gh = github(),
): BoxRunnerTokenDeps & { calls: Call[] } => ({
  provider: provider(vals),
  fetch: gh.fetch,
  now: () => NOW,
  calls: gh.calls,
});

const good = { app_id: "12345", private_key: PEM };

/** No secret in anything a failure or a caller could print. */
const clean = (v: unknown) => {
  const s = JSON.stringify(v);
  for (const x of SECRETS) expect(s).not.toContain(x);
  expect(s).not.toContain("BEGIN RSA");
};

describe("issue 921: the box runner's token, from the project's GitHub App", () => {
  it("mints the installation token, then the registration token", async () => {
    const d = deps(good);
    const r = await mintBoxRunnerToken("acme/app", refs, d);
    expect(r).toEqual({
      ok: true,
      token: { value: REG_TOKEN, expiresAt: "2026-11-22T21:00:00Z" },
    });
    expect(d.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/app/installation",
      "POST https://api.github.com/app/installations/77/access_tokens",
      "GET https://api.github.com/repos/acme/app",
      "POST https://api.github.com/repos/acme/app/actions/runners/registration-token",
      "DELETE https://api.github.com/installation/token",
    ]);
    // The App's JWT for the first two; the installation token for the last.
    const jwt = d.calls[0].auth.replace(/^Bearer /, "");
    const [, payload] = jwt.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toEqual({
      iss: "12345",
      iat: NOW / 1000 - 60,
      exp: NOW / 1000 + 9 * 60,
    });
    expect(d.calls[1].auth).toBe(`Bearer ${jwt}`);
    for (const c of d.calls.slice(2))
      expect(c.auth).toBe(`Bearer ${INSTALL_TOKEN}`);
  });

  it("the installation token is scoped to the repo and runner admin only", async () => {
    const gh = github();
    let body: unknown;
    const spy = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/access_tokens")) body = JSON.parse(String(init?.body));
      return gh.fetch(url, init);
    }) as typeof globalThis.fetch;
    await mintBoxRunnerToken("acme/app", refs, {
      ...deps(good),
      fetch: spy,
    });
    expect(body).toEqual({
      repositories: ["app"],
      permissions: { administration: "write" },
    });
  });

  it.each([
    ["app-id", { private_key: PEM }],
    ["private-key", { app_id: "12345" }],
    ["app-id", { app_id: "not a number", private_key: PEM }],
    ["private-key", { app_id: "12345", private_key: "not a key" }],
  ] as [string, Record<string, string>][])(
    "a missing or wrong %s fails closed",
    async (part, vals) => {
      const d = deps(vals);
      const r = await mintBoxRunnerToken("acme/app", refs, d);
      expect(r).toMatchObject({ ok: false, part });
      expect(d.calls).toEqual([]);
      clean(r);
    },
  );

  it.each([
    ["installation", { install: 404 }],
    ["installation-token", { access: 401 }],
    ["registration-token", { reg: 403 }],
  ] as [string, Parameters<typeof github>[0]][])(
    "GitHub refusing the %s fails closed, with no token in the error",
    async (part, fail) => {
      const r = await mintBoxRunnerToken(
        "acme/app",
        refs,
        deps(good, github(fail)),
      );
      expect(r).toMatchObject({ ok: false, part });
      expect((r as { error: string }).error).toMatch(/GitHub answered \d{3}/);
      clean(r);
    },
  );

  it("a network error fails closed without its message's secrets", async () => {
    const fetch = (async () => {
      throw new Error(`socket closed ${INSTALL_TOKEN}`);
    }) as typeof globalThis.fetch;
    const r = await mintBoxRunnerToken("acme/app", refs, {
      ...deps(good),
      fetch,
    });
    expect(r).toMatchObject({ ok: false, part: "installation" });
    clean(r);
  });

  it("a repo that isn't owner/name is refused before anything is read", async () => {
    // "." and "..": the URL parser would fold them into another endpoint.
    for (const repo of [
      "acme/app/../x",
      "acme/..",
      "acme/.",
      ".../app",
      "acme/",
    ]) {
      let read = 0;
      const d = {
        ...deps(good),
        provider: {
          tryGetWithReason: async () => {
            read++;
            return { value: null };
          },
        },
      };
      const r = await mintBoxRunnerToken(repo, refs, d);
      expect(r).toMatchObject({ ok: false, part: "repo" });
      expect(read).toBe(0);
      expect(d.calls).toEqual([]);
    }
    // A name with dots that isn't only dots is a real repo name.
    expect(
      await mintBoxRunnerToken("acme/app.js", refs, deps(good)),
    ).toMatchObject({ ok: false, part: "installation" });
  });

  it("the setting names the item; the fields default to app_id and private_key", () => {
    expect(boxRunnerAppRefs({ vault: "ci", item: "Runner App" })).toEqual({
      appId: { vault: "ci", item: "Runner App", field: "app_id" },
      privateKey: { vault: "ci", item: "Runner App", field: "private_key" },
    });
    expect(
      boxRunnerAppRefs({
        vault: "ci",
        item: "Runner App",
        app_id_field: "APP_ID",
        private_key_field: "APP_KEY",
      }),
    ).toEqual({
      appId: { vault: "ci", item: "Runner App", field: "APP_ID" },
      privateKey: { vault: "ci", item: "Runner App", field: "APP_KEY" },
    });
    expect(boxRunnerAppRefs({ vault: "ci" })).toBeNull();
    expect(boxRunnerAppRefs("ci/Runner App")).toBeNull();
    expect(
      boxRunnerAppRefs({ vault: "ci", item: "x", app_id_field: "a b" }),
    ).toBeNull();
  });
});

/** The calls after the installation token, as "METHOD path". */
const after = (calls: Call[]) =>
  calls.slice(2).map((c) => `${c.method} ${new URL(c.url).pathname}`);

describe("issue 921 review: public repos, revoking, the API root", () => {
  it("refuses a repo GitHub says is public, before any registration token", async () => {
    for (const repo of [{ private: false }, {}, { private: "yes" }]) {
      const d = deps(good, github({}, repo));
      const r = await mintBoxRunnerToken("acme/app", refs, d);
      expect(r).toMatchObject({ ok: false, part: "public-repo" });
      if (!r.ok) expect(r.error).toMatch(/public.*a person/i);
      expect(after(d.calls)).toEqual([
        "GET /repos/acme/app",
        "DELETE /installation/token",
      ]);
      clean(r);
    }
  });

  it("a public repo goes ahead only when the person's setting allows it", async () => {
    const d = {
      ...deps(good, github({}, { private: false })),
      allowPublicRepo: true,
    };
    const r = await mintBoxRunnerToken("acme/app", refs, d);
    expect(r).toMatchObject({ ok: true, token: { value: REG_TOKEN } });
  });

  it("fails closed when the repo can't be read, and still revokes", async () => {
    const d = deps(good, github({ repo: 404 }));
    const r = await mintBoxRunnerToken("acme/app", refs, d);
    expect(r).toMatchObject({ ok: false, part: "public-repo" });
    expect(after(d.calls)).toEqual([
      "GET /repos/acme/app",
      "DELETE /installation/token",
    ]);
    clean(r);
  });

  it("revokes the installation token when the registration token fails too", async () => {
    const d = deps(good, github({ reg: 500 }));
    const r = await mintBoxRunnerToken("acme/app", refs, d);
    expect(r).toMatchObject({ ok: false, part: "registration-token" });
    expect(after(d.calls).pop()).toBe("DELETE /installation/token");
    clean(r);
  });

  it("a revoke GitHub refuses, or can't be reached, doesn't fail the mint", async () => {
    const r = await mintBoxRunnerToken(
      "acme/app",
      refs,
      deps(good, github({ revoke: 500 })),
    );
    expect(r).toMatchObject({ ok: true, token: { value: REG_TOKEN } });
    const gh = github();
    const flaky = (async (url: string, init?: RequestInit) => {
      if (url.endsWith("/installation/token")) throw new Error(INSTALL_TOKEN);
      return gh.fetch(url, init);
    }) as typeof globalThis.fetch;
    const r2 = await mintBoxRunnerToken("acme/app", refs, {
      ...deps(good, gh),
      fetch: flaky,
    });
    expect(r2).toMatchObject({ ok: true });
    // The revoke's own error (it carried the installation token) is dropped.
    expect(JSON.stringify(r2)).not.toContain(INSTALL_TOKEN);
  });

  it("the API root is an https origin, checked before any secret is read", async () => {
    for (const api of [
      "http://api.github.example",
      "https://user:pw@ghe.example",
      "https://ghe.example/api?x=1",
      "not a url",
    ]) {
      let read = 0;
      const r = await mintBoxRunnerToken("acme/app", refs, {
        ...deps(good),
        provider: {
          tryGetWithReason: async () => {
            read++;
            return { value: null, reason: "not found" };
          },
        },
        api,
      });
      expect(r).toMatchObject({ ok: false, part: "api" });
      expect(read).toBe(0);
    }
    const d = { ...deps(good), api: "https://ghe.example/api/v3/" };
    const gh = github();
    const seen: string[] = [];
    d.fetch = (async (url: string, init?: RequestInit) => {
      seen.push(url);
      return gh.fetch(url, init);
    }) as typeof globalThis.fetch;
    expect(await mintBoxRunnerToken("acme/app", refs, d)).toMatchObject({
      ok: true,
    });
    expect(seen[0]).toBe(
      "https://ghe.example/api/v3/repos/acme/app/installation",
    );
  });
});
