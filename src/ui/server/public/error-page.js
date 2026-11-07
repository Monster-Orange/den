/**
 * The error page (R26a, 0.3.0-dev.38): what a failed page request gets
 * inside the shell frame (rail, top bar, status chip). The server fills
 * #den-error (a JSON script) with what failed; this draws it.
 *
 *   404 "Page not found"   the path asked for; "Did you mean …" from the
 *                          command palette's own matcher (topbar.js
 *                          rankCommands) over the shell's pages; links to
 *                          Workspaces and Search (⌘K); the list of pages;
 *                          for /plugins/<id>/…, that the plugin isn't
 *                          installed, by name
 *   422 "Config is invalid"  each validation problem (file, key path,
 *                          message), `<cli> validate`, "Reload once fixed",
 *                          and links to Logs and Settings (config-free)
 *   500 "Something went wrong"  the method and route template (never query
 *                          values), the time, the request id; Retry and
 *                          Copy details. No stack: the server log has it
 *                          under the same request id.
 *
 * On an engine mismatch (MD-2) the shell's banner leads the page with the
 * restart message, and a 404 says the page may be new in that version.
 *
 * suggestPage and detailsText are pure, for tests.
 */
import { rankCommands } from "/topbar.js";

// Its words are the shell's catalog (shell.js MESSAGES, R19: the err.*
// keys), so the page is in the page's language. "Copy details" is a
// report: it stays in English, like the server log it points at.

function esc(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

/**
 * The closest page to `pathname` by the palette's ranking: the whole slug
 * first, then each of its words, then shorter prefixes of it (two letters
 * at least), so a near-miss and a stray word both find something. `items`
 * are palette rows ({ label, keywords, href }). Null when nothing matches.
 */
export function suggestPage(pathname, items, rank = rankCommands) {
  const slug = String(pathname || "")
    .split("/")
    .filter(Boolean)
    .pop()
    ?.replace(/\.html?$/i, "")
    .toLowerCase();
  if (!slug) return null;
  const tries = [slug, ...slug.split(/[-_.\s]+/).filter((w) => w.length > 1)];
  for (let n = slug.length - 1; n >= 2; n--) tries.push(slug.slice(0, n));
  for (const q of tries) {
    const hit = rank(items, q, { limit: 1 })[0];
    if (hit) return hit;
  }
  return null;
}

/** "Copy details": what a report needs, nothing more (no stack). */
export function detailsText(d, page = "") {
  return [
    `Den ${d.version ?? "unknown"}`,
    `Status ${d.status}`,
    d.status === 500
      ? `Route ${d.method ?? "GET"} ${d.route ?? ""}`
      : `Path ${d.path ?? ""}`,
    `Request ${d.requestId}`,
    `Time ${d.time}`,
    ...(page ? [`Page ${page}`] : []),
    ...(d.engine ? [d.engine.message] : []),
  ].join("\n");
}

function pageItems(sh) {
  const st = sh.getState?.() ?? {};
  const rows = (sh.orderedNav?.() ?? sh.nav?.() ?? [])
    .filter((n) => !n.when || n.when(st))
    .map((n) => ({
      label: sh.t(n.label),
      keywords: [n.id, ...(n.keywords ?? [])],
      href: n.href,
    }));
  rows.push({
    label: sh.t("n.settings"),
    keywords: ["settings", "preferences"],
    href: "/settings",
  });
  return rows;
}

function readData() {
  try {
    return JSON.parse(document.getElementById("den-error")?.textContent ?? "");
  } catch {
    return null;
  }
}

async function copy(text, btn, t) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch {
      /* nothing more to try */
    }
    ta.remove();
  }
  const label = btn.textContent;
  btn.textContent = t("err.copied");
  setTimeout(() => (btn.textContent = label), 1500);
}

/** `text` with `{cmd}` as inline code (the rest escaped). */
function withCmd(text, cmd) {
  return esc(text).replace("\u0000", `<code class="mono">${esc(cmd)}</code>`);
}

/**
 * The signed-out page (SEC-1b, SEC-1 spec §2): "Sign in to use the
 * terminal" (a shell-grade route on loopback) or "Sign in to use <name>"
 * (beyond loopback), the command that prints a sign-in link with a copy
 * button, and on 127.0.0.1 or [::1] a link to the same page on localhost,
 * where the cookie is. It never asks for a secret or a token.
 *
 * A link from 127.0.0.1 lands here once without the cookie (a cross-site
 * navigation doesn't carry a SameSite=Strict one); /api/session, asked
 * same-origin, does carry it, so a signed-in browser reloads the page
 * from here (same-origin) and is let through.
 *
 * SEC-2a: above that, Sign in with GitHub. The server runs GitHub's device
 * flow; the page shows the code and github.com/login/device, polls the
 * server, and reloads once the owner approved it (the server sets the
 * cookie). Another account is refused by name. With no owner linked, or no
 * client id configured, it says what to do on the Den machine instead.
 */
function githubBlock(s, t) {
  const g = s.github;
  if (!g || s.localhost) return "";
  if (g.state === "no_owner")
    return `<div id="den-gh"><p class="lead">${withCmd(t("err.signin.githubNoOwner", { cmd: "\u0000" }), g.owner)}</p></div>`;
  if (g.state === "no_client_id")
    return `<div id="den-gh"><p>${withCmd(t("err.signin.githubNoClient", { key: "\u0000" }), "web.github_client_id")}</p></div>`;
  return (
    `<div id="den-gh"><div class="acts" style="margin-top:0">` +
    `<button type="button" class="btn primary" id="den-gh-start">${esc(t("err.signin.github"))}</button>` +
    `</div><div id="den-gh-flow" aria-live="polite"></div></div>`
  );
}

/** The device flow on the page: start, show the code, poll, reload. */
function wireGithub(root, t) {
  const start = root.querySelector("#den-gh-start");
  const box = root.querySelector("#den-gh-flow");
  if (!start || !box) return;
  let timer = null;
  const show = (html) => (box.innerHTML = html);
  const fail = (text) => {
    clearTimeout(timer);
    start.hidden = false;
    start.textContent = t("err.signin.githubAgain");
    show(
      `<p class="den-gh-err" role="alert" style="margin-top:12px">${esc(text)}</p>`,
    );
  };
  const poll = (id) => {
    fetch(`/api/github/signin/${encodeURIComponent(id)}`, {
      cache: "no-store",
      credentials: "same-origin",
    })
      .then((r) => r.json().catch(() => ({})))
      .then((b) => {
        if (b.state === "pending") {
          timer = setTimeout(() => poll(id), 1500);
          return;
        }
        if (b.state === "ok") {
          show(
            `<p class="lead" style="margin-top:12px">${esc(t("err.signin.githubDone"))}</p>`,
          );
          location.replace(location.href);
          return;
        }
        fail(
          b.state === "refused"
            ? t("err.signin.githubRefused", { login: b.login ?? "" })
            : b.state === "expired"
              ? t("err.signin.githubExpired")
              : b.state === "denied"
                ? t("err.signin.githubDenied")
                : t("err.signin.githubFailed"),
        );
      })
      .catch(() => fail(t("err.signin.githubFailed")));
  };
  start.addEventListener("click", () => {
    clearTimeout(timer);
    start.disabled = true;
    fetch("/api/github/signin", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then((r) =>
        r
          .json()
          .catch(() => ({}))
          .then((b) => [r.status, b]),
      )
      .then(([status, b]) => {
        start.disabled = false;
        if (!b.ok || !b.userCode) {
          fail(
            status === 429
              ? t("err.signin.githubBusy")
              : b.error || t("err.signin.githubFailed"),
          );
          return;
        }
        start.hidden = true;
        const url = b.verificationUri || "https://github.com/login/device";
        const shown = url.replace(/^https:\/\//, "");
        show(
          `<p class="lead" style="margin-top:12px">${t(
            "err.signin.githubEnter",
            {
              url: `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(shown)}</a>`,
            },
          )}</p>` +
            `<pre class="code" id="den-gh-code" style="font-size:22px;letter-spacing:0.12em;text-align:center">${esc(b.userCode)}</pre>` +
            `<div class="acts" style="margin-top:0">` +
            `<a class="btn primary" id="den-gh-open" href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(t("err.signin.githubOpen"))}</a>` +
            `<button type="button" class="btn" id="den-gh-copy">${esc(t("err.signin.githubCopy"))}</button></div>` +
            `<p class="den-gh-wait" style="margin-top:12px">${esc(t("err.signin.githubWaiting"))}</p>`,
        );
        const cp = box.querySelector("#den-gh-copy");
        cp?.addEventListener("click", () => copy(b.userCode, cp, t));
        timer = setTimeout(() => poll(b.id), 1500);
      })
      .catch(() => {
        start.disabled = false;
        fail(t("err.signin.githubFailed"));
      });
  });
}

function mountSignedOut(root, sh, d) {
  const t = sh.t;
  const s = d.signin;
  const title = s.expired
    ? t("err.signin.expiredTitle")
    : s.scope === "terminal"
      ? t("err.signin.terminal")
      : t("err.signin.title", { name: s.name || "Den" });
  document.title = document.title.replace(/Error$/, title);
  const gh = githubBlock(s, t);
  const lead = s.expired
    ? withCmd(t("err.signin.expired", { cmd: "\u0000" }), s.cmd)
    : withCmd(
        t(gh ? "err.signin.orLead" : "err.signin.lead", { cmd: "\u0000" }),
        s.cmd,
      );
  root.innerHTML =
    `<div class="ph"><div><h1>${esc(title)}</h1>` +
    `<div class="sub">${esc(t("err.signin.sub"))}</div></div></div>` +
    `<div class="empty" id="den-signin">` +
    (gh
      ? `${gh}<hr style="border:0;border-top:1px solid var(--border);margin:20px 0">`
      : "") +
    `<p class="lead">${lead}</p>` +
    `<pre class="code" id="den-signin-cmd">${esc(s.cmd)}</pre>` +
    (s.localhost
      ? `<p>${esc(t("err.signin.local", { host: location.host }))}</p>`
      : "") +
    `<p class="den-signin-why">${esc(t("err.signin.why"))}</p>` +
    `<dl class="facts">` +
    `<dt>${esc(t("err.500.id"))}</dt><dd class="mono" id="den-err-id">${esc(d.requestId)}</dd>` +
    `</dl><div class="acts">` +
    (s.localhost
      ? `<a class="btn primary" id="den-signin-local" href="${esc(s.localhost)}">${esc(t("err.421.open"))}</a>`
      : "") +
    `<button type="button" class="btn${s.localhost || gh ? "" : " primary"}" id="den-signin-copy">${esc(t("err.signin.copy"))}</button>` +
    `</div></div>`;
  const btn = root.querySelector("#den-signin-copy");
  btn?.addEventListener("click", () => copy(s.cmd, btn, t));
  wireGithub(root, t);
  if (s.expired || s.localhost) return;
  let tried = false;
  try {
    tried = sessionStorage.getItem("den-signin-reload") === location.href;
    sessionStorage.removeItem("den-signin-reload");
  } catch {
    /* no storage: try once */
  }
  if (tried) return;
  fetch("/api/session", { cache: "no-store", credentials: "same-origin" })
    .then((r) => (r.ok ? r.json() : null))
    .then((b) => {
      if (!b || b.signedIn !== true) return;
      try {
        sessionStorage.setItem("den-signin-reload", location.href);
      } catch {
        /* none */
      }
      location.replace(location.href);
    })
    .catch(() => {});
}

export function mountErrorPage(root) {
  const sh = window.denShell;
  const d = readData();
  if (!root || !sh || !d) return;
  const t = sh.t;
  const header = (title, sub) =>
    `<div class="ph"><div><h1>${esc(title)}</h1>` +
    `<div class="sub">${sub}</div></div></div>`;

  if (d.status === 404) {
    document.title = document.title.replace(/Error$/, t("err.404.title"));
    const items = pageItems(sh);
    const hit = suggestPage(d.path, items);
    const lines = [];
    if (d.plugin) {
      const name = esc(d.plugin.name || d.plugin.id);
      lines.push(
        `<p class="lead">${t(
          d.plugin.installed
            ? "err.404.pluginNoPage"
            : d.plugin.locked
              ? "err.404.pluginLocked"
              : "err.404.plugin",
          { name: `<b>${name}</b>` },
        )}</p>`,
      );
    } else lines.push(`<p class="lead">${esc(t("err.404.lead"))}</p>`);
    if (d.engine)
      lines.push(
        `<p>${esc(t("err.404.stale", { onDisk: d.engine.onDisk ?? "?", loaded: d.engine.loaded ?? "?" }))}</p>`,
      );
    if (hit)
      lines.push(
        `<p class="den-err-mean">${t("err.404.mean", {
          page: `<a href="${esc(hit.href)}">${esc(hit.label)}</a>`,
        })}</p>`,
      );
    root.innerHTML =
      header(
        t("err.404.title"),
        // The path sits where the language puts it ("Nothing at {path}").
        esc(t("err.404.sub", { path: "\u0000" })).replace(
          "\u0000",
          `<span class="mono">${esc(d.path)}</span>`,
        ),
      ) +
      `<div class="empty">${lines.join("")}` +
      `<div class="acts"><a class="btn primary" href="/local-dev">${esc(t("err.404.workspaces"))}</a>` +
      `<button type="button" class="btn" id="den-err-search">${esc(t("err.404.search"))} <kbd>⌘K</kbd></button></div>` +
      `<h2 class="sec">${esc(t("err.404.pages"))}</h2><ul class="pages">` +
      items
        .map((i) => `<li><a href="${esc(i.href)}">${esc(i.label)}</a></li>`)
        .join("") +
      `</ul></div>`;
    root.querySelector("#den-err-search")?.addEventListener("click", () => {
      document.getElementById("den-search")?.click();
    });
    return;
  }

  if (d.status === 422) {
    // R26a's 422 (0.3.0-dev.40): each problem (file, key path, message),
    // the command that shows them in a terminal, and "Reload once fixed".
    // Settings and Logs are config-free, so the rail reaches the fix.
    document.title = document.title.replace(/Error$/, t("err.422.title"));
    const issues =
      Array.isArray(d.issues) && d.issues.length
        ? d.issues
        : [{ file: "", key: "", message: d.message ?? "" }];
    const cmd = `${d.cli || "den"} validate`;
    root.innerHTML =
      header(t("err.422.title"), esc(t("err.422.sub"))) +
      `<div class="empty wide"><p class="lead">${esc(t("err.422.lead"))}</p>` +
      `<div class="tablewrap"><table class="svc" id="den-err-issues"><thead><tr>` +
      `<th>${esc(t("err.422.file"))}</th><th>${esc(t("err.422.key"))}</th><th>${esc(t("err.422.problem"))}</th>` +
      `</tr></thead><tbody>` +
      issues
        .map(
          (i) =>
            `<tr><td class="mono">${esc(i.file)}</td><td class="mono"><b>${esc(i.key)}</b></td><td>${esc(i.message)}</td></tr>`,
        )
        .join("") +
      `</tbody></table></div>` +
      `<p>${esc(t("err.422.cmd"))}</p>` +
      `<pre class="code" id="den-err-cmd">${esc(cmd)}</pre>` +
      `<dl class="facts">` +
      `<dt>${esc(t("err.500.id"))}</dt><dd class="mono" id="den-err-id">${esc(d.requestId)}</dd>` +
      `</dl><div class="acts">` +
      `<button type="button" class="btn primary" id="den-err-retry">${esc(t("err.422.reload"))}</button>` +
      `<a class="btn" href="/logs">${esc(t("err.422.logs"))}</a>` +
      `<a class="btn" href="/settings">${esc(t("err.422.settings"))}</a>` +
      `</div></div>`;
    root
      .querySelector("#den-err-retry")
      ?.addEventListener("click", () => location.reload());
    return;
  }

  if (d.status === 401 && d.code === "signin_required" && d.signin) {
    mountSignedOut(root, sh, d);
    return;
  }

  if (d.status === 421 || d.status === 403 || d.status === 401) {
    // SEC-1a: the request checks refused it (a host that isn't this
    // server's, a cross-site request). A 421 links to the same path on
    // localhost, the canonical loopback name.
    const title =
      d.status === 421 ? t("err.421.title") : t("err.refused.title");
    document.title = document.title.replace(/Error$/, title);
    const here =
      d.status === 421
        ? `http://localhost${location.port ? `:${location.port}` : ""}${d.path ?? "/"}`
        : null;
    root.innerHTML =
      header(title, `<span class="mono">${esc(d.code ?? "")}</span>`) +
      `<div class="empty"><p class="lead">${esc(d.status === 421 ? t("err.421.lead") : (d.message ?? ""))}</p>` +
      `<dl class="facts">` +
      `<dt>${esc(t("err.500.id"))}</dt><dd class="mono" id="den-err-id">${esc(d.requestId)}</dd>` +
      `</dl><div class="acts">` +
      (here
        ? `<a class="btn primary" id="den-err-local" href="${esc(here)}">${esc(t("err.421.open"))}</a>`
        : `<button type="button" class="btn primary" id="den-err-retry">${esc(t("err.retry"))}</button>`) +
      `</div></div>`;
    root
      .querySelector("#den-err-retry")
      ?.addEventListener("click", () => location.reload());
    return;
  }

  document.title = document.title.replace(/Error$/, t("err.500.title"));
  const what = `${d.method ?? "GET"} ${d.route ?? ""}`;
  const when = new Date(d.time);
  root.innerHTML =
    header(
      t("err.500.title"),
      `<span class="mono">${esc(t("err.500.sub", { what }))}</span>`,
    ) +
    `<div class="empty"><p class="lead">${esc(t("err.500.lead"))}</p>` +
    `<dl class="facts">` +
    `<dt>${esc(t("err.500.what"))}</dt><dd class="mono">${esc(what)}</dd>` +
    `<dt>${esc(t("err.500.time"))}</dt><dd><time datetime="${esc(d.time)}">${esc(isNaN(when) ? d.time : when.toLocaleString(sh.lang?.() && sh.lang() !== "en" ? sh.lang() : undefined))}</time></dd>` +
    `<dt>${esc(t("err.500.id"))}</dt><dd class="mono" id="den-err-id">${esc(d.requestId)}</dd>` +
    `<dt>${esc(t("err.500.version"))}</dt><dd class="mono">${esc(d.version ?? "unknown")}</dd>` +
    `</dl><div class="acts">` +
    `<button type="button" class="btn primary" id="den-err-retry">${esc(t("err.retry"))}</button>` +
    `<button type="button" class="btn" id="den-err-copy">${esc(t("err.copy"))}</button>` +
    `</div></div>`;
  root
    .querySelector("#den-err-retry")
    ?.addEventListener("click", () => location.reload());
  const copyBtn = root.querySelector("#den-err-copy");
  copyBtn?.addEventListener("click", () =>
    copy(detailsText(d, location.pathname), copyBtn, t),
  );
}
