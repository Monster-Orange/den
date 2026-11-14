/**
 * FB (den#81): Report an issue, the dialog (mock v3, F1–F8). One dialog,
 * three steps: Write, Include, Review and send. It opens on top of
 * whatever is open (showModal stacks over another dialog) without closing
 * it. Nothing is sent without the person's click after the preview, which
 * is the exact text the server will post (/api/report/preview).
 *
 *   openReport({ draft? })   opens it (a draft: Finish later's, or an
 *                            agent's, to review and send)
 *
 * Sending (/api/report/send): the person's `gh` files it. Not signed in:
 * F4, Den's GitHub App's device flow (/api/report/github-send), with the
 * filled-in new-issue tab as the other way. The same title open: F5. Over
 * the hour's limit: F7. Finish later: F8 (a draft on this computer).
 *
 * Framework-free and self-contained (the UI-kit shape): its own CSS on the
 * theme tokens, its words through denShell.t (fb.* keys, en/es/ja).
 */

const t = (key, vars) => window.denShell?.t?.(key, vars) ?? key;
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/** The flat speech-bubble icon (the mock's Report button). */
export const REPORT_ICON =
  '<svg class="fb-ico" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4V5z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 8v4M12 14.2v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

const CSS = `
.fb-dlg{font-family:var(--sans);width:min(640px,calc(100vw - 32px));max-width:100%;max-height:calc(100vh - 32px);padding:0;border:1px solid var(--border-strong, var(--border));border-radius:12px;background:var(--raised, var(--surface, var(--bg)));color:var(--text);box-shadow:var(--shadow);overflow:auto}
.fb-dlg::backdrop{background:rgba(0,0,0,.3)}
.fb-b{padding:16px 18px;display:grid;gap:10px}
.fb-b h2{font-size:17px;font-weight:600;margin:0;outline:none}
.fb-b p{margin:0;font-size:13px;line-height:1.5}
.fb-sub{color:var(--muted)}
.fb-steps{font:11px var(--mono);color:var(--muted);display:flex;gap:6px;flex-wrap:wrap}
.fb-steps b{color:var(--text)}
.fb-h{font:11px var(--mono);text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin-top:4px}
.fb-kinds{display:flex;gap:6px;flex-wrap:wrap}
.fb-kinds label{display:inline-flex;align-items:center;gap:6px;min-height:34px;padding:0 12px;border:1px solid var(--border-strong, var(--border));border-radius:999px;font-size:13px;cursor:pointer}
.fb-kinds input:checked + span{font-weight:600}
.fb-b label.fb-f{display:grid;gap:4px;font-size:13px}
.fb-b input[type=text],.fb-b textarea{font:13px var(--sans);padding:7px 9px;border:1px solid var(--border-strong, var(--border));border-radius:6px;background:var(--bg);color:var(--text);width:100%;box-sizing:border-box}
.fb-b textarea{min-height:76px;resize:vertical}
.fb-tools{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:13px}
.fb-b details{border:1px solid var(--border);border-radius:6px;padding:6px 8px;font-size:13px}
.fb-b summary{display:flex;align-items:center;gap:8px;cursor:pointer}
.fb-b summary .fb-i{margin-inline-start:auto;width:20px;height:20px;border-radius:50%;border:1px solid var(--border-strong, var(--border));display:inline-grid;place-items:center;font:11px var(--mono)}
.fb-b pre{margin:6px 0 0;font:12px/1.5 var(--mono);background:var(--sunken, var(--bg));padding:8px;border-radius:4px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:220px;overflow:auto}
.fb-dest{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:13px}
.fb-pill{font:11px var(--mono);border:1px solid var(--border-strong, var(--border));border-radius:999px;padding:1px 8px}
.fb-warn{border-inline-start:3px solid var(--warn);background:color-mix(in srgb,var(--warn) 10%,transparent);padding:8px 10px;border-radius:4px;font-size:13px}
.fb-err{color:var(--bad, var(--err));font-size:13px}
.fb-code{border:1px dashed var(--border-strong, var(--border));border-radius:6px;padding:10px;text-align:center;font:600 22px var(--mono);letter-spacing:.14em}
.fb-fine{font-size:12px;color:var(--muted)}
.fb-btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}
.fb-btns button,.fb-btns a{min-height:40px;padding:0 14px;border-radius:.2rem;border:1px solid var(--border-strong, var(--border));background:var(--surface, var(--bg));color:var(--text);font:13px var(--sans);cursor:pointer;display:inline-flex;align-items:center;text-decoration:none}
.fb-btns .fb-pri{background:var(--accent-fill, var(--accent));border-color:var(--accent-fill, var(--accent));color:var(--on-accent)}
.fb-btns button:focus-visible,.fb-btns a:focus-visible{outline:2px solid var(--accent-text, var(--accent));outline-offset:2px}
.fb-ico{width:16px;height:16px;flex:none}
@media (max-width:600px){
  .fb-dlg{width:100%;max-width:100%;margin:0;inset:auto 0 0 0;border-radius:12px 12px 0 0;max-height:92vh}
  .fb-b{padding:14px}
  .fb-btns{flex-direction:column;position:sticky;bottom:-14px;background:var(--raised, var(--surface, var(--bg)));padding-bottom:14px}
  .fb-btns button,.fb-btns a{width:100%;justify-content:center}
  .fb-steps .fb-wide{display:none}
}
@media (min-width:601px){.fb-steps .fb-narrow{display:none}}
`;

function ensureCss() {
  if (document.getElementById("fb-css")) return;
  const s = document.createElement("style");
  s.id = "fb-css";
  s.textContent = CSS;
  document.head.append(s);
}

const KINDS = ["bug", "idea", "question"];

/** The browser's own sections: what it runs, never who or where. */
export function clientSections(win = window) {
  const n = win.navigator || {};
  const dark = win.matchMedia?.("(prefers-color-scheme: dark)")?.matches;
  const open = [...(win.document?.querySelectorAll("dialog[open]") ?? [])]
    .map((d) => d.getAttribute("aria-label") || d.className || "dialog")
    .filter((x) => !/fb-dlg/.test(x));
  return {
    Browser: [
      String(n.userAgent || "?"),
      `viewport ${win.innerWidth}×${win.innerHeight} · ${win.devicePixelRatio || 1}×`,
      `${document.documentElement.getAttribute("data-theme") || (dark ? "dark" : "light")} · ${document.documentElement.lang || "en"}`,
    ].join("\n"),
    Page: [
      `page: ${document.getElementById("den-shell")?.getAttribute("data-page") || win.location.pathname}`,
      `dialogs open: ${open.length ? open.join(", ") : "none"}`,
    ].join("\n"),
  };
}

async function api(method, url, body, extra = {}) {
  // The shell's fetch adds X-Den-CSRF to a same-origin change (SEC-1a).
  const headers = { "content-type": "application/json", ...extra.headers };
  const r = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try {
    data = await r.json();
  } catch {
    /* not JSON */
  }
  return { status: r.status, data };
}

/** Remembered Include choices (Remember my choices), this browser only. */
const PREF_KEY = "den.report.include";
function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) || "null");
  } catch {
    return null;
  }
}
function savePrefs(p) {
  try {
    if (p) localStorage.setItem(PREF_KEY, JSON.stringify(p));
    else localStorage.removeItem(PREF_KEY);
  } catch {
    /* storage off: not remembered */
  }
}

/**
 * A write through the working pop-up (BUSY-1): it shows only when the
 * answer is slow. The dialog's own answers (F4, F5, F7: a 4xx) are its to
 * show; no answer or a 5xx is the pop-up's Failure, with Try again.
 * Resolves with { status, data }, or null when it didn't get through.
 */
async function write(url, body, title, button) {
  let got = null;
  const run = (headers) =>
    api("POST", url, body, { headers }).then((r) => {
      if (r.status === 0 || r.status >= 500) {
        const e = new Error(r.data.error || "");
        e.status = r.status;
        throw e;
      }
      got = r;
      return r.data;
    });
  const busy = window.denShell?.busyAction;
  if (!busy) {
    try {
      await run({});
    } catch {
      return null;
    }
    return got;
  }
  await busy({
    button,
    title,
    done: t("fb.busyDone"),
    failed: t("fb.busyFailed"),
    who: "Den",
    toastFast: false,
    run,
  });
  return got;
}

let current = null;

/** Opens the dialog (one at a time: a second call focuses the first). */
export async function openReport(opts = {}) {
  if (current) {
    current.dlg.querySelector("h2")?.focus();
    return current;
  }
  ensureCss();
  const dlg = document.createElement("dialog");
  dlg.className = "fb-dlg";
  dlg.setAttribute("aria-modal", "true");
  document.body.append(dlg);
  const d = opts.draft || {};
  const prefs = loadPrefs();
  const st = {
    step: "write",
    kind: KINDS.includes(d.kind) ? d.kind : "bug",
    title: d.title || "",
    description: d.description || "",
    sections: d.sections || prefs?.sections || null,
    redact:
      d.redact !== undefined ? d.redact !== false : prefs?.redact !== false,
    remember: !!prefs,
    repo: d.repo || null,
    draftId: d.id && d.by === "person" ? d.id : null,
    agentDraftId: d.id && d.by !== "person" ? d.id : null,
    info: null,
    diag: {},
    client: clientSections(),
    preview: null,
    error: "",
    dup: null,
    flow: null,
    link: "",
    sent: null,
    limit: null,
    addTo: null,
    fileNew: false,
    viaApp: false,
  };
  const self = { dlg, st, close };
  current = self;

  const [info, diag] = await Promise.all([
    api("GET", "/api/report"),
    api("GET", "/api/report/diagnostics"),
  ]);
  st.info = info.data || {};
  st.diag = diag.data?.sections || {};
  st.repo = st.repo || st.info.repos?.[0]?.repo || "";
  if (!st.sections) {
    st.sections = {};
    for (const k of Object.keys(allSections())) st.sections[k] = true;
  }

  function allSections() {
    return { ...st.diag, ...st.client };
  }
  function dirty() {
    return (
      st.step !== "sent" &&
      st.step !== "later" &&
      (st.title.trim() !== (d.title || "") ||
        st.description.trim() !== (d.description || ""))
    );
  }
  function form() {
    return {
      kind: st.kind,
      title: st.title,
      description: st.description,
      sections: st.sections,
      client: st.client,
      redact: st.redact,
      repo: st.repo,
      ...(st.draftId ? { draftId: st.draftId } : {}),
      ...(st.agentDraftId ? { draftId: st.agentDraftId } : {}),
    };
  }

  function stepsHtml(i) {
    const names = [t("fb.step1"), t("fb.step2"), t("fb.step3")];
    return `<div class="fb-steps" aria-live="polite"><span class="fb-wide">${names
      .map((n, k) => (k === i ? `<b>${esc(n)}</b>` : esc(n)))
      .join(" › ")}</span><span class="fb-narrow">${esc(
      t("fb.stepOf", { i: i + 1, n: 3 }),
    )} · <b>${esc(names[i].replace(/^\d+\s*/, ""))}</b></span></div>`;
  }
  const btn = (act, label, pri) =>
    `<button type="button" data-act="${act}"${pri ? ' class="fb-pri"' : ""}>${esc(label)}</button>`;
  const linkBtn = (href, label, pri) =>
    `<a href="${esc(href)}" target="_blank" rel="noopener"${pri ? ' class="fb-pri"' : ""}>${esc(label)}</a>`;

  function render() {
    let h = "";
    let role = "dialog";
    let label = t("fb.title");
    const err = st.error
      ? `<p class="fb-err" role="alert">${esc(st.error)}</p>`
      : "";
    if (st.step === "write") {
      h = `<h2 tabindex="-1">${esc(t("fb.title"))}</h2>
<p class="fb-sub">${esc(t("fb.sub"))}</p>${stepsHtml(0)}
<div class="fb-h" id="fb-kind">${esc(t("fb.kind"))}</div>
<div class="fb-kinds" role="radiogroup" aria-labelledby="fb-kind">${KINDS.map(
        (k) =>
          `<label><input type="radio" name="fb-kind" value="${k}"${st.kind === k ? " checked" : ""}><span>${esc(t(`fb.k.${k}`))}</span></label>`,
      ).join("")}</div>
<label class="fb-f">${esc(t("fb.titleL"))}<input type="text" data-f="title" maxlength="200" value="${esc(st.title)}"></label>
<label class="fb-f">${esc(t("fb.desc"))}<textarea data-f="description" maxlength="20000">${esc(st.description)}</textarea></label>
<div class="fb-h">${esc(t("fb.shot"))}</div>
<p class="fb-fine">${esc(t("fb.ncap"))}</p>${err}
<div class="fb-btns">${btn("next", t("fb.next"), true)}${btn("later", t("fb.later"))}${btn("cancel", t("fb.cancel"))}</div>`;
    } else if (st.step === "include") {
      label = t("fb.incH");
      const secs = allSections();
      h = `<h2 tabindex="-1">${esc(t("fb.incH"))}</h2>${stepsHtml(1)}
<p class="fb-fine">${esc(t("fb.incN"))}</p>
<div class="fb-tools">${btn("all", t("fb.all"))}${btn("none", t("fb.none"))}</div>
${Object.entries(secs)
  .map(([name, v], i) => {
    const nm =
      t(`fb.sec.${name}`) === `fb.sec.${name}` ? name : t(`fb.sec.${name}`);
    return `<details${i < 2 ? " open" : ""}><summary><input type="checkbox" data-sec="${esc(name)}" aria-label="${esc(nm)}"${st.sections[name] ? " checked" : ""}><b>${esc(nm)}</b><span class="fb-i" title="${esc(t("fb.dgi"))}" aria-label="${esc(t("fb.dgi"))}">i</span></summary><p class="fb-fine">${esc(t(`fb.use.${name}`) === `fb.use.${name}` ? "" : t(`fb.use.${name}`))}</p><pre>${esc(typeof v === "string" ? v : JSON.stringify(v, null, 2))}</pre></details>`;
  })
  .join("")}
<label class="fb-tools"><input type="checkbox" data-f="redact"${st.redact ? " checked" : ""}> ${esc(t("fb.redact"))}</label>
<label class="fb-tools"><input type="checkbox" data-f="remember"${st.remember ? " checked" : ""}> ${esc(t("fb.remember"))}</label>${err}
<div class="fb-btns">${btn("review", t("fb.step3"), true)}${btn("back-write", t("fb.back"))}</div>`;
    } else if (st.step === "review") {
      label = t("fb.revH");
      const pv = st.preview;
      const repos = st.info?.repos || [];
      h = `<h2 tabindex="-1">${esc(t("fb.revH"))}</h2>${stepsHtml(2)}
<div class="fb-h">${esc(t("fb.dest"))}</div>
<div class="fb-dest">${
        repos.length > 1
          ? `<select data-f="repo" aria-label="${esc(t("fb.dest"))}">${repos
              .map(
                (r) =>
                  `<option${r.repo === st.repo ? " selected" : ""}>${esc(r.repo)}</option>`,
              )
              .join("")}</select>`
          : `<b>${esc(st.repo)}</b>`
      }<span class="fb-pill">${esc(t("fb.pub"))}</span></div>
<pre data-preview>${esc(pv ? `${pv.title}\n\n${pv.body}` : "…")}</pre>
<div class="fb-warn" role="note"><b>${esc(t("fb.pub"))}.</b> ${esc(t("fb.pubW"))}</div>${err}
<div class="fb-btns">${btn("send", t("fb.send"), true)}${btn("later", t("fb.later"))}${btn("back-include", t("fb.back"))}</div>`;
    } else if (st.step === "signin") {
      label = t("fb.siH");
      const f = st.flow;
      h = `<h2 tabindex="-1">${esc(t("fb.siH"))}</h2><p>${esc(t("fb.siB"))}</p>
${
  f
    ? `<div class="fb-h">${esc(t("fb.codeL"))}</div><div class="fb-code" aria-live="polite">${esc(f.userCode)}</div><p class="fb-fine" aria-live="polite">${esc(t("fb.waiting"))}</p>`
    : `<p>${esc(t("fb.noApp"))}</p>`
}${err}
<div class="fb-btns">${
        f
          ? linkBtn(
              f.verificationUri || "https://github.com/login/device",
              t("fb.open"),
              true,
            )
          : ""
      }${btn("later", t("fb.later"), !f)}${btn("back-review", t("fb.back"))}</div>
${st.link ? `<p class="fb-fine">${esc(t("fb.siAlt"))} ${linkBtn(st.link, t("fb.siAltLink"))}</p>` : ""}`;
    } else if (st.step === "dup") {
      role = "alertdialog";
      label = t("fb.dupH");
      h = `<h2 tabindex="-1">${esc(t("fb.dupH"))}</h2><p>${esc(
        t("fb.dupB", { title: st.dup.title }),
      )} ${linkBtn(st.dup.url, `#${st.dup.number}`)}</p>
<div class="fb-btns">${btn("addto", t("fb.addTo"), true)}${btn("filenew", t("fb.fileNew"))}${btn("back-review", t("fb.back"))}</div>`;
    } else if (st.step === "sent") {
      label = t("fb.sentH");
      h = `<h2 tabindex="-1">${esc(t("fb.sentH"))}</h2><p>${esc(
        t(st.sent.added ? "fb.addedB" : "fb.sentB", { title: st.title }),
      )}</p>
<div class="fb-btns">${st.sent.url ? linkBtn(st.sent.url, t("fb.openIssue"), true) : ""}${btn("done", t("fb.done"), !st.sent.url)}</div>`;
    } else if (st.step === "limit") {
      role = "alertdialog";
      label = t("fb.limH", { n: st.limit.n });
      h = `<h2 tabindex="-1">${esc(label)}</h2><p>${esc(
        t("fb.limB", { min: st.limit.min }),
      )}</p>
<div class="fb-btns">${btn("later", t("fb.later"), true)}${btn("cancel", t("fb.cancel"))}</div>`;
    } else if (st.step === "failed") {
      role = "alertdialog";
      label = t("fb.failH");
      h = `<h2 tabindex="-1">${esc(t("fb.failH"))}</h2><p>${esc(st.error)}</p>
<div class="fb-btns">${st.link ? linkBtn(st.link, t("fb.siAltLink"), true) : ""}${btn("later", t("fb.later"), !st.link)}${btn("back-review", t("fb.back"))}</div>`;
    } else if (st.step === "later") {
      role = "status";
      label = t("fb.latH");
      h = `<h2 tabindex="-1">${esc(t("fb.latH"))}</h2><p>${esc(t("fb.latB"))}</p>
<div class="fb-btns">${btn("done", t("fb.done"), true)}</div>`;
    } else if (st.step === "keep") {
      role = "alertdialog";
      label = t("fb.keepH");
      h = `<h2 tabindex="-1">${esc(t("fb.keepH"))}</h2>
<div class="fb-btns">${btn("later", t("fb.keep"), true)}${btn("discard", t("fb.discard"))}${btn("back-write", t("fb.back"))}</div>`;
    }
    dlg.setAttribute("role", role);
    dlg.setAttribute("aria-label", label);
    dlg.dataset.step = st.step;
    dlg.innerHTML = `<div class="fb-b">${h}</div>`;
    const focus =
      st.step === "write"
        ? dlg.querySelector('[data-f="title"]')
        : dlg.querySelector("h2");
    focus?.focus();
  }

  function go(step) {
    st.step = step;
    st.error = "";
    render();
  }

  async function preview() {
    const r = await write("/api/report/preview", form(), t("fb.busyPreview"));
    if (!r) return render();
    if (r.status !== 200) {
      st.error = r.data.error || `${r.status}`;
      st.preview = null;
    } else st.preview = r.data;
    render();
  }

  async function saveDraft() {
    const r = await write(
      "/api/report/drafts",
      { ...form(), ...(st.draftId ? { id: st.draftId } : {}) },
      t("fb.busySave"),
      dlg.querySelector('[data-act="later"]'),
    );
    if (!r) return render();
    if (r.status !== 200) {
      st.error = r.data.error || `${r.status}`;
      return render();
    }
    st.draftId = r.data.draft?.id || st.draftId;
    go("later");
  }

  function onAnswer(r) {
    if (r.status === 200 && r.data.ok) {
      st.sent = r.data;
      return go("sent");
    }
    if (r.status === 429) {
      const next = r.data.nextAt ? Date.parse(r.data.nextAt) : Date.now();
      st.limit = {
        n: r.data.limit ?? 5,
        min: Math.max(1, Math.ceil((next - Date.now()) / 60_000)),
      };
      return go("limit");
    }
    if (r.status === 409 && r.data.duplicate) {
      st.dup = r.data.duplicate;
      return go("dup");
    }
    st.link = r.data.newIssueUrl || st.link;
    if (r.status === 409 && r.data.need === "github") {
      if (r.data.deviceFlow) return viaApp();
      st.flow = null;
      return go("signin");
    }
    st.error = r.data.error || `${r.status}`;
    go("failed");
  }

  async function send() {
    if (st.viaApp) return viaApp();
    const r = await write(
      "/api/report/send",
      {
        ...form(),
        ...(st.addTo !== null ? { addTo: st.addTo } : {}),
        ...(st.fileNew ? { fileNew: true } : {}),
      },
      t("fb.busySend"),
      dlg.querySelector(
        '[data-act="send"],[data-act="addto"],[data-act="filenew"]',
      ),
    );
    if (!r) return render();
    onAnswer(r);
  }

  /** F4 with Den's GitHub App: show the code, wait for the approval. */
  async function viaApp() {
    st.viaApp = true;
    const r = await write(
      "/api/report/github-send",
      {
        ...form(),
        ...(st.addTo !== null ? { addTo: st.addTo } : {}),
        ...(st.fileNew ? { fileNew: true } : {}),
      },
      t("fb.busySend"),
    );
    if (!r) return render();
    st.link = r.data.newIssueUrl || st.link;
    if (r.status !== 200 || !r.data.flow) {
      if (r.status === 429 || (r.status === 409 && r.data.duplicate))
        return onAnswer(r);
      st.flow = null;
      st.error = r.data.error || "";
      return go("signin");
    }
    st.flow = r.data.flow;
    go("signin");
    const id = st.flow.id;
    const poll = async () => {
      if (current !== self || st.step !== "signin" || st.flow?.id !== id)
        return;
      const p = await api("GET", `/api/report/github-send/${id}`);
      const f = p.data.flow;
      if (!f || f.state === "pending") return setTimeout(poll, 2000);
      if (f.state === "ok") {
        st.sent = f.result || {};
        return go("sent");
      }
      st.error =
        f.message || (f.state === "expired" ? t("fb.expired") : t("fb.denied"));
      go("failed");
    };
    setTimeout(poll, 2000);
  }

  function close() {
    if (current === self) current = null;
    if (dlg.open) dlg.close();
    dlg.remove();
  }

  /** Esc: back from "keep it?", ask when text was typed, else close. */
  const onEsc = () => {
    if (st.step === "keep") return go("write");
    if (dirty()) return go("keep");
    close();
  };
  dlg.addEventListener("cancel", (e) => {
    e.preventDefault();
    onEsc();
  });
  // The page's own Esc handlers may stop the dialog's cancel: Esc is
  // handled here first.
  dlg.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    onEsc();
  });
  // Chrome may close a dialog even when its cancel is stopped (no user
  // activation since the last Esc): with text typed, it opens again and
  // asks to keep it; else it is gone.
  dlg.addEventListener("close", () => {
    if (current !== self) return;
    if (dirty() && st.step !== "keep") {
      dlg.showModal();
      return go("keep");
    }
    close();
  });
  dlg.addEventListener("input", (e) => {
    const f = e.target.getAttribute?.("data-f");
    if (f === "title" || f === "description") st[f] = e.target.value;
  });
  dlg.addEventListener("change", (e) => {
    const el = e.target;
    if (el.name === "fb-kind") st.kind = el.value;
    const sec = el.getAttribute?.("data-sec");
    if (sec) st.sections[sec] = el.checked;
    const f = el.getAttribute?.("data-f");
    if (f === "redact") st.redact = el.checked;
    if (f === "remember") st.remember = el.checked;
    if (f === "repo") {
      st.repo = el.value;
      void preview();
    }
  });
  dlg.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-act]");
    if (!b) return;
    const act = b.getAttribute("data-act");
    if (act === "next") {
      if (!st.title.trim()) {
        st.error = t("fb.needTitle");
        return render();
      }
      return go("include");
    }
    if (act === "all" || act === "none") {
      for (const k of Object.keys(allSections()))
        st.sections[k] = act === "all";
      return render();
    }
    if (act === "review") {
      savePrefs(
        st.remember ? { sections: st.sections, redact: st.redact } : null,
      );
      st.preview = null;
      go("review");
      return void preview();
    }
    if (act === "send") return void send();
    if (act === "addto") {
      st.addTo = st.dup.number;
      st.fileNew = false;
      return void send();
    }
    if (act === "filenew") {
      st.fileNew = true;
      st.addTo = null;
      return void send();
    }
    if (act === "later") return void saveDraft();
    if (act === "back-write") return go("write");
    if (act === "back-include") return go("include");
    if (act === "back-review") {
      go("review");
      return void preview();
    }
    if (act === "cancel") return dirty() ? go("keep") : close();
    if (act === "discard" || act === "done") return close();
  });

  render();
  dlg.showModal();
  render();
  return self;
}
