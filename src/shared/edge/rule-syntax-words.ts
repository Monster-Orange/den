/**
 * Issue 519: what `doctor` says when an edge on Traefik v2 has rules that
 * v3 reads differently, in each language the UI ships (a test keeps the
 * three even, placeholders too).
 *
 * Placeholders: {image} edge.image now, {major} its Traefik major version,
 * {target} the image Den suggests, {count} how many rules, {where} where a
 * rule is, {rule} the rule, {why} why v3 reads it differently, {arg} the
 * compat flag.
 */
import type { UiLanguage } from "../../ui/server/ui-language.js";

export type RuleSyntaxWord =
  | "head"
  | "headUnknown"
  | "rule"
  | "compat"
  | "rewrite"
  | "compatSet"
  | "why.namedGroup"
  | "why.multiArg"
  | "why.headers"
  | "why.hostHeader"
  | "why.queryEquals";

export const RULE_SYNTAX_WORDS: Readonly<
  Record<UiLanguage, Readonly<Record<RuleSyntaxWord, string>>>
> = {
  en: {
    head: "edge.image {image} is Traefik v{major}. Before you move it to {target}: {count} route rule(s) use Traefik v2 syntax that v3 reads differently, so on v3 they stop matching with nothing that says why:",
    headUnknown:
      "edge.image {image}: Den can't tell which Traefik version it is. Before you move it to {target}: {count} route rule(s) use Traefik v2 syntax that v3 reads differently, so on v3 they stop matching with nothing that says why:",
    rule: "{where}: {rule} ({why})",
    compat:
      "Either add {arg} to edge.args, then set edge.image to {target}: works now, and these rules keep their v2 meaning.",
    rewrite:
      "Or rewrite the rules above in v3 syntax, then set edge.image to {target}.",
    compatSet:
      "edge.args has {arg}, so these rules keep working on v3: set edge.image to {target}.",
    "why.namedGroup":
      "a named group like {name:…}; v3 takes a plain regular expression",
    "why.multiArg":
      "more than one value in one matcher; v3 takes one, joined with ||",
    "why.headers": "Headers/HeadersRegexp; v3 names them Header/HeaderRegexp",
    "why.hostHeader": "HostHeader; v3 has only Host",
    "why.queryEquals":
      "Query with key=value; v3 takes the key and the value apart",
  },
  es: {
    head: "edge.image {image} es Traefik v{major}. Antes de cambiarla a {target}: {count} regla(s) de ruta usan sintaxis de Traefik v2 que v3 lee de otra forma, así que en v3 dejan de coincidir sin nada que diga por qué:",
    headUnknown:
      "edge.image {image}: Den no sabe qué versión de Traefik es. Antes de cambiarla a {target}: {count} regla(s) de ruta usan sintaxis de Traefik v2 que v3 lee de otra forma, así que en v3 dejan de coincidir sin nada que diga por qué:",
    rule: "{where}: {rule} ({why})",
    compat:
      "O bien añade {arg} a edge.args y luego pon edge.image en {target}: funciona ya, y estas reglas conservan su sentido de v2.",
    rewrite:
      "O reescribe las reglas de arriba en sintaxis de v3 y luego pon edge.image en {target}.",
    compatSet:
      "edge.args tiene {arg}, así que estas reglas siguen funcionando en v3: pon edge.image en {target}.",
    "why.namedGroup":
      "un grupo con nombre como {name:…}; v3 usa una expresión regular simple",
    "why.multiArg":
      "más de un valor en un mismo matcher; v3 acepta uno, unidos con ||",
    "why.headers": "Headers/HeadersRegexp; en v3 se llaman Header/HeaderRegexp",
    "why.hostHeader": "HostHeader; v3 solo tiene Host",
    "why.queryEquals":
      "Query con clave=valor; v3 recibe la clave y el valor por separado",
  },
  ja: {
    head: "edge.image {image} は Traefik v{major} です。{target} に移す前に: {count} 件のルートルールが v3 では別の意味になる Traefik v2 の書き方を使っています。v3 では理由が何も表示されないまま一致しなくなります:",
    headUnknown:
      "edge.image {image}: Den にはどの Traefik のバージョンか分かりません。{target} に移す前に: {count} 件のルートルールが v3 では別の意味になる Traefik v2 の書き方を使っています。v3 では理由が何も表示されないまま一致しなくなります:",
    rule: "{where}: {rule}（{why}）",
    compat:
      "{arg} を edge.args に加えてから edge.image を {target} にする: 今すぐ使え、これらのルールは v2 の意味のままです。",
    rewrite:
      "または上のルールを v3 の書き方に書き直してから edge.image を {target} にする。",
    compatSet:
      "edge.args に {arg} があるので、これらのルールは v3 でも動きます: edge.image を {target} にしてください。",
    "why.namedGroup":
      "{name:…} のような名前付きグループ。v3 は普通の正規表現を使います",
    "why.multiArg":
      "1 つのマッチャーに複数の値。v3 は 1 つだけで、|| でつなぎます",
    "why.headers": "Headers/HeadersRegexp。v3 では Header/HeaderRegexp です",
    "why.hostHeader": "HostHeader。v3 には Host しかありません",
    "why.queryEquals":
      "key=value 形式の Query。v3 はキーと値を別々に受け取ります",
  },
};

/** One line, its placeholders filled. */
export function ruleSyntaxWord(
  lang: UiLanguage,
  key: RuleSyntaxWord,
  vars: Record<string, string | number> = {},
): string {
  const s =
    (RULE_SYNTAX_WORDS[lang] ?? RULE_SYNTAX_WORDS.en)[key] ??
    RULE_SYNTAX_WORDS.en[key];
  return s.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in vars ? String(vars[k]) : m,
  );
}
