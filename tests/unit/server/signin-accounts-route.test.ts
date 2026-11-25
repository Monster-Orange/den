/**
 * Issue 339: Settings' sign-in accounts routes (handleAccountsRoute).
 * A person's only; the token is in no answer or log line, also when the
 * store refuses it; a bad request is a 400 in plain words. The store is in
 * memory (signin-accounts.ts with an injected provider); invented tokens.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as http from "http";
import type { AddressInfo } from "net";
import * as os from "os";
import * as path from "path";
import {
  handleAccountsRoute,
  type AccountsRouteDeps,
} from "../../../src/ui/server/keep-running-routes.js";
import {
  accountsView,
  addAccount,
  saveAccountToken,
  setAccountOrder,
} from "../../../src/shared/agents/signin-accounts.js";
import type {
  SecretRef,
  SecretsProvider,
} from "../../../src/shared/secrets/types.js";

const TOKEN = "fake-account-route-0123456789abcdef";
const tmps: string[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0))
    await new Promise((r) => s.close(() => r(null)));
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

class MemStore implements SecretsProvider {
  readonly name = "1password" as const;
  values: Record<string, string> = {};
  refuse = false;
  async isReady() {
    return true;
  }
  async get(): Promise<string> {
    throw new Error("not read here");
  }
  async tryGet() {
    return null;
  }
  async set(ref: SecretRef, v: string): Promise<void> {
    if (this.refuse)
      throw new Error(`Command failed: op x=${v}\nop said no ${v}`);
    this.values[ref.item] = v;
  }
  async preflight() {
    return { ok: true };
  }
  runPrefix() {
    return [];
  }
}

async function world() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "den-acct-route-"));
  tmps.push(stateDir);
  const store = new MemStore();
  const refs: Record<string, Partial<SecretRef>> = {};
  const lines: string[] = [];
  const removed: string[][] = [];
  const d: AccountsRouteDeps = {
    // Issue 1182: what the route asked to remove (the store is the shared
    // code's, covered in signin-accounts tests).
    remove: async (rt, account) => {
      removed.push([rt, account]);
      return { label: `Account ${account}`, store: "1Password" };
    },
    isAgent: (req) => req.headers["x-test-agent"] === "1",
    add: (rt, name) => void addAccount(stateDir, rt, name),
    order: (rt, ids) => void setAccountOrder(stateDir, rt, ids),
    saveToken: (rt, account, token) =>
      saveAccountToken(token, {
        runtimeId: rt,
        accountId: account,
        stateDir,
        provider: () => store,
        ref: () => null,
        status: () => ({
          backend: "1password",
          label: "1Password",
          implicit: false,
          detect: { available: true },
        }),
        saveRefAs: (n, r) => (refs[n] = r),
      }),
    view: () =>
      accountsView(stateDir, "den-claude", (n) =>
        refs[n] ? { vault: "", item: "x", field: "f" } : null,
      ),
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
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (!handleAccountsRoute(req, res, url.pathname, d)) {
      res.writeHead(404);
      res.end();
    }
  });
  servers.push(server);
  await new Promise((r) => server.listen(0, "127.0.0.1", () => r(null)));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (p: string, body: unknown, agent = false) => {
    const r = await fetch(base + p, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(agent ? { "x-test-agent": "1" } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: r.status, text: await r.text() };
  };
  return { post, store, lines, stateDir, removed };
}

describe("issue 1182: POST /api/agents/accounts/remove", () => {
  it("a person removes an account: the answer says which, and where its token was", async () => {
    const w = await world();
    const r = await w.post("/api/agents/accounts/remove", {
      runtime: "den-claude",
      account: "2",
    });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text)).toMatchObject({
      ok: true,
      removed: "Account 2",
      store: "1Password",
    });
    expect(w.removed).toEqual([["den-claude", "2"]]);
  });

  it("an agent is refused, and nothing is removed", async () => {
    const w = await world();
    const r = await w.post(
      "/api/agents/accounts/remove",
      { runtime: "den-claude", account: "2" },
      true,
    );
    expect(r.status).toBe(403);
    expect(w.removed).toEqual([]);
  });

  it("needs the account, as a string", async () => {
    const w = await world();
    const r = await w.post("/api/agents/accounts/remove", {
      runtime: "den-claude",
    });
    expect(r.status).toBe(400);
    expect(w.removed).toEqual([]);
  });
});

describe("issue 339: the accounts routes", () => {
  it("add, set a token, order: the answer is the list, never the token", async () => {
    const w = await world();
    let r = await w.post("/api/agents/accounts", { runtime: "den-claude" });
    expect(r.status).toBe(200);
    expect(
      JSON.parse(r.text).accounts.map((a: { id: string }) => a.id),
    ).toEqual(["1", "2"]);
    r = await w.post("/api/agents/accounts/token", {
      runtime: "den-claude",
      account: "2",
      token: TOKEN,
    });
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(TOKEN);
    expect(JSON.parse(r.text).accounts[1]).toMatchObject({
      id: "2",
      configured: true,
    });
    expect(Object.values(w.store.values)).toEqual([TOKEN]);
    r = await w.post("/api/agents/accounts/order", {
      runtime: "den-claude",
      order: ["2", "1"],
    });
    expect(JSON.parse(r.text).accounts[0]).toMatchObject({
      id: "2",
      first: true,
    });
    expect(w.lines.join("\n")).toMatch(/saved in 1Password/);
    expect(w.lines.join("\n")).not.toContain(TOKEN);
  });

  it("an agent's request is refused, and nothing changes", async () => {
    const w = await world();
    const r = await w.post(
      "/api/agents/accounts",
      { runtime: "den-claude" },
      true,
    );
    expect(r.status).toBe(403);
    expect(fs.readdirSync(w.stateDir)).toEqual([]);
  });

  it("a store error never carries the token; a bad order or name is a 400", async () => {
    const w = await world();
    w.store.refuse = true;
    let r = await w.post("/api/agents/accounts/token", {
      runtime: "den-claude",
      account: "1",
      token: TOKEN,
    });
    expect(r.status).toBe(500);
    expect(r.text).toMatch(/op said no/);
    expect(r.text).not.toContain(TOKEN);
    r = await w.post("/api/agents/accounts/order", {
      runtime: "den-claude",
      order: ["9"],
    });
    expect(r.status).toBe(400);
    r = await w.post("/api/agents/accounts", {
      runtime: "den-claude",
      name: "x@y.example",
    });
    expect(r.status).toBe(400);
    expect(r.text).toMatch(/not an email/);
  });
});
