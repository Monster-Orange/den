/**
 * Issue 340: under the always-on service, when no vendor account has a
 * token an agent can start on, the agent starts as today and doctor says
 * why: each account by its label (never an email, never a token) and what
 * stopped it ("not set", "capped", the store's reason), then how to set
 * one. With more than one account, doctor's sign-in row follows the pick
 * (the account agents start on), not account one alone.
 *
 * Invented tokens only; the store is a map of ref name to token.
 */
import { afterEach, describe, expect, it } from "@jest/globals";
import { whereRows, type WhereDeps } from "../../../src/ui/cli/doctor-where.js";
import {
  accountLabel,
  addAccount,
  setAccountOrder,
  signInPicks,
  vendorName,
} from "../../../src/shared/agents/signin-accounts.js";
import type { TokenStatus } from "../../../src/shared/agents/signin-token.js";
import { cleanupRigs, rig } from "../agents/helpers/rig.js";

afterEach(cleanupRigs);

const T2 = "fake-doctor-two-0123456789abcdef";
const V = vendorName("den-claude");
const A = accountLabel({ id: "1" }, V);
const B = accountLabel({ id: "2" }, V);

const read =
  (values: Record<string, string>) =>
  async (name: string): Promise<{ token: string | null; reason?: string }> =>
    values[name]
      ? { token: values[name]! }
      : { token: null, reason: "not set" };

const deps = (over: Partial<WhereDeps>): WhereDeps => ({
  cli: "acme",
  platform: "darwin",
  server: async () => ({ launchd: "System" }),
  host: async () => ({ launchd: "System", pid: 5 }),
  service: () => ({
    state: "loaded",
    mode: "always",
    plist: "/Library/LaunchDaemons/x.plist",
    domain: "system",
  }),
  ...over,
});

/** Account one has no token: what today's row reads. */
const noLegacy = async (): Promise<TokenStatus> => ({
  mode: "token",
  configured: false,
  setAt: null,
  ageDays: null,
  old: false,
  warnDays: 330,
  store: "1Password",
  stored: false,
});

describe("signInPicks: each vendor's pick, read as a start would", () => {
  it("names the account agents start on, and why the others were passed over", async () => {
    const r = await rig();
    addAccount(r.stateDir, "den-claude");
    const picks = await signInPicks({
      stateDir: r.stateDir,
      runtimeIds: ["den-claude", "generic"],
      read: read({ agent_signin_token__2: T2 }),
    });
    expect(picks).toEqual([
      {
        runtime: "den-claude",
        vendor: V,
        count: 2,
        picked: { id: "2", label: B },
        misses: [{ id: "1", label: A, reason: "not set" }],
      },
    ]);
    expect(JSON.stringify(picks)).not.toContain("fake-doctor");
  });

  it("none with a token: picked is null, and every account says why", async () => {
    const r = await rig();
    addAccount(r.stateDir, "den-claude");
    setAccountOrder(r.stateDir, "den-claude", ["2", "1"]);
    const picks = await signInPicks({
      stateDir: r.stateDir,
      runtimeIds: ["den-claude"],
      read: read({ agent_signin_token__2: T2 }),
      capped: (_rt, id) => id === "2",
    });
    expect(picks[0]!.picked).toBeNull();
    expect(picks[0]!.misses).toEqual([
      { id: "2", label: B, reason: "capped" },
      { id: "1", label: A, reason: "not set" },
    ]);
  });
});

describe("doctor's sign-in row", () => {
  it("no account with a token: warns, says why for each, and how to set one", async () => {
    const rows = await whereRows(
      deps({
        signIn: noLegacy,
        signInPicks: async () => [
          {
            runtime: "den-claude",
            vendor: V,
            count: 2,
            picked: null,
            misses: [
              { id: "1", label: A, reason: "not set" },
              { id: "2", label: B, reason: "capped" },
            ],
          },
        ],
      }),
    );
    const row = rows.filter((r) => r.what === "agent sign-in");
    expect(row).toHaveLength(1);
    expect(row[0]!.status).toBe("warn");
    expect(row[0]!.detail).toContain(`${A}: not set`);
    expect(row[0]!.detail).toContain(`${B}: capped`);
    expect(row[0]!.detail).toMatch(/start as today, with no token/);
    expect(row[0]!.detail).toContain("acme agents accounts set-token");
  });

  it("more than one account and one has a token: ok, naming it, even though account one has none", async () => {
    const rows = await whereRows(
      deps({
        signIn: noLegacy,
        signInPicks: async () => [
          {
            runtime: "den-claude",
            vendor: V,
            count: 2,
            picked: { id: "2", label: B },
            misses: [{ id: "1", label: A, reason: "not set" }],
          },
        ],
      }),
    );
    const row = rows.filter((r) => r.what === "agent sign-in");
    expect(row).toHaveLength(1);
    expect(row[0]!.status).toBe("ok");
    expect(row[0]!.detail).toContain(B);
    expect(row[0]!.detail).toContain(`${A}: not set`);
  });

  it("one account: today's row, unchanged", async () => {
    const rows = await whereRows(
      deps({
        signIn: noLegacy,
        signInPicks: async () => [
          {
            runtime: "den-claude",
            vendor: V,
            count: 1,
            picked: null,
            misses: [{ id: "1", label: A, reason: "not set" }],
          },
        ],
      }),
    );
    const row = rows.filter((r) => r.what === "agent sign-in");
    expect(row).toHaveLength(1);
    expect(row[0]!.detail).toMatch(
      /no sign-in token is configured: agents will not be able to sign in after logout/,
    );
  });
});
