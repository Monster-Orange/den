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
 *
 * An address is not taken on its word. While the Setting needs a
 * container, a ws:// to loopback or to one of the host's own addresses
 * reaches a Playwright server started on this machine, unless a running
 * container publishes that port: so it passes only when `docker ps` shows
 * one does. And on the strict level (2), "self" is refused too: the gate
 * can't check that a run starts its own container before it starts.
 */
import { execFile } from "child_process";
import * as dns from "dns";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import { uiLanguage, type UiLanguage } from "../ui-language.js";
import {
  readDenConfig,
  readInstallMode,
  readUserConfig,
  type InstallMode,
} from "../den-config.js";

export type { UiLanguage };

/** The person's language (user.yml), for the command line; else English. */
export function personLanguage(): UiLanguage {
  try {
    return uiLanguage(readUserConfig().language);
  } catch {
    return "en";
  }
}
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

/** The port an endpoint's address names (its scheme's default if none). */
function portOf(u: URL): number {
  if (u.port) return Number(u.port);
  return u.protocol === "wss:" ? 443 : 80;
}

/** An IPv4 address on loopback or the any-address. */
function hostV4(h: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === "0.0.0.0";
}

/**
 * A hostname or address as compared here: lower case, no brackets, no
 * trailing dot, and an IPv4 address carried in IPv6 (::ffff:a.b.c.d,
 * ::a.b.c.d, or URL's hex form ::ffff:7f00:1) written as IPv4.
 */
export function normalizeAddress(raw: string): string {
  let h = raw.trim().toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  while (h.endsWith(".")) h = h.slice(0, -1);
  const v4in6 = /^::(?:ffff:)?(.+)$/.exec(h);
  if (v4in6) {
    const rest = v4in6[1]!;
    if (net.isIPv4(rest)) return rest;
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex) {
      const hi = parseInt(hex[1]!, 16);
      const lo = parseInt(hex[2]!, 16);
      return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
    }
  }
  return h;
}

/** A loopback name: localhost or a name under it. */
function loopbackName(h: string): boolean {
  return h === "localhost" || h.endsWith(".localhost");
}

/**
 * Whether a hostname or address is this machine: loopback names and
 * addresses, the any-address, or one of `own` (its interface addresses).
 */
export function isHostAddress(raw: string, own: readonly string[] = []) {
  const h = normalizeAddress(raw);
  if (loopbackName(h)) return true;
  if (hostV4(h) || h === "::1" || h === "::") return true;
  return own.some((a) => normalizeAddress(a) === h);
}

/** The host's own interface addresses. */
export function ownAddresses(): string[] {
  return Object.values(os.networkInterfaces())
    .flat()
    .map((i) => i?.address)
    .filter((a): a is string => !!a);
}

/** A host address and port a running container publishes. */
export interface Binding {
  address: string;
  port: number;
}

/** The bindings in `docker ps --format {{.Ports}}` output. */
export function parsePublished(out: string): Binding[] {
  const found: Binding[] = [];
  for (const entry of out.split(/[,\n]/)) {
    const m = /^\s*(.*):(\d+)(?:-(\d+))?->/.exec(entry);
    if (!m) continue;
    const address = normalizeAddress(m[1] || "0.0.0.0");
    const a = Number(m[2]);
    const b = m[3] ? Number(m[3]) : a;
    for (let p = a; p <= b && p - a < 1024; p++)
      found.push({ address, port: p });
  }
  return found;
}

/** Whether a published binding answers on `address` (normalized). */
function covers(b: Binding, address: string, port: number): boolean {
  if (b.port !== port) return false;
  if (b.address === "::") return true;
  if (b.address === "0.0.0.0") return net.isIPv4(address);
  return b.address === address;
}

/**
 * The account's home folder from the user database, never $HOME (which
 * the caller's environment sets). Empty if it can't be read.
 */
export function accountHome(): string {
  try {
    return os.userInfo().homedir;
  } catch {
    return "";
  }
}

/**
 * Docker's environment: the caller's, without anything that points the
 * command at another engine or config (DOCKER_HOST, DOCKER_CONTEXT,
 * DOCKER_CONFIG), PATH fixed, and HOME the account's (so ~/.docker is the
 * real one).
 */
export function dockerEnv(
  from: NodeJS.ProcessEnv,
  home: string = accountHome(),
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...from, PATH: "/usr/bin:/bin" };
  delete env.DOCKER_HOST;
  delete env.DOCKER_CONTEXT;
  delete env.DOCKER_CONFIG;
  if (home) env.HOME = home;
  else delete env.HOME;
  return env;
}

/**
 * Where Docker's command is looked for, system folders first. Never the
 * caller's PATH: `gate run` runs in the agent's own environment.
 */
export function dockerCandidates(home = accountHome()): string[] {
  return [
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/usr/bin/docker",
    "/Applications/Docker.app/Contents/Resources/bin/docker",
    ...(home ? [`${home}/.orbstack/bin/docker`] : []),
  ];
}

/**
 * What running containers publish on this host. Rejects when Docker can't
 * be asked: then nothing is proven. Run with dockerEnv, so the account's
 * own engine answers.
 */
export function dockerPublished(timeoutMs = 3000): Promise<Binding[]> {
  const bin = dockerCandidates().find((p) => fs.existsSync(p));
  if (!bin) return Promise.reject(new Error("docker not found"));
  const env = dockerEnv(process.env);
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      ["ps", "--format", "{{.Ports}}"],
      { timeout: timeoutMs, env },
      (e, stdout) => (e ? reject(e) : resolve(parsePublished(stdout))),
    );
  });
}

/** A name's addresses (dns.lookup, all of them); rejects on failure. */
export async function resolveName(
  name: string,
  timeoutMs = 3000,
): Promise<string[]> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const found = await Promise.race([
      dns.promises.lookup(name, { all: true }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("lookup timed out")),
          timeoutMs,
        );
      }),
    ]);
    return found.map((f) => f.address);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  /** The Setting's strict level (2): "self" is refused too. */
  strict?: boolean;
  /**
   * The install's mode. The endpoint checks below (proof for a host
   * address, level 2's "self") apply on strict only: a personal install
   * takes a declared endpoint at its word. Absent: strict.
   */
  mode?: InstallMode;
  /**
   * What running containers publish on this host; absent: unknown, so a
   * host address isn't proven to be a container.
   */
  published?: readonly Binding[];
  /** The host's own addresses (beyond loopback). */
  hostAddresses?: readonly string[];
  /**
   * The endpoint's name, resolved (all its addresses). Absent or empty
   * for a name that isn't an address: unresolved, so not proven.
   */
  resolved?: readonly string[];
  /**
   * Issue 1198: some test box could take it (boxCouldServe). "any" with no
   * browser of its own waits for a box only when one could.
   */
  boxCouldServe?: boolean;
}

export type BrowserRefusalCode =
  | "browser_needs_container"
  | "browser_endpoint_bad"
  | "browser_endpoint_host"
  | "browser_self_strict";

export type BrowserSlotVerdict =
  | { ok: true; declared?: string; boxesOnly?: true }
  | { ok: false; code: BrowserRefusalCode };

/**
 * The addresses an endpoint's host stands for, if known without a lookup:
 * an address itself, or both loopbacks for a loopback name. Null: a name
 * that needs resolving.
 */
function literalAddresses(hostname: string): string[] | null {
  const h = normalizeAddress(hostname);
  if (net.isIP(h)) return [h];
  if (loopbackName(h)) return ["127.0.0.1", "::1"];
  return null;
}

/** Whether this ask may queue for a slot, and what it declared. */
export function browserSlotCheck(a: BrowserSlotAsk): BrowserSlotVerdict {
  if (a.kind !== "browser") return { ok: true };
  const requires =
    a.requiresContainer ?? browserRequiresContainerDefault(a.platform);
  if (a.endpoint !== undefined) {
    if (checkBrowserEndpoint(a.endpoint))
      return { ok: false, code: "browser_endpoint_bad" };
    const strictInstall = (a.mode ?? "strict") === "strict";
    if (requires && strictInstall && a.endpoint === SELF && a.strict)
      return { ok: false, code: "browser_self_strict" };
    if (requires && strictInstall && a.endpoint !== SELF) {
      const u = new URL(a.endpoint);
      const port = portOf(u);
      const addrs = (literalAddresses(u.hostname) ?? a.resolved ?? []).map(
        normalizeAddress,
      );
      // Every address the name stands for that is this machine must be
      // one a container publishes on that port; unresolved: not proven.
      const own = a.hostAddresses ?? [];
      const proven =
        addrs.length > 0 &&
        addrs
          .filter((x) => isHostAddress(x, own))
          .every((x) => (a.published ?? []).some((b) => covers(b, x, port)));
      if (!proven) return { ok: false, code: "browser_endpoint_host" };
    }
    return { ok: true, declared: declaredOf(a.endpoint) };
  }
  if (a.where && a.where !== "local" && a.where !== "any") return { ok: true };
  if (!requires) return { ok: true };
  // Issue 1198: one that may take a box (whose browser is a container)
  // waits for a box, never this machine.
  if (a.where === "any" && a.boxCouldServe)
    return { ok: true, boxesOnly: true };
  return { ok: false, code: "browser_needs_container" };
}

/** What `browserSlotCheckOn` reads from the gate's store. */
export interface BrowserCheckHost {
  platform: NodeJS.Platform;
  settings(): {
    browserRequiresContainer: boolean;
    browserContainerStrict: boolean;
  };
  containerBindings(): Promise<readonly Binding[]>;
  hostAddresses(): readonly string[];
  resolveHost(name: string): Promise<readonly string[]>;
  /** The install's mode (readInstallMode); unreadable: strict. */
  installMode(): InstallMode;
}

/** The install's mode from user.yml and den.yml; unreadable: strict. */
export function installModeNow(): InstallMode {
  try {
    return readInstallMode(readUserConfig(), {
      install_mode: readDenConfig().install_mode,
    });
  } catch {
    return "strict";
  }
}

/**
 * The rule with the store's Setting. While a container is needed it
 * resolves the endpoint's name and, if any address is this machine, asks
 * Docker what containers publish. A lookup or Docker that fails: not
 * proven.
 */
export async function browserSlotCheckOn(
  host: BrowserCheckHost,
  a: {
    kind: GateKind;
    endpoint?: string;
    where?: string;
    /** Issue 1198: some test box could take it (boxCouldServe). */
    boxCouldServe?: boolean;
  },
): Promise<BrowserSlotVerdict> {
  const s = host.settings();
  let mode: InstallMode;
  try {
    mode = host.installMode();
  } catch {
    mode = "strict";
  }
  const ask: BrowserSlotAsk = {
    ...a,
    platform: host.platform,
    requiresContainer: s.browserRequiresContainer,
    strict: s.browserContainerStrict,
    mode,
  };
  if (
    a.kind === "browser" &&
    s.browserRequiresContainer &&
    mode === "strict" &&
    a.endpoint !== undefined &&
    a.endpoint !== SELF &&
    !checkBrowserEndpoint(a.endpoint)
  ) {
    const own = host.hostAddresses();
    ask.hostAddresses = own;
    const hostname = new URL(a.endpoint).hostname;
    let addrs = literalAddresses(hostname);
    if (!addrs)
      try {
        addrs = [...(await host.resolveHost(normalizeAddress(hostname)))];
        ask.resolved = addrs;
      } catch {
        // Unresolved: not proven.
      }
    if (addrs?.some((x) => isHostAddress(x, own)))
      try {
        ask.published = await host.containerBindings();
      } catch {
        // Unknown: the address stays unproven.
      }
  }
  return browserSlotCheck(ask);
}

type Word = "needsCli" | "needsField" | "bad" | "host" | "selfStrict";

/**
 * The refusal, in each language the UI ships (a test keeps the three
 * even, placeholders too). {cli} the command, {vars} the variables,
 * {from} where a bad endpoint came from, {value} what it was.
 */
export const BROWSER_WORDS: Record<UiLanguage, Record<Word, string>> = {
  en: {
    needsCli:
      'a browser run on this macOS host must use a browser in a container, never one started on this machine. Set {vars} to the container\'s Playwright endpoint (ws:// or wss://), or pass --browser-endpoint ws://…; a run that starts its own browser container passes --browser-endpoint=self. Or turn the rule off: {cli} gate settings --browser-requires-container 0 (Settings, "Browser runs need a container").',
    needsField:
      'a browser slot on this macOS host must use a browser in a container, never one started on this machine. Give browser_endpoint: the container\'s Playwright endpoint (ws:// or wss://), or "self" when the run starts its own browser container. Or a person turns the rule off: {cli} gate settings --browser-requires-container 0 (Settings, "Browser runs need a container").',
    bad: '{from} is "{value}": give a ws:// or wss:// address of a Playwright endpoint, or self when the run starts its own browser container.',
    host: '{from} is "{value}": that address is this machine (or its name cannot be resolved), and no running container publishes that address and port, so it could reach a browser started here. Give the Playwright endpoint of a container (a port a container publishes, or another machine\'s address).',
    selfStrict:
      'this host is on the strict level: a run can\'t say it starts its own browser container ("self"), because that can\'t be checked before it starts. Give the Playwright endpoint of a running container. Or a person lowers the level: {cli} gate settings --browser-requires-container 1 (Settings, "Browser runs need a container").',
  },
  es: {
    needsCli:
      'una ejecución de navegador en este Mac debe usar un navegador en un contenedor, nunca uno iniciado en esta máquina. Define {vars} con el endpoint de Playwright del contenedor (ws:// o wss://), o pasa --browser-endpoint ws://…; una ejecución que inicia su propio contenedor de navegador pasa --browser-endpoint=self. O desactiva la regla: {cli} gate settings --browser-requires-container 0 (Ajustes, "Las ejecuciones de navegador necesitan un contenedor").',
    needsField:
      'un turno de navegador en este Mac debe usar un navegador en un contenedor, nunca uno iniciado en esta máquina. Indica browser_endpoint: el endpoint de Playwright del contenedor (ws:// o wss://), o "self" cuando la ejecución inicia su propio contenedor de navegador. O una persona desactiva la regla: {cli} gate settings --browser-requires-container 0 (Ajustes, "Las ejecuciones de navegador necesitan un contenedor").',
    bad: '{from} es "{value}": indica una dirección ws:// o wss:// de un endpoint de Playwright, o self cuando la ejecución inicia su propio contenedor de navegador.',
    host: '{from} es "{value}": esa dirección es esta máquina (o su nombre no se puede resolver) y ningún contenedor en marcha publica esa dirección y puerto, así que podría llegar a un navegador iniciado aquí. Indica el endpoint de Playwright de un contenedor (un puerto que publica un contenedor, o la dirección de otra máquina).',
    selfStrict:
      'esta máquina está en el nivel estricto: una ejecución no puede decir que inicia su propio contenedor de navegador ("self"), porque eso no se puede comprobar antes de que empiece. Indica el endpoint de Playwright de un contenedor en marcha. O una persona baja el nivel: {cli} gate settings --browser-requires-container 1 (Ajustes, "Las ejecuciones de navegador necesitan un contenedor").',
  },
  ja: {
    needsCli:
      "この macOS ホストでのブラウザ実行は、コンテナ内のブラウザを使う必要があります。このマシンで起動したブラウザは使えません。{vars} にコンテナの Playwright エンドポイント (ws:// または wss://) を設定するか、--browser-endpoint ws://… を渡してください。自分でブラウザのコンテナを起動する実行は --browser-endpoint=self を渡します。またはルールをオフにします: {cli} gate settings --browser-requires-container 0 (設定の「ブラウザ実行にはコンテナが必要」)。",
    needsField:
      'この macOS ホストでのブラウザ枠は、コンテナ内のブラウザを使う必要があります。このマシンで起動したブラウザは使えません。browser_endpoint を渡してください: コンテナの Playwright エンドポイント (ws:// または wss://)、または実行が自分でブラウザのコンテナを起動するときは "self"。またはルールを人がオフにします: {cli} gate settings --browser-requires-container 0 (設定の「ブラウザ実行にはコンテナが必要」)。',
    bad: '{from} が "{value}" です: Playwright エンドポイントの ws:// または wss:// のアドレスか、実行が自分でブラウザのコンテナを起動するときは self を渡してください。',
    host: '{from} が "{value}" です: このアドレスはこのマシン (または名前を解決できない) で、そのアドレスとポートを公開している実行中のコンテナがないため、ここで起動したブラウザにつながる可能性があります。コンテナの Playwright エンドポイント (コンテナが公開しているポート、または別のマシンのアドレス) を渡してください。',
    selfStrict:
      'このホストは厳格レベルです: 実行が自分でブラウザのコンテナを起動する ("self") とは言えません。起動前に確かめられないためです。実行中のコンテナの Playwright エンドポイントを渡してください。またはレベルを人が下げます: {cli} gate settings --browser-requires-container 1 (設定の「ブラウザ実行にはコンテナが必要」)。',
  },
};

/** The refusal for a verdict that isn't ok, filled in. */
export function browserSlotRefusal(
  v: { ok: false; code: BrowserRefusalCode },
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
      : v.code === "browser_endpoint_host"
        ? "host"
        : v.code === "browser_self_strict"
          ? "selfStrict"
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
