import * as fs from "fs";
import * as path from "path";
import * as ts from "typescript";

export const SETTINGS_PUBLIC = path.join(
  __dirname,
  "../../../../src/ui/server/public",
);

export const SETTINGS_PART = /^settings-(?:common|ui-[\w-]+|rows-[\w-]+)\.js$/;

export function stripComments(text: string): string {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    text,
  );
  let out = "";
  let kind = scanner.scan();
  while (kind !== ts.SyntaxKind.EndOfFileToken) {
    if (
      kind === ts.SyntaxKind.SingleLineCommentTrivia ||
      kind === ts.SyntaxKind.MultiLineCommentTrivia
    ) {
      out += scanner.getTokenText().replace(/[^\n]/g, "");
    } else if (
      kind === ts.SyntaxKind.SlashToken ||
      kind === ts.SyntaxKind.SlashEqualsToken
    ) {
      const re = scanner.reScanSlashToken();
      out += scanner.getTokenText();
      kind = re;
    } else if (kind === ts.SyntaxKind.CloseBraceToken) {
      const t = scanner.reScanTemplateToken(false);
      out += scanner.getTokenText();
      kind = t;
    } else {
      out += scanner.getTokenText();
    }
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
