/**
 * H5 wording (Ward: "den still calls projects workspaces"): nothing a
 * person reads says "workspace" (es "espacio de trabajo", ja
 * "ワークスペース"); it says "project". Checked: every UI catalog (en, es,
 * ja, and the modules' English fallbacks), the Settings registry's labels
 * and help, the pages' visible text (text and title, aria-label,
 * placeholder, alt), and the CLI's help.
 *
 * Code stays as it is for now: command names (`den workspace list`), the
 * -w/--workspace flag, config keys and files (workspaces.yml,
 * `<ws>.agents.…`), API paths (/api/workspaces/…) and identifiers. Those
 * forms are taken out before the words are looked for.
 */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vm from "vm";
import ts from "typescript";
import { UI_LANGUAGES } from "../../../src/ui/server/ui-language.js";
import { EN_FALLBACK as TOPBAR_EN } from "../../../src/ui/server/public/topbar.js";
import { EN_FALLBACK as APPEARANCE_EN } from "../../../src/ui/server/public/appearance.js";
import { EN_FALLBACK as PICKER_EN } from "../../../src/ui/server/public/workspace-picker.js";
import { DEN_SETTINGS } from "../../../src/ui/server/public/settings-registry.js";

const ENGINE = path.resolve(__dirname, "../../..");
const PUBLIC = path.join(ENGINE, "src", "ui", "server", "public");
const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");

/** The words, by language. */
const WORD: Record<string, RegExp> = {
  en: /\bworkspaces?\b/i,
  // "espacio" alone too, and an English word left untranslated.
  // ("espacios simples" is spaces, the characters.)
  es: /\bespacios? de trabajo\b|\bespacio\b|\bworkspaces?\b/i,
  ja: /ワークスペース|\bworkspaces?\b/i,
};
const ANY = new RegExp(
  Object.values(WORD)
    .map((r) => r.source)
    .join("|"),
  "i",
);

/** Code a person may see but that stays as it is (see above). */
function withoutCode(s: string): string {
  return (
    s
      // `inline code`, and a message's {placeholders}
      .replace(/`[^`]*`/g, " ")
      .replace(/\{\w+\}/g, " ")
      // flags
      .replace(/--?workspaces?\b/gi, " ")
      // config files and keys
      .replace(/\bworkspaces?\.ya?ml\b/gi, " ")
      .replace(/\bdefaults\.workspaces?\b/gi, " ")
      .replace(/\.code-workspace\b/gi, " ")
      // API paths
      .replace(/\/api\/workspaces?\b[^\s"']*/gi, " ")
      // a command: <cli> workspace …, den workspace …, {cli} workspace …
      .replace(
        /(?:\{cli\}|<cli>|\$\{cli\}|\bden|\bacme)\s+workspaces?\b/gi,
        " ",
      )
      // help's own command column: "  workspace list   …"
      .replace(/^\s{2,}workspace(?= [a-z<[])/gim, " ")
  );
}

/**
 * In source, also: a field or value named in quotes ("workspace",
 * `workspace`), an MCP tool's name, the command `workspace seed` and the
 * few strings that are keys or file text, not messages.
 */
function codeForms(s: string): string {
  return s
    .replace(/\\?["']workspaces?\\?["']/g, " ")
    .replace(/\bmcp --call workspaces?\b/g, " ")
    .replace(/\bworkspace_\w+/g, " ")
    .replace(/^workspace seed$/, " ")
    .replace(
      /<stack> ?-<stack workspace>|\(config\/local\/workspaces\.yml\)/g,
      " ",
    )
    .replace(/^# .*$/, " ");
}

/**
 * The strings a TypeScript file builds, read by the compiler's parser:
 * string literals and templates (a `${…}` is a space; one holding the
 * CLI's name, `${cli} workspace use`, reads as "den"). Not imports, type
 * literals or object keys.
 */
function sourceProse(
  file: string,
  src = fs.readFileSync(file, "utf-8"),
  firstLine = 1,
): { line: number; text: string }[] {
  const sf = ts.createSourceFile(
    file,
    src,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS,
  );
  const out: { line: number; text: string }[] = [];
  const push = (n: ts.Node, text: string) => {
    const t = withoutCode(text).trim();
    if (!/[A-Za-z]+\s+[A-Za-z]+/.test(t) && !/^[A-Z][a-z]+$/.test(t)) return;
    out.push({
      line: sf.getLineAndCharacterOfPosition(n.getStart()).line + firstLine,
      text,
    });
  };
  const visit = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isLiteralTypeNode(n)) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const p = n.parent;
      const isKey =
        (ts.isPropertyAssignment(p) && p.name === n) ||
        ts.isElementAccessExpression(p);
      if (!isKey) push(n, n.text);
      return;
    }
    if (ts.isTemplateExpression(n)) {
      let text = n.head.text;
      for (const span of n.templateSpans) {
        text += /\b(?:cli|bin)\b/.test(span.expression.getText(sf))
          ? "den"
          : " ";
        text += span.literal.text;
      }
      push(n, text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function hits(where: string, text: string, word: RegExp): string[] {
  return withoutCode(text)
    .split("\n")
    .filter((l) => word.test(l))
    .map((l) => `${where}: ${l.trim().slice(0, 160)}`);
}

function catalogs(): Record<string, Record<string, string>> {
  const window: Record<string, unknown> = {};
  const document = {
    getElementById: () => null,
    documentElement: { lang: "en" },
    addEventListener: () => {},
  };
  const ctx = vm.createContext({ window, document, Intl });
  for (const f of [
    ...UI_LANGUAGES.filter((l) => l !== "en").map((l) => `i18n/${l}.js`),
    "shell.js",
  ])
    try {
      vm.runInContext(read(f), ctx, { filename: f });
    } catch {
      // shell.js stops at its first DOM use; its catalog is set before it.
    }
  return window.denMessages as Record<string, Record<string, string>>;
}

/** A page's visible text: its text nodes and the attributes people read. */
function visible(html: string): string {
  const body = html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const attrs = [
    ...body.matchAll(
      /\s(?:title|aria-label|placeholder|alt)\s*=\s*"([^"]*)"/gi,
    ),
  ].map((m) => m[1]);
  const text = body.replace(/<[^>]*>/g, "\n");
  return [text, ...attrs].join("\n");
}

/**
 * Text the page scripts build, read by the same parser as Den's source
 * (a regex scan lost strings nested in `${…}` and broke on apostrophes):
 * each string with its code attributes and tags taken out. The pages'
 * inline scripts are read one by one.
 */
function scriptProse(
  file: string,
  src: string,
): { line: number; text: string }[] {
  const scripts = file.endsWith(".html")
    ? [...src.matchAll(/(<script\b[^>]*>)([\s\S]*?)<\/script>/gi)].map((m) => ({
        code: m[2],
        line: src.slice(0, (m.index ?? 0) + m[1].length).split("\n").length,
      }))
    : [{ code: src, line: 1 }];
  return scripts.flatMap(({ code, line }) =>
    sourceProse(file.replace(/\.html$/, ".js"), code, line).map((p) => ({
      line: p.line,
      // A tag is replaced by the attributes people read on it.
      text: p.text.replace(
        /<[^>]*>/g,
        (tag) =>
          ` ${[
            ...tag.matchAll(
              /\s(?:title|aria-label|placeholder|alt)\s*=\s*"([^"]*)"/gi,
            ),
          ]
            .map((m) => m[1])
            .join(" ")} `,
      ),
    })),
  );
}

describe("no 'workspace' where people read (H5 wording)", () => {
  it.each(UI_LANGUAGES)("the %s catalog", (lang) => {
    const cat = catalogs()[lang] ?? {};
    const word = WORD[lang] ?? ANY;
    const found = Object.entries(cat).flatMap(([k, v]) =>
      hits(k, String(v), word),
    );
    expect(found).toEqual([]);
  });

  it("the modules' English fallbacks", () => {
    const found = Object.entries({
      ...TOPBAR_EN,
      ...APPEARANCE_EN,
      ...PICKER_EN,
    }).flatMap(([k, v]) => hits(k, String(v), WORD.en));
    expect(found).toEqual([]);
  });

  it("Settings' labels and help", () => {
    const found: string[] = [];
    const walk = (v: unknown, at: string) => {
      if (typeof v === "string") found.push(...hits(at, v, WORD.en));
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${at}[${i}]`));
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          // Keys, ids, config paths and search keywords (the old word still
          // finds a setting) are code.
          if (
            /^(id|key|keys|keywords|category|path|configKey|scope|kind|type)$/.test(
              k,
            )
          )
            continue;
          walk(x, `${at}.${k}`);
        }
    };
    walk(DEN_SETTINGS, "settings");
    expect(found).toEqual([]);
  });

  it("the pages' visible text", () => {
    const found = fs
      .readdirSync(PUBLIC)
      .filter((f) => f.endsWith(".html"))
      .flatMap((f) => hits(f, visible(read(f)), ANY));
    expect(found).toEqual([]);
  });

  it("the text the pages' scripts build", () => {
    const found = fs
      .readdirSync(PUBLIC)
      .filter(
        (f) => (f.endsWith(".js") && f !== "shell.js") || f.endsWith(".html"),
      )
      .flatMap((f) =>
        scriptProse(f, read(f)).flatMap((p) =>
          hits(`${f}:${p.line}`, p.text.replace(/\n/g, " "), WORD.en),
        ),
      );
    expect(found).toEqual([]);
  });

  // The built-in personas' descriptions and instructions: shown on the
  // Agents page and in each agent's brief.
  it("the built-in personas", () => {
    const pack = path.join(ENGINE, "src", "shared", "agents", "default-pack");
    const found = fs
      .readdirSync(pack)
      .filter((f) => f.endsWith(".md"))
      .flatMap((f) =>
        hits(
          `default-pack/${f}`,
          fs.readFileSync(path.join(pack, f), "utf-8"),
          WORD.en,
        ),
      );
    expect(found).toEqual([]);
  });

  // Vision: "people see them as toasts and CLI errors". The messages Den's
  // code builds: the server's errors, MCP tools' text, the CLI's output and
  // the shared modules both use. JSON field names and codes stay.
  it.each([
    ["src/ui/server", false],
    ["src/ui/mcp", false],
    ["src/ui/cli", true],
    ["src/shared", true],
  ])("the messages in %s", (dir, deep) => {
    const root = path.join(ENGINE, dir);
    const files = (
      fs.readdirSync(root, { recursive: deep }) as string[]
    ).filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"));
    const found = files.flatMap((f) =>
      sourceProse(path.join(root, f)).flatMap((p) =>
        hits(`${dir}/${f}:${p.line}`, codeForms(p.text), WORD.en),
      ),
    );
    expect(found).toEqual([]);
  });

  describe("the CLI's help", () => {
    let tmp = "";
    let root = "";
    beforeAll(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "den-words-"));
      root = path.join(tmp, "den");
      fs.mkdirSync(path.join(root, "config"), { recursive: true });
      fs.writeFileSync(path.join(root, "den.yml"), "product:\n  name: den\n");
      fs.writeFileSync(
        path.join(root, "config", "den.yml"),
        "environments: [local]\n",
      );
    });
    afterAll(() => {
      if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
    });
    const help = (args: string[]) => {
      const r = spawnSync(path.join(ENGINE, "bin", "den"), args, {
        cwd: root,
        encoding: "utf-8",
        input: "",
        env: {
          ...process.env,
          DEN_ROOT: root,
          DEN_HOME: path.join(tmp, "home"),
          DEN_DAEMONS_FILE: path.join(tmp, "daemons.json"),
          PORT: "1",
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
        timeout: 60_000,
      });
      return `${r.stdout}${r.stderr}`;
    };
    it.each([
      [["--help"]],
      [["workspace", "--help"]],
      [["agents", "--help"]],
      [["sessions", "--help"]],
      [["repo", "--help"]],
      [["web", "--help"]],
      [["onboard", "--help"]],
      [["usage", "--help"]],
    ])(
      "den %j",
      (args) => {
        expect(hits(args.join(" "), help(args), WORD.en)).toEqual([]);
      },
      60_000,
    );
  });
});
