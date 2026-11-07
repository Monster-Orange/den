/**
 * `den create`: the scaffolder, and examples/distribution as its output.
 *
 * examples/distribution/ must be exactly `den create acme` at this Den's
 * version, so the example and the scaffolder cannot drift. Regenerate it
 * with `npm run example:regen`.
 */
import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { parse as parseYaml } from "yaml";
import {
  parseCreateArgs,
  renderDistribution,
  runCreate,
  runningDenVersion,
  titleFromName,
  writeDistribution,
} from "../../src/ui/cli/create.js";
import { readProfileFile } from "../../src/shared/profile.js";

const EXAMPLE = path.resolve("examples/distribution");

function listFiles(root: string, rel = ""): string[] {
  return fs
    .readdirSync(path.join(root, rel), { withFileTypes: true })
    .flatMap((e) => {
      const p = rel ? `${rel}/${e.name}` : e.name;
      return e.isDirectory() ? listFiles(root, p) : [p];
    })
    .sort();
}

describe("examples/distribution is `den create acme`", () => {
  const files = renderDistribution({
    name: "acme",
    denVersion: runningDenVersion(path.resolve(".")),
  });

  it("has exactly the scaffolded files", () => {
    expect(listFiles(EXAMPLE)).toEqual(Object.keys(files).sort());
  });

  it.each(Object.keys(files))("%s matches", (rel) => {
    expect(fs.readFileSync(path.join(EXAMPLE, rel), "utf-8")).toBe(files[rel]);
  });

  it("bin/acme is executable", () => {
    expect(fs.statSync(path.join(EXAMPLE, "bin/acme")).mode & 0o111).not.toBe(
      0,
    );
  });
});

describe("renderDistribution", () => {
  it("pins the exact Den version and names everything after the product", () => {
    const files = renderDistribution({ name: "acme", denVersion: "1.2.3" });
    const pkg = JSON.parse(files["package.json"]) as {
      private: boolean;
      bin: Record<string, string>;
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["@monster-orange/den"]).toBe("1.2.3");
    expect(pkg.private).toBe(true);
    expect(pkg.bin).toEqual({ acme: "./bin/acme" });
    expect(files["Makefile"]).toContain(
      "include node_modules/@monster-orange/den/make/den.mk",
    );
    expect(files["bin/acme"]).toContain(
      'exec "$DEN_ROOT/node_modules/@monster-orange/den/bin/den" "$@"',
    );
    const cfg = parseYaml(files["config/acme.yml"]) as {
      brand: { name: string; banner: string[] };
      secrets: { provider: string };
      edge: { org: string; domain: string };
      github_org: string;
    };
    expect(cfg.brand.name).toBe("Acme");
    expect(cfg.brand.banner.join("\n")).toContain("A C M E");
    expect(cfg.secrets.provider).toBe("none");
    expect(cfg.edge).toEqual({
      org: "acme",
      domain: "acme.localhost",
      tls: "none",
    });
    // No placeholder org: github_org is left for the distribution to set.
    expect(cfg.github_org).toBeUndefined();
    expect(files["config/acme.yml"]).toContain("# github_org: example-org");
    expect(files["config/acme.yml"]).toMatch(
      /# +tls: \{ strategy: mkcert \}.*\n.*# +tls: \{ strategy: mkcert, ca: .*\n.*# +tls: \{ strategy: files, include: edge\/dynamic/,
    );
    expect(files["config/environments/local.json"]).toContain(
      '"name": "local"',
    );
  });

  it("den.yml is a valid profile that derives everything from the name", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-create-profile-"));
    try {
      const file = path.join(dir, "den.yml");
      fs.writeFileSync(
        file,
        renderDistribution({ name: "shop-dev", denVersion: "1.0.0" })[
          "den.yml"
        ],
      );
      const p = readProfileFile(file);
      expect(p).toMatchObject({
        name: "shop-dev",
        cli: "shop-dev",
        envPrefix: "SHOP_DEV",
        configFile: "config/shop-dev.yml",
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--cli, --env-prefix and --title set the profile and brand", () => {
    const files = renderDistribution({
      name: "acme",
      cli: "ac",
      envPrefix: "AC",
      title: "Acme Web",
      denVersion: "1.0.0",
    });
    expect(Object.keys(files)).toContain("bin/ac");
    expect(files["den.yml"]).toMatch(/^ {2}cli: ac$/m);
    expect(files["den.yml"]).toMatch(/^ {2}env_prefix: AC$/m);
    expect(files["config/acme.yml"]).toMatch(/^ {2}name: Acme Web$/m);
    expect(JSON.parse(files["package.json"]).bin).toEqual({ ac: "./bin/ac" });
  });

  it.each(["Acme", "1acme", "acme_web", "", "-acme"])(
    "refuses the name %p",
    (name) => {
      expect(() => renderDistribution({ name, denVersion: "1.0.0" })).toThrow();
    },
  );

  it("refuses a bad --cli or --env-prefix", () => {
    expect(() =>
      renderDistribution({ name: "acme", cli: "Acme", denVersion: "1" }),
    ).toThrow(/--cli/);
    expect(() =>
      renderDistribution({ name: "acme", envPrefix: "acme", denVersion: "1" }),
    ).toThrow(/env_prefix/);
  });

  it("titleFromName", () => {
    expect(titleFromName("acme")).toBe("Acme");
    expect(titleFromName("shop-web")).toBe("Shop Web");
  });
});

describe("writeDistribution", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-create-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("writes into a new directory, bin executable", () => {
    const dir = path.join(tmp, "acme");
    const written = writeDistribution(dir, {
      name: "acme",
      denVersion: "1.0.0",
    });
    expect(written).toContain("den.yml");
    expect(fs.statSync(path.join(dir, "bin/acme")).mode & 0o111).not.toBe(0);
    expect(fs.existsSync(path.join(dir, "manifests"))).toBe(true);
    expect(fs.existsSync(path.join(dir, "tests/pillars"))).toBe(true);
  });

  it("accepts an existing empty directory", () => {
    expect(() =>
      writeDistribution(tmp, { name: "acme", denVersion: "1.0.0" }),
    ).not.toThrow();
  });

  it("refuses a non-empty directory and leaves it untouched", () => {
    fs.writeFileSync(path.join(tmp, "den.yml"), "mine\n");
    expect(() =>
      writeDistribution(tmp, { name: "acme", denVersion: "1.0.0" }),
    ).toThrow(/not empty/);
    expect(fs.readFileSync(path.join(tmp, "den.yml"), "utf-8")).toBe("mine\n");
    expect(fs.readdirSync(tmp)).toEqual(["den.yml"]);
  });
});

describe("parseCreateArgs", () => {
  it("defaults the dir to ./<name> under the caller's cwd", () => {
    expect(parseCreateArgs(["acme"], "/work")).toMatchObject({
      name: "acme",
      dir: path.resolve("/work/acme"),
    });
  });

  it("takes a dir and the flags in both forms", () => {
    expect(
      parseCreateArgs(
        [
          "acme",
          "out",
          "--title",
          "Acme Web",
          "--cli=ac",
          "--env-prefix",
          "AC",
        ],
        "/work",
      ),
    ).toEqual({
      name: "acme",
      dir: path.resolve("/work/out"),
      title: "Acme Web",
      cli: "ac",
      envPrefix: "AC",
      yes: false,
      json: false,
    });
  });

  it("refuses unknown flags, a missing value, and no name", () => {
    expect(() => parseCreateArgs(["acme", "--force"], "/w")).toThrow(
      /unknown flag/,
    );
    expect(() => parseCreateArgs(["acme", "--cli"], "/w")).toThrow(
      /needs a value/,
    );
    expect(() => parseCreateArgs([], "/w")).toThrow(/usage/);
  });
});

describe("runCreate's Next: hint", () => {
  let tmp = "";
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-create-next-"));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function cdLine(argv: string[], cwd: string): Promise<string> {
    const lines: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void lines.push(a.join(" "));
    try {
      // A start port of its own, and no probing: never the real default.
      expect(
        await runCreate(argv, cwd, {
          startPort: 41000,
          inUse: async () => false,
        }),
      ).toBe(0);
    } finally {
      console.log = log;
    }
    return lines.find((l) => l.startsWith("  cd ")) ?? "";
  }

  it("is relative under the cwd, absolute when the dir is elsewhere", async () => {
    const here = path.join(tmp, "here");
    fs.mkdirSync(here);
    expect(await cdLine(["demo"], here)).toBe("  cd demo");
    const elsewhere = path.join(tmp, "elsewhere", "demo2");
    expect(await cdLine(["demo2", elsewhere], here)).toBe(`  cd ${elsewhere}`);
  });
});
