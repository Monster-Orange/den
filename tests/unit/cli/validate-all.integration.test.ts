/**
 * Bare `<cli> validate` in the distribution root validates every manifest
 * the distribution uses, never cloning: each workspace repo once per
 * checkout (own or held, plus override), a missing checkout falls back to
 * its held manifest, no manifest at all is a warning, and held manifests in
 * no workspace are checked too. `--held` reads only manifests/. A path
 * argument keeps its old behaviour.
 *
 * Real bin/den in a throwaway distribution.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const ENGINE = path.resolve(__dirname, "../../..");
let tmp = "";
let root = "";
let repos = "";

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function den(args: string[], cwd = root): { code: number; out: string } {
  const r = spawnSync(path.join(ENGINE, "bin", "den"), args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      DEN_ROOT: root,
      DEN_HOME: path.join(tmp, "home"),
      DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: `${r.stdout}${r.stderr}` };
}

const manifest = (name: string) =>
  `name: ${name}\nservices:\n  api:\n    commands:\n      local:\n        up: "true"\n`;
const held = (f: string, c: string) =>
  write(path.join(root, "manifests", f), c);

beforeAll(() => {
  tmp = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "den-validate-all-")),
  );
  root = path.join(tmp, "den");
  repos = path.join(tmp, "repos");
  write(path.join(root, "den.yml"), "product:\n  name: den\n");
  write(path.join(root, "config", "den.yml"), "environments: [local]\n");
  write(
    path.join(root, "config", "local", "service-catalog.yml"),
    ["shop", "site", "ghost"].map((r) => `${r}:\n  gh: acme/${r}\n`).join(""),
  );
  write(path.join(repos, "shop", ".den.yml"), manifest("shop"));
  const shop = { mode: "dev-managed", path: path.join(repos, "shop") };
  write(
    path.join(root, "config", "local", "workspaces.yml"),
    JSON.stringify({
      active: ["a"],
      focus: "a",
      workspaces: {
        a: {
          services: {
            shop,
            site: { mode: "managed", branch: "main" },
            ghost: { mode: "dev-managed", path: path.join(repos, "gone") },
          },
        },
        b: { services: { shop } },
      },
    }),
  );
  held("site.den.yml", manifest("site"));
  held("extra.den.yml", manifest("extra"));
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("bare validate in the distribution root", () => {
  it("checks every repo once per checkout, falls back to held, warns on none; never clones", () => {
    const r = den(["validate"]);
    expect(r.code).toBe(0);
    // shop: one line for both workspaces.
    expect(r.out.match(/✓\s+shop\s/g)?.length).toBe(1);
    expect(r.out).toMatch(/shop\s+own\s+.*repos\/shop\s+\[a, b\]/);
    expect(r.out).toMatch(/site\s+held\s+.*\(held only, no checkout\)/);
    expect(r.out).toMatch(/⚠\s+ghost\s+.*\(no checkout and no held manifest\)/);
    expect(r.out).toMatch(
      /extra\s+held\s+manifests\/\s+\(held, in no workspace\)/,
    );
    expect(r.out).toMatch(/4 repos: all valid, 1 with no manifest to check/);
    expect(fs.existsSync(path.join(root, ".den-services"))).toBe(false);
  });

  it("a bad override fails the run (exit 1), naming the layer", () => {
    held("shop.override.yml", "nonsense_key: 1\n");
    try {
      const r = den(["validate"]);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(/✗\s+shop\s+own \+ override/);
      expect(r.out).toMatch(/shop\.override\.yml/);
      expect(r.out).toMatch(/1 failed/);
    } finally {
      fs.rmSync(path.join(root, "manifests", "shop.override.yml"));
    }
  });

  it("--held reads only manifests/, whatever is checked out", () => {
    held(
      "shop.override.yml",
      'services:\n  api:\n    commands:\n      local:\n        up: "echo"\n',
    );
    try {
      const r = den(["validate", "--held"]);
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/extra\s+held/);
      expect(r.out).toMatch(/site\s+held/);
      expect(r.out).toMatch(/⚠\s+shop\s+override\s+.*override only/);
      expect(r.out).not.toMatch(/repos\/shop/);
      expect(r.out).not.toMatch(/ghost/);
    } finally {
      fs.rmSync(path.join(root, "manifests", "shop.override.yml"));
    }
  });

  it("a path argument keeps its old behaviour", () => {
    const r = den(["validate", path.join(repos, "shop")]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/\.den\.yml/);
    expect(r.out).not.toMatch(/extra/);
  });
});

describe("an org config that fails validation (0.3.0-dev.40)", () => {
  it("validate lists each problem with its key path and exits non-zero", () => {
    const file = path.join(root, "config", "den.yml");
    const before = fs.readFileSync(file, "utf-8");
    write(
      file,
      before +
        "orgs:\n  acme:\n    sources: not-a-list\n  globex:\n    repos: nope\n",
    );
    try {
      const r = den(["validate"]);
      expect(r.code).toBe(1);
      expect(r.out).toMatch(
        /✗\s+config\/den\.yml\s+orgs\.acme\.sources\s+must be a list/,
      );
      expect(r.out).toMatch(
        /✗\s+config\/den\.yml\s+orgs\.globex\.repos\s+must be a list of repo names/,
      );
      // The manifests are still checked.
      expect(r.out).toMatch(/✓\s+shop\s/);
      expect(r.out).not.toContain("❌");
    } finally {
      write(file, before);
    }
  });
});

describe("the caps (0.4.2)", () => {
  it("a wrong sessions.max_concurrent or agents.max_concurrent fails validate, naming the key", () => {
    const file = path.join(root, "config", "den.yml");
    const before = fs.readFileSync(file, "utf-8");
    write(
      file,
      before +
        "agents:\n  max_concurrent: 0\nsessions:\n  max_concurrent: lots\n",
    );
    try {
      const r = den(["validate"]);
      expect(r.code).toBe(1);
      // 0.4.29: with its file, and naming the key, never the value.
      expect(r.out).toMatch(
        /✗\s+config\/den\.yml: agents\.max_concurrent: must be a whole number of at least 1$/m,
      );
      expect(r.out).toMatch(
        /✗\s+config\/den\.yml: sessions\.max_concurrent: must be a whole number of at least 1$/m,
      );
      expect(r.out).not.toContain("lots");
      expect(r.out).toMatch(/✓\s+shop\s/);
    } finally {
      write(file, before);
    }
  });
});
