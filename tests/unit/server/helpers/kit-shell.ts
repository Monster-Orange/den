/**
 * Issue 95: a test page with Den's shell on it needs the UI kit's shell
 * too, as Den's own server gives it: the kit's stylesheets in the head and
 * its shell script (/den-ui-shell.js) before shell.js (kitPage), and the
 * files behind them (kitAsset). Issue 409: and Den's en catalog,
 * /i18n/en.js, just before them (localizePage), as every page has it. A
 * harness that serves shell.js on a bare page wraps its HTML in kitPage
 * and asks kitAsset first.
 */
import * as fs from "fs";
import * as path from "path";
import {
  KIT_FILES,
  KIT_SHELL_SCRIPT,
  kitPage as serverKitPage,
  kitShellScript,
} from "../../../../src/ui/server/ui-assets.js";
import {
  UI_LANGUAGES,
  localizePage,
} from "../../../../src/ui/server/ui-language.js";
import { PUBLIC_DIR, catalogFile } from "./en-catalog.js";

/** A page with the shell, as the server fills it: en's catalog, the kit's. */
export function kitPage(html: string): string {
  return serverKitPage(localizePage(html, "en"));
}

const KIT = path.join(process.cwd(), "packages", "den-ui", "src");

/**
 * The kit's file for a path (/den-ui-shell.js or /kit/<file>), or null.
 * `pseudo`: a pseudo-locale's name; the kit's words are wrapped in ⟦…⟧ for
 * it, in the classic shell script and in the kit's own strings.js (What's
 * new and Report draw with that one).
 */
export function kitAsset(
  pathname: string,
  pseudo = "",
): { contentType: string; body: string } | null {
  const table = pseudo ? kitPseudoTable() : null;
  const extraJs = table
    ? `\nwindow.DenUIShell.addStrings(${JSON.stringify(pseudo)}, ${JSON.stringify(table)});\n`
    : "";
  if (
    pathname === KIT_SHELL_SCRIPT ||
    pathname.startsWith(KIT_SHELL_SCRIPT + "?")
  )
    return {
      contentType: "text/javascript; charset=utf-8",
      body: (kitShellScript(process.cwd()) ?? "") + extraJs,
    };
  // Issue 409: Den's catalogs (/i18n/<lang>.js), as the server serves them.
  const cat = /^\/(i18n\/[\w-]+\.js)(?:\?.*)?$/.exec(pathname);
  if (cat && UI_LANGUAGES.some((l) => catalogFile(l) === cat[1]))
    return {
      contentType: "text/javascript; charset=utf-8",
      body: fs.readFileSync(path.join(PUBLIC_DIR, cat[1]), "utf-8"),
    };
  const m = /^\/kit\/([\w./-]+)$/.exec(pathname);
  if (!m || !KIT_FILES.includes(m[1])) return null;
  const f = m[1];
  return {
    contentType: f.endsWith(".css")
      ? "text/css; charset=utf-8"
      : "text/javascript; charset=utf-8",
    body:
      fs.readFileSync(path.join(KIT, f), "utf-8") +
      (table && f === "strings.js"
        ? `\naddStrings(${JSON.stringify(pseudo)}, ${JSON.stringify(table)});\n`
        : ""),
  };
}

/** The kit's en words, each wrapped in ⟦…⟧ (a pseudo-locale's table). */
export function kitPseudoTable(): Record<string, string> {
  const src = fs.readFileSync(path.join(KIT, "strings.js"), "utf-8");
  const en = new Function(
    src
      .slice(
        src.indexOf("export const en = "),
        src.indexOf("export const es = "),
      )
      .replace("export const en = ", "return "),
  )() as Record<string, string>;
  return Object.fromEntries(Object.entries(en).map(([k, v]) => [k, `⟦${v}⟧`]));
}

/** A line for after the kit's shell script: its words as `lang`'s, wrapped. */
export function kitPseudo(lang: string): string {
  return `\nwindow.DenUIShell.addStrings(${JSON.stringify(lang)}, ${JSON.stringify(kitPseudoTable())});\n`;
}
