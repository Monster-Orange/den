/**
 * Local-secrets readiness gate.
 *
 * Regression context: a sidecar's generated `up.sh` only checks that secrets
 * are present and non-empty, so the stack placeholder (`replace-me`) starts the
 * stack for real and gets baked into database volumes at initdb time — an
 * unrecoverable state that still reports healthy, because liveness probes
 * don't authenticate.
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  checkRepoSecrets,
  describeSecretsCheck,
} from "../../../src/shared/environment-manager/secrets-check.js";

let repo: string;

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "den-secrets-"));
});

afterEach(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

function writeExample(content: string): void {
  fs.writeFileSync(path.join(repo, ".stack-secrets.example.yml"), content);
}

function writeSecrets(content: string): void {
  fs.writeFileSync(path.join(repo, ".stack-secrets.yml"), content);
}

describe("checkRepoSecrets", () => {
  it("returns null when the repo declares no secrets contract", () => {
    expect(checkRepoSecrets(repo)).toBeNull();
  });

  it("returns null for a repo path that does not exist", () => {
    expect(checkRepoSecrets(path.join(repo, "nope"))).toBeNull();
  });

  it("flags a missing secrets file and lists every declared key", () => {
    writeExample(
      "# Used by: localstack\nTOKEN: replace-me\nPASSWORD: replace-me\n",
    );

    const res = checkRepoSecrets(repo)!;
    expect(res.ok).toBe(false);
    expect(res.fileMissing).toBe(true);
    expect(res.missingKeys.sort()).toEqual(["PASSWORD", "TOKEN"]);
  });

  it("flags placeholder values that up.sh would happily accept", () => {
    writeExample("TOKEN: replace-me\nPASSWORD: replace-me\n");
    writeSecrets("TOKEN: replace-me\nPASSWORD: real-value\n");

    const res = checkRepoSecrets(repo)!;
    expect(res.ok).toBe(false);
    expect(res.placeholderKeys).toEqual(["TOKEN"]);
    expect(res.missingKeys).toEqual([]);
  });

  it("flags angle-bracket placeholders and empty values", () => {
    writeExample("A: replace-me\nB: replace-me\nC: replace-me\n");
    writeSecrets('A: "<your-token>"\nB: ""\nC: fine\n');

    const res = checkRepoSecrets(repo)!;
    expect(res.ok).toBe(false);
    expect(res.placeholderKeys.sort()).toEqual(["A", "B"]);
  });

  it("flags keys absent from the secrets file", () => {
    writeExample("A: replace-me\nB: replace-me\n");
    writeSecrets("A: real\n");

    const res = checkRepoSecrets(repo)!;
    expect(res.ok).toBe(false);
    expect(res.missingKeys).toEqual(["B"]);
  });

  it("passes when every declared key holds a real value", () => {
    writeExample(
      "# Used by: localstack, postgres\nA: replace-me\nB: replace-me\n",
    );
    writeSecrets("A: real\nB: also-real\n");

    expect(checkRepoSecrets(repo)!.ok).toBe(true);
  });

  it("tolerates comments and quoted values in the secrets file", () => {
    writeExample("A: replace-me\n");
    writeSecrets('# a comment\nA: "quoted-value"\n');

    expect(checkRepoSecrets(repo)!.ok).toBe(true);
  });

  it("returns null rather than inventing failures on an unparseable contract", () => {
    writeExample("just a scalar\n");
    expect(checkRepoSecrets(repo)).toBeNull();
  });
});

describe("describeSecretsCheck", () => {
  it("names the file path and the unset keys, never the values", () => {
    writeExample("TOKEN: replace-me\n");
    writeSecrets("TOKEN: super-secret-real-value\nOTHER: x\n");
    // Force a failure shape with a known value present.
    const res = checkRepoSecrets(repo)!;
    const forced = { ...res, ok: false, placeholderKeys: ["TOKEN"] };

    const text = describeSecretsCheck("infra-stack", forced).join("\n");
    expect(text).toContain("infra-stack");
    expect(text).toContain("TOKEN");
    expect(text).toContain(".stack-secrets.yml");
    expect(text).not.toContain("super-secret-real-value");
  });
});

// ── seedSecretsFromSibling ────────────────────────────────────────────────────

describe("seedSecretsFromSibling", () => {
  // The donor search resolves through den's own root + repos_root, so give
  // it a self-contained tree: <tmp>/den + <tmp>/repos/<repo>.
  let tree: string;
  let distRoot: string;
  let target: string;
  let sibling: string;
  let seedFn: typeof import("../../../src/shared/environment-manager/secrets-check.js").seedSecretsFromSibling;
  let checkFn: typeof import("../../../src/shared/environment-manager/secrets-check.js").checkRepoSecrets;

  const EXAMPLE =
    "# Used by: localstack\nTOKEN: replace-me\n# Used by: postgres\nPASSWORD: replace-me\n";

  beforeEach(async () => {
    jest.resetModules();
    tree = fs.mkdtempSync(path.join(os.tmpdir(), "den-seed-"));
    distRoot = path.join(tree, "den");
    target = path.join(distRoot, ".den-services", "demo", "main");
    sibling = path.join(tree, "repos", "demo");
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.mkdirSync(path.join(distRoot, "config"), { recursive: true });
    fs.writeFileSync(path.join(distRoot, "den.yml"), "product:\n  name: den\n");
    fs.writeFileSync(
      path.join(distRoot, "config", "den.yml"),
      "repos_root: ../repos\n",
    );
    fs.writeFileSync(path.join(target, ".stack-secrets.example.yml"), EXAMPLE);

    process.env.DEN_ROOT = distRoot;
    delete process.env.DEN_INVOKE_CWD;
    const mod =
      await import("../../../src/shared/environment-manager/secrets-check.js");
    seedFn = mod.seedSecretsFromSibling;
    checkFn = mod.checkRepoSecrets;
  });

  afterEach(() => {
    fs.rmSync(tree, { recursive: true, force: true });
    delete process.env.DEN_ROOT;
  });

  it("fills placeholders from the sibling checkout of the same repo", () => {
    fs.writeFileSync(path.join(target, ".stack-secrets.yml"), EXAMPLE);
    fs.writeFileSync(
      path.join(sibling, ".stack-secrets.yml"),
      "TOKEN: real-token\nPASSWORD: real-pw\n",
    );

    const res = seedFn("demo", target)!;
    expect(res.filled).toEqual(["PASSWORD", "TOKEN"]);
    expect(checkFn(target)!.ok).toBe(true);
  });

  it("preserves the generated comments and key order", () => {
    fs.writeFileSync(path.join(target, ".stack-secrets.yml"), EXAMPLE);
    fs.writeFileSync(
      path.join(sibling, ".stack-secrets.yml"),
      "TOKEN: real-token\nPASSWORD: real-pw\n",
    );

    seedFn("demo", target);
    const written = fs.readFileSync(
      path.join(target, ".stack-secrets.yml"),
      "utf-8",
    );
    expect(written).toContain("# Used by: localstack");
    expect(written.indexOf("TOKEN:")).toBeLessThan(
      written.indexOf("PASSWORD:"),
    );
  });

  it("never overwrites a value the target already has", () => {
    fs.writeFileSync(
      path.join(target, ".stack-secrets.yml"),
      "TOKEN: mine-already\nPASSWORD: replace-me\n",
    );
    fs.writeFileSync(
      path.join(sibling, ".stack-secrets.yml"),
      "TOKEN: donor-token\nPASSWORD: donor-pw\n",
    );

    const res = seedFn("demo", target)!;
    expect(res.filled).toEqual(["PASSWORD"]);
    const written = fs.readFileSync(
      path.join(target, ".stack-secrets.yml"),
      "utf-8",
    );
    expect(written).toContain("mine-already");
    expect(written).not.toContain("donor-token");
  });

  it("does not copy placeholder values from the donor", () => {
    fs.writeFileSync(path.join(target, ".stack-secrets.yml"), EXAMPLE);
    fs.writeFileSync(
      path.join(sibling, ".stack-secrets.yml"),
      "TOKEN: replace-me\nPASSWORD: real-pw\n",
    );

    const res = seedFn("demo", target)!;
    expect(res.filled).toEqual(["PASSWORD"]);
    expect(checkFn(target)!.placeholderKeys).toEqual(["TOKEN"]);
  });

  it("creates the secrets file from the example when it is absent", () => {
    fs.writeFileSync(
      path.join(sibling, ".stack-secrets.yml"),
      "TOKEN: real-token\nPASSWORD: real-pw\n",
    );

    expect(seedFn("demo", target)!.filled).toEqual(["PASSWORD", "TOKEN"]);
    expect(checkFn(target)!.ok).toBe(true);
  });

  it("returns null when no donor checkout has real values", () => {
    fs.writeFileSync(path.join(target, ".stack-secrets.yml"), EXAMPLE);
    expect(seedFn("demo", target)).toBeNull();
  });

  it("returns null when the repo declares no secrets contract", () => {
    fs.rmSync(path.join(target, ".stack-secrets.example.yml"));
    expect(seedFn("demo", target)).toBeNull();
  });

  it("never treats the target itself as its own donor", () => {
    // Target has real values already => nothing to fill, and no self-copy.
    fs.writeFileSync(
      path.join(target, ".stack-secrets.yml"),
      "TOKEN: a\nPASSWORD: b\n",
    );
    expect(seedFn("demo", target)).toBeNull();
  });
});

describe("seedSecretsFromSibling permissions", () => {
  it("tightens an already-existing secrets file to 0600", async () => {
    jest.resetModules();
    const tree = fs.mkdtempSync(path.join(os.tmpdir(), "den-seed-perm-"));
    const distRoot = path.join(tree, "den");
    const target = path.join(distRoot, ".den-services", "demo", "main");
    const sibling = path.join(tree, "repos", "demo");
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    fs.mkdirSync(path.join(distRoot, "config"), { recursive: true });
    fs.writeFileSync(path.join(distRoot, "den.yml"), "product:\n  name: den\n");
    fs.writeFileSync(
      path.join(distRoot, "config", "den.yml"),
      "repos_root: ../repos\n",
    );
    fs.writeFileSync(
      path.join(target, ".stack-secrets.example.yml"),
      "TOKEN: replace-me\n",
    );
    const secretsFile = path.join(target, ".stack-secrets.yml");
    fs.writeFileSync(secretsFile, "TOKEN: replace-me\n");
    fs.chmodSync(secretsFile, 0o644); // pre-existing, world-readable
    fs.writeFileSync(
      path.join(sibling, ".stack-secrets.yml"),
      "TOKEN: real-token\n",
    );

    process.env.DEN_ROOT = distRoot;
    const mod =
      await import("../../../src/shared/environment-manager/secrets-check.js");
    mod.seedSecretsFromSibling("demo", target);

    expect(fs.statSync(secretsFile).mode & 0o777).toBe(0o600);

    fs.rmSync(tree, { recursive: true, force: true });
    delete process.env.DEN_ROOT;
  });
});
