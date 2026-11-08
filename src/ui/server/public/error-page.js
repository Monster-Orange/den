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

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* no Clipboard API here (plain http beyond localhost): the fallback */
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    /* nothing more to try */
  }
  ta.remove();
}

async function copy(text, btn, t) {
  await copyText(text);
  const label = btn.textContent;
  btn.textContent = t("err.copied");
  setTimeout(() => (btn.textContent = label), 1500);
}

/** `text` with `{cmd}` as inline code (the rest escaped). */
function withCmd(text, cmd) {
  return esc(text).replace("\u0000", `<code class="mono">${esc(cmd)}</code>`);
}

/** `t(key, vars)` escaped, with `{host}` (and `{target}`) in bold. */
function withHost(t, key, vars) {
  const marks = {};
  const v = { ...vars };
  for (const k of ["host", "target", "user"])
    if (k in v) {
      marks[k] = v[k];
      v[k] = `\u0001${k}\u0001`;
    }
  let out = esc(t(key, v));
  for (const [k, val] of Object.entries(marks))
    out = out.split(`\u0001${k}\u0001`).join(`<b>${esc(val)}</b>`);
  return out;
}

const COPY_ICON =
  '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5a1.5 1.5 0 0 0-1.5-1.5H4A1.5 1.5 0 0 0 2.5 3v5A1.5 1.5 0 0 0 4 9.5h.5"/></svg>';

/**
 * One command on the page: the line itself, and an icon button right next
 * to it that copies it ("Copied" for a moment after). `extra` is more
 * actions beside it (Open Terminal). Every command the page prints comes
 * from the server, built by one helper (cli-command.ts): never a bare
 * `<cli>` the server's user can't run.
 */
function cmdLine(id, cmd, t, extra = "") {
  return (
    `<div class="den-cmd" data-cmd="${esc(id)}">` +
    `<pre class="code" id="${esc(id)}">${esc(cmd)}</pre>` +
    `<button type="button" class="btn den-copy" data-copy-for="${esc(id)}" aria-label="${esc(t("err.signin.copy"))}" title="${esc(t("err.signin.copy"))}">` +
    `${COPY_ICON}<span class="den-copied" aria-live="polite"></span></button>` +
    extra +
    `</div>`
  );
}

/** Wire every copy button under `root` (each once). */
function wireCopy(root, t) {
  root.querySelectorAll("button[data-copy-for]").forEach((b) => {
    if (b.dataset.wired) return;
    b.dataset.wired = "1";
    let timer = null;
    b.addEventListener("click", async () => {
      const pre = root.querySelector(`#${CSS.escape(b.dataset.copyFor)}`);
      await copyText(pre?.textContent ?? "");
      const note = b.querySelector(".den-copied");
      if (!note) return;
      note.textContent = t("err.copied");
      b.classList.add("done");
      clearTimeout(timer);
      timer = setTimeout(() => {
        note.textContent = "";
        b.classList.remove("done");
      }, 1500);
    });
  });
}

/** `ms` left as m:ss ("9:59"); 0:00 at or past the end. */
export function countdownText(ms) {
  const s = Math.max(0, Math.ceil(Number(ms) / 1000) || 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Where a signed-in page goes: the page that was asked for. On /signin,
 * its same-origin `next` (else `/`); anywhere else, the same URL.
 */
/**
 * 0.4.15: keep a sign-in's approval key (web-session.ts) in this origin's
 * localStorage, where shell.js sends it from. It comes in the sign-in's
 * own answer only.
 */
function keepApproveKey(b) {
  if (!b || typeof b.approveKey !== "string") return;
  try {
    localStorage.setItem("den.approveKey", b.approveKey);
  } catch {
    /* storage blocked: this browser signs in again to approve */
  }
}

export function landingAfterSignIn(loc) {
  if (loc.pathname !== "/signin") return loc.pathname + loc.search + loc.hash;
  const n = new URLSearchParams(loc.search).get("next") || "/";
  return n.startsWith("/") && !n.startsWith("//") && !n.includes("\\")
    ? n
    : "/";
}

/**
 * Sign in with GitHub (SEC-2a): shown only when a client id is configured.
 * The server runs GitHub's device flow; the page shows the code and
 * github.com/login/device, polls the server, and goes on once the owner
 * approved it (the server sets the cookie). Another account is refused by
 * name.
 *
 * SEC-2a-UX: the same three steps in every state (link the owner on the
 * machine, enter the code on GitHub, come back and press the button).
 * Once an owner is linked, step 1 is done and names it, and the button
 * follows the steps. Below them: only the owner's account signs in this
 * way, and Learn more.
 */
function githubBlock(s, t) {
  const g = s.github;
  if (!g || s.localhost || g.state === "no_client_id") return "";
  const host = s.machine || "";
  const ready = g.state === "ready";
  const step1 = withHost(t, "err.signin.ghStep1", {
    host,
    cmd: "\u0000",
  }).replace("\u0000", `<code class="mono">${esc(g.owner)}</code>`);
  return (
    `<div id="den-gh">` +
    `<ol class="den-steps" id="den-gh-steps">` +
    `<li id="den-gh-step1"${ready ? ' class="done"' : ""}><p>${step1}</p>` +
    (ready && g.ownerLogin
      ? `<p class="den-gh-owner" id="den-gh-owner">${esc(t("err.signin.ghOwner", { login: g.ownerLogin }))}</p>`
      : "") +
    `</li>` +
    `<li id="den-gh-step2"><p>${esc(t("err.signin.ghStep2"))}</p></li>` +
    `<li id="den-gh-step3"><p>${esc(t("err.signin.ghStep3"))}</p></li>` +
    `</ol>` +
    (ready
      ? `<div class="acts" style="margin-top:0">` +
        `<button type="button" class="btn primary" id="den-gh-start">${esc(t("err.signin.github"))}</button>` +
        `</div><div id="den-gh-flow" aria-live="polite"></div>`
      : "") +
    `<p class="den-gh-note" id="den-gh-only">${esc(t("err.signin.ghOnly"))}` +
    (g.learnMore
      ? ` <a id="den-gh-learn" href="${esc(g.learnMore)}" target="_blank" rel="noopener noreferrer">${esc(t("err.signin.ghLearn"))}</a>`
      : "") +
    `</p></div>`
  );
}

/** The device flow on the page: start, show the code, poll, go on. */
function wireGithub(root, t, s) {
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
          keepApproveKey(b);
          show(
            `<p class="lead" style="margin-top:12px">${esc(t("err.signin.githubDone"))}</p>`,
          );
          location.replace(landingAfterSignIn(location));
          return;
        }
        fail(
          b.state === "refused"
            ? t("err.signin.githubRefused", {
                login: b.login ?? "",
                name: s.name,
              })
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

/**
 * Approve this computer with a code (SEC-2a, the main fallback). The page
 * asks the server for a request: a short code to approve it with, on the
 * server (`<cli> web approve <code>`) or in a signed-in Settings › Access ›
 * Waiting devices, and a poll id only this page holds. It polls; once
 * approved, the poll sets the cookie and the page goes on by itself. A
 * live countdown runs out at 10 minutes: "This code expired", and a new
 * one is a click away. Denied, likewise.
 */
function wirePair(root, t, s) {
  const box = root.querySelector("#den-pair");
  if (!box) return;
  const host = s.machine || "";
  const target = s.ssh?.target || "";
  // SEC-2a-UX: the account to log in as, so the SSH app doesn't guess one.
  const user = s.ssh?.user || "";
  const login = user ? `${user}@${target}` : target;
  let poll = null;
  let tick = null;
  let gen = 0;
  const stop = () => {
    clearTimeout(poll);
    clearTimeout(tick);
    gen++;
  };
  const ended = (key) => {
    stop();
    box.innerHTML =
      `<p class="den-pair-end" role="alert" id="den-pair-ended">${withHost(t, key, { host })}</p>` +
      `<div class="acts" style="margin-top:0"><button type="button" class="btn primary" id="den-pair-new">${esc(t("err.signin.newCode"))}</button></div>`;
    box.querySelector("#den-pair-new").addEventListener("click", begin);
  };
  const failed = () => {
    stop();
    box.innerHTML =
      `<p class="den-pair-end" role="alert">${esc(t("err.signin.codeFailed", { name: s.name }))}</p>` +
      `<div class="acts" style="margin-top:0"><button type="button" class="btn" id="den-pair-new">${esc(t("err.retry"))}</button></div>`;
    box.querySelector("#den-pair-new").addEventListener("click", begin);
  };
  const show = (b) => {
    const term =
      s.ssh?.name && target
        ? `<a class="btn" id="den-pair-term" href="ssh://${esc(login)}">${esc(t("err.signin.openTerminal"))}</a>`
        : "";
    box.innerHTML =
      `<ol class="den-steps">` +
      `<li><p>${withHost(t, "err.signin.step1", { host })}</p>` +
      cmdLine("den-pair-cmd", b.approve, t) +
      `<p>${withHost(t, "err.signin.step1Or", { name: s.name, host })}</p></li>` +
      `<li><p>${esc(t("err.signin.step2"))}</p>` +
      `<p class="den-pair-wait" id="den-pair-status">${esc(t("err.signin.waiting"))} <span class="mono" id="den-pair-left"></span></p></li>` +
      `</ol>` +
      `<p>${withHost(t, "err.signin.noTerminal", { host })}</p>` +
      cmdLine("den-pair-ssh", b.ssh, t, term) +
      (term
        ? `<p class="den-pair-note" id="den-pair-note">${
            user
              ? withHost(t, "err.signin.sshUserNote", { host, user })
              : withHost(t, "err.signin.sshNote", { target })
          }</p>`
        : "");
    wireCopy(box, t);
  };
  function begin() {
    stop();
    const mine = gen;
    fetch("/api/signin/code", {
      method: "POST",
      cache: "no-store",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    })
      .then((r) => r.json().catch(() => ({})))
      .then((b) => {
        if (mine !== gen) return;
        if (!b.ok || !b.id || !b.approve) return failed();
        // The page's own clock, from what is left: no server clock skew.
        const deadline = Date.now() + Number(b.expiresIn ?? 600_000);
        show(b);
        const left = box.querySelector("#den-pair-left");
        const count = () => {
          if (mine !== gen) return;
          const ms = deadline - Date.now();
          if (ms <= 0) return ended("err.signin.codeExpired");
          left.textContent = countdownText(ms);
          tick = setTimeout(count, Math.min(1000, ms % 1000 || 1000));
        };
        count();
        const ask = () =>
          fetch(`/api/signin/code/${encodeURIComponent(b.id)}`, {
            cache: "no-store",
            credentials: "same-origin",
          })
            .then((r) => r.json().catch(() => ({})))
            .then((p) => {
              if (mine !== gen) return;
              if (p.state === "pending") {
                poll = setTimeout(ask, 1500);
                return;
              }
              if (p.state === "ok") {
                keepApproveKey(p);
                stop();
                box.innerHTML = `<p class="lead" id="den-pair-in">${esc(t("err.signin.youreIn"))}</p>`;
                location.replace(landingAfterSignIn(location));
                return;
              }
              ended(
                p.state === "denied"
                  ? "err.signin.codeDenied"
                  : "err.signin.codeExpired",
              );
            })
            .catch(() => {
              if (mine === gen) poll = setTimeout(ask, 3000);
            });
        poll = setTimeout(ask, 1500);
      })
      .catch(() => {
        if (mine === gen) failed();
      });
  }
  begin();
}

/**
 * The signed-out page (SEC-1b; SEC-2 spec "exact copy"): "Sign in to
 * <product>", which machine it runs on, Sign in with GitHub (when a client
 * id is configured), then "Or approve this computer" with a code, the ssh
 * one-liner from this computer, why, and (collapsed) the one-time link.
 * Every command names the machine it runs on and has a copy button. It
 * never asks for a secret or a token, and never runs anything here.
 *
 * On 127.0.0.1 or [::1] it links to the same page on localhost, where the
 * cookie is. A link from 127.0.0.1 lands here once without the cookie (a
 * cross-site navigation doesn't carry a SameSite=Strict one); /api/session,
 * asked same-origin, does carry it, so a signed-in browser reloads the page
 * from here (same-origin) and is let through.
 */
function mountSignedOut(root, sh, d) {
  const t = sh.t;
  const s = d.signin;
  const name = s.name || "Den";
  const host = s.machine || "";
  const title = s.expired
    ? t("err.signin.expiredTitle")
    : s.scope === "terminal"
      ? t("err.signin.terminal")
      : t("err.signin.title", { name });
  document.title = document.title.replace(/Error$/, title);
  const facts =
    `<dl class="facts">` +
    `<dt>${esc(t("err.500.id"))}</dt><dd class="mono" id="den-err-id">${esc(d.requestId)}</dd>` +
    `</dl>`;
  const head =
    `<div class="ph"><div><h1>${esc(title)}</h1>` +
    `<div class="sub">${esc(t("err.signin.sub"))}</div></div></div>`;
  if (s.confirm) {
    // SEC-2a: a link `web login` waits on: the code it printed, first.
    root.innerHTML =
      `<div class="ph"><div><h1>${esc(t("err.signin.title", { name }))}</h1>` +
      `<div class="sub">${esc(t("err.signin.sub"))}</div></div></div>` +
      `<div class="empty" id="den-signin">` +
      `<form id="den-confirm" autocomplete="off">` +
      `<p class="lead"><label for="den-confirm-code">${withHost(t, "err.signin.confirmLead", { host })}</label></p>` +
      `<div class="acts" style="margin-top:0">` +
      `<input id="den-confirm-code" class="mono" name="code" required maxlength="12" spellcheck="false" autocapitalize="characters" placeholder="ABCD-EFGH" ` +
      `style="font:16px/1.45 var(--mono);letter-spacing:0.08em;padding:6px 10px;border:1px solid var(--border);border-radius:var(--radius-button);background:var(--sunken);color:var(--text);width:12ch">` +
      `<button type="submit" class="btn primary" id="den-confirm-go">${esc(t("err.signin.confirmGo"))}</button></div>` +
      `<p class="den-confirm-err" id="den-confirm-err" role="alert" style="margin-top:12px"></p>` +
      `</form>` +
      `<p class="den-signin-why">${withHost(t, "err.signin.confirmWhy", { host })}</p>` +
      facts +
      `</div>`;
    const form = root.querySelector("#den-confirm");
    const input = root.querySelector("#den-confirm-code");
    const err = root.querySelector("#den-confirm-err");
    const go = root.querySelector("#den-confirm-go");
    input?.focus();
    form?.addEventListener("submit", (e) => {
      e.preventDefault();
      go.disabled = true;
      err.textContent = "";
      fetch(location.pathname + location.search, {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: input.value }),
      })
        .then((r) => r.json().catch(() => ({})))
        .then((b) => {
          go.disabled = false;
          if (b.ok) {
            keepApproveKey(b);
            err.textContent = "";
            form.innerHTML = `<p class="lead" id="den-confirm-in">${esc(t("err.signin.youreIn"))}</p>`;
            location.replace(typeof b.next === "string" ? b.next : "/");
            return;
          }
          err.textContent =
            b.code === "wrong_code"
              ? t("err.signin.confirmWrong")
              : b.code === "rate_limited"
                ? t("err.signin.confirmBusy")
                : t("err.signin.confirmGone", { host });
          if (b.code !== "wrong_code" && b.code !== "rate_limited")
            go.disabled = true;
          input.select();
        })
        .catch(() => {
          go.disabled = false;
          err.textContent = t("err.signin.confirmBusy");
        });
    });
    return;
  }
  if (s.localhost) {
    // 127.0.0.1 or [::1]: the cookie is on localhost. Nothing to approve.
    root.innerHTML =
      head +
      `<div class="empty" id="den-signin">` +
      `<p class="lead">${esc(t("err.signin.local", { host: location.host }))}</p>` +
      facts +
      `<div class="acts"><a class="btn primary" id="den-signin-local" href="${esc(s.localhost)}">${esc(t("err.421.open"))}</a></div></div>`;
    return;
  }
  const gh = githubBlock(s, t);
  root.innerHTML =
    head +
    `<div class="empty" id="den-signin">` +
    (s.expired
      ? `<p class="lead" role="alert">${esc(t("err.signin.expiredLead"))}</p>`
      : "") +
    `<p class="lead" id="den-signin-where">${withHost(t, "err.signin.where", { name, host })}</p>` +
    gh +
    `<h2 class="den-h" id="den-pair-title">${esc(t(gh ? "err.signin.approveOr" : "err.signin.approve"))}</h2>` +
    `<div id="den-pair" aria-live="polite"></div>` +
    `<p class="den-signin-why"><b>${esc(t("err.signin.whyTitle"))}</b> ${withHost(t, "err.signin.whyText", { name, host })}</p>` +
    `<details class="den-other" id="den-signin-other"><summary>${withCmd(t("err.signin.other", { cmd: "\u0000" }), "web login --origin")}</summary>` +
    `<p>${withHost(t, "err.signin.otherStep", { host })}</p>` +
    cmdLine("den-signin-cmd", s.cmd, t) +
    (s.ssh?.login
      ? `<p>${withHost(t, "err.signin.noTerminal", { host })}</p>` +
        cmdLine("den-signin-ssh", s.ssh.login, t)
      : "") +
    `</details>` +
    facts +
    `</div>`;
  wireCopy(root, t);
  wireGithub(root, t, s);
  wirePair(root, t, s);
  if (s.expired) return;
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
