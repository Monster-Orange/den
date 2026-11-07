/**
 * 0.4.12: the claim code (Ward, 2026-11-07). The install step hands the
 * person `http://localhost:<port>/?claim=<code>`; its first open signs that
 * browser in, so approving an agent's changes works without a sign-in step.
 *
 *  - `c1.<nonce>.<expiry>.<mac>`, HMAC-SHA256 of web.secret with its own
 *    context: a login code is never a claim code, and the other way round;
 *  - valid for 30 minutes;
 *  - single use, and the used nonces outlive a server restart (a file, 0600,
 *    pruned once they expire);
 *  - the CLI refuses to mint one inside an agent's session.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { randomBytes } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CLAIM_CODE_TTL_MS,
  ClaimNonces,
  checkClaimCode,
  claimLink,
  claimRefusalForAgent,
  mintClaimCode,
} from "../../../src/shared/claim-code.js";
import {
  checkLoginCode,
  mintLoginCode,
} from "../../../src/shared/web-session.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "den-claim-"));
  tmps.push(d);
  return d;
};

const secret = randomBytes(32);
const T0 = Date.parse("2026-11-07T12:00:00Z");

describe("the claim code", () => {
  it("is valid for 30 minutes, then expired", () => {
    const c = mintClaimCode(secret, T0);
    expect(c).toMatch(/^c1\./);
    expect(CLAIM_CODE_TTL_MS).toBe(30 * 60_000);
    expect(checkClaimCode(c, secret, T0 + 29 * 60_000)).toMatchObject({
      ok: true,
    });
    expect(checkClaimCode(c, secret, T0 + 30 * 60_000)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("another secret's code, a changed code, or garbage is refused", () => {
    const c = mintClaimCode(secret, T0);
    expect(checkClaimCode(c, randomBytes(32), T0).ok).toBe(false);
    const flipped = c.slice(0, -2) + (c.endsWith("AA") ? "BB" : "AA");
    expect(checkClaimCode(flipped, secret, T0).ok).toBe(false);
    expect(checkClaimCode("nope", secret, T0)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("is not a login code, and a login code is not a claim code", () => {
    const claim = mintClaimCode(secret, T0);
    const login = mintLoginCode(secret, T0);
    expect(checkLoginCode(claim, secret, T0).ok).toBe(false);
    expect(checkClaimCode(login, secret, T0).ok).toBe(false);
  });

  it("an expiry further out than 30 minutes is refused (no long-lived codes)", () => {
    const c = mintClaimCode(secret, T0 + 60 * 60_000);
    expect(checkClaimCode(c, secret, T0)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("the link is the page with ?claim=", () => {
    expect(claimLink("http://localhost:4100", "c1.x")).toBe(
      "http://localhost:4100/?claim=c1.x",
    );
  });
});

describe("single use, across a restart", () => {
  it("a nonce is used once; a new store on the same file still knows it", () => {
    const dir = tmpDir();
    const c = mintClaimCode(secret, T0);
    const v = checkClaimCode(c, secret, T0);
    if (!v.ok) throw new Error("bad code");
    const a = new ClaimNonces(dir);
    expect(a.consume(v.nonce, v.expiresAt, T0)).toBe(true);
    expect(a.consume(v.nonce, v.expiresAt, T0)).toBe(false);
    // The server restarted.
    const b = new ClaimNonces(dir);
    expect(b.consume(v.nonce, v.expiresAt, T0 + 1000)).toBe(false);
    const file = path.join(dir, "claim-nonces.json");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, "utf-8")).not.toContain(c);
  });

  it("expired nonces are pruned", () => {
    const dir = tmpDir();
    const s = new ClaimNonces(dir);
    s.consume("n".repeat(22), T0 + 1000, T0);
    s.consume("m".repeat(22), T0 + 10 * 60_000, T0 + 5000);
    const kept = JSON.parse(
      fs.readFileSync(path.join(dir, "claim-nonces.json"), "utf-8"),
    ) as Record<string, number>;
    expect(Object.keys(kept)).toEqual(["m".repeat(22)]);
  });
});

describe("the CLI refuses inside an agent's session", () => {
  it.each([
    [{ DEN_AGENT: "agent:planner" }],
    [{ DEN_ACTOR_TOKEN: "den_at_x" }],
  ])("%j", (env) => {
    expect(claimRefusalForAgent(env)).toMatch(
      /An agent can't make a claim link/,
    );
  });
  it("a person's shell may", () => {
    expect(claimRefusalForAgent({ HOME: "/home/someone" })).toBeNull();
  });
});
