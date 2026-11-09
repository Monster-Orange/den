/**
 * Every served page and script still parses once its product placeholders
 * (__DEN_CLI__, __DEN_NAME__, …) are filled, for names a distribution may
 * really have: hyphens (acme-den, globex-den), digits, and the shortest.
 *
 * 0.4.20 and 0.4.21-dev.0 put __DEN_CLI__ inside a JS identifier in
 * header.js (`let ___DEN_CLI__Config`): with a hyphenated name the served
 * file was a SyntaxError, and every page mounted nothing. Den's own name
 * ("den") has no hyphen, so nothing caught it.
 *
 * Every .js file must parse as an ES module (`node --check` on a .mjs
 * copy): pages import them as modules, and a plain `node --check x.js` parses
 * a file as a script, where `let _acme-denConfig` can slip by. A file a page
 * also loads as a classic <script src> (shell.js) must parse as a script too.
 * Each inline <script> parses as what its type says.
 */
import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fillProductTokens, titleOf } from "../../../src/shared/product.js";
import { profileFrom } from "../../../src/shared/profile.js";

const PUBLIC = path.resolve(__dirname, "../../../src/ui/server/public");

/** Every .js and .html under public/, relative. */
function files(dir = PUBLIC, rel = ""): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }))
    if (e.isDirectory()) out.push(...files(dir, path.join(rel, e.name)));
    else if (/\.(js|html)$/.test(e.name)) out.push(path.join(rel, e.name));
  return out.sort();
}

/** The product a profile makes, as fillProductTokens takes it. */
function productOf(raw: Record<string, string>) {
  const { brand, ...profile } = raw;
  const p = profileFrom(profile, os.tmpdir());
  const yml = p.manifestFiles[0];
  return {
    ...p,
    title: titleOf(p.name, brand),
    manifestYml: yml,
    manifestJson: p.manifestFiles[1] ?? yml.replace(/\.ya?ml$/, "") + ".json",
  };
}

/** The inline scripts of an HTML page (no src), with whether each is a module. */
function inlineScripts(html: string): { code: string; module: boolean }[] {
  const out: { code: string; module: boolean }[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const attrs = m[1];
    if (/\bsrc\s*=/.test(attrs)) continue;
    const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] ?? "";
    if (type && type !== "module" && !/javascript/i.test(type)) continue; // JSON data
    out.push({ code: m[2], module: type === "module" });
  }
  return out;
}

/** Why `code` doesn't parse as a module (.mjs) or a script (.cjs), or "". */
function parseError(code: string, tmp: string, module: boolean): string {
  const tryAs = (ext: string) => {
    const f = path.join(tmp, `check${ext}`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, ["--check", f], {
      encoding: "utf-8",
    });
    return r.status === 0
      ? ""
      : (r.stderr.split("\n").find((l) => /Error/.test(l)) ?? "error");
  };
  return tryAs(module ? ".mjs" : ".cjs");
}

/** The public .js files some page loads as a classic <script src="/x.js">. */
function classicScripts(): Set<string> {
  const out = new Set<string>();
  for (const rel of files().filter((f) => f.endsWith(".html"))) {
    const html = fs.readFileSync(path.join(PUBLIC, rel), "utf-8");
    const re = /<script\b([^>]*)>/gi;
    for (let m = re.exec(html); m; m = re.exec(html)) {
      const src = /\bsrc\s*=\s*["']\/?([^"']+)["']/i.exec(m[1])?.[1];
      if (src && !/\btype\s*=\s*["']?module/i.test(m[1])) out.add(src);
    }
  }
  return out;
}

const NAMES: Record<string, string>[] = [
  { name: "acme-den" },
  { name: "globex-den", brand: "Globex Den" },
  { name: "acme-den", brand: "Acmé Dev_2.0 - Beta" },
  { name: "globex-den" },
  { name: "a" },
  { name: "x9-2-b", cli: "x9-cli" },
  { name: "acme--den-", config: "config/acme.v2.yml", services_dir: "svc/a_b" },
  { name: "den" },
];

describe("served pages parse with any product name", () => {
  it.each(NAMES.map((n) => [n.name, n]))(
    "%s: every public .js and inline script parses",
    (_name, raw) => {
      const p = productOf(raw);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-tokens-"));
      const classic = classicScripts();
      try {
        const bad: string[] = [];
        for (const rel of files()) {
          const text = fillProductTokens(
            fs.readFileSync(path.join(PUBLIC, rel), "utf-8"),
            p,
          );
          if (rel.endsWith(".js")) {
            const e = parseError(text, tmp, true);
            if (e) bad.push(`${rel} (as a module): ${e}`);
            const c = classic.has(rel) ? parseError(text, tmp, false) : "";
            if (c) bad.push(`${rel} (as a classic script): ${c}`);
          } else
            inlineScripts(text).forEach((s, i) => {
              const e = parseError(s.code, tmp, s.module);
              if (e) bad.push(`${rel} <script #${i + 1}>: ${e}`);
            });
        }
        expect(bad).toEqual([]);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it("a module error a script parse misses still fails (the dev.0 header.js line)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-tokens-"));
    try {
      const dev0 = "let _acme-denConfig = null;\nexport const x = 1;\n";
      expect(parseError(dev0, tmp, true)).toMatch(/SyntaxError/);
      // No import or export: a script parse alone would not catch it.
      const bare = "let _acme-denConfig = null;\n";
      expect(parseError(bare, tmp, true)).toMatch(/SyntaxError/);
      expect(classicScripts().has("shell.js")).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("no placeholder sits inside an identifier (letters, digits or _ next to it)", () => {
    const hits: string[] = [];
    for (const rel of files()) {
      const lines = fs
        .readFileSync(path.join(PUBLIC, rel), "utf-8")
        .split("\n");
      lines.forEach((l, i) => {
        // __DEN_X__ glued to a word character: part of a name, not a string.
        if (/[A-Za-z0-9$]__DEN_[A-Z_]+__|__DEN_[A-Z_]+__[A-Za-z0-9$]/.test(l))
          hits.push(`${rel}:${i + 1}: ${l.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

describe("which product names a distribution may have (den.yml product:)", () => {
  it.each(["a", "den", "acme-den", "x9-2-b", "acme--den", "acme-"])(
    "name %s is allowed",
    (name) => {
      expect(profileFrom({ name }, os.tmpdir()).name).toBe(name);
    },
  );

  it.each(["Acme", "9den", "-den", "acme_den", "acme.den", "acme den", "acmé"])(
    "name %s is refused, naming the rule",
    (name) => {
      expect(() => profileFrom({ name }, os.tmpdir())).toThrow(
        /product.name .* must be lower-case letters, digits and "-", starting with a letter/,
      );
    },
  );

  it.each([`x"y`, "x'y", "X", "9x", "x y", "x$y"])(
    "cli %s is refused",
    (cli) => {
      expect(() => profileFrom({ name: "acme", cli }, os.tmpdir())).toThrow(
        /product.cli/,
      );
    },
  );

  it.each([
    ["config", `config/a"b.yml`],
    ["manifest", ".a$b.yml"],
    ["services_dir", "a\\b"],
    ["workspaces_dir", "<ws>"],
  ])("%s %s is refused", (key, v) => {
    expect(() => profileFrom({ name: "acme", [key]: v }, os.tmpdir())).toThrow(
      new RegExp(`product.${key}`),
    );
  });
});
