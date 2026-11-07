/**
 * A fake GitHub for SEC-2a's tests: the device-flow endpoints and `GET
 * /user`, on localhost (DEN_TEST_GITHUB_URL points Den at it). No test ever
 * reaches github.com.
 *
 *   POST /login/device/code         a device code and a user code
 *   POST /login/oauth/access_token  authorization_pending until a test
 *                                   approves (as an account), denies, or
 *                                   expires the code; then a token, once
 *   GET  /user                      the approving account's id and login
 *
 * It records every request's form fields, so a test can check that no
 * client secret and no scope (offline_access least of all) was ever sent.
 * Every answer closes its connection (no keep-alive).
 */
import { randomBytes } from "crypto";
import * as http from "http";
import type { AddressInfo } from "net";

export interface FakeAccount {
  id: number;
  login: string;
}

interface Code {
  deviceCode: string;
  userCode: string;
  outcome:
    | { kind: "pending" }
    | { kind: "approved"; account: FakeAccount }
    | { kind: "denied" }
    | { kind: "expired" }
    | { kind: "slow_down" };
  slowDowns: number;
}

export interface FakeGithub {
  url: string;
  /** Every request: its path and form fields (or the Authorization header's presence). */
  requests: { path: string; fields: Record<string, string>; auth: boolean }[];
  /** Codes handed out, newest last. */
  codes: Code[];
  /** Tokens issued (a test checks none reaches Den's state or output). */
  tokens: string[];
  approve(userCode: string, account: FakeAccount): void;
  deny(userCode: string): void;
  expire(userCode: string): void;
  /** The next N polls of this code answer slow_down. */
  slowDown(userCode: string, n: number): void;
  close(): Promise<void>;
}

export async function startFakeGithub(
  opts: { interval?: number; expiresIn?: number } = {},
): Promise<FakeGithub> {
  const codes: Code[] = [];
  const tokens = new Map<string, FakeAccount>();
  const requests: FakeGithub["requests"] = [];
  const find = (userCode: string) => {
    const c = codes.find((x) => x.userCode === userCode);
    if (!c) throw new Error("no such user code");
    return c;
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d: Buffer) => (body += d.toString()));
    req.on("end", () => {
      const fields = Object.fromEntries(new URLSearchParams(body));
      requests.push({
        path: req.url ?? "",
        fields,
        auth: req.headers.authorization !== undefined,
      });
      const send = (status: number, o: unknown) => {
        res.writeHead(status, {
          "content-type": "application/json",
          connection: "close",
        });
        res.end(JSON.stringify(o));
      };
      if (req.method === "POST" && req.url === "/login/device/code") {
        if (!fields.client_id)
          return send(400, { error: "unauthorized_client" });
        const c: Code = {
          deviceCode: randomBytes(20).toString("hex"),
          userCode: `${randomBytes(2).toString("hex").toUpperCase()}-${randomBytes(2).toString("hex").toUpperCase()}`,
          outcome: { kind: "pending" },
          slowDowns: 0,
        };
        codes.push(c);
        return send(200, {
          device_code: c.deviceCode,
          user_code: c.userCode,
          verification_uri: "https://github.com/login/device",
          expires_in: opts.expiresIn ?? 900,
          interval: opts.interval ?? 0,
        });
      }
      if (req.method === "POST" && req.url === "/login/oauth/access_token") {
        const c = codes.find((x) => x.deviceCode === fields.device_code);
        if (!c) return send(200, { error: "incorrect_device_code" });
        if (c.slowDowns > 0) {
          c.slowDowns--;
          return send(200, {
            error: "slow_down",
            interval: opts.interval ?? 0,
          });
        }
        const o = c.outcome;
        if (o.kind === "pending")
          return send(200, { error: "authorization_pending" });
        if (o.kind === "denied") return send(200, { error: "access_denied" });
        if (o.kind === "expired") return send(200, { error: "expired_token" });
        if (o.kind === "approved") {
          const token = `ghu_${randomBytes(18).toString("hex")}`;
          tokens.set(token, o.account);
          // A device code is good for one token.
          c.outcome = { kind: "expired" };
          return send(200, {
            access_token: token,
            token_type: "bearer",
            scope: "",
          });
        }
        return send(200, { error: "slow_down" });
      }
      if (req.method === "GET" && req.url === "/user") {
        const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
        const a = m ? tokens.get(m[1]) : undefined;
        if (!a) return send(401, { message: "Bad credentials" });
        return send(200, { id: a.id, login: a.login, type: "User" });
      }
      send(404, { message: "Not Found" });
    });
  });
  server.keepAliveTimeout = 1;
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://localhost:${port}`,
    requests,
    codes,
    get tokens() {
      return [...tokens.keys()];
    },
    approve: (u, account) => (find(u).outcome = { kind: "approved", account }),
    deny: (u) => (find(u).outcome = { kind: "denied" }),
    expire: (u) => (find(u).outcome = { kind: "expired" }),
    slowDown: (u, n) => (find(u).slowDowns = n),
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/** What a failure may print about a code or token: never the value. */
export const masked = (v: string | undefined | null): string =>
  v ? `<${v.length} chars>` : String(v);
