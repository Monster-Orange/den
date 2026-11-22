/**
 * Issue 1073: a test install's name map for Den's own address checks.
 *
 * A test install can't prove an address on a private name (for example
 * `<name>.bed.test`): Den's address check resolves names through this
 * machine's DNS, and a private name needs /etc/hosts, which needs sudo.
 * Its launcher may instead pass `<PREFIX>_TEST_RESOLVE="name=ip,name=ip"`
 * in the server's own start environment (never a file, never a setting,
 * never a request). The server takes it out of its environment at start.
 * It is consulted only by Den's checks of its own address (the address
 * proof, Check and save, making an alias the address, the server agent's
 * address write), and only while the install is a test install: on any
 * other install it is ignored, and the server's log and doctor say so.
 */
import * as fs from "fs";
import * as net from "net";
import * as path from "path";

/** The launcher's map, `<PREFIX>_TEST_RESOLVE` (profile readEnv). */
export const TEST_RESOLVE_ENV_KEY = "TEST_RESOLVE";

const NAME_RE =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;

const norm = (h: string) => h.trim().toLowerCase().replace(/\.$/, "");

/** The map, or why it can't be read (then none of it is used). */
export function parseTestResolve(
  v: string | undefined,
): { ok: true; map: Map<string, string> } | { ok: false; error: string } {
  const map = new Map<string, string>();
  for (const raw of (v ?? "").split(",")) {
    const pair = raw.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    const name = eq > 0 ? norm(pair.slice(0, eq)) : "";
    const ip = eq > 0 ? pair.slice(eq + 1).trim() : "";
    if (!NAME_RE.test(name) || net.isIP(name) || !net.isIP(ip))
      return {
        ok: false,
        error: `"${pair.slice(0, 80)}" isn't name=ip (a host name, then an IPv4 or IPv6 address)`,
      };
    map.set(name, ip);
  }
  return { ok: true, map };
}

/**
 * The address the map gives `host`, or null (DNS decides). `testInstall`
 * is asked at every lookup: the map counts only while it holds.
 */
export function testResolver(
  map: ReadonlyMap<string, string>,
  testInstall: () => boolean,
): (host: string) => string | null {
  return (host) => {
    if (!map.size) return null;
    const ip = map.get(norm(host));
    return ip && testInstall() ? ip : null;
  };
}

/** What the server's log and doctor say when the map is set but unused. */
export function testResolveIgnored(envName: string, why: string): string {
  return `${envName} is ignored: ${why}. Den's address checks use this machine's DNS.`;
}

/**
 * The server's hook, set once at start (index.ts). Den's resolvers ask it
 * first: health.ts's resolveName (pingHttp: Check and save, making an
 * alias the address, web_url_set) and den-identity's lookup (the address
 * proof). Unset, or null for a name: DNS as before.
 */
let hook: ((host: string) => string | null) | null = null;
export function setTestResolve(
  fn: ((host: string) => string | null) | null,
): void {
  hook = fn;
}
export function testResolveLookup(host: string): string | null {
  return hook ? hook(host) : null;
}

/** What the server decided at start, for doctor (state dir). */
export const TEST_RESOLVE_STATE_FILE = "test-resolve.json";
export type TestResolveState =
  | { state: "used"; names: string[] }
  | { state: "ignored"; env: string; why: string };

export function writeTestResolveState(
  dir: string,
  s: TestResolveState | null,
): void {
  const p = path.join(dir, TEST_RESOLVE_STATE_FILE);
  try {
    if (!s) fs.rmSync(p, { force: true });
    else {
      // The server writes this at start, before it makes its state folder.
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(p, JSON.stringify(s) + "\n", { mode: 0o600 });
    }
  } catch {
    /* doctor just says nothing */
  }
}

export function readTestResolveState(dir: string): TestResolveState | null {
  try {
    const v = JSON.parse(
      fs.readFileSync(path.join(dir, TEST_RESOLVE_STATE_FILE), "utf8"),
    ) as TestResolveState;
    return v.state === "used" || v.state === "ignored" ? v : null;
  } catch {
    return null;
  }
}

/** Doctor's line, or null when the map isn't set. */
export function testResolveDoctorLine(
  s: TestResolveState | null,
): string | null {
  if (!s) return null;
  if (s.state === "used")
    return `  test names  ✓  this test install's address checks resolve ${s.names.join(", ")} from its start environment`;
  return `  test names  ✗  ${testResolveIgnored(s.env, s.why)}`;
}
