/**
 * den-claude's deny rules (SEC-1 §6c.1) against Claude Code's documented
 * Bash rule syntax, modelled here (the real `claude` never runs):
 *
 *   - `Bash(<pattern>)` with `*` matches any run of characters, at any
 *     position, against the whole command; a compound command (`&&`,
 *     `||`, `;`, `|`) is checked part by part, and any part denied denies it;
 *   - the legacy `Bash(<prefix>:*)` matches commands that start with
 *     `<prefix>` followed by a space and arguments.
 *
 * The 0.4.1-dev.4 rules were the legacy form only; on Claude Code 2.1.x
 * a bare `cat <state>/web.secret` came back "needs approval", not denied.
 */
import { describe, expect, it } from "@jest/globals";
import {
  BASH_READERS,
  stateDirDenyRules,
} from "../../../src/shared/agents/den-claude.js";

/** Whether one Bash rule matches one simple command (documented semantics). */
function ruleMatches(rule: string, cmd: string): boolean {
  const m = /^Bash\((.*)\)$/s.exec(rule);
  if (!m) return false;
  const body = m[1];
  if (body.endsWith(":*")) {
    // Legacy prefix: the prefix, then a space and something after it.
    const prefix = body.slice(0, -2);
    return cmd.startsWith(prefix + " ");
  }
  const re = new RegExp(
    "^" +
      body
        .split("*")
        .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join("[\\s\\S]*") +
      "$",
  );
  return re.test(cmd);
}
function denied(rules: string[], command: string): boolean {
  return command
    .split(/&&|\|\||;|\|/)
    .map((c) => c.trim())
    .filter(Boolean)
    .some((c) => rules.some((r) => ruleMatches(r, c)));
}

const HOME = "/home/someone";
const STATE = `${HOME}/.acme`;

describe("the Bash deny rules", () => {
  const rules = stateDirDenyRules(STATE, HOME);

  it.each([
    `cat ${STATE}/web.secret`,
    `cat "${STATE}/web.secret"`,
    `cat '${STATE}/web.secret'`,
    `head -c 64 ${STATE}/web.secret`,
    `base64 < ${STATE}/web.secret`,
    `cp ${STATE}/web.secret /tmp/x`,
    `cd /tmp && cat ${STATE}/web.secret`,
    "cat ~/.acme/web.secret",
    "cat $HOME/.acme/web.secret",
    "cat ${HOME}/.acme/web.secret",
    `cat ${STATE}/sessions/abc.json`,
    `ls ${STATE}/sessions/`,
    "tail ~/.acme/sessions/abc.log",
  ])("denies %s", (cmd) => expect(denied(rules, cmd)).toBe(true));

  it("the dev.4 rules alone did not deny a bare `cat <state>/web.secret` (the finding)", () => {
    const legacy = rules.filter((r) => r.endsWith(":*)"));
    expect(legacy).toHaveLength(2);
    expect(denied(legacy, `cat ${STATE}/web.secret`)).toBe(false);
  });

  it.each([
    "cat README.md",
    `ls ${STATE}`,
    `cat ${STATE}/config.yml`,
    "npm test",
  ])("leaves %s alone", (cmd) => expect(denied(rules, cmd)).toBe(false));

  it("a state dir with a space: quoted and backslash-escaped spellings are denied", () => {
    const st = "/Users/some one/Library/Application Support/acme";
    const r = stateDirDenyRules(st, "/Users/some one");
    for (const cmd of [
      `cat "${st}/web.secret"`,
      `cat ${st.replace(/ /g, "\\ ")}/web.secret`,
      'cat ~/Library/"Application Support"/acme/web.secret'.replace(
        /"Application Support"/,
        "Application\\ Support",
      ),
    ])
      expect([cmd, denied(r, cmd)]).toEqual([cmd, true]);
  });

  it("names the common readers too, each denied by a rule of its own (not only the leading wildcard)", () => {
    expect([...BASH_READERS]).toEqual([
      "cat",
      "head",
      "tail",
      "less",
      "more",
      "xxd",
      "od",
      "strings",
      "base64",
      "cp",
    ]);
    const named = rules.filter(
      (r) => !r.startsWith("Bash(*") && !r.endsWith(":*)"),
    );
    for (const r of BASH_READERS)
      for (const cmd of [
        `${r} ${STATE}/web.secret`,
        `${r} -n 1 ~/.acme/sessions/x.json`,
      ])
        expect([cmd, denied(named, cmd)]).toEqual([cmd, true]);
  });

  it("keeps the Read rules (absolute, `//` paths)", () => {
    expect(rules.slice(0, 2)).toEqual([
      `Read(/${STATE}/web.secret)`,
      `Read(/${STATE}/sessions/**)`,
    ]);
  });

  it("every Bash rule is one of the two documented shapes, with no unbalanced parenthesis", () => {
    for (const r of rules.filter((x) => x.startsWith("Bash(")))
      expect([r, /^Bash\([^()]+\)$/.test(r)]).toEqual([r, true]);
  });
});
