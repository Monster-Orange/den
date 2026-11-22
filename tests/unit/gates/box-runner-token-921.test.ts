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
function github(fail: Partial<Record<"install" | "access" | "reg", number>> = {}) {
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
      "POST https://api.github.com/repos/acme/app/actions/runners/registration-token",
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
    expect(d.calls[2].auth).toBe(`Bearer ${INSTALL_TOKEN}`);
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
  ] as const)("a missing or wrong %s fails closed", async (part, vals) => {
    const d = deps(vals);
    const r = await mintBoxRunnerToken("acme/app", refs, d);
    expect(r).toMatchObject({ ok: false, part });
    expect(d.calls).toEqual([]);
    clean(r);
  });

  it.each([
    ["installation", { install: 404 }],
    ["installation-token", { access: 401 }],
    ["registration-token", { reg: 403 }],
  ] as const)("GitHub refusing the %s fails closed, with no token in the error", async (part, fail) => {
    const r = await mintBoxRunnerToken("acme/app", refs, deps(good, github(fail)));
    expect(r).toMatchObject({ ok: false, part });
    expect((r as { error: string }).error).toMatch(/GitHub answered \d{3}/);
    clean(r);
  });

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
    let read = 0;
    const r = await mintBoxRunnerToken("acme/app/../x", refs, {
      ...deps(good),
      provider: {
        tryGetWithReason: async () => {
          read++;
          return { value: null };
        },
      },
    });
    expect(r).toMatchObject({ ok: false, part: "repo" });
    expect(read).toBe(0);
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
    expect(boxRunnerAppRefs({ vault: "ci", item: "x", app_id_field: "a b" })).toBeNull();
  });
});
