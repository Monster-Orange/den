import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

export const SETTINGS_PUBLIC = path.join(
  __dirname,
  "../../../../src/ui/server/public",
);

export const SETTINGS_PART = /^settings-(?:common|ui-[\w-]+|rows-[\w-]+)\.js$/;

const NOT_BEFORE_REGEX = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.Identifier,
  ts.SyntaxKind.PrivateIdentifier,
  ts.SyntaxKind.NumericLiteral,
  ts.SyntaxKind.BigIntLiteral,
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.RegularExpressionLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.CloseParenToken,
  ts.SyntaxKind.CloseBracketToken,
  ts.SyntaxKind.CloseBraceToken,
  ts.SyntaxKind.PlusPlusToken,
  ts.SyntaxKind.MinusMinusToken,
  ts.SyntaxKind.ThisKeyword,
  ts.SyntaxKind.SuperKeyword,
  ts.SyntaxKind.TrueKeyword,
  ts.SyntaxKind.FalseKeyword,
  ts.SyntaxKind.NullKeyword,
]);

export function stripComments(text: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  const depths: number[] = [];
  let prev: ts.SyntaxKind | undefined;
  let out = "";
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; ) {
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      out += scanner.getTokenText().replace(/[^\n]/g, "");
      kind = scanner.scan();
      continue;
    }
    if (
      (kind === ts.SyntaxKind.SlashToken ||
        kind === ts.SyntaxKind.SlashEqualsToken) &&
      (prev === undefined || !NOT_BEFORE_REGEX.has(prev))
    ) {
      kind = scanner.reScanSlashToken();
    } else if (kind === ts.SyntaxKind.OpenBraceToken && depths.length) {
      depths[depths.length - 1]++;
    } else if (kind === ts.SyntaxKind.CloseBraceToken && depths.length) {
      if (depths[depths.length - 1] === 0) {
        depths.pop();
        kind = scanner.reScanTemplateToken(false);
      } else {
        depths[depths.length - 1]--;
      }
    }
    if (
      kind === ts.SyntaxKind.TemplateHead ||
      kind === ts.SyntaxKind.TemplateMiddle
    ) {
      depths.push(0);
    }
    if (
      kind !== ts.SyntaxKind.WhitespaceTrivia &&
      kind !== ts.SyntaxKind.NewLineTrivia
    ) {
      prev = kind;
    }
    out += scanner.getTokenText();
    kind = scanner.scan();
  }
  return out;
}

export function settingsFiles(dir: string = SETTINGS_PUBLIC): string[] {
  const parts = fs
    .readdirSync(dir)
    .filter((f) => SETTINGS_PART.test(f))
    .sort();
  return ["settings-registry.js", ...parts];
}

export function readSettingsSources(
  opts: { dir?: string; comments?: boolean } = {},
): string {
  const dir = opts.dir ?? SETTINGS_PUBLIC;
  return settingsFiles(dir)
    .map((f) => {
      const text = fs.readFileSync(path.join(dir, f), "utf-8");
      return opts.comments ? text : stripComments(text);
    })
    .join("\n");
}
