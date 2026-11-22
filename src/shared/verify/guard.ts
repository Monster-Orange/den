/**
 * Issue 214 (VERIFY-SPEC section 6, "Methods"): the method rule for a run on
 * an environment. Production sends only GET, HEAD and OPTIONS, plus the exact
 * method-and-path pairs in verify.environments.<env>.write_allow; other
 * environments send any method unless the org lists `methods`. A blocked
 * request never leaves, and is logged with the ones that did.
 */

export interface MethodRules {
  methods: string[] | "all";
  writeAllow: { method: string; path: string }[];
}

export interface RequestLog {
  method: string;
  url: string;
  status?: number;
  blocked?: true;
  error?: string;
}

export const READ_ONLY = ["GET", "HEAD", "OPTIONS"];
const METHOD_RE = /^(GET|HEAD|OPTIONS|POST|PUT|PATCH|DELETE)$/;

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};

function pairs(v: unknown, env: string): MethodRules["writeAllow"] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v))
    throw new Error(
      `verify.environments.${env}.write_allow: a list like ["POST /login"]`,
    );
  return v.map((p) => {
    const m = /^\s*([A-Za-z]+)\s+(\/\S*)\s*$/.exec(String(p));
    const method = m?.[1].toUpperCase() ?? "";
    if (!m || !METHOD_RE.test(method))
      throw new Error(
        `verify.environments.${env}.write_allow: a method and a path, like "POST /login", got ${JSON.stringify(p)}`,
      );
    return { method, path: m[2] };
  });
}

/** The rule for `env`, from Den's `verify:` block. A list under `environments` (issue 441's imported names) sets none. */
export function methodRules(raw: unknown, env: string): MethodRules {
  const e = obj(obj(obj(raw).environments)[env]);
  const production = env === "production";
  let methods: MethodRules["methods"] = production ? [...READ_ONLY] : "all";
  if (Array.isArray(e.methods)) {
    const list = e.methods.map((m) => String(m).toUpperCase());
    if (!list.every((m) => METHOD_RE.test(m)))
      throw new Error(
        `verify.environments.${env}.methods: HTTP methods, got ${JSON.stringify(e.methods)}`,
      );
    methods = list;
  }
  return { methods, writeAllow: pairs(e.write_allow, env) };
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

export function allowedRequest(
  r: MethodRules,
  method: string,
  url: string,
): boolean {
  const m = method.toUpperCase();
  if (r.methods === "all" || r.methods.includes(m)) return true;
  const p = pathOf(url);
  return r.writeAllow.some((w) => w.method === m && w.path === p);
}

export type Probe = (url: string, method?: string) => Promise<number>;

/** `probe`, under the rule: a blocked request throws and never reaches `probe`. */
export function guardProbe(
  probe: Probe,
  r: MethodRules,
  log: RequestLog[],
): Probe {
  return async (url, method = "GET") => {
    const m = method.toUpperCase();
    if (!allowedRequest(r, m, url)) {
      log.push({ method: m, url, blocked: true });
      throw new Error(`blocked: ${m} is not allowed on a read-only run`);
    }
    try {
      const status = await probe(url, m);
      log.push({ method: m, url, status });
      return status;
    } catch (e) {
      log.push({ method: m, url, error: (e as Error).message });
      throw e;
    }
  };
}
