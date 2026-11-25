import { afterEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { repoSecretDenyRules } from "../../../src/shared/agents/den-claude.js";
import { cmdAgents } from "../../../src/ui/cli/agents-command.js";
import { denied, readDenied } from "./helpers/claude-rules.js";
import { cleanupRigs, rig, type Rig } from "./helpers/rig.js";

const HOME = "/home/someone";
const REPO = `${HOME}/src/shop-api`;
const DIST = `${HOME}/src/acme-dist`;

const editDenied = (rules: string[], file: string): boolean =>
  readDenied(
    rules
      .filter((r) => r.startsWith("Edit(/"))
      .map((r) => `Read(${r.slice("Edit(".length)}`),
    file,
  );

describe("issue 1507: the rules for a repo's secrets file and the cached sign-ins", () => {
  const rules = repoSecretDenyRules([REPO], [`${DIST}/playwright/.auth`], HOME);

  it.each([
    `${REPO}/.stack-secrets.yml`,
    `${REPO}/.stack-secrets.yml.4242.ab12.tmp`,
    `${DIST}/playwright/.auth/api-token-admin-dev.json`,
    `${DIST}/playwright/.auth/admin-dev.json`,
  ])("denies Read and Edit of %s", (f) => {
    expect([f, readDenied(rules, f)]).toEqual([f, true]);
    expect([f, editDenied(rules, f)]).toEqual([f, true]);
  });

  it.each([
    `cat ${REPO}/.stack-secrets.yml`,
    "cat ~/src/shop-api/.stack-secrets.yml",
    "cat $HOME/src/shop-api/.stack-secrets.yml",
    `head ${DIST}/playwright/.auth/admin-dev.json`,
    "cp ~/src/acme-dist/playwright/.auth/admin-dev.json /tmp/x",
  ])("denies %s", (cmd) => expect(denied(rules, cmd)).toBe(true));

  it.each([
    `${REPO}/.stack-secrets.example.yml`,
    `${REPO}/src/index.ts`,
    `${DIST}/playwright/tests/home.spec.ts`,
  ])("leaves %s readable", (f) => expect(readDenied(rules, f)).toBe(false));

  it("names no repo when there is none, and still the sign-ins folder", () => {
    const only = repoSecretDenyRules([], [`${DIST}/playwright/.auth`], HOME);
    expect(readDenied(only, `${DIST}/playwright/.auth/a.json`)).toBe(true);
    expect(only.some((r) => r.includes(".stack-secrets"))).toBe(false);
  });
});

afterEach(async () => {
  await cleanupRigs();
});

const deny = (r: Rig): string[] =>
  (
    JSON.parse(
      fs.readFileSync(
        path.join(r.stateDir, "agent-files", "planner", "settings.json"),
        "utf-8",
      ),
    ) as { permissions: { deny: string[] } }
  ).permissions.deny;

describe("issue 1507: an agent's start denies its projects' repo secrets files", () => {
  it("its own project's repos and a granted project's, and the distribution's cached sign-ins", async () => {
    const r = await rig();
    const own = path.join(r.dir, "repos", "shop-api");
    const granted = path.join(r.dir, "repos", "shop-web");
    const elsewhere = path.join(r.dir, "repos", "unrelated");
    r.deps.workspaceServices = (ws) =>
      ws === "north"
        ? [{ address: "api", path: own }]
        : ws === "south"
          ? [{ address: "web", path: granted }]
          : [];
    r.config.agents = { planner: { grants: ["south"] } };
    expect(
      await cmdAgents(["start", "-w", "north", "--persona", "planner"], r.deps),
    ).toBe(0);
    const d = deny(r);
    for (const f of [
      path.join(own, ".stack-secrets.yml"),
      path.join(granted, ".stack-secrets.yml"),
      path.join(r.dir, "playwright", ".auth", "admin-dev.json"),
    ]) {
      expect([f, readDenied(d, f)]).toEqual([f, true]);
      expect([f, editDenied(d, f)]).toEqual([f, true]);
    }
    expect(denied(d, `cat ${path.join(own, ".stack-secrets.yml")}`)).toBe(true);
    expect(readDenied(d, path.join(own, ".stack-secrets.example.yml"))).toBe(
      false,
    );
    expect(readDenied(d, path.join(own, "README.md"))).toBe(false);
    expect(readDenied(d, path.join(elsewhere, ".stack-secrets.yml"))).toBe(
      false,
    );
  });
});
