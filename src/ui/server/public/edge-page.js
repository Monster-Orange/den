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
  if (tls.from === "implicit" || tls.implicit)
    return "implicit: edge.tls is not set (mkcert with a local CA, deprecated)";
  if (tls.from === "legacy")
    return "from the legacy keys (caroot / issue_cert), mapped";
  return "set in edge.tls";
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
  if (strategy === "files") return "Names the included certs should cover";
  return `Certificate names${issued ? "" : " (planned)"}`;
}

/** The page's content (below the header) from /api/edge's JSON. */
export function edgeView(st) {
  if (!st || st.configured === false)
    return (
      `<div class="empty"><b>No edge configured.</b> ` +
      `${esc(st?.error ?? "")}</div>`
    );
  const tls = st.tls ?? { strategy: "none" };
  const none = tls.strategy === "none";
  const ports = st.ports
    ? none
      ? `:${st.ports.http} (http only)`
      : `:${st.ports.http} / :${st.ports.https}`
    : "not published";
  // Fronted: no host ports (edge.publish: false). The proxy in front
  // terminates TLS for browsers, so this machine's CA trust is moot.
  const fronted = !st.ports;
  const trust = none
    ? "—"
    : fronted
      ? "not needed: fronted"
      : st.caTrusted === null || st.caTrusted === undefined
        ? "unknown"
        : st.caTrusted
          ? "trusted"
          : "not trusted";
  const included = Array.isArray(st.included) ? st.included : [];
  const stacks = Array.isArray(st.stacks) ? st.stacks : [];
  const errors = [
    ...(Array.isArray(st.includedErrors) ? st.includedErrors : []),
    ...(Array.isArray(st.stackErrors) ? st.stackErrors : []),
  ];
  const certNames = Array.isArray(st.certNames) ? st.certNames : [];
  const tiles = [
    tile(
      "Container",
      st.up ? "up" : "down",
      `<span class="mono">${esc(st.container)}</span>: ${esc(st.state)}`,
      !st.up,
    ),
    tile(
      "Ports",
      ports,
      `network <span class="mono">${esc(st.network)}</span>`,
      false,
    ),
    tile("TLS", tls.strategy, esc(tlsNote(tls)), false),
    tile(
      "CA trust",
      trust,
      none
        ? "http only: no CA"
        : fronted
          ? "a proxy in front owns browser trust"
          : tls.ca
            ? `<span class="mono">${esc(tls.ca)}</span>`
            : "no CA set",
      st.caTrusted === false && !fronted,
    ),
    tile(
      "Certificate",
      none ? "—" : st.certIssued ? "issued" : "not issued",
      none
        ? "http only: no cert"
        : tls.strategy === "files"
          ? "from the included config"
          : `${certNames.length} name${certNames.length === 1 ? "" : "s"}`,
      false,
    ),
  ];
  const scheme = none ? "http://" : "https://";
  const routes = (st.routes ?? []).map((r) => [
    `<span class="mono">${esc(r.name)}</span>`,
    link(r.url),
    `<span class="mono">${esc(r.upstream)}</span>`,
    `<span class="src">den</span>`,
  ]);
  const routerRow = (r, src) => [
    `<span class="mono">${esc(r.name)}</span>`,
    r.hosts?.length
      ? r.hosts
          .map((h) => link((r.tls ? "https://" : "http://") + h, h))
          .join("<br>")
      : `<span class="mono rule">${esc(r.rule)}</span>`,
    `<span class="mono">${esc(r.service)}</span>`,
    src,
  ];
  const inc = included.map((r) =>
    routerRow(
      r,
      `<span class="src" title="included dynamic file">${esc(r.file)}</span>`,
    ),
  );
  // The stacks' own route files (stack up writes them): source "stack",
  // marked with the file.
  const stk = stacks.map((r) =>
    routerRow(
      r,
      `<span class="src" title="written by stack up">stack</span> ` +
        `<span class="mono sub">${esc(r.file)}</span>`,
    ),
  );
  return (
    `<div class="sum">${tiles.join("")}</div>` +
    `<section aria-labelledby="edge-h-routes"><h2 class="sec" id="edge-h-routes">Routes</h2>` +
    table(
      ["Name", "URL", "Upstream", "Source"],
      [...routes, ...inc, ...stk],
      "No routes.",
    ) +
    (errors.length
      ? `<ul class="errs">` +
        errors
          .map(
            (e) =>
              `<li><span class="mono">${esc(e.file)}</span>: not read (${esc(e.error)})</li>`,
          )
          .join("") +
        `</ul>`
      : "") +
    `<p class="note">Den's own routes, then the routers in the included dynamic files (edge include), each with its source file, then the routers the stacks wrote (stack).</p>` +
    `</section>` +
    `<section aria-labelledby="edge-h-domains"><h2 class="sec" id="edge-h-domains">Domains</h2>` +
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
          : `<p class="none">None: the included config holds the certs.</p>`) +
        `</section>`)
  );
}

/** The header's sub line: org / container · state. */
export function edgeSub(st) {
  if (!st || st.configured === false) return "Not configured";
  return `${st.org} / ${st.container} · ${st.state}`;
}

/** Fetch /api/edge and draw the page into `root` (the header's sub line too). */
export async function mountEdge(root, sub, fetchFn = fetch) {
  let st;
  try {
    const r = await fetchFn("/api/edge");
    st = await r.json();
  } catch (e) {
    st = { configured: false, error: (e && e.message) || "unreachable" };
  }
  if (sub) sub.textContent = edgeSub(st);
  root.innerHTML = edgeView(st);
  root.removeAttribute("aria-busy");
  return st;
}
