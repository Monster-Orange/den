/**
 * den.theme/v1: the schema, the contrast rules, and the file checks that
 * `<cli> theme validate` and `theme add` run.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  CONTRAST_RULES,
  contrastRatio,
  validateThemeDir,
  type ThemeManifest,
} from "../../../src/shared/theme/contract.js";

const light = {
  bg: "#f6f8fa",
  surface: "#ffffff",
  raised: "#ffffff",
  sunken: "#eef1f4",
  text: "#1f2328",
  muted: "#59636e",
  faint: "#656e7b",
  border: "#d1d9e0",
  "border-strong": "#7c8c9e",
  accent: "#0969da",
  "accent-text": "#0969da",
  "accent-fill": "#0969da",
  "on-accent": "#ffffff",
  ok: "#1a7d36",
  warn: "#946300",
  bad: "#cf222e",
  remote: "#0d7882",
};
const dark = {
  bg: "#0d1117",
  surface: "#161b22",
  raised: "#1c2330",
  sunken: "#0b0f14",
  text: "#e6edf3",
  muted: "#9198a1",
  faint: "#838a95",
  border: "#30363d",
  "border-strong": "#646d7a",
  accent: "#4493f8",
  "accent-text": "#58a6ff",
  "accent-fill": "#1f6feb",
  "on-accent": "#ffffff",
  ok: "#3fb950",
  warn: "#d29922",
  bad: "#f85149",
  remote: "#39c5cf",
};

const base = (): ThemeManifest => ({
  schema: "den.theme/v1",
  id: "sample",
  name: "Sample",
  version: "1.0.0",
  license: "MIT",
  mark: { svg: "mark.svg", shape: "rounded" },
  modes: { light: { ...light }, dark: { ...dark } },
});

let tmp: string;
let n = 0;
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-theme-"));
  // This checkout's schema (jest's entry point can resolve another one).
  process.env.DEN_ENGINE_ROOT = path.resolve(__dirname, "../../..");
});
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Write a theme dir; `files` are extra files (default: a clean mark.svg). */
function theme(
  m: unknown,
  files: Record<string, string> = {
    "mark.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>',
  },
): string {
  const dir = path.join(tmp, `t${n++}`);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "den-theme.json"), JSON.stringify(m));
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), c);
  }
  return dir;
}

describe("contrastRatio", () => {
  it("matches WCAG's reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    // WCAG's own example: #777777 on white is 4.48.
    expect(contrastRatio("#777777", "#ffffff")).toBeCloseTo(4.48, 2);
  });
});

describe("validateThemeDir", () => {
  it("passes a complete theme", () => {
    const r = validateThemeDir(theme(base()), { expectId: "sample" });
    expect(r.issues).toEqual([]);
    expect(r.contrast).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it("names each failing pair with its mode and ratio", () => {
    const m = base();
    m.modes.light.muted = "#9a9a9a"; // ~2.8 on white
    const r = validateThemeDir(theme(m));
    expect(r.ok).toBe(false);
    expect(r.contrast).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mode: "light",
          fg: "muted",
          bg: "surface",
          min: 4.5,
        }),
      ]),
    );
    expect(r.contrast.every((c) => c.ratio < c.min)).toBe(true);
  });

  it("requires both modes", () => {
    const m = base() as unknown as { modes: Record<string, unknown> };
    delete m.modes.light;
    const r = validateThemeDir(theme(m));
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.message).join()).toMatch(/light/);
  });

  it("takes colors as #rrggbb only", () => {
    const m = base();
    m.modes.dark.text = "hsl(0 0% 100%)";
    expect(validateThemeDir(theme(m)).issues[0]).toMatchObject({
      at: "/modes/dark/text",
    });
  });

  it("refuses CSS that could escape its custom property", () => {
    for (const shadow of [
      "0 0 1px red; } body { display: none",
      "url(https://tracker.example/x.png)",
      "</style><script>",
    ]) {
      const m = base();
      m.modes.dark.shadow = shadow;
      const r = validateThemeDir(theme(m));
      expect(r.ok).toBe(false);
      expect(r.issues.map((i) => i.message).join()).not.toMatch(
        /must NOT be valid/,
      );
    }
  });

  it("refuses files outside the theme, and only takes woff2 and svg", () => {
    for (const mark of ["../mark.svg", "/etc/mark.svg", "mark.png"]) {
      const m = base();
      m.mark = { svg: mark };
      expect(validateThemeDir(theme(m)).ok).toBe(false);
    }
    const m = base();
    m.fonts = [
      { family: "X", license: "OFL-1.1", files: [{ path: "fonts/x.ttf" }] },
    ];
    expect(validateThemeDir(theme(m)).ok).toBe(false);
  });

  it("reports a referenced file that is missing", () => {
    const m = base();
    m.fonts = [
      {
        family: "Sample Sans",
        license: "OFL-1.1",
        files: [{ path: "fonts/sample-400.woff2", weight: "400" }],
      },
    ];
    const r = validateThemeDir(theme(m));
    expect(r.issues).toEqual([
      { at: "", message: "fonts/sample-400.woff2 is missing" },
    ]);
  });

  it("takes a font only as real woff2 with its license beside it", () => {
    const m = base();
    m.fonts = [
      {
        family: "Sample Sans",
        license: "OFL-1.1",
        files: [{ path: "fonts/sample-400.woff2", weight: "400" }],
      },
    ];
    const svg = { "mark.svg": '<svg xmlns="http://www.w3.org/2000/svg"/>' };
    const font = "fonts/sample-400.woff2";
    expect(
      validateThemeDir(
        theme(m, { ...svg, [font]: "wOF2…", "fonts/OFL.txt": "x" }),
      ).issues,
    ).toEqual([]);
    expect(
      validateThemeDir(
        theme(m, { ...svg, [font]: "<html>", "fonts/OFL.txt": "x" }),
      ).issues[0].message,
    ).toMatch(/not a woff2/);
    expect(
      validateThemeDir(theme(m, { ...svg, [font]: "wOF2…" })).issues[0].message,
    ).toMatch(/no OFL.txt or LICENSE/);
  });

  it("refuses a mark with script, foreign HTML, entities or external refs", () => {
    for (const svg of [
      "<svg><script>alert(1)</script></svg>",
      '<svg onload="alert(1)"/>',
      "<svg><foreignObject><div/></foreignObject></svg>",
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>',
      '<svg><image href="https://tracker.example/x.png"/></svg>',
      '<svg><rect style="fill:url(https://x.example/a)"/></svg>',
    ]) {
      const r = validateThemeDir(theme(base(), { "mark.svg": svg }));
      expect(r.issues[0]?.message).toMatch(/image only/);
    }
  });

  it("takes the theme's and each font's license as one SPDX rule", () => {
    for (const license of ["UNLICENSED", "NONE", "", "see LICENSE"]) {
      const m = base();
      m.license = license;
      expect(validateThemeDir(theme(m)).issues[0]).toMatchObject({
        at: "/license",
      });
      const f = base();
      f.fonts = [{ family: "X", license, files: [{ path: "x.woff2" }] }];
      expect(validateThemeDir(theme(f)).issues.map((i) => i.at)).toContain(
        "/fonts/0/license",
      );
    }
    const u = base();
    u.license = "UNLICENSED";
    expect(validateThemeDir(theme(u)).issues).toEqual([
      {
        at: "/license",
        message: expect.stringMatching(
          /SPDX expression .*UNLICENSED, NONE and NOASSERTION are refused/,
        ),
      },
    ]);
    const m = base();
    m.license = "MIT OR Apache-2.0";
    expect(validateThemeDir(theme(m)).ok).toBe(true);
  });

  it("checks the id against its directory when asked", () => {
    const r = validateThemeDir(theme(base()), { expectId: "other" });
    expect(r.issues[0]).toMatchObject({ at: "/id" });
  });

  it("says when there is no manifest or it is not JSON", () => {
    const dir = path.join(tmp, "empty");
    fs.mkdirSync(dir);
    expect(validateThemeDir(dir).issues[0].message).toMatch(
      /no den-theme.json/,
    );
    fs.writeFileSync(path.join(dir, "den-theme.json"), "{ nope");
    expect(validateThemeDir(dir).issues[0].message).toMatch(/not valid JSON/);
  });

  it("rejects unknown fields (v1 only grows by adding optional ones)", () => {
    const r = validateThemeDir(theme({ ...base(), colour: "#000000" }));
    expect(r.issues[0].message).toMatch(/colour/);
  });
});

describe("the contract", () => {
  it("every rule names a required token", () => {
    const schema = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, "../../../schemas/den.theme.v1.json"),
        "utf-8",
      ),
    ) as { $defs: { colors: { required: string[] } } };
    const required = new Set(schema.$defs.colors.required);
    for (const [fg, bg] of CONTRAST_RULES) {
      expect(required.has(fg)).toBe(true);
      expect(required.has(bg)).toBe(true);
    }
  });

  it("the bundled default theme is valid and ships in the package", () => {
    const root = path.join(__dirname, "../../..");
    const r = validateThemeDir(path.join(root, "themes", "den"), {
      expectId: "den",
    });
    expect({ issues: r.issues, contrast: r.contrast }).toEqual({
      issues: [],
      contrast: [],
    });
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, "package.json"), "utf-8"),
    ) as { files: string[] };
    expect(pkg.files).toContain("themes/");
  });

  it("the schema ships in the package", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../../package.json"), "utf-8"),
    ) as { files: string[] };
    expect(pkg.files).toContain("schemas/");
  });
});
