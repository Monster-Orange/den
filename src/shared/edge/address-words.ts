/**
 * Issue 455: the words the command line says about Den's address, in each
 * language the UI ships (a test keeps the three even, placeholders too).
 * The page's own words are in the UI catalogs (shell.js "addr.*").
 *
 * Placeholders: {title} the product ("Den"), {cli} its command, {port} the
 * held port, {owner} what holds it ("nginx"), {kind} its kind's word,
 * {name} the container's name or the pid, {address} the address that was
 * just checked, {wanted} the address Den would rather give, {host} that
 * address's name, {what} what answered, {link} a sign-in link.
 */
import type { UiLanguage } from "../ui-language.js";

export type AddressWord =
  | "held"
  | "heldBare"
  | "unknown"
  | "none"
  | "open"
  | "toUse"
  | "kind.container"
  | "kind.process"
  | "doctor.head"
  | "doctor.headBare"
  | "doctor.headUnknown"
  | "doctor.headNone"
  | "doctor.checked"
  | "doctor.options"
  | "doctor.route"
  | "doctor.ok"
  | "doctor.unchecked"
  | "edgeUnchecked"
  | "unreachable"
  | "edgeDown"
  | "edgeNotDen"
  | "edgeHeld"
  | "edgeHeldUnknown"
  | "routeHelp"
  | "routeUnknown";

export const ADDRESS_WORDS: Readonly<
  Record<UiLanguage, Readonly<Record<AddressWord, string>>>
> = {
  en: {
    held: "Port {port} is held by {owner} ({kind} {name}), so {title}'s own proxy did not start. {title} is at {address} until port {port} is free.",
    heldBare:
      "Port {port} is held by {owner}, so {title}'s own proxy did not start. {title} is at {address} until port {port} is free.",
    unknown:
      "Port {port} is in use by something {title} cannot name. {title} is at {address} until it is free.",
    none: "Nothing answers at {wanted} yet. {title} is at {address} for now.",
    open: "Open it: {link}",
    toUse: "To use {host} without a port: Edge, or  {cli} doctor",
    "kind.container": "Docker container",
    "kind.process": "process",
    "doctor.head":
      "Edge: not running. Port {port} is held by {owner} ({kind} {name}).",
    "doctor.headBare": "Edge: not running. Port {port} is held by {owner}.",
    "doctor.headUnknown":
      "Edge: not running. Port {port} is in use by something {title} cannot name.",
    "doctor.headNone": "Not reachable yet: nothing answers at {wanted}.",
    "doctor.checked":
      "{title} answers at {address}. That address was checked just now: it is this {title}.",
    "doctor.options":
      "Options: free port {port}, or add {title} to that proxy (route below).",
    "doctor.route":
      "Route for nginx / Caddy / Traefik:  {cli} edge route --for nginx",
    "doctor.ok": "{address}: checked just now: it is this {title}.",
    "doctor.unchecked":
      "{title} is not running here, so no address was checked.",
    unreachable: "Not reachable yet: nothing answers at {address}.",
    edgeUnchecked:
      "The edge address {wanted} isn't checked yet: it hasn't answered as this {title}.",
    edgeDown: "The edge isn't running. Start it with: {cli} edge up",
    edgeNotDen: "Port {port} answers, but it isn't {title}: {what}.",
    edgeHeld:
      "Port {port} is held by {owner} ({kind} {name}), not {title}'s proxy.",
    edgeHeldUnknown: "Port {port} is in use by something {title} cannot name.",
    routeHelp:
      "The route for your own proxy: it sends {host} to {title} at port {port}. Paste it where that proxy's config lives, then reload it. {title} changes nothing in your other project.",
    routeUnknown: "{cli} edge route --for nginx, caddy or traefik",
  },
  es: {
    held: "El puerto {port} lo ocupa {owner} ({kind} {name}), así que el proxy propio de {title} no arrancó. {title} está en {address} hasta que el puerto {port} quede libre.",
    heldBare:
      "El puerto {port} lo ocupa {owner}, así que el proxy propio de {title} no arrancó. {title} está en {address} hasta que el puerto {port} quede libre.",
    unknown:
      "El puerto {port} lo usa algo que {title} no sabe nombrar. {title} está en {address} hasta que quede libre.",
    none: "Todavía nada responde en {wanted}. {title} está en {address} por ahora.",
    open: "Ábrelo: {link}",
    toUse: "Para usar {host} sin puerto: Edge, o  {cli} doctor",
    "kind.container": "contenedor de Docker",
    "kind.process": "proceso",
    "doctor.head":
      "Edge: no está en marcha. El puerto {port} lo ocupa {owner} ({kind} {name}).",
    "doctor.headBare":
      "Edge: no está en marcha. El puerto {port} lo ocupa {owner}.",
    "doctor.headUnknown":
      "Edge: no está en marcha. El puerto {port} lo usa algo que {title} no sabe nombrar.",
    "doctor.headNone": "Aún no se puede llegar: nada responde en {wanted}.",
    "doctor.checked":
      "{title} responde en {address}. Esa dirección se comprobó ahora mismo: es este {title}.",
    "doctor.options":
      "Opciones: liberar el puerto {port}, o añadir {title} a ese proxy (ruta abajo).",
    "doctor.route":
      "Ruta para nginx / Caddy / Traefik:  {cli} edge route --for nginx",
    "doctor.ok": "{address}: comprobada ahora mismo: es este {title}.",
    "doctor.unchecked":
      "{title} no está en marcha aquí, así que no se comprobó ninguna dirección.",
    unreachable: "Aún no se puede llegar: nada responde en {address}.",
    edgeUnchecked:
      "La dirección del edge {wanted} aún no está comprobada: todavía no ha respondido como este {title}.",
    edgeDown: "El edge no está en marcha. Arráncalo con: {cli} edge up",
    edgeNotDen: "El puerto {port} responde, pero no es {title}: {what}.",
    edgeHeld:
      "El puerto {port} lo ocupa {owner} ({kind} {name}), no el proxy de {title}.",
    edgeHeldUnknown:
      "El puerto {port} lo usa algo que {title} no sabe nombrar.",
    routeHelp:
      "La ruta para tu propio proxy: envía {host} a {title} en el puerto {port}. Pégala donde está la configuración de ese proxy y recárgalo. {title} no cambia nada en tu otro proyecto.",
    routeUnknown: "{cli} edge route --for nginx, caddy o traefik",
  },
  ja: {
    held: "ポート {port} は {owner}（{kind} {name}）が使っているため、{title} 自身のプロキシは起動しませんでした。ポート {port} が空くまで、{title} は {address} にあります。",
    heldBare:
      "ポート {port} は {owner} が使っているため、{title} 自身のプロキシは起動しませんでした。ポート {port} が空くまで、{title} は {address} にあります。",
    unknown:
      "ポート {port} は {title} が特定できない何かが使っています。空くまで、{title} は {address} にあります。",
    none: "{wanted} ではまだ何も応答しません。今は {title} は {address} にあります。",
    open: "開く: {link}",
    toUse: "{host} をポートなしで使うには: Edge、または  {cli} doctor",
    "kind.container": "Docker コンテナ",
    "kind.process": "プロセス",
    "doctor.head":
      "Edge: 停止中。ポート {port} は {owner}（{kind} {name}）が使っています。",
    "doctor.headBare":
      "Edge: 停止中。ポート {port} は {owner} が使っています。",
    "doctor.headUnknown":
      "Edge: 停止中。ポート {port} は {title} が特定できない何かが使っています。",
    "doctor.headNone": "まだ届きません: {wanted} では何も応答していません。",
    "doctor.checked":
      "{title} は {address} で応答します。このアドレスはたった今確認しました: この {title} です。",
    "doctor.options":
      "選択肢: ポート {port} を空けるか、そのプロキシに {title} を追加します（ルートは下記）。",
    "doctor.route":
      "nginx / Caddy / Traefik 用のルート:  {cli} edge route --for nginx",
    "doctor.ok": "{address}: たった今確認しました: この {title} です。",
    "doctor.unchecked":
      "{title} がここで動いていないため、アドレスは確認していません。",
    unreachable: "まだ届きません: {address} では何も応答していません。",
    edgeUnchecked:
      "edge のアドレス {wanted} はまだ確認していません: この {title} として応答していません。",
    edgeDown: "edge が動いていません。起動するには: {cli} edge up",
    edgeNotDen:
      "ポート {port} は応答しますが、{title} ではありません: {what}。",
    edgeHeld:
      "ポート {port} は {title} のプロキシではなく {owner}（{kind} {name}）が使っています。",
    edgeHeldUnknown:
      "ポート {port} は {title} が特定できない何かが使っています。",
    routeHelp:
      "お使いのプロキシ用のルート: {host} をポート {port} の {title} に送ります。そのプロキシの設定がある場所に貼り付けて、再読み込みしてください。{title} は他のプロジェクトを何も変更しません。",
    routeUnknown: "{cli} edge route --for nginx、caddy または traefik",
  },
};

/** One line, its placeholders filled. */
export function addressWord(
  lang: UiLanguage,
  key: AddressWord,
  vars: Record<string, string | number> = {},
): string {
  const s =
    (ADDRESS_WORDS[lang] ?? ADDRESS_WORDS.en)[key] ?? ADDRESS_WORDS.en[key];
  return s.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in vars ? String(vars[k]) : m,
  );
}
