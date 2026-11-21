/**
 * Gate: a browser slot on macOS needs a container browser.
 *
 * A browser suite started on a shared Mac drives that Mac's own WebKit.
 * Several at once can take its window server down, and every login
 * session on the Mac with it. So on macOS (a Setting, on by default
 * there and off elsewhere: gate_slots.browser_requires_container) a
 * browser-kind ask declares where its browser runs:
 *
 *  - a container's Playwright endpoint, a ws:// or wss:// address (`gate
 *    run --browser-endpoint`, or DEN_PW_WS, HUB_PW_WEBKIT_WS or
 *    E2E_WEBKIT_WS in the run's environment; `browser_endpoint` over MCP
 *    and HTTP);
 *  - or "self": the run starts its own browser container, so no address
 *    exists yet when it asks (its own guard keeps it in the container).
 *
 * A run for a named test box uses that box's browser and needs neither.
 * An endpoint that is given is checked everywhere, Setting on or off. The
 * slot records what was declared ("self", or the address without its
 * path), so status shows it.
 *
 * One rule (`browserSlotCheck`), called by `gate run`, the MCP tool
 * gate_slot_request and the runners' POST /api/gate-slots/ask.
 */
import type { UiLanguage } from "../../ui/server/ui-language.js";
import type { GateKind } from "./rules.js";

/** Where a run's environment may name its container browser, in order. */
export const BROWSER_ENDPOINT_VARS = [
  "DEN_PW_WS",
  "HUB_PW_WEBKIT_WS",
  "E2E_WEBKIT_WS",
] as const;

/** The run starts its own browser container. */
export const SELF = "self";

/** The Setting's default for a host: on for macOS, off elsewhere. */
export function browserRequiresContainerDefault(
  platform: NodeJS.Platform,
): boolean {
  return platform === "darwin";
}

/** null when `raw` declares a container browser; else what is wrong. */
export function checkBrowserEndpoint(raw: string): string | null {
  if (raw === SELF) return null;
  const want = "a ws:// or wss:// address of a Playwright endpoint, or self";
  if (!raw || raw.length > 2048 || /\s/.test(raw)) return want;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return want;
  }
  if ((u.protocol !== "ws:" && u.protocol !== "wss:") || !u.hostname)
    return want;
  return null;
}

/** What a slot records: "self", or the address without path or login. */
export function declaredOf(endpoint: string): string {
  if (endpoint === SELF) return SELF;
  const u = new URL(endpoint);
  return `${u.protocol}//${u.host}`;
}

/**
 * The run's environment: the first of BROWSER_ENDPOINT_VARS that is a
 * good endpoint; else the first one set (so a refusal names it); else
 * none.
 */
export function endpointFromEnv(
  env: NodeJS.ProcessEnv,
): { endpoint: string; from: string } | undefined {
  const set = BROWSER_ENDPOINT_VARS.map((from) => ({
    from,
    endpoint: (env[from] ?? "").trim(),
  })).filter((x) => x.endpoint);
  return set.find((x) => !checkBrowserEndpoint(x.endpoint)) ?? set[0];
}

export interface BrowserSlotAsk {
  kind: GateKind;
  /** What the ask declared: an address, or "self". */
  endpoint?: string;
  /** Issue 625: "local", "any", or a test box's name. */
  where?: string;
  /** The host's platform (the store's). */
  platform: NodeJS.Platform;
  /** The Setting; absent: the platform's default. */
  requiresContainer?: boolean;
}

export type BrowserSlotVerdict =
  | { ok: true; declared?: string }
  | { ok: false; code: "browser_needs_container" | "browser_endpoint_bad" };

/** Whether this ask may queue for a slot, and what it declared. */
export function browserSlotCheck(a: BrowserSlotAsk): BrowserSlotVerdict {
  if (a.kind !== "browser") return { ok: true };
  if (a.endpoint !== undefined) {
    if (checkBrowserEndpoint(a.endpoint))
      return { ok: false, code: "browser_endpoint_bad" };
    return { ok: true, declared: declaredOf(a.endpoint) };
  }
  if (a.where && a.where !== "local" && a.where !== "any") return { ok: true };
  const requires =
    a.requiresContainer ?? browserRequiresContainerDefault(a.platform);
  return requires
    ? { ok: false, code: "browser_needs_container" }
    : { ok: true };
}

type Word = "needsCli" | "needsField" | "bad";

/**
 * The refusal, in each language the UI ships (a test keeps the three
 * even, placeholders too). {cli} the command, {vars} the variables,
 * {from} where a bad endpoint came from, {value} what it was.
 */
export const BROWSER_WORDS: Record<UiLanguage, Record<Word, string>> = {
  en: {
    needsCli:
      'a browser run on this macOS host must use a browser in a container, never one started on this machine. Set {vars} to the container\'s Playwright server (ws:// or wss://), or pass --browser-endpoint ws://…; a run that starts its own browser container passes --browser-endpoint=self. Or turn the rule off: {cli} gate settings --browser-requires-container 0 (Settings, "Browser runs need a container").',
    needsField:
      'a browser slot on this macOS host must use a browser in a container, never one started on this machine. Give browser_endpoint: the container\'s Playwright server (ws:// or wss://), or "self" when the run starts its own browser container. Or a person turns the rule off: {cli} gate settings --browser-requires-container 0 (Settings, "Browser runs need a container").',
    bad: '{from} is "{value}": give a ws:// or wss:// address of a Playwright endpoint, or self when the run starts its own browser container.',
  },
  es: {
    needsCli:
      'una ejecución de navegador en este Mac debe usar un navegador en un contenedor, nunca uno iniciado en esta máquina. Define {vars} con el endpoint de Playwright del contenedor (ws:// o wss://), o pasa --browser-endpoint ws://…; una ejecución que inicia su propio contenedor de navegador pasa --browser-endpoint=self. O desactiva la regla: {cli} gate settings --browser-requires-container 0 (Ajustes, "Las ejecuciones de navegador necesitan un contenedor").',
    needsField:
      'un turno de navegador en este Mac debe usar un navegador en un contenedor, nunca uno iniciado en esta máquina. Indica browser_endpoint: el endpoint de Playwright del contenedor (ws:// o wss://), o "self" cuando la ejecución inicia su propio contenedor de navegador. O una persona desactiva la regla: {cli} gate settings --browser-requires-container 0 (Ajustes, "Las ejecuciones de navegador necesitan un contenedor").',
    bad: '{from} es "{value}": indica una dirección ws:// o wss:// de un endpoint de Playwright, o self cuando la ejecución inicia su propio contenedor de navegador.',
  },
  ja: {
    needsCli:
      "この macOS ホストでのブラウザ実行は、コンテナ内のブラウザを使う必要があります。このマシンで起動したブラウザは使えません。{vars} にコンテナの Playwright エンドポイント (ws:// または wss://) を設定するか、--browser-endpoint ws://… を渡してください。自分でブラウザのコンテナを起動する実行は --browser-endpoint=self を渡します。またはルールをオフにします: {cli} gate settings --browser-requires-container 0 (設定の「ブラウザ実行にはコンテナが必要」)。",
    needsField:
      'この macOS ホストでのブラウザ枠は、コンテナ内のブラウザを使う必要があります。このマシンで起動したブラウザは使えません。browser_endpoint を渡してください: コンテナの Playwright エンドポイント (ws:// または wss://)、または実行が自分でブラウザのコンテナを起動するときは "self"。またはルールを人がオフにします: {cli} gate settings --browser-requires-container 0 (設定の「ブラウザ実行にはコンテナが必要」)。',
    bad: '{from} が "{value}" です: Playwright エンドポイントの ws:// または wss:// のアドレスか、実行が自分でブラウザのコンテナを起動するときは self を渡してください。',
  },
};

/** The refusal for a verdict that isn't ok, filled in. */
export function browserSlotRefusal(
  v: { ok: false; code: "browser_needs_container" | "browser_endpoint_bad" },
  o: {
    lang: UiLanguage;
    /** cli: `gate run`'s flags and variables; field: browser_endpoint. */
    surface: "cli" | "field";
    cli: string;
    from?: string;
    value?: string;
  },
): string {
  const words = BROWSER_WORDS[o.lang] ?? BROWSER_WORDS.en;
  const key: Word =
    v.code === "browser_endpoint_bad"
      ? "bad"
      : o.surface === "cli"
        ? "needsCli"
        : "needsField";
  const vars: Record<string, string> = {
    cli: o.cli,
    vars: BROWSER_ENDPOINT_VARS.join(", "),
    from:
      o.from ??
      (o.surface === "cli" ? "--browser-endpoint" : "browser_endpoint"),
    value: (o.value ?? "").slice(0, 200),
  };
  return words[key].replace(/\{(\w+)\}/g, (m, k: string) =>
    k in vars ? vars[k]! : m,
  );
}
