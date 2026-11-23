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
  credentialDirRules,
  stateDirDenyRules,
} from "../../../src/shared/agents/den-claude.js";
import { denied, readDenied } from "./helpers/claude-rules.js";

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

describe("issue 810: the fixture person's key is denied as web.secret is", () => {
  const rules = stateDirDenyRules(STATE, HOME);
  it.each([
    `cat ${STATE}/fixture-person.key`,
    `cp ${STATE}/fixture-person.key /tmp/x`,
    `echo x > ${STATE}/fixture-person.key`,
    `chmod 600 ${STATE}/fixture-person.key`,
    "cat ~/.acme/fixture-person.key",
  ])("denies %s", (cmd) => expect(denied(rules, cmd)).toBe(true));
  it("Read and Edit on its path", () => {
    expect(rules).toContain(`Read(/${STATE}/fixture-person.key)`);
    expect(rules).toContain(`Edit(/${STATE}/fixture-person.key)`);
  });
});

describe("Sign-in: the deny rules for the person-only sign-in commands", () => {
  const rules = stateDirDenyRules(STATE, HOME);
  it.each([
    "den web login",
    "den web login --no-wait",
    "./bin/den web login --origin http://x:4100",
    "/usr/local/bin/acme web login",
    "cd /tmp && den web login",
    "den web claim-link",
    "den web token --print",
    'curl -H "Authorization: Bearer $(den web token --print)" http://localhost:4100/api/x',
  ])("denies %s", (cmd) => expect(denied(rules, cmd)).toBe(true));
  it.each(["den web up", "den web sessions", "den web logout --all"])(
    "leaves %s alone",
    (cmd) => expect(denied(rules, cmd)).toBe(false),
  );
});

describe("issue 728: every credential file in the state dir is denied as web.secret is", () => {
  const rules = stateDirDenyRules(STATE, HOME);
  // Each holds a secret: another agent's raw token, Hub's token and the
  // ones kept for a retried revoke, the push key and subscriptions, the
  // browser sessions, the test-install seal, and the token and key hashes.
  const files = [
    "actor-token/planner/token",
    "actor-tokens.json",
    "hub/token",
    "hub/unrevoked/1.token",
    "push-vapid.json",
    "push-subscriptions.json",
    "web-sessions.json",
    "test-install.created",
    "embed/server-keys.json",
    "gate/runner-tokens.json",
  ];
  it.each(
    files.flatMap((f) => [`cat ${STATE}/${f}`, `cp ~/.acme/${f} /tmp/x`]),
  )("denies %s", (cmd) => expect(denied(rules, cmd)).toBe(true));
  it.each(files)("a Read rule covers %s", (f) =>
    expect([f, readDenied(rules, `${STATE}/${f}`)]).toEqual([f, true]),
  );
  // Issue 1299: a damaged sessions file moved aside, and a write's
  // temporary copy, hold the same records.
  it.each(["web-sessions.json.bad-1795413600000", "actor-tokens.json.tmp-123"])(
    "a Read rule covers the copy %s",
    (f) => expect([f, readDenied(rules, `${STATE}/${f}`)]).toEqual([f, true]),
  );
  // Issue 1299 review: an agent that wrote a live pid in the sessions
  // lock would hold every sign-in for its wait, then refuse it.
  it("web-sessions.lock: no Read, Edit, Write or shell", () => {
    const lock = `${STATE}/web-sessions.lock`;
    expect(readDenied(rules, lock)).toBe(true);
    expect(rules).toContain(`Edit(/${lock})`);
    expect(rules).toContain(`Write(/${lock})`);
    for (const cmd of [
      `echo 1 > ${lock}`,
      `cat ${lock}`,
      `rm ${lock}`,
      `touch ~/.acme/web-sessions.lock`,
    ])
      expect([cmd, denied(rules, cmd)]).toEqual([cmd, true]);
  });
});

describe("issue 728: what an agent needs to run stays allowed", () => {
  const rules = stateDirDenyRules(STATE, HOME);
  // Its token reaches its MCP server and the CLI through
  // DEN_ACTOR_TOKEN_FILE (child processes, which these rules don't bind);
  // its MCP config and settings are in agent-files/<id>, with no secret.
  it.each([
    `cat ${STATE}/agent-files/planner/mcp.json`,
    `cat ${STATE}/agent-files/planner/settings.json`,
    "den mcp headers hub",
    "den gate run --kind cpu -- npx jest x",
    "den agents list",
    'test -n "$DEN_ACTOR_TOKEN_FILE"',
    `ls ${STATE}`,
    `tail -n 50 ${STATE}/logs/server.log`,
  ])("leaves %s alone", (cmd) => expect(denied(rules, cmd)).toBe(false));
  it("no Read rule covers agent-files", () => {
    expect(rules.filter((r) => r.includes("agent-files"))).toEqual([]);
  });
});

describe("issue 728: the edge's key folders, from the resolved edge config", () => {
  const EDGE = `${HOME}/.local/share/acme/edge`;
  const rules = credentialDirRules([`${EDGE}/ca`, `${EDGE}/certs`], HOME);
  it.each([
    `cat ${EDGE}/ca/rootCA-key.pem`,
    `cp ${EDGE}/certs/edge-key.pem /tmp/x`,
    "cat ~/.local/share/acme/edge/ca/rootCA-key.pem",
    "base64 < $HOME/.local/share/acme/edge/certs/edge-key.pem",
  ])("denies %s", (cmd) => expect(denied(rules, cmd)).toBe(true));
  it.each(["ca/rootCA-key.pem", "certs/edge-key.pem"])(
    "a Read rule covers %s",
    (f) => expect(readDenied(rules, `${EDGE}/${f}`)).toBe(true),
  );
  it("the fallback for a broken edge config: any org's key folders", () => {
    const any = credentialDirRules(
      [`${HOME}/.local/share/*/edge/ca`, `${HOME}/.local/share/*/edge/certs`],
      HOME,
    );
    expect(denied(any, `cat ${EDGE}/ca/rootCA-key.pem`)).toBe(true);
    expect(denied(any, "cat ~/.local/share/acme/edge/certs/edge-key.pem")).toBe(
      true,
    );
    expect(readDenied(any, `${EDGE}/ca/rootCA-key.pem`)).toBe(true);
    expect(readDenied(any, `${HOME}/.local/share/acme/notes.txt`)).toBe(false);
  });
  it("none for no folders", () =>
    expect(credentialDirRules([], HOME)).toEqual([]));
});
