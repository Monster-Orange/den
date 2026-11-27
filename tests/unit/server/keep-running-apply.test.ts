/**
 * Issue 163: the page side of Settings › Keep agents running after logout
 * › Apply (applyKeepRunning in settings-registry.js). The server decides
 * when sudo needs the password (needsSudo); only then does the page ask,
 * then apply again. No password: nothing more is sent. Applied: Den
 * restarts, and the page waits for it to come back.
 */
import { describe, expect, it } from "@jest/globals";
// @ts-expect-error plain browser module
import { applyKeepRunning } from "../../../src/ui/server/public/settings-registry.js";

function world(answers: unknown[], password: boolean) {
  const posted: unknown[] = [];
  const asked: unknown[] = [];
  let waited = 0;
  return {
    posted,
    asked,
    waited: () => waited,
    deps: {
      post: async (body: unknown) => {
        posted.push(body);
        return answers.shift();
      },
      askSudo: async (need: unknown) => {
        asked.push(need);
        return password;
      },
      waitBack: async () => {
        waited++;
      },
    },
  };
}

describe("Apply: the page", () => {
  it("needs sudo: asks with the server's command, then applies again and waits for Den", async () => {
    const need = { command: "acme service install --mode always" };
    const w = world(
      [
        { ok: false, needsSudo: need },
        { ok: true, applied: true, mode: "always" },
      ],
      true,
    );
    expect(await applyKeepRunning(true, w.deps)).toEqual({
      state: "applied",
      mode: "always",
    });
    expect(w.asked).toEqual([need]);
    expect(w.posted).toEqual([{ on: true }, { on: true }]);
    expect(w.waited()).toBe(1);
  });

  it("no password given: nothing more is sent, nothing waits", async () => {
    const w = world([{ ok: false, needsSudo: { command: "x" } }], false);
    expect(await applyKeepRunning(true, w.deps)).toEqual({ state: "refused" });
    expect(w.posted).toEqual([{ on: true }]);
    expect(w.waited()).toBe(0);
  });

  it("off over login: never asks; saved, nothing to restart", async () => {
    const w = world([{ ok: true, applied: false, mode: "login" }], false);
    expect(await applyKeepRunning(false, w.deps)).toEqual({
      state: "saved",
      mode: "login",
    });
    expect(w.asked).toEqual([]);
    expect(w.waited()).toBe(0);
  });

  it("a failure says so", async () => {
    const w = world([null], true);
    expect(await applyKeepRunning(true, w.deps)).toEqual({ state: "failed" });
  });
});

// @ts-expect-error plain browser module
import {
  keepTokenHtml,
  keepTokenLine,
} from "../../../src/ui/server/public/settings-registry.js";

/** Issue 163 (b): the row's sign-in token line (never the token). */
describe("Keep agents running after logout: the sign-in token line", () => {
  const t = (k: string, v?: Record<string, unknown>) =>
    `${k}${v ? ` ${JSON.stringify(v)}` : ""}`;

  it("none configured in mode always: agents will not be able to sign in after logout", () => {
    expect(
      keepTokenLine(
        { configured: false, mode: "token", runtime: "Claude Code" },
        t,
      ),
    ).toEqual({
      state: "missing",
      text: 'keep.noToken {"runtime":"Claude Code"}',
      go: true,
    });
    expect(keepTokenLine(null, t)).toEqual({
      state: "missing",
      text: 'keep.noToken {"runtime":"keep.runtimeAny"}',
      go: true,
    });
  });

  it("none configured, not in mode always: says nothing about logout failing", () => {
    expect(keepTokenLine({ configured: false, mode: "desktop" }, t)).toEqual({
      state: "missing",
      text: "keep.noTokenNotNeeded",
    });
    expect(
      keepTokenLine({ configured: false, mode: "token", no_store: true }, t),
    ).toEqual({ state: "missing", text: "keep.noStore" });
    expect(
      keepTokenLine({ configured: false, mode: "desktop", no_store: true }, t)
        .text,
    ).toBe("keep.noStore");
  });

  it("old: says how many days, to make a new one", () => {
    expect(
      keepTokenLine(
        { configured: true, old: true, age_days: 340, runtime: "Claude Code" },
        t,
      ),
    ).toEqual({
      state: "old",
      text: 'keep.tokenOld {"n":340,"runtime":"Claude Code"}',
      go: true,
    });
  });

  it("issue 399: the line links the vendor's docs and the Sign-in token field, never a command", () => {
    const en: Record<string, string> = {
      "keep.noToken":
        "No sign-in token is set. {runtime} makes one ({docs}); paste it into {field} below.",
      "keep.docs": "its sign-in docs",
      "keep.tokenLabel": "Sign-in token",
    };
    const tt = (k: string, v?: Record<string, unknown>) =>
      (en[k] ?? k).replace(/\{(\w+)\}/g, (m, x) =>
        v && v[x] != null ? String(v[x]) : m,
      );
    const s = {
      configured: false,
      mode: "token",
      runtime: "Claude <Code>",
      docs: "https://vendor.example.com/docs/auth",
    };
    const html = keepTokenHtml(keepTokenLine(s, tt), s, tt);
    expect(html).toBe(
      "No sign-in token is set. Claude &lt;Code&gt; makes one (" +
        '<a href="https://vendor.example.com/docs/auth" target="_blank" rel="noopener noreferrer" data-keep-token-docs>its sign-in docs</a>' +
        '); paste it into <a href="#" data-keep-token-go>Sign-in token</a> below.',
    );
    // Not https: no link, the words only.
    expect(
      keepTokenHtml(keepTokenLine(s, tt), { ...s, docs: "javascript:x" }, tt),
    ).not.toContain("javascript:");
    // A line with nothing to point at stays text.
    expect(keepTokenHtml({ state: "set", text: "set <b>" }, s, tt)).toBe(
      "set &lt;b&gt;",
    );
  });

  it("set: says when; unknown when: names the store", () => {
    const set = keepTokenLine(
      { configured: true, old: false, set_at: "2026-11-16T10:00:00Z" },
      t,
    );
    expect(set.state).toBe("set");
    // The kit's date (issue 668): the year only when it isn't this year's.
    expect(set.text).toMatch(/^keep\.tokenSet \{"date":"Nov 16(, 2026)?"\}$/);
    expect(
      keepTokenLine({ configured: true, set_at: null, store: "Doppler" }, t),
    ).toEqual({ state: "set", text: 'keep.tokenStore {"store":"Doppler"}' });
  });
});

describe("Keep agents running after logout: the store's credential line", () => {
  const t = (k: string) => k;
  it("cred_keychain: the row warns", () => {
    expect(
      keepTokenLine(
        {
          configured: true,
          set_at: "2026-11-16T10:00:00Z",
          cred_keychain: true,
        },
        t,
      ),
    ).toEqual({ state: "cred", text: "keep.credKeychain" });
  });
});
