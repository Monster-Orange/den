/**
 * Values the server sends, in the page's language (issue 171): a Docker
 * state ("running"), the edge's TLS strategy ("none"), a GitHub run or
 * deploy state ("failure"), a health check's reason ("fetch failed"), a
 * perf report's status and metric labels. The server keeps sending its
 * own words (the CLI and agents read them); the pages show these.
 *
 * A value with no word here is shown as sent: a name or a tool's output.
 */

/** A word in the page's language: shell.js's catalog. Without the shell, the key. */
const t = (key, vars) => globalThis.window?.denShell?.t?.(key, vars) ?? key;

/** Whether the page is in English (the shell's language). */
const inEnglish = () => globalThis.window?.denShell?.lang?.() === "en";

/** The catalog's word for `key`, or null when the catalog has none. */
function word(key, vars) {
  const w = t(key, vars);
  return w === key ? null : w;
}

const slug = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");

/** A Docker container state ("running", "exited", …, Den's "absent"). */
export function dockerState(state) {
  return word(`val.docker.${slug(state)}`) ?? String(state ?? "");
}

/** The edge's TLS strategy: none and files are words, mkcert a tool's name. */
export function tlsStrategy(strategy) {
  return word(`val.tls.${slug(strategy)}`) ?? String(strategy ?? "");
}

/** A GitHub deployment or run state ("failure", "timed_out", …). */
export function githubState(state) {
  return word(`val.gh.${slug(state)}`) ?? String(state ?? "");
}

/**
 * A status line's vars (release-service.ts's `t`), its `state` in the
 * page's language.
 */
export function statusVars(vars) {
  if (!vars || typeof vars.state !== "string") return vars;
  return { ...vars, state: githubState(vars.state) };
}

/** A perf report's status: passed or failed. */
export function perfStatus(status) {
  return status === "passed"
    ? t("perf.passed")
    : status === "failed"
      ? t("perf.failed")
      : String(status ?? "");
}

/**
 * The metric labels report-normalizer.ts writes into a report, by slug
 * (the stored label, lowercase, each run of other characters as "_").
 */
const PERF_LABELS = {
  http_requests: "val.perf.httpReqs",
  iterations: "val.perf.iterations",
  virtual_users: "val.perf.vus",
  http_avg: "val.perf.httpAvg",
  http_p50: "val.perf.httpP50",
  http_p95: "val.perf.httpP95",
  http_p99: "val.perf.httpP99",
  http_max: "val.perf.httpMax",
  requests_sec: "val.perf.reqRate",
  iterations_sec: "val.perf.iterRate",
  failure_rate: "val.perf.failRate",
};

/** A perf metric's label in the page's language (a custom metric's name as is). */
export function perfLabel(label) {
  const key = PERF_LABELS[slug(label)];
  return (key && word(key)) ?? String(label ?? "");
}

/**
 * A health check's reason (health.ts, compose-health.ts) in words: the
 * catalog's sentence, or null when the reason is one Den doesn't know (a
 * distribution's own check's output), shown then as sent.
 */
export function healthReason(error, ms) {
  const e = String(error ?? "").trim();
  // No shell (a module's unit test): the reason as sent. In English the
  // reason stays as sent too: it is the words `<cli> status` prints and
  // the error people search for (ECONNREFUSED); es and ja get Den's words.
  if (!e || !globalThis.window?.denShell?.t) return null;
  if (inEnglish()) return null;
  return reasonWords(e, ms);
}

/** A reason in the catalog's words in any language, or null (unknown). */
function reasonWords(e, ms) {
  let m;
  if ((m = /^(.*) \(twice in a row\)$/.exec(e)))
    return t("val.h.twice", {
      why: reasonWords(m[1], ms) ?? m[1],
    });
  if (/^container state unknown: /.test(e)) return t("val.h.dockerUnknown");
  if (e === "timeout" || /\bETIMEDOUT\b|\btimed out\b/i.test(e))
    return ms
      ? t("env.timedOut", { s: Math.max(1, Math.round(ms / 1000)) })
      : t("val.h.timeout");
  if ((m = /^no answer within (\d+)s$/.exec(e)))
    return t("val.h.noAnswer", { s: Number(m[1]) });
  if (e === "dns" || /\b(ENOTFOUND|EAI_AGAIN)\b/.test(e)) return t("val.h.dns");
  if (e === "no route (edge 404)") return t("val.h.noRoute");
  if (e === "fallback got non-2xx") return t("val.h.fallback");
  if ((m = /^killed \((\w+)\)$/.exec(e)))
    return t("val.h.killed", { signal: m[1] });
  if ((m = /^exit (\d+)$/.exec(e))) return t("val.h.exit", { code: m[1] });
  if (/\bECONNREFUSED\b/.test(e)) return t("val.h.refused");
  if (/\bECONNRESET\b|socket hang up/i.test(e)) return t("val.h.reset");
  if (
    e === "unreachable" ||
    e === "fetch failed" ||
    /\b(EHOSTUNREACH|ENETUNREACH|EHOSTDOWN)\b/.test(e)
  )
    return t("val.h.unreachable");
  if (/certificate|\bCERT_|\bSSL\b|\bTLS\b/i.test(e)) return t("val.h.tls");
  if ((m = /^(.+): no container$/.exec(e)))
    return t("val.h.noContainer", { name: m[1] });
  // A container's row: name, state and Docker's status (compose-health.ts).
  if ((m = /^([^\t]+)\t([^\t]+)\t(.*)$/.exec(e))) {
    const [, name, state, status] = m;
    if (/\(unhealthy\)/.test(status)) return t("val.h.unhealthy", { name });
    if (/\(health: starting\)/.test(status))
      return t("val.h.starting", { name });
    if (/\(healthy\)/.test(status)) return t("val.h.healthy", { name });
    return t("val.h.container", { name, state: dockerState(state) });
  }
  return null;
}

/**
 * A health cell's words (environments.html): what the cell reads, and its
 * title's reason. `r` is one check's result from /api/health/stream.
 */
export function healthCellWords(r) {
  // A check that couldn't reach its target ("fetch failed") gets its own
  // line in every language, English too: the raw words say neither what
  // didn't answer nor what to try.
  const raw = String(r.error ?? "").replace(/ \(twice in a row\)$/, "");
  if (r.ok === false && !r.status && raw === "fetch failed") {
    const target = r.url ?? r.check ?? r.label ?? "";
    const why = t("env.fetchFailedWhy", { url: target });
    return {
      what: t("env.fetchFailed"),
      why,
      title: [r.label, why].filter(Boolean).join(" — "),
    };
  }
  // Issue 1466: Den's words in the cell in English too; English keeps the
  // reason as sent beside them in the title (the error people search for).
  const sent = String(r.error ?? "").trim();
  const en = inEnglish();
  const known = en
    ? sent && globalThis.window?.denShell?.t
      ? reasonWords(sent, r.ms)
      : null
    : healthReason(r.error, r.ms);
  // Den's own words when it knows the reason; else a plain "down" in the
  // cell and the reason as sent (a check's own output) in the title.
  const why =
    known && en && known !== sent ? `${known} (${sent})` : (known ?? sent);
  const what = r.status
    ? String(r.status)
    : r.ok
      ? t("env.up")
      : (known ?? t("env.down"));
  return {
    what,
    why,
    title: [r.label, r.url ?? r.check, why].filter(Boolean).join(" — "),
  };
}
