/**
 * Issue 163 (dev.2 gate): the sign-in token's status follows what is
 * STORED, not the config ref. On a real web server (the demo
 * distribution, helpers/agents-page-server.ts):
 *
 * - Doppler (its CLI a fake on the server's PATH that keeps values in a
 *   temp dir): a ref with nothing behind it is "no token"; after Save it
 *   is set; after Remove, no token again.
 * - env: Den's record of the set (the state dir's meta file) is the one
 *   truth for the page and a new CLI process alike, marked process-local.
 *
 * Invented values; the token is never in an answer.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from "@jest/globals";
import { denAuth } from "./helpers/den-auth.js";
import {
  startAgentsPageServer,
  type AgentsPageServer,
} from "./helpers/agents-page-server.js";
import { stopServer } from "../../child-servers.js";

jest.setTimeout(90_000);

const TOKEN = "fake-oat-token-stored-0123456789abcdef";
const REFS = (key: string) =>
  `  refs:\n    agent_signin_token:\n      key: ${key}\n`;

let dop: AgentsPageServer | null = null;
let env: AgentsPageServer | null = null;

beforeAll(async () => {
  dop = await startAgentsPageServer({
    userYml: `secrets:\n  provider: doppler\n${REFS("ACME_AGENT_SIGNIN_TOKEN")}`,
    scripts: {
      doppler: [
        'if [ "$1" = "--version" ]; then echo "v3.0.0"; exit 0; fi',
        'mkdir -p "$TMP/kept"',
        'if [ "$1" = secrets ] && [ "$2" = set ]; then cat > "$TMP/kept/$3"; exit 0; fi',
        'if [ "$1" = secrets ] && [ "$2" = get ]; then [ -s "$TMP/kept/$3" ] && cat "$TMP/kept/$3" && exit 0; echo "Could not find requested secret" >&2; exit 1; fi',
        'if [ "$1" = secrets ] && [ "$2" = delete ]; then rm -f "$TMP/kept/$3"; exit 0; fi',
        "exit 1",
      ].join("\n"),
    },
  });
  env = await startAgentsPageServer({
    userYml: `secrets:\n  provider: env\n${REFS("ACME_AGENT_SIGNIN_TOKEN")}`,
  });
}, 120_000);

afterAll(async () => {
  await dop?.stop();
  await env?.stop();
  void stopServer;
});

const signin = async (s: AgentsPageServer) =>
  (await s.settingsGet()).agent_signin as Record<string, unknown>;

async function call(s: AgentsPageServer, method: "POST" | "DELETE") {
  const r = await fetch(`${s.base}/api/agents/signin-token`, {
    method,
    headers: { ...denAuth(s.stateDir), "content-type": "application/json" },
    ...(method === "POST" ? { body: JSON.stringify({ token: TOKEN }) } : {}),
  });
  const text = await r.text();
  expect(text).not.toContain(TOKEN);
  return {
    status: r.status,
    body: JSON.parse(text) as Record<string, unknown>,
  };
}

describe("Doppler: the row follows the stored value", () => {
  it("a ref with nothing behind it: no token; Save: set; Remove: no token", async () => {
    expect(await signin(dop!)).toMatchObject({ configured: false });
    expect((await call(dop!, "POST")).status).toBe(200);
    expect(await signin(dop!)).toMatchObject({ configured: true });
    expect((await call(dop!, "DELETE")).status).toBe(200);
    expect(await signin(dop!)).toMatchObject({ configured: false });
    expect(JSON.stringify(await dop!.settingsGet())).not.toContain(TOKEN);
  });
});

describe("env: Den's record is the one truth, marked process-local", () => {
  it("before Save: no token; after: set and process-local; after Remove: no token", async () => {
    expect(await signin(env!)).toMatchObject({ configured: false });
    expect((await call(env!, "POST")).status).toBe(200);
    expect(await signin(env!)).toMatchObject({
      configured: true,
      process_local: true,
    });
    const del = await call(env!, "DELETE");
    expect(del.body).toMatchObject({ ok: true, cleared: true });
    expect(await signin(env!)).toMatchObject({ configured: false });
  });
});
