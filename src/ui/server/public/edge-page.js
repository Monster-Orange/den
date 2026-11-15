/**
 * The Edge page (0.3.0-dev.30, PL-SPEC §10): a built-in shell page in the
 * Ship group, in the rail only when /api/edge reports the edge configured
 * (shell.js asks /api/edge?probe=1). Read-only: what `<cli> edge status`
 * and `<cli> edge routes` show, from /api/edge:
 *
 *   the container and its ports · the TLS strategy (edge.tls: none,
 *   mkcert or files; with its CA, and whether it was set, mapped from the
 *   legacy keys, or implicit) · CA trust · the cert and its names · the
 *   domains · Den's own routes · the routers in the included dynamic files
 *   (`edge include`), each with its source file: Traefik serves them, Den
 *   doesn't generate them (a consumer's review) · the routers the stacks
 *   wrote (`stack-*.yml`, 0.3.0-dev.32), source "stack" with the file.
 *
 * CA trust reads "not needed: fronted" when edge.publish is false (no host
 * ports: a proxy in front owns browser trust, the BOOT-1 rule), neutral,
 * never a red "not trusted" (0.3.0-dev.32). Under tls `files` the cert
 * names are the ones the included certs should cover (0.3.0-dev.32).
 *
 * No trust/untrust or up/down here: those stay CLI commands.
 *
 * The page header is the prototype's .ph (R20). edgeView(status) is pure
 * (HTML from /api/edge's JSON), so tests need no server.
 */

/**
 * A word in the page's language (issue 171): shell.js's catalog, "edge.*".
 * Without the shell (a test that installs none) the key comes back.
 */
const t = (key, vars) => globalThis.window?.denShell?.t?.(key, vars) ?? key;

function esc(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

/** A link for a URL the edge serves (http/https only; anything else is text). */
function link(url, text) {
  return /^https?:\/\//.test(String(url))
    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(text ?? url)}</a>`
    : esc(text ?? url);
}

/** Where the TLS strategy came from, in a line. */
export function tlsNote(tls) {
  if (!tls) return "";
  if (tls.from === "implicit" || tls.implicit) return t("edge.tls.implicit");
  if (tls.from === "legacy") return t("edge.tls.legacy");
  return t("edge.tls.set");
}

function tile(k, v, s, bad) {
  return (
    `<div class="tile${bad ? " bad" : ""}"><div class="k">${esc(k)}</div>` +
    `<div class="v">${esc(v)}</div><div class="s">${s}</div></div>`
  );
}

function table(cols, rows, empty) {
  if (!rows.length) return `<p class="none">${esc(empty)}</p>`;
  return (
    `<div class="tablewrap"><table class="svc"><thead><tr>` +
    cols.map((c) => `<th scope="col">${esc(c)}</th>`).join("") +
    `</tr></thead><tbody>` +
    rows
      .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
      .join("") +
    `</tbody></table></div>`
  );
}

/**
 * The cert-names card's heading. Under tls `files` Den issues nothing: the
 * names are the ones the included certs should cover (a consumer's nit,
 * 0.3.0-dev.32). mkcert (and none): Den's own cert, issued or planned.
 */
export function certHeading(strategy, issued) {
  if (strategy === "files") return t("edge.cert.files");
  return t(issued ? "edge.cert.names" : "edge.cert.planned");
}

/** The page's content (below the header) from /api/edge's JSON. */
export function edgeView(st) {
  if (!st || st.configured === false)
    return (
      `<div class="empty"><b>${esc(t("edge.none"))}</b> ` +
      `${esc(st?.error ?? "")}</div>`
    );
  const tls = st.tls ?? { strategy: "none" };
  const none = tls.strategy === "none";
  const ports = st.ports
    ? none
      ? t("edge.ports.httpOnly", { http: st.ports.http })
      : `:${st.ports.http} / :${st.ports.https}`
    : t("edge.ports.none");
  // Fronted: no host ports (edge.publish: false). The proxy in front
  // terminates TLS for browsers, so this machine's CA trust is moot.
  const fronted = !st.ports;
  const trust = none
    ? "—"
    : fronted
      ? t("edge.trust.fronted")
      : st.caTrusted === null || st.caTrusted === undefined
        ? t("edge.trust.unknown")
        : st.caTrusted
          ? t("edge.trust.yes")
          : t("edge.trust.no");
  const included = Array.isArray(st.included) ? st.included : [];
  const stacks = Array.isArray(st.stacks) ? st.stacks : [];
  const errors = [
    ...(Array.isArray(st.includedErrors) ? st.includedErrors : []),
    ...(Array.isArray(st.stackErrors) ? st.stackErrors : []),
  ];
  const certNames = Array.isArray(st.certNames) ? st.certNames : [];
  const tiles = [
    tile(
      t("edge.k.container"),
      st.up ? t("edge.up") : t("edge.down"),
      `<span class="mono">${esc(st.container)}</span>: ${esc(st.state)}`,
      !st.up,
    ),
    tile(
      t("edge.k.ports"),
      ports,
      `${esc(t("edge.network"))} <span class="mono">${esc(st.network)}</span>`,
      false,
    ),
    tile("TLS", tls.strategy, esc(tlsNote(tls)), false),
    tile(
      t("edge.k.trust"),
      trust,
      none
        ? esc(t("edge.trust.httpOnly"))
        : fronted
          ? esc(t("edge.trust.proxy"))
          : tls.ca
            ? `<span class="mono">${esc(tls.ca)}</span>`
            : esc(t("edge.trust.noCa")),
      st.caTrusted === false && !fronted,
    ),
    tile(
      t("edge.k.cert"),
      none
        ? "—"
        : st.certIssued
          ? t("edge.cert.issued")
          : t("edge.cert.notIssued"),
      none
        ? esc(t("edge.cert.httpOnly"))
        : tls.strategy === "files"
          ? esc(t("edge.cert.fromFiles"))
          : esc(t("edge.cert.n", { n: certNames.length })),
      false,
    ),
  ];
  const scheme = none ? "http://" : "https://";
  const routes = (st.routes ?? []).map((r) => [
    `<span class="mono">${esc(r.name)}</span>`,
    link(r.url),
    `<span class="mono">${esc(r.upstream)}</span>`,
    `<span class="src" translate="no">den</span>`,
  ]);
  // Like Den's own rows: the URL with its scheme (https:// when the router
  // has TLS or is on websecure), and the upstream URL when its file
  // defines the service's loadBalancer, else the service's name
  // (0.3.0-dev.33, a consumer's dogfood finding).
  const routerRow = (r, src) => {
    const scheme = (r.secure ?? r.tls) ? "https://" : "http://";
    return [
      `<span class="mono">${esc(r.name)}</span>`,
      r.hosts?.length
        ? r.hosts.map((h) => link(scheme + h)).join("<br>")
        : `<span class="mono rule">${esc(r.rule)}</span>`,
      `<span class="mono">${esc(r.upstream || r.service)}</span>`,
      src,
    ];
  };
  const inc = included.map((r) =>
    routerRow(
      r,
      `<span class="src" title="${esc(t("edge.src.included"))}">${esc(r.file)}</span>`,
    ),
  );
  // The stacks' own route files (stack up writes them): source "stack",
  // marked with the file.
  const stk = stacks.map((r) =>
    routerRow(
      r,
      `<span class="src" title="${esc(t("edge.src.stack"))}" translate="no">stack</span> ` +
        `<span class="mono sub">${esc(r.file)}</span>`,
    ),
  );
  return (
    `<div class="sum">${tiles.join("")}</div>` +
    `<section aria-labelledby="edge-h-routes"><h2 class="sec" id="edge-h-routes">${esc(t("edge.routes"))}</h2>` +
    table(
      [t("edge.col.name"), "URL", t("edge.col.upstream"), t("edge.col.source")],
      [...routes, ...inc, ...stk],
      t("edge.routes.none"),
    ) +
    (errors.length
      ? `<ul class="errs">` +
        errors
          .map(
            (e) =>
              `<li><span class="mono">${esc(e.file)}</span>: ${esc(t("edge.notRead", { error: e.error }))}</li>`,
          )
          .join("") +
        `</ul>`
      : "") +
    `<p class="note">${esc(t("edge.routes.note"))}</p>` +
    `</section>` +
    `<section aria-labelledby="edge-h-domains"><h2 class="sec" id="edge-h-domains">${esc(t("edge.domains"))}</h2>` +
    `<ul class="names">` +
    (st.domains ?? [])
      .map(
        (d) =>
          `<li>${link(scheme + d, d)} <span class="mono sub">+ *.${esc(d)}</span></li>`,
      )
      .join("") +
    `</ul></section>` +
    (none
      ? ""
      : `<section aria-labelledby="edge-h-cert"><h2 class="sec" id="edge-h-cert">${esc(certHeading(tls.strategy, st.certIssued))}</h2>` +
        (certNames.length
          ? `<ul class="names">${certNames.map((n) => `<li class="mono">${esc(n)}</li>`).join("")}</ul>`
          : `<p class="none">${esc(t("edge.cert.none"))}</p>`) +
        `</section>`)
  );
}

/** The header's sub line: org / container · state. */
export function edgeSub(st) {
  if (!st || st.configured === false) return t("edge.notConfigured");
  return `${st.org} / ${st.container} · ${st.state}`;
}

/** Fetch /api/edge and draw the page into `root` (the header's sub line too). */
export async function mountEdge(root, sub, fetchFn = fetch) {
  let st;
  try {
    const r = await fetchFn("/api/edge");
    st = await r.json();
  } catch (e) {
    st = {
      configured: false,
      error: (e && e.message) || t("edge.unreachable"),
    };
  }
  if (sub) sub.textContent = edgeSub(st);
  root.innerHTML = edgeView(st);
  root.removeAttribute("aria-busy");
  return st;
}
