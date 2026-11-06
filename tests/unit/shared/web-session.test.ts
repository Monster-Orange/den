/**
 * SEC-1b (SEC-1 spec §2): the login code, `next`, the session store (a
 * session never expires: Ward, 2026-11-06) and the sign-in config, as pure functions with an injected
 * clock (no test waits 60 s). No code, cookie value or secret is printed:
 * a failure shows booleans and reasons only.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkLoginCode,
  ignoredConfigWarning,
  LOGIN_CODE_TTL_MS,
  loginLink,
  mintLoginCode,
  parseOrigin,
  readWebAuthConfig,
  safeNext,
  WebSessionStore,
  webSessionsPath,
} from "../../../src/shared/web-session.js";
import {
  ensureWebSecret,
  readWebSecret,
  rotateWebSecret,
} from "../../../src/shared/web-secret.js";

const T0 = Date.UTC(2026, 10, 6, 9, 0, 0);
const MIN = 60_000;
const DAY = 86_400_000;

let tmp = "";
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "den-wsess-")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("the login code", () => {
  const secret = randomBytes(32);

  it("verifies within 60 s, and is refused at 60 s and after", () => {
    const code = mintLoginCode(secret, T0);
    expect(checkLoginCode(code, secret, T0).ok).toBe(true);
    expect(checkLoginCode(code, secret, T0 + LOGIN_CODE_TTL_MS - 1).ok).toBe(
      true,
    );
    expect(checkLoginCode(code, secret, T0 + LOGIN_CODE_TTL_MS)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(checkLoginCode(code, secret, T0 + 10 * MIN).ok).toBe(false);
  });

  it("is refused when it claims more than 60 s (a clock far behind)", () => {
    const code = mintLoginCode(secret, T0);
    expect(checkLoginCode(code, secret, T0 - 2 * MIN)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("is single use: the store records its nonce, a second use is refused", () => {
    const store = new WebSessionStore({
      stateDir: () => tmp,
      secret: () => secret,
      now: () => T0,
    });
    const c = checkLoginCode(mintLoginCode(secret, T0), secret, T0);
    if (!c.ok) throw new Error("fresh code refused");
    expect(store.consumeCode(c.nonce, c.expiresAt)).toBe(true);
    expect(store.consumeCode(c.nonce, c.expiresAt)).toBe(false);
    // A second store on the same state dir (a restarted server) agrees.
    const again = new WebSessionStore({
      stateDir: () => tmp,
      secret: () => secret,
      now: () => T0,
    });
    expect(again.consumeCode(c.nonce, c.expiresAt)).toBe(false);
  });

  it("a tampered code is refused: its mac, its nonce, its expiry, another secret", () => {
    const code = mintLoginCode(secret, T0);
    const [v, nonce, exp, mac] = code.split(".");
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    const tampered = [
      [v, nonce, exp, flip(mac)],
      [v, flip(nonce), exp, mac],
      [v, nonce, (parseInt(exp, 36) + MIN).toString(36), mac],
      ["v2", nonce, exp, mac],
    ].map((p) => p.join("."));
    for (const t of tampered)
      expect(checkLoginCode(t, secret, T0).ok).toBe(false);
    expect(checkLoginCode(code, randomBytes(32), T0)).toEqual({
      ok: false,
      reason: "bad_mac",
    });
    for (const junk of ["", "x", `${code}.`, code.slice(0, -1), " " + code])
      expect(checkLoginCode(junk, secret, T0).ok).toBe(false);
  });
});

describe("next: only a same-origin path", () => {
  it.each([
    "//evil.example",
    "//evil.example/x",
    "http://evil.example",
    "https://evil.example/",
    "/\\evil.example",
    "/\\/evil.example",
    "\\\\evil.example",
    "javascript:alert(1)",
    "evil.example",
    "/x\nSet-Cookie: a=b",
    "/auth?c=whatever",
    "",
  ])("%p goes to /", (n) => expect(safeNext(n)).toBe("/"));

  it("keeps a path, its query and its hash", () => {
    expect(safeNext("/settings?x=1#cli")).toBe("/settings?x=1#cli");
    expect(safeNext("/local-dev")).toBe("/local-dev");
    expect(safeNext(null)).toBe("/");
  });

  it("the link: localhost, the code, and next only when it isn't /", () => {
    expect(loginLink("http://localhost:4100", "CODE")).toBe(
      "http://localhost:4100/auth?c=CODE",
    );
    expect(loginLink("http://localhost:4100/", "CODE", "/settings")).toBe(
      "http://localhost:4100/auth?c=CODE&next=%2Fsettings",
    );
    expect(loginLink("http://localhost:4100", "CODE", "//evil")).toBe(
      "http://localhost:4100/auth?c=CODE",
    );
  });

  it("--origin takes an origin only", () => {
    expect(parseOrigin("https://den.acme.localhost")).toBe(
      "https://den.acme.localhost",
    );
    expect(parseOrigin("http://192.0.2.4:4100/")).toBe("http://192.0.2.4:4100");
    for (const bad of [
      "den.acme.localhost",
      "ftp://x",
      "https://x/path",
      "https://u:p@x",
      "https://x?q=1",
    ])
      expect(parseOrigin(bad)).toBeNull();
  });
});

describe("the session store", () => {
  let now = T0;
  const store = () =>
    new WebSessionStore({
      stateDir: () => tmp,
      secret: () => readWebSecret(tmp),
      now: () => now,
    });
  beforeEach(() => {
    now = T0;
    ensureWebSecret(tmp);
  });

  it("a session's record is server-side, 0600, keyed by neither the id nor anything the cookie carries", () => {
    const s = store();
    const { id, session } = s.create({
      userAgent: "Mozilla/5.0 ".repeat(40),
      host: "LOCALHOST:4100",
    });
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const file = webSessionsPath(tmp);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const raw = fs.readFileSync(file, "utf-8");
    expect(raw.includes(id)).toBe(false);
    expect(session.userAgent.length).toBe(120);
    expect(session.host).toBe("localhost:4100");
    expect(session.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(s.lookup(id)?.key).toBe(session.key);
    expect(s.lookup("x".repeat(43))).toBeNull();
    expect(s.lookup("")).toBeNull();
  });

  it("never expires: idle for a year, or two years after sign-in, it is still live (it ends at sign-out)", () => {
    const s = store();
    const { id } = s.create({});
    now = T0 + 365 * DAY; // a year without a request
    expect(s.lookup(id)).not.toBeNull();
    now = T0 + 730 * DAY;
    expect(s.lookup(id)).not.toBeNull();
    expect(s.list().length).toBe(1);
    // Making another session never prunes it either.
    s.create({});
    expect(s.list().length).toBe(2);
    expect(s.lookup(id)).not.toBeNull();
  });

  it("rotating web.secret ends every session", () => {
    const s = store();
    const { id } = s.create({});
    expect(s.lookup(id)).not.toBeNull();
    rotateWebSecret(tmp);
    expect(fs.statSync(path.join(tmp, "web.secret")).mode & 0o777).toBe(0o600);
    expect(s.lookup(id)).toBeNull();
  });

  it("ends one by its id prefix, or all", () => {
    const s = store();
    const a = s.create({ host: "a" });
    now += 1;
    const b = s.create({ host: "b" });
    expect(s.list().map((x) => x.host)).toEqual(["b", "a"]);
    expect(() => s.endByPrefix("zz")).toThrow(/not a session id prefix/);
    s.endByPrefix(a.session.key.slice(0, 8));
    expect(s.lookup(a.id)).toBeNull();
    expect(s.lookup(b.id)).not.toBeNull();
    expect(s.endAll()).toBe(1);
    expect(s.lookup(b.id)).toBeNull();
  });
});

describe("the sign-in config (web.allow_plain_http_remote; web.session is ignored)", () => {
  const write = (rel: string, body: string) => {
    const f = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, body);
  };

  it("defaults: no plain-HTTP remote, nothing ignored, no warning", () => {
    const cfg = readWebAuthConfig(tmp);
    expect(cfg).toEqual({ allowPlainHttpRemote: false, ignored: [] });
    expect(ignoredConfigWarning(cfg)).toBeNull();
  });

  it.each([
    ["web:\n  session:\n    idle: 12h\n    max: 10d\n"],
    ["web:\n  session:\n    idle: soon\n"],
    ["web:\n  session:\n    ttl: 1d\n"],
    ["web:\n  session: 7d\n"],
  ])(
    "the 0.4.1-dev web.session keys (%p) are read, ignored and warned about: never a refusal",
    (body) => {
      write("config/local/user.yml", body);
      write("config/den.yml", "web:\n  session:\n    max: 30d\n");
      let cfg: ReturnType<typeof readWebAuthConfig> | null = null;
      expect(() => (cfg = readWebAuthConfig(tmp))).not.toThrow();
      const c = cfg as unknown as ReturnType<typeof readWebAuthConfig>;
      expect(c.ignored.some((k) => k.endsWith("(config/local/user.yml)"))).toBe(
        true,
      );
      expect(c.ignored).toContain(
        `web.session.max (${path.join("config", "den.yml")})`,
      );
      expect(ignoredConfigWarning(c)).toMatch(
        /: ignored\. A browser session never expires/,
      );
    },
  );

  it("a wrong allow_plain_http_remote still names the key", () => {
    write(
      "config/local/user.yml",
      "web:\n  allow_plain_http_remote: yes please\n",
    );
    expect(() => readWebAuthConfig(tmp)).toThrow(
      /web\.allow_plain_http_remote must be true or false/,
    );
  });

  it("allow_plain_http_remote is this machine's choice: user.yml only", () => {
    write("config/den.yml", "web:\n  allow_plain_http_remote: true\n");
    expect(readWebAuthConfig(tmp).allowPlainHttpRemote).toBe(false);
    write("config/local/user.yml", "web:\n  allow_plain_http_remote: true\n");
    expect(readWebAuthConfig(tmp).allowPlainHttpRemote).toBe(true);
  });
});
