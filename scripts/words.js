/**
 * The words people see (LOGICAL-ERD.md, "Words people see"): Den and Hub
 * show exactly these, and a patch may not add a "never shown" word to an
 * en, es or ja string, CLI help, MCP tool text or an error message.
 *
 *   company   never team, tenant, org
 *   install   never "Den install", server
 *   project   never workspace, space
 *   person    never user, account
 *   agent     never bot, session
 *
 * Code a person may see stays as it is: `inline code`, {placeholders},
 * flags (--workspace, -w), command names after the CLI's name (`den org
 * list`, `<cli> sessions attach`), paths, config keys, env names and
 * identifiers. "MCP server" is the protocol's own name. The gate
 * (scripts/words-gate.mjs) runs this over the strings a patch adds.
 */

/** The "never shown" words, by language (the catalog's own words). */
export const NEVER_SHOWN = {
  en: [
    ["team", /\bteams?\b/i],
    ["tenant", /\btenants?\b/i],
    ["org", /\borg(?:s|anization|anizations)?\b/i],
    ["Den install", /\bden installs?\b/i],
    ["server", /\bservers?\b/i],
    ["workspace", /\bworkspaces?\b/i],
    ["space", /\bspaces?\b/i],
    ["user", /\busers?\b/i],
    ["account", /\baccounts?\b/i],
    ["bot", /\bbots?\b/i],
    ["session", /\bsessions?\b/i],
  ],
  es: [
    ["equipo", /\bequipos?\b/i],
    ["inquilino", /\binquilinos?\b/i],
    ["organización", /\borganizaci(?:ón|ones)\b/i],
    ["servidor", /\bservidor(?:es)?\b/i],
    ["espacio de trabajo", /\bespacios? de trabajo\b/i],
    ["usuario", /\busuari[oa]s?\b/i],
    ["cuenta", /\bcuentas?\b/i],
    ["bot", /\bbots?\b/i],
    ["sesión", /\bsesi(?:ón|ones)\b/i],
  ],
  ja: [
    ["チーム", /チーム/],
    ["テナント", /テナント/],
    ["組織", /組織/],
    ["サーバー", /サーバー?/],
    ["ワークスペース", /ワークスペース/],
    ["ユーザー", /ユーザー?/],
    ["アカウント", /アカウント/],
    ["ボット", /ボット/],
    ["セッション", /セッション/],
  ],
};

const COMMANDS =
  "org|orgs|sessions?|workspaces?|server-agent|team|account|users?";

/** `text` less the code a person may see (see above). */
export function withoutCode(text) {
  return (
    text
      // a command after the CLI's name: den org list, <cli> sessions attach
      .replace(
        new RegExp(
          `(?:\\bden|\\bacme|<cli>|\\{cli\\})\\s+(?:${COMMANDS})\\b`,
          "gi",
        ),
        " ",
      )
      // a tag's attribute values (href, class, data-*, id…) are code; only
      // title, aria-label, placeholder and alt are read
      .replace(
        /\s(?!(?:title|aria-label|placeholder|alt)\s*=)[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*')/gi,
        " ",
      )
      // `inline code`, {placeholders}, <placeholders>
      .replace(/`[^`]*`/g, " ")
      .replace(/\$?\{[^{}]*\}/g, " ")
      .replace(/<[\w ./|-]+>/g, " ")
      // flags, env names, config keys, paths, identifiers
      .replace(/(?<![\w-])--?[a-z][\w-]*/gi, " ")
      .replace(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g, " ")
      .replace(/\b[\w-]+(?:\.[\w-]+)+\b/g, " ")
      .replace(/(?:\/[\w.@:-]+)+\/?/g, " ")
      .replace(/\b\w+_\w+\b/g, " ")
      .replace(/\b[a-z]+[A-Z]\w*\b/g, " ")
      // the protocol's own name
      .replace(/\bMCP servers?\b/gi, " ")
  );
}

/** The language a string is in: ja by its script, es by its words, else en. */
export function languageOf(text) {
  if (/[぀-ヿ一-鿿]/.test(text)) return "ja";
  if (/[ñáéíóú¿¡]|\b(?:el|la|los|las|una?|del|para|con|que)\b/i.test(text))
    return "es";
  return "en";
}

/** The "never shown" words in `text`, by name (none: []). */
export function neverShownIn(text, lang = languageOf(text)) {
  const t = withoutCode(text);
  return NEVER_SHOWN[lang].filter(([, re]) => re.test(t)).map(([w]) => w);
}

/**
 * The strings in one line of source that a person reads: quoted strings
 * and template text with two words in a row (a lone word or a key is
 * code). Comments are not strings.
 */
export function proseIn(line) {
  const code = line.replace(/^\s*(?:\/\/|\*|\/\*|#).*$/, "");
  const out = [];
  const lit = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g;
  for (const m of code.matchAll(lit)) {
    const s = (m[1] ?? m[2] ?? m[3] ?? "").replace(/\$\{[^{}]*\}/g, " ");
    if (/[A-Za-zÀ-ɏ]+\s+[A-Za-zÀ-ɏ]+/.test(s) || /[぀-ヿ一-鿿]{2}/.test(s))
      out.push(s);
  }
  return out;
}
