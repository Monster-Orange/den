/**
 * Issue 455: the address Den gives people, checked first. Den never
 * prints, links or opens an address it hasn't just proven reaches this
 * Den (den-identity.ts: a challenge only this install answers).
 *
 *  - The address people are given (web.url, D80) answers as this Den:
 *    that one.
 *  - It doesn't (another server holds its port and answers, or nothing
 *    does): Den's own port on this machine, http://localhost:<web port>,
 *    when that answers as this Den, and one line that says why, naming
 *    what holds the port when Den can see it (port-owner.ts).
 *  - Neither answers as this Den (its web server isn't running): nothing
 *    is claimed; callers keep what they did before and say it is
 *    unchecked.
 *
 * The probe's limits are Settings with permissive defaults
 * (web.address_check_timeout_seconds, web.address_check_retries).
 * The command line says the notice once per change (noticeOnce), never on
 * every run.
 */
import * as fs from "fs";
import * as path from "path";
import { writeFileAtomic } from "../atomic-write.js";
import { readUserConfig, type UserConfig } from "../den-config.js";
import {
  identityKey,
  probeIdentity,
  type ProbeResult,
} from "../den-identity.js";
import { localhostOrigin } from "../web-session.js";
import { isLoopbackName } from "../web-url-check.js";
import { readWebSecret } from "../web-secret.js";
import { portInUse } from "../port-pick.js";
import { addressWord, type AddressWord } from "./address-words.js";
import { portOwner, type PortOwner } from "./port-owner.js";
import {
  proxyKindOf,
  proxyRoutes,
  upstreamHostFor,
  type ProxyKind,
  type RouteTarget,
} from "./proxy-route.js";
import { uiLanguage, type UiLanguage } from "../../ui/server/ui-language.js";

/** The probe's limits: Settings, with permissive defaults. */
export const ADDRESS_CHECK_LIMITS = {
  timeout_seconds: { min: 0.5, max: 600, default: 5 },
  retries: { min: 0, max: 20, default: 2 },
  cache_seconds: { min: 0, max: 86_400, default: 60 },
} as const;

export interface AddressCheckSettings {
  timeoutMs: number;
  retries: number;
  /** How long the page reuses the last check (web.address_check_cache_seconds). */
  cacheMs: number;
}

function limited(v: unknown, l: { min: number; max: number; default: number }) {
  return typeof v === "number" && Number.isFinite(v) && v >= l.min && v <= l.max
    ? v
    : l.default;
}

/** user.yml web.address_check_timeout_seconds, _retries and _cache_seconds. */
export function addressCheckSettings(
  read: () => UserConfig = readUserConfig,
): AddressCheckSettings {
  let web: Record<string, unknown> = {};
  try {
    const w = read().web;
    if (w && typeof w === "object" && !Array.isArray(w)) web = w;
  } catch {
    /* defaults */
  }
  return {
    timeoutMs:
      limited(
        web.address_check_timeout_seconds,
        ADDRESS_CHECK_LIMITS.timeout_seconds,
      ) * 1000,
    retries: Math.round(
      limited(web.address_check_retries, ADDRESS_CHECK_LIMITS.retries),
    ),
    cacheMs:
      limited(
        web.address_check_cache_seconds,
        ADDRESS_CHECK_LIMITS.cache_seconds,
      ) * 1000,
  };
}

/** What answered the address people are given, when it wasn't this Den. */
export type WantedAnswer = "den" | "other" | "nothing" | "unknown";

export interface PortState {
  port: number;
  held: boolean;
  /** Who holds it, when it is held and Den can see who. */
  by: PortOwner | null;
}

export interface AddressState {
  checkedAt: string;
  /** The address people are given (web.url), or null when it isn't set. */
  wanted: string | null;
  /** How the wanted address answered. */
  wantedAnswer: WantedAnswer;
  /** Den's own port on this machine (http://localhost:<web port>). */
  direct: string;
  /** Whether the direct address answered as this Den. */
  directOk: boolean;
  /**
   * The address to print and open: one just proven to be this Den, or
   * null when none is (Den's web server isn't answering).
   */
  address: string | null;
  /** The wanted address's port, and whether something else holds it. */
  port: number | null;
  /** What holds that port, when Den can see it. */
  owner: PortOwner | null;
  /** What answered instead, as words can say it ("nginx"), or null. */
  answeredAs: string | null;
  /** The route another proxy needs, for each kind (when one holds it). */
  routes: Record<ProxyKind, string> | null;
  /** The kind most likely in front ("nginx" for an nginx container). */
  routeKind: ProxyKind | null;
}

export interface CheckDeps {
  /** Den's web port here. */
  webPort: number;
  /** The address people are given (web.url), or null. */
  wanted: string | null;
  /** The identity key (identityKey(web.secret)), or null: nothing proves. */
  key: Buffer | null;
  settings?: AddressCheckSettings;
  probe?: typeof probeIdentity;
  owner?: (port: number) => PortOwner | null;
  /** The product's command ("den"), for the Traefik route's name. */
  cli?: string;
  now?: () => Date;
  /**
   * Whether this install's edge, which serves the wanted address, is down:
   * true or false when Den knows, null when it doesn't (the CLI's lines,
   * upAddressLines). Not used by the check itself.
   */
  edgeDown?: () => boolean | null;
}

/** The person's language (user.yml `language`, R19) for the CLI's words. */
export function cliLanguage(
  read: () => UserConfig = readUserConfig,
): UiLanguage {
  try {
    return uiLanguage(read().language);
  } catch {
    return "en";
  }
}

/** The identity key from this machine's web.secret, or null. */
export function localIdentityKey(stateDir: string): Buffer | null {
  const s = readWebSecret(stateDir);
  return s ? identityKey(s) : null;
}

/** "nginx/1.27.3 (Ubuntu)" → "nginx". */
export function serverName(header: string | null | undefined): string | null {
  const s = String(header ?? "").trim();
  if (!s) return null;
  return s.split(/[\s/]/)[0] || null;
}

function wantedPort(u: URL): number {
  return Number(u.port) || (u.protocol === "https:" ? 443 : 80);
}

function answerOf(r: ProbeResult): WantedAnswer {
  if (r.ok) return "den";
  if (r.other) return "other";
  if (r.hits.length && r.hits.every((h) => h.kind === "refused"))
    return "nothing";
  return "unknown";
}

/** Check the address people are given, and Den's own, now. */
export async function checkAddress(d: CheckDeps): Promise<AddressState> {
  const settings = d.settings ?? addressCheckSettings();
  const probe = d.probe ?? probeIdentity;
  const now = (d.now ?? (() => new Date()))();
  const direct = localhostOrigin(d.webPort);
  const base: AddressState = {
    checkedAt: now.toISOString(),
    wanted: d.wanted,
    wantedAnswer: "unknown",
    direct,
    directOk: false,
    address: null,
    port: null,
    owner: null,
    answeredAs: null,
    routes: null,
    routeKind: null,
  };
  if (!d.key) return base;
  const opts = {
    key: d.key,
    timeoutMs: settings.timeoutMs,
    retries: settings.retries,
  };
  // Den's own port first: when it doesn't answer as this Den (its server
  // isn't running here), an address elsewhere isn't asked either.
  const own = await probe(direct, opts);
  const askWanted =
    !!d.wanted && (own.ok || isLoopbackName(new URL(d.wanted).hostname));
  const want = askWanted && d.wanted ? await probe(d.wanted, opts) : null;
  base.directOk = own.ok;
  if (want) base.wantedAnswer = answerOf(want);
  if (want?.ok) return { ...base, address: d.wanted };
  base.address = own.ok ? direct : null;
  if (!d.wanted) return base;
  const u = new URL(d.wanted);
  const port = wantedPort(u);
  base.port = port;
  // Who holds it: only a port on this machine can be looked up here.
  const local = isLoopbackName(u.hostname);
  const owner = local && want?.other ? (d.owner ?? portOwner)(port) : null;
  base.owner = owner;
  // Another Den install answering (a wrong answer) has no name to give:
  // the words then say "something Den cannot name".
  base.answeredAs = owner?.owner ?? serverName(want?.other?.server) ?? null;
  if (local && want?.other) {
    const t: RouteTarget = {
      host: u.hostname,
      listen: port,
      upstreamHost: upstreamHostFor(owner?.kind ?? null),
      upstreamPort: d.webPort,
      name: d.cli ?? "den",
    };
    base.routes = proxyRoutes(t);
    base.routeKind = proxyKindOf(owner?.owner ?? base.answeredAs);
  }
  return base;
}

/**
 * The address to give people. The wanted one (web.url) unless the check
 * found another server answering it: then Den's own port, proven. When
 * nothing answers the wanted address (or it can't be asked from here),
 * it is still the one given (D80: web.url is the address, no fallback):
 * no other server is reached, and doctor says it wasn't checked.
 */
export function givenAddress(s: AddressState): string | null {
  if (s.wantedAnswer === "other" && s.address) return s.address;
  return s.wanted ?? s.address;
}

/**
 * Next to the address Den gives, when nothing answers it (issue 455,
 * Vision): it is still the one given (D80), and the CLI says so plainly.
 * "The edge isn't running." and its next step only when Den knows the
 * edge is down (`edgeDown` true); otherwise nothing more.
 */
export function upAddressLines(
  s: AddressState,
  w: NoticeWords,
  edgeDown: boolean | null,
): string[] {
  if (!s.wanted || s.wantedAnswer !== "nothing") return [];
  if (givenAddress(s) !== s.wanted) return [];
  const out = [addressWord(w.lang, "unreachable", { address: s.wanted })];
  if (edgeDown === true)
    out.push(addressWord(w.lang, "edgeDown", { cli: w.cli }));
  return out;
}

/** A host port, and who holds it (issue 455: Edge's Ports row). */
export async function portState(
  port: number,
  owner: (port: number) => PortOwner | null = portOwner,
  inUse: (port: number) => Promise<boolean> = (p) => portInUse(p),
): Promise<PortState> {
  const held = await inUse(port);
  return { port, held, by: held ? owner(port) : null };
}

export interface NoticeWords {
  lang: UiLanguage;
  title: string;
  cli: string;
}

/**
 * The one sentence (mock v3, "Words, in one place"), or null when the
 * address people are given works (or nothing was proven at all).
 */
export function noticeLine(s: AddressState, w: NoticeWords): string | null {
  if (!s.address || s.address === s.wanted || !s.wanted) return null;
  // Only another server answering moves the address (givenAddress).
  if (s.wantedAnswer !== "other") return null;
  const v = {
    title: w.title,
    cli: w.cli,
    port: s.port ?? "",
    address: s.address,
    wanted: s.wanted,
    owner: s.answeredAs ?? "",
    name: s.owner?.name ?? "",
    kind: s.owner
      ? addressWord(w.lang, `kind.${s.owner.kind}` as AddressWord)
      : "",
  };
  return addressWord(
    w.lang,
    s.owner ? "held" : s.answeredAs ? "heldBare" : "unknown",
    v,
  );
}

/** `den web up`'s lines when the address people are given isn't Den. */
export function upNoticeLines(
  s: AddressState,
  w: NoticeWords,
  link: string | null,
): string[] {
  const line = noticeLine(s, w);
  if (!line || !s.wanted) return [];
  const out = [line];
  if (link) out.push(addressWord(w.lang, "open", { link }));
  out.push(
    addressWord(w.lang, "toUse", {
      host: new URL(s.wanted).hostname,
      cli: w.cli,
    }),
  );
  return out;
}

/** `den doctor`'s lines for the address (mock v3's doctor frame). */
export function doctorAddressLines(
  s: AddressState,
  w: NoticeWords,
): { status: "ok" | "warn"; lines: string[] } {
  const v = {
    title: w.title,
    cli: w.cli,
    port: s.port ?? "",
    address: s.address ?? s.direct,
    wanted: s.wanted ?? "",
    owner: s.answeredAs ?? "",
    name: s.owner?.name ?? "",
    kind:
      s.owner?.kind === "container"
        ? "container"
        : s.owner
          ? addressWord(w.lang, "kind.process")
          : "",
  };
  if (!s.directOk && s.wantedAnswer !== "den")
    return {
      status: "warn",
      lines: [addressWord(w.lang, "doctor.unchecked", v)],
    };
  if (s.wantedAnswer === "den" || !s.wanted)
    return {
      status: "ok",
      lines: [
        addressWord(w.lang, "doctor.ok", {
          ...v,
          address: s.wanted ?? s.direct,
        }),
      ],
    };
  const head: AddressWord =
    s.wantedAnswer !== "other"
      ? "doctor.headNone"
      : s.owner
        ? "doctor.head"
        : s.answeredAs
          ? "doctor.headBare"
          : "doctor.headUnknown";
  const lines = [
    addressWord(w.lang, head, v),
    addressWord(w.lang, "doctor.checked", v),
  ];
  if (s.wantedAnswer === "other") {
    lines.push(addressWord(w.lang, "doctor.options", v));
    lines.push(addressWord(w.lang, "doctor.route", v));
  }
  return { status: "warn", lines };
}

const NOTICE_FILE = "address-notice.json";

/**
 * Whether the notice is new (the working address, or what holds the port,
 * changed since it was last said), recording it. Once per change, never
 * on every run (mock v3).
 */
export function noticeOnce(stateDir: string, s: AddressState): boolean {
  const key = JSON.stringify([
    s.address,
    s.wanted,
    s.answeredAs,
    s.owner?.name ?? null,
  ]);
  const file = path.join(stateDir, NOTICE_FILE);
  let last: string | null = null;
  try {
    last =
      (JSON.parse(fs.readFileSync(file, "utf8")) as { key?: string }).key ??
      null;
  } catch {
    last = null;
  }
  if (last === key) return false;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    writeFileAtomic(file, JSON.stringify({ key, at: s.checkedAt }) + "\n");
  } catch {
    /* said anyway; said again next time */
  }
  return true;
}
