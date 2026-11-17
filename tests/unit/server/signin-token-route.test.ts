/**
 * #299 (inside #163): Settings › Keep agents running after logout ›
 * Sign-in token. POST /api/agents/signin-token {token} writes the token to
 * the install's configured secrets store by the same code as `agents token
 * set` (saveAgentToken), here a Doppler store whose CLI is a shim that
 * keeps what it is given on stdin in a temp dir. The answer never carries
 * the token; an agent's request is refused.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  handleSignInTokenRoute,
  type SignInTokenDeps,
} from "../../../src/ui/server/keep-running-routes.js";
import {
  agentTokenStatusNow,
  saveAgentToken,
} from "../../../src/shared/agents/signin-token.js";
import { spawn } from "child_process";
import type {
  SecretRef,
  SecretsProvider,
} from "../../../src/shared/secrets/types.js";

/**
 * A Doppler-shaped store that runs the shim by its absolute path (the
 * token on stdin, as DopplerProvider does), so no PATH lookup can ever
 * reach a real `doppler`.
 */
class ShimStore implements SecretsProvider {
  readonly name = "doppler" as const;
  constructor(private readonly shim: string) {}
  async isReady() {
    return true;
  }
  async get(): Promise<string> {
    throw new Error("not read here");
  }
  async tryGet() {
    return null;
  }
  set(ref: SecretRef, value: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const c = spawn(
        this.shim,
        ["secrets", "set", ref.key ?? ref.field, "--silent"],
        {
          stdio: ["pipe", "ignore", "ignore"],
        },
      );
      c.on("error", reject);
      c.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
      );
      c.stdin.end(value);
    });
  }
  async preflight() {
    return { ok: true };
  }
  runPrefix() {
    return [];
  }
}

const TOKEN = "fake-oat-token-route-0123456789";
const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** A server with only the route, on a store whose `doppler` is a shim. */
async function world(over: Partial<SignInTokenDeps> = {}) {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), "den-token-route-"));
  tmps.push(t);
  const bin = path.join(t, "bin");
  const kept = path.join(t, "kept");
  fs.mkdirSync(bin);
  fs.mkdirSync(kept);
  // `doppler secrets set KEY --silent`: what comes on stdin is kept; argv
  // is logged too, to show the token never travels there.
  fs.writeFileSync(
    path.join(bin, "doppler"),
    `#!/bin/sh\necho "$@" >> "${t}/argv"\n[ "$1" = secrets ] && [ "$2" = set ] && cat > "${kept}/$3"\nexit 0\n`,
    { mode: 0o755 },
  );
  const stateDir = path.join(t, "state");
  const savedRefs: unknown[] = [];
  const lines: string[] = [];
  const d: SignInTokenDeps = {
    isAgent: (req) => req.headers["x-test-agent"] === "1",
    save: async (token) => {
      {
        return await saveAgentToken(token, {
          provider: () => new ShimStore(path.join(bin, "doppler")),
          ref: () => null,
          status: () => ({
            backend: "doppler",
            label: "Doppler",
            implicit: false,
            detect: { available: true },
          }),
          saveRef: (r) => savedRefs.push(r),
          stateDir,
        });
      }
    },
    status: () => {
      const st = agentTokenStatusNow({
        env: { DEN_AGENT_SIGNIN: "token" },
        stateDir,
        ref: () =>
          savedRefs.length ? { vault: "", item: "", field: "K" } : null,
        status: () => ({
          backend: "doppler",
          label: "Doppler",
          implicit: false,
          detect: { available: true },
        }),
      });
      return { configured: st.configured, set_at: st.setAt, store: st.store };
    },
    log: (l) => lines.push(l),
    readBody: (req) =>
      new Promise((res) => {
        let b = "";
        req.on("data", (c) => (b += String(c)));
        req.on("end", () => res(b));
      }),
    sendJson: (res, body, status = 200) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    },
    ...over,
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    if (!handleSignInTokenRoute(req, res, u.pathname, d)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const post = async (body: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/agents/signin-token`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: r.status, text: await r.text() };
  };
  return {
    t,
    kept,
    post,
    lines,
    savedRefs,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("POST /api/agents/signin-token", () => {
  it("writes the token to the configured store (stdin, never argv) and answers set <date>, never the token", async () => {
    const w = await world();
    const r = await w.post({ token: `  ${TOKEN}\n` });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.store).toBe("Doppler");
    expect((body.signin as { set_at: string }).set_at).toMatch(/^\d{4}-/);
    expect(r.text).not.toContain(TOKEN);
    const files = fs.readdirSync(w.kept);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/_AGENT_SIGNIN_TOKEN$/);
    expect(fs.readFileSync(path.join(w.kept, files[0]!), "utf-8")).toBe(TOKEN);
    expect(fs.readFileSync(path.join(w.t, "argv"), "utf-8")).not.toContain(
      TOKEN,
    );
    expect(w.lines.join("\n")).not.toContain(TOKEN);
    await w.close();
  });

  it("refuses an agent's request, and stores nothing", async () => {
    const w = await world();
    const r = await w.post({ token: TOKEN }, { "x-test-agent": "1" });
    expect(r.status).toBe(403);
    expect(r.text).toMatch(/only a person/);
    expect(fs.readdirSync(w.kept)).toEqual([]);
    await w.close();
  });

  it("refuses an empty or malformed value without echoing it", async () => {
    const w = await world();
    const bad = await w.post({ token: "has a space in it 123" });
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain("has a space");
    expect((await w.post({ token: "" })).status).toBe(400);
    expect((await w.post({})).status).toBe(400);
    expect((await w.post("not json")).status).toBe(400);
    expect(fs.readdirSync(w.kept)).toEqual([]);
    await w.close();
  });

  it("a store failure: 500, its reason without the token", async () => {
    const w = await world({
      save: async (t) => {
        throw new Error(`doppler said no to ${t}`);
      },
    });
    const r = await w.post({ token: TOKEN });
    expect(r.status).toBe(500);
    expect(r.text).toMatch(/doppler said no/);
    expect(r.text).not.toContain(TOKEN);
    await w.close();
  });
});
