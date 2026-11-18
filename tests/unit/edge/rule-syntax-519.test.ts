/**
 * Issue 519: Traefik v3 reads some v2 rule syntax differently, and those
 * routes stop matching after the upgrade. v2RuleSyntaxIn finds them; the
 * edge readers gather rules from files only (never docker).
 */
import { afterAll, describe, expect, it, jest } from "@jest/globals";

jest.mock("child_process");

import * as child from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  edgeImageHint,
  edgeRules,
  hasV2CompatArg,
  labelRules,
  V2_COMPAT_ARG,
  v2RuleSyntaxIn,
  type RuleAt,
} from "../../../src/shared/edge/rule-syntax.js";
import { RULE_SYNTAX_WORDS } from "../../../src/shared/edge/rule-syntax-words.js";
import type { EdgeConfig } from "../../../src/shared/edge/types.js";
import type { StackConfig } from "../../../src/shared/stacks/types.js";

const made: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "rule-syntax-"));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

const at = (rule: string, ruleSyntax?: string): RuleAt => ({
  where: "x",
  rule,
  ...(ruleSyntax ? { ruleSyntax } : {}),
});
const whys = (rule: string, ruleSyntax?: string) =>
  v2RuleSyntaxIn([at(rule, ruleSyntax)]).flatMap((r) => r.why);

describe("v2RuleSyntaxIn", () => {
  it.each([
    ["HostRegexp(`{sub:[a-z]+}.example.com`)", "namedGroup"],
    ["HostRegexp(`{sub:(a|b)}.example.com`) && PathPrefix(`/`)", "namedGroup"],
    ["Path(`/user/{id:[0-9]+}`)", "namedGroup"],
    ["PathPrefix(`/{tenant}`)", "namedGroup"],
    ["Host(`a.example.com`, `b.example.com`)", "multiArg"],
    ["Method(`GET`, `POST`)", "multiArg"],
    ["Headers(`X-Env`, `dev`)", "headers"],
    ["HeadersRegexp(`X-Env`, `^d`)", "headers"],
    ["HostHeader(`a.example.com`)", "hostHeader"],
    ["Query(`mobile=true`)", "queryEquals"],
  ])("%s is v2-only (%s)", (rule, why) => {
    expect(whys(rule)).toContain(why);
  });

  it.each([
    "Host(`a.example.com`)",
    "Host(`a.example.com`) || Host(`b.example.com`)",
    "HostRegexp(`^[a-z]+\\.example\\.com$`)",
    "HostRegexp(`^[a-z]{2,8}\\.example\\.com$`)",
    "PathRegexp(`^/user/[0-9]+$`)",
    "Header(`X-Env`, `dev`)",
    "Query(`mobile`, `true`)",
    "PathPrefix(`/`)",
    "",
  ])("%s works on v3", (rule) => {
    expect(v2RuleSyntaxIn([at(rule)])).toEqual([]);
  });

  it("a router that sets ruleSyntax: v2 keeps working on v3", () => {
    expect(whys("HostRegexp(`{sub:[a-z]+}.example.com`)", "v2")).toEqual([]);
  });

  it("keeps where and the rule", () => {
    expect(
      v2RuleSyntaxIn([
        { where: "a.yml router r", rule: "HostHeader(`x`)" },
        { where: "b", rule: "Host(`y`)" },
      ]),
    ).toEqual([
      { where: "a.yml router r", rule: "HostHeader(`x`)", why: ["hostHeader"] },
    ]);
  });
});

describe("labelRules: router rules in a compose file's labels", () => {
  it("map and list labels, http and tcp, with ruleSyntax", () => {
    const doc = {
      services: {
        api: {
          labels: {
            "traefik.http.routers.api.rule": "Host(`api.x`)",
            "traefik.http.routers.api.rulesyntax": "v2",
            "traefik.enable": "true",
          },
        },
        db: {
          labels: ["traefik.tcp.routers.db.rule=HostSNI(`db.x`)", "other=1"],
        },
      },
    };
    expect(labelRules(doc, "app/docker-compose.yml")).toEqual([
      {
        where: "app/docker-compose.yml service api label traefik.http.routers.api.rule",
        rule: "Host(`api.x`)",
        ruleSyntax: "v2",
      },
      {
        where: "app/docker-compose.yml service db label traefik.tcp.routers.db.rule",
        rule: "HostSNI(`db.x`)",
      },
    ]);
  });
});

describe("edgeRules: Den's routes, included files, stack route files, labels", () => {
  it("reads files only, never docker", () => {
    const root = tmp();
    const inc = path.join(root, "inc");
    const state = path.join(root, "state");
    fs.mkdirSync(inc);
    fs.mkdirSync(path.join(state, "dynamic"), { recursive: true });
    fs.writeFileSync(
      path.join(inc, "a.yml"),
      "http:\n  routers:\n    one:\n      rule: \"HostHeader(`a`)\"\n",
    );
    fs.writeFileSync(
      path.join(state, "dynamic", "stack-p.yml"),
      "http:\n  routers:\n    two:\n      rule: \"Host(`b`)\"\n",
    );
    const repo = path.join(root, "repo");
    fs.mkdirSync(repo);
    fs.writeFileSync(
      path.join(repo, "compose.yml"),
      'services:\n  w:\n    labels: ["traefik.http.routers.w.rule=Host(`c`, `d`)"]\n',
    );
    const cfg = {
      domain: "acme.localhost",
      aliases: [],
      routes: { web: "http://127.0.0.1:1" },
      include: inc,
      stateDir: state,
      args: [],
    } as unknown as EdgeConfig;
    const stacks = [
      { name: "p", repo: "repo", repoPath: repo, files: ["compose.yml"] },
    ] as unknown as StackConfig[];
    const rules = edgeRules(cfg, { stacks: () => stacks });
    expect(rules.map((r) => r.where)).toEqual([
      "edge route web",
      "a.yml router one",
      "stack-p.yml router two",
      "repo/compose.yml service w label traefik.http.routers.w.rule",
    ]);
    expect(v2RuleSyntaxIn(rules).map((r) => r.where)).toEqual([
      "a.yml router one",
      "repo/compose.yml service w label traefik.http.routers.w.rule",
    ]);
    const calls = [child.spawnSync, child.execSync, child.execFileSync, child.spawn]
      .map((f) => (f as unknown as jest.Mock).mock.calls.length);
    expect(calls).toEqual([0, 0, 0, 0]);
  });

  it("a file it can't read is skipped, not fatal", () => {
    const cfg = {
      domain: "acme.localhost",
      routes: {},
      include: "/nonexistent-519",
      stateDir: "/nonexistent-519",
      args: [],
    } as unknown as EdgeConfig;
    const stacks = [
      { name: "p", repo: "r", repoPath: "/nonexistent-519", files: ["c.yml"] },
    ] as unknown as StackConfig[];
    expect(() => edgeRules(cfg, { stacks: () => stacks })).not.toThrow();
  });
});

describe("edgeImageHint", () => {
  const v2 = v2RuleSyntaxIn([
    { where: "a.yml router one", rule: "HostRegexp(`{s:[a-z]+}.x`)" },
  ]);
  it("v3 already: the OK line, whatever the rules", () => {
    const h = edgeImageHint({ image: "traefik:v3.7.17", args: [] }, v2, "en");
    expect(h.status).toBe("ok");
  });
  it("v2 with v2 rules: the head, each rule, both ways", () => {
    const h = edgeImageHint({ image: "traefik:v2.11", args: [] }, v2, "en");
    expect(h.status).toBe("warn");
    expect(h.lines[0]).toContain("1 route rule");
    expect(h.lines.join("\n")).toContain("a.yml router one");
    expect(h.lines.join("\n")).toContain(V2_COMPAT_ARG);
  });
  it("the compat arg already in edge.args: v3 is safe, say so", () => {
    const h = edgeImageHint(
      { image: "traefik:v2.11", args: [V2_COMPAT_ARG] },
      v2,
      "en",
    );
    expect(h.lines.join("\n")).toContain("keep working");
    expect(hasV2CompatArg([V2_COMPAT_ARG])).toBe(true);
    expect(hasV2CompatArg(["--core.defaultRuleSyntax", "v2"])).toBe(true);
    expect(hasV2CompatArg([])).toBe(false);
  });
  it("es and ja", () => {
    for (const lang of ["es", "ja"] as const) {
      const h = edgeImageHint({ image: "traefik:v2.11", args: [] }, v2, lang);
      expect(h.lines.join("\n")).toContain(V2_COMPAT_ARG);
      expect(h.lines[0]).not.toBe(
        edgeImageHint({ image: "traefik:v2.11", args: [] }, v2, "en").lines[0],
      );
    }
  });
});

describe("the words, in every language the UI ships", () => {
  const ph = (s: string) =>
    [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  it("es and ja have every en line, with the same placeholders", () => {
    const en = RULE_SYNTAX_WORDS.en;
    for (const lang of ["es", "ja"] as const) {
      const tr = RULE_SYNTAX_WORDS[lang];
      expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
      for (const k of Object.keys(en) as (keyof typeof en)[])
        expect([lang, k, ph(tr[k])]).toEqual([lang, k, ph(en[k])]);
    }
  });
});
