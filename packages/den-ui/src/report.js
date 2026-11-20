/**
 * den-ui Report form: Report an issue, one dialog, three steps (Write,
 * Include, Review and send). It opens on top of whatever is open
 * (showModal stacks over another dialog) without closing it. Nothing is
 * sent without the person's click on Review, which shows the exact text.
 *
 *   configureReport({ lang, adapter, busy, mine, page, screenshot })
 *     adapter   the product's server calls, all optional:
 *       fileReport(payload) → Promise<{ number, url } | { error }>
 *                 payload: the form, its preview, and `shot`: the masked
 *                 screenshot as a PNG data URL, or null ("Don't include")
 *                 the simple way: on success the form says "Filed as #N"
 *                 with the link. With no way to send, the form offers
 *                 Copy report only.
 *       info()           → { repos: [{ repo }], maxPerHour, captureSeconds }
 *                 each repo may say its visibility ("public" | "private" |
 *                 "internal" | "unknown"; missing or anything else is
 *                 "unknown": a "Visibility not known" pill and a caution,
 *                 never the public pill nor a private claim) and an
 *                 audience (who can see it, plain text)
 *       diagnostics()    → { sections: { name: text } }  shown on Include
 *       preview(form, headers)  → { status, data: { title, body } }
 *                 the text the product will post (its redactor's); else
 *                 the kit makes one from the form
 *       send(form, headers)     → { status, data }  the full way: 200 ok
 *                 (data.url, data.added), 409 duplicate / need github,
 *                 429 the hour's limit (data.nextAt, data.limit)
 *       githubSend(form, headers), githubPoll(id)   a device-flow sign-in
 *       saveDraft(form, headers) → { status, data: { draft: { id } } }
 *                 Finish later (hidden without it)
 *     busy(action, run, opts)   the working pop-up (busy.js's busyAction
 *               with the product's words), for the slow calls
 *     mine()    opens "My reports" (the link is hidden without it)
 *     page()    the page's name for the Page section (else its path)
 *     screenshot  false: no screenshot step (report-shot.js, loaded when
 *               a report opens)
 *     library   html-to-image's URL on the product's origin (the
 *               screenshot's library)
 *   openReport({ prefill?, draft? })   opens it (one at a time: a second
 *               call focuses the first). prefill: { kind, title,
 *               description } (a per-item "Report this …" button)
 *
 * Words: the kit's (kit.report.*, en/es/ja). Look: report.css.
 */
import { esc as kitEsc, kitT } from "./strings.js";
import { focusBack, openerOf } from "./dialog.js";

const cfg = {
  lang: "en",
  adapter: null,
  busy: null,
  mine: null,
  page: null,
  screenshot: true,
  library: "",
};
const lang = () => (typeof cfg.lang === "function" ? cfg.lang() : cfg.lang);
const t = (key, vars) => kitT(lang(), key, vars);
const esc = kitEsc;

export function configureReport(o = {}) {
  Object.assign(cfg, o);
}

const VIS = ["public", "private", "internal"];

/**
 * Who can see a report sent to `repo`, one of the host's info().repos[]
 * (issue 415). Public, private and internal only when the host says so;
 * anything else is "unknown": the form then neither says public nor claims
 * private, and keeps the caution (mask anything private). The audience
 * shows only on private and internal. Gives the pill (after the
 * destination) and the note (above Send) as markup, every word escaped.
 */
export function reportVisibility(repo, lng) {
  const r = repo || {};
  const l = lng ?? lang();
  const say = (key, vars) => esc(kitT(l, key, vars));
  const visibility = VIS.includes(r.visibility) ? r.visibility : "unknown";
  const closed = visibility === "private" || visibility === "internal";
  const audience = closed ? String(r.audience || "").trim() : "";
  const key = { public: "pub", private: "priv", internal: "int" }[visibility];
  const pill = `<span class="fb-pill" data-vis="${visibility}">${say(
    `kit.report.${key || "unk"}`,
  )}</span>${audience ? `<span class="fb-fine">${esc(audience)}</span>` : ""}`;
  const note =
    visibility === "public"
      ? `<div class="fb-warn" role="note"><b>${say("kit.report.pub")}.</b> ${say("kit.report.pubW")}</div>`
      : closed
        ? `<p class="fb-fine" role="note" data-vis-note>${audience ? say("kit.report.privW", { who: audience }) : say("kit.report.privN")}</p>`
        : `<div class="fb-warn" role="note" data-vis-unknown>${say("kit.report.unkW")}</div>`;
  return { visibility, audience, pill, note };
}

/** The report as text, from the form alone (no product preview). */
export function localPreview(f) {
  const lines = [
    `**Kind:** ${f.kind}`,
    `**Title:** ${f.title}`,
    "",
    f.description || "",
  ];
  const secs = { ...(f.diag || {}), ...(f.client || {}) };
  for (const [name, on] of Object.entries(f.sections || {})) {
    if (!on || secs[name] == null) continue;
    const v = secs[name];
    lines.push(
      "",
      `### ${name}`,
      "",
      "```",
      typeof v === "string" ? v : JSON.stringify(v, null, 2),
      "```",
    );
  }
  return { title: f.title, body: lines.join("\n") };
}

/** Text to the clipboard (navigator.clipboard, else a selection's copy). */
export function copyReport(text) {
  if (navigator.clipboard?.writeText)
    return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.className = "kit-offscreen";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy") ? resolve() : reject(new Error("copy"));
    } catch (e) {
      reject(e);
    } finally {
      ta.remove();
    }
  });
}
/**
 * report.css, once: the page's own <link> to it when there is one (a
 * product loads it in its <head>), else one added beside this module.
 */
function ensureCss() {
  if (document.querySelector('link[rel="stylesheet"][href*="report.css"]'))
    return Promise.resolve();
  return new Promise((ok) => {
    const l = document.createElement("link");
    l.rel = "stylesheet";
    l.href = new URL("./report.css", import.meta.url).href;
    l.onload = l.onerror = () => ok();
    document.head.append(l);
  });
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
      `page: ${(cfg.page && cfg.page()) || win.location.pathname}`,
      `dialogs open: ${open.length ? open.join(", ") : "none"}`,
    ].join("\n"),
  };
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
 * A write through the working pop-up (cfg.busy): it shows only when the
 * answer is slow. The form's own answers (a 4xx: signed out, a duplicate,
 * the hour's limit) are its to show; no answer or a 5xx is the pop-up's
 * Failure, with Try again. `call(headers)` is the adapter's, resolving
 * with { status, data }. `action` names it for the pop-up's words.
 * Resolves with { status, data }, or null when it didn't get through.
 */
async function write(call, action, button) {
  let got = null;
  const run = (headers) =>
    Promise.resolve(call(headers || {})).then((r) => {
      const res = r || { status: 0, data: {} };
      res.data = res.data || {};
      if (res.status === 0 || res.status >= 500) {
        const e = new Error(res.data.error || "");
        e.status = res.status;
        throw e;
      }
      got = res;
      return res.data;
    });
  if (!cfg.busy) {
    try {
      await run({});
    } catch {
      return null;
    }
    return got;
  }
  await cfg.busy(action, run, { button, toastFast: false });
  return got;
}

let current = null;

/** Opens the dialog (one at a time: a second call focuses the first). */
export async function openReport(opts = {}) {
  if (current) {
    current.dlg.querySelector("h2")?.focus();
    return current;
  }
  // What opened it, for focus to go back to when it closes (Safari doesn't
  // focus a clicked button, so its own dialog restore finds the body).
  const opener = openerOf(opts.opener);
  ensureCss();
  const dlg = document.createElement("dialog");
  dlg.className = "fb-dlg";
  dlg.setAttribute("aria-modal", "true");
  const d = opts.draft || opts.prefill || {};
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
    // The screenshot: a canvas, or null when the page couldn't be taken.
    shot: null,
    masks: [],
    noShot: false,
    drag: null,
    saved: null,
  };
  const self = { dlg, st, close };
  const sends = () => !!(ad.send || ad.fileReport);
  current = self;

  const ad = cfg.adapter || {};
  const [info, diag, shots] = await Promise.all([
    ad.info ? Promise.resolve(ad.info()).catch(() => ({})) : {},
    ad.diagnostics ? Promise.resolve(ad.diagnostics()).catch(() => ({})) : {},
    // Loaded only when a report opens: a page without the screenshot
    // module (or a failed load) still has Report, with no screenshot.
    cfg.screenshot === false
      ? null
      : import("./report-shot.js")
          .then((m) => {
            if (cfg.library) m.configureShots({ library: cfg.library });
            return m;
          })
          .catch(() => null),
    ensureCss(),
  ]);
  st.info = info || {};
  // Taken before the dialog is on the page, so it shows what the person
  // saw: the page and any pop-up open over it.
  // A draft brings its own: Finish later's from this browser (with its
  // masks), an agent's from its record.
  const fromDraft = async () => {
    if (d.by === "person" && d.id) {
      const k = await shots.loadShot(d.id);
      if (!k) return null;
      st.masks = k.masks;
      st.noShot = k.noShot;
      return k.canvas;
    }
    return typeof d.shot === "string" ? shots.canvasOf(d.shot) : null;
  };
  st.shot = !shots
    ? null
    : opts.draft
      ? await fromDraft()
      : await shots.capture({
          seconds: st.info.captureSeconds || 15,
          skip: (el) => el.classList?.contains("fb-dlg"),
        });
  if (current !== self) return self;
  document.body.append(dlg);
  st.diag = diag?.sections || diag || {};
  st.repo = st.repo || st.info.repos?.[0]?.repo || "";
  if (!st.sections) {
    st.sections = {};
    for (const k of Object.keys(allSections())) st.sections[k] = true;
  }

  function allSections() {
    return { ...st.diag, ...st.client };
  }
  /** Who can see the selected repo (issue 415): see reportVisibility. */
  const selected = (repos) => repos.find((x) => x.repo === st.repo) || {};
  const visPill = (repos) => reportVisibility(selected(repos), lang()).pill;
  const visNote = (repos) => reportVisibility(selected(repos), lang()).note;
  /** Whether a screenshot goes with the report. */
  function shotOn() {
    return !!st.shot && !st.noShot;
  }
  function maskedShot() {
    return shots.masked(st.shot, st.masks);
  }
  const pct = (v) => Math.round(v * 100);
  /** Draws the screenshot with its masks (and one being dragged). */
  function paintShot() {
    const c = dlg.querySelector("canvas[data-shot]");
    if (!c || !st.shot) return;
    c.width = st.shot.width;
    c.height = st.shot.height;
    const g = c.getContext("2d");
    g.drawImage(maskedShot(), 0, 0);
    if (st.drag?.b) {
      const r = shots.rectOf(st.drag.a, st.drag.b);
      // Black at 60%: a mask being drawn (a mask hides; not a theme colour).
      g.fillStyle = "black";
      g.globalAlpha = 0.6;
      g.fillRect(r.x * c.width, r.y * c.height, r.w * c.width, r.h * c.height);
      g.globalAlpha = 1;
    }
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
    const names = [
      t("kit.report.step1"),
      t("kit.report.step2"),
      t("kit.report.step3"),
    ];
    return `<div class="fb-steps" aria-live="polite"><span class="fb-wide">${names
      .map((n, k) => (k === i ? `<b>${esc(n)}</b>` : esc(n)))
      .join(" › ")}</span><span class="fb-narrow">${esc(
      t("kit.report.stepOf", { i: i + 1, n: 3 }),
    )} · <b>${esc(names[i].replace(/^\d+\s*/, ""))}</b></span></div>`;
  }
  // Finish later only where the product keeps drafts.
  const laterBtn = (label, pri) =>
    ad.saveDraft ? btn("later", label, pri) : "";
  const btn = (act, label, pri) =>
    `<button type="button" data-act="${act}"${pri ? ' class="fb-pri"' : ""}>${esc(label)}</button>`;
  const linkBtn = (href, label, pri) =>
    `<a href="${esc(href)}" target="_blank" rel="noopener"${pri ? ' class="fb-pri"' : ""}>${esc(label)}</a>`;

  /** Draws the step; `focusSel` keeps focus where the person was. */
  function render(focusSel) {
    let h = "";
    let role = "dialog";
    let label = t("kit.report.title");
    const err = st.error
      ? `<p class="fb-err" role="alert">${esc(st.error)}</p>`
      : "";
    if (st.step === "write") {
      h = `<h2 tabindex="-1">${esc(t("kit.report.title"))}</h2>
<p class="fb-sub">${esc(t("kit.report.sub"))}</p>${cfg.mine ? `<button type="button" class="fb-lk" data-act="mine">${esc(t("kit.report.mine"))}</button>` : ""}${stepsHtml(0)}
<div class="fb-h" id="fb-kind">${esc(t("kit.report.kind"))}</div>
<div class="fb-kinds" role="radiogroup" aria-labelledby="fb-kind">${KINDS.map(
        (k) =>
          `<label><input type="radio" name="fb-kind" value="${k}"${st.kind === k ? " checked" : ""}><span>${esc(t(`kit.report.k.${k}`))}</span></label>`,
      ).join("")}</div>
<label class="fb-f">${esc(t("kit.report.titleL"))}<input type="text" data-f="title" maxlength="200" value="${esc(st.title)}"></label>
<label class="fb-f">${esc(t("kit.report.desc"))}<textarea data-f="description" maxlength="20000">${esc(st.description)}</textarea></label>
<div class="fb-h">${esc(t("kit.report.shot"))}</div>
${
  st.shot
    ? `<p class="fb-fine">${esc(t("kit.report.shotNote"))}</p>
<div class="fb-shot"${st.noShot ? " hidden" : ""}><canvas data-shot role="img" aria-label="${esc(t("kit.report.shot"))}"></canvas></div>
<div class="fb-tools">${st.noShot ? "" : btn("undo", t("kit.report.undo"))}<label><input type="checkbox" data-f="noshot"${st.noShot ? " checked" : ""}> ${esc(t("kit.report.nos"))}</label><span class="fb-fine" aria-live="polite">${st.noShot ? "" : esc(t("kit.report.masks", { n: st.masks.length }))}</span></div>
${
  st.noShot
    ? ""
    : `<details class="fb-kbd"${st.kbd ? " open" : ""}><summary>${esc(t("kit.report.kbdMask"))}</summary>
<div class="fb-tools">${[
        ["x", "kit.report.mx"],
        ["y", "kit.report.my"],
        ["w", "kit.report.mw"],
        ["h", "kit.report.mh"],
      ]
        .map(
          ([k, l]) =>
            `<label>${esc(t(l))} <input type="number" data-m="${k}" min="0" max="100" step="1" value="${k === "w" || k === "h" ? 20 : 0}"></label>`,
        )
        .join(
          "",
        )}${btn("addmask", t("kit.report.addMask"))}${btn("maskall", t("kit.report.maskAll"))}</div>
<ul class="fb-masks">${st.masks
        .map(
          (m, i) =>
            `<li>${esc(t("kit.report.area", { x: pct(m.x), y: pct(m.y), w: pct(m.w), h: pct(m.h) }))} <button type="button" data-act="rmmask" data-i="${i}">${esc(t("kit.report.rmMask"))}</button></li>`,
        )
        .join("")}</ul></details>`
}`
    : `<p class="fb-fine" role="status">${esc(t("kit.report.ncap"))}</p>`
}${err}
<div class="fb-btns">${btn("next", t("kit.report.next"), true)}${laterBtn(t("kit.report.later"))}${btn("cancel", t("kit.report.cancel"))}</div>`;
    } else if (st.step === "include") {
      label = t("kit.report.incH");
      const secs = allSections();
      h = `<h2 tabindex="-1">${esc(t("kit.report.incH"))}</h2>${stepsHtml(1)}
<p class="fb-fine">${esc(t("kit.report.incN"))}</p>
<div class="fb-tools">${btn("all", t("kit.report.all"))}${btn("none", t("kit.report.none"))}</div>
${Object.entries(secs)
  .map(([name, v], i) => {
    const nm =
      t(`kit.report.sec.${name}`) === `kit.report.sec.${name}`
        ? name
        : t(`kit.report.sec.${name}`);
    return `<details${i < 2 ? " open" : ""}><summary><input type="checkbox" data-sec="${esc(name)}" aria-label="${esc(nm)}"${st.sections[name] ? " checked" : ""}><b>${esc(nm)}</b><span class="fb-i" title="${esc(t("kit.report.dgi"))}" aria-label="${esc(t("kit.report.dgi"))}">i</span></summary><p class="fb-fine">${esc(t(`kit.report.use.${name}`) === `kit.report.use.${name}` ? "" : t(`kit.report.use.${name}`))}</p><pre>${esc(typeof v === "string" ? v : JSON.stringify(v, null, 2))}</pre></details>`;
  })
  .join("")}
<label class="fb-tools"><input type="checkbox" data-f="redact"${st.redact ? " checked" : ""}> ${esc(t("kit.report.redact"))}</label>
<label class="fb-tools"><input type="checkbox" data-f="remember"${st.remember ? " checked" : ""}> ${esc(t("kit.report.remember"))}</label>${err}
<div class="fb-btns">${btn("review", t("kit.report.step3"), true)}${btn("back-write", t("kit.report.back"))}</div>`;
    } else if (st.step === "review") {
      label = t("kit.report.revH");
      const pv = st.preview;
      const repos = st.info?.repos || [];
      h = `<h2 tabindex="-1">${esc(t("kit.report.revH"))}</h2>${stepsHtml(2)}
${
  sends()
    ? `<div class="fb-h">${esc(t("kit.report.dest"))}</div>
<div class="fb-dest">${
        repos.length > 1
          ? `<select data-f="repo" aria-label="${esc(t("kit.report.dest"))}">${repos
              .map(
                (r) =>
                  `<option${r.repo === st.repo ? " selected" : ""}>${esc(r.repo)}</option>`,
              )
              .join("")}</select>`
          : `<b>${esc(st.repo)}</b>`
      }${visPill(repos)}</div>`
    : ""
}
<pre data-preview>${esc(pv ? `${pv.title}\n\n${pv.body}` : "…")}</pre>${
        shotOn()
          ? `<div class="fb-h">${esc(t("kit.report.revShot", { n: st.masks.length }))}</div><div class="fb-shot"><img data-shot-review alt="${esc(t("kit.report.revShot", { n: st.masks.length }))}" src="${maskedShot().toDataURL("image/png")}"></div>`
          : ""
      }
${sends() ? visNote(repos) : ""}${err}${st.copied ? `<p class="fb-fine" role="status">${esc(t(st.copied === "ok" ? "kit.report.copied" : "kit.report.copyFailed"))}</p>` : ""}
<div class="fb-btns">${sends() ? btn("send", t("kit.report.send"), true) : btn("copy", t("kit.report.copy"), true)}${laterBtn(t("kit.report.later"))}${btn("back-include", t("kit.report.back"))}</div>`;
    } else if (st.step === "signin") {
      label = t("kit.report.siH");
      const f = st.flow;
      h = `<h2 tabindex="-1">${esc(t("kit.report.siH"))}</h2><p>${esc(t("kit.report.siB"))}</p>
${
  f
    ? `<div class="fb-h">${esc(t("kit.report.codeL"))}</div><div class="fb-code" aria-live="polite">${esc(f.userCode)}</div><p class="fb-fine" aria-live="polite">${esc(t("kit.report.waiting"))}</p>`
    : `<p>${esc(t("kit.report.noApp"))}</p>`
}${err}
<div class="fb-btns">${
        f
          ? linkBtn(
              f.verificationUri || "https://github.com/login/device",
              t("kit.report.open"),
              true,
            )
          : ""
      }${laterBtn(t("kit.report.later"), !f)}${btn("back-review", t("kit.report.back"))}</div>
${st.link ? `<p class="fb-fine">${esc(t("kit.report.siAlt"))} ${linkBtn(st.link, t("kit.report.siAltLink"))}</p>` : ""}`;
    } else if (st.step === "dup") {
      role = "alertdialog";
      label = t("kit.report.dupH");
      h = `<h2 tabindex="-1">${esc(t("kit.report.dupH"))}</h2><p>${esc(
        t("kit.report.dupB", { title: st.dup.title }),
      )} ${linkBtn(st.dup.url, `#${st.dup.number}`)}</p>
<div class="fb-btns">${btn("addto", t("kit.report.addTo"), true)}${btn("filenew", t("kit.report.fileNew"))}${btn("back-review", t("kit.report.back"))}</div>`;
    } else if (st.step === "sent") {
      label = t("kit.report.sentH");
      h = `<h2 tabindex="-1">${esc(t("kit.report.sentH"))}</h2>${
        st.sent.filed
          ? `<p>${esc(t("kit.report.filed", { n: st.sent.number }))}${st.sent.url ? ` ${linkBtn(st.sent.url, `#${st.sent.number}`)}` : ""}</p>`
          : `<p>${esc(t(st.sent.added ? "kit.report.addedB" : "kit.report.sentB", { title: st.title }))}</p>`
      }${
        st.saved
          ? `<p data-saved>${esc(t(st.saved.copied ? "kit.report.sentShot" : "kit.report.sentShotSaved"))}</p>`
          : ""
      }
<div class="fb-btns">${st.sent.url ? linkBtn(st.sent.url, t("kit.report.openIssue"), true) : ""}${btn("done", t("kit.report.done"), !st.sent.url)}</div>`;
    } else if (st.step === "limit") {
      role = "alertdialog";
      label = t("kit.report.limH", { n: st.limit.n });
      h = `<h2 tabindex="-1">${esc(label)}</h2><p>${esc(
        t("kit.report.limB", { min: st.limit.min }),
      )}</p>
<div class="fb-btns">${laterBtn(t("kit.report.later"), true)}${btn("cancel", t("kit.report.cancel"))}</div>`;
    } else if (st.step === "failed") {
      role = "alertdialog";
      label = t("kit.report.failH");
      h = `<h2 tabindex="-1">${esc(t("kit.report.failH"))}</h2><p>${esc(st.error)}</p>
<div class="fb-btns">${btn("retry", t("kit.report.retry"), true)}${st.link ? linkBtn(st.link, t("kit.report.siAltLink")) : ""}${laterBtn(t("kit.report.later"))}${btn("back-review", t("kit.report.back"))}</div>`;
    } else if (st.step === "later") {
      role = "status";
      label = t("kit.report.latH");
      h = `<h2 tabindex="-1">${esc(t("kit.report.latH"))}</h2><p>${esc(t("kit.report.latB"))}</p>
<div class="fb-btns">${btn("done", t("kit.report.done"), true)}</div>`;
    } else if (st.step === "keep") {
      role = "alertdialog";
      label = t("kit.report.keepH");
      h = `<h2 tabindex="-1">${esc(t("kit.report.keepH"))}</h2>
<div class="fb-btns">${laterBtn(t("kit.report.keep"), true)}${btn("discard", t("kit.report.discard"))}${btn("back-write", t("kit.report.back"))}</div>`;
    }
    dlg.setAttribute("role", role);
    dlg.setAttribute("aria-label", label);
    dlg.dataset.step = st.step;
    dlg.innerHTML = `<div class="fb-b">${h}</div>`;
    paintShot();
    const focus =
      (focusSel && dlg.querySelector(focusSel)) ||
      (st.step === "write"
        ? dlg.querySelector('[data-f="title"]')
        : dlg.querySelector("h2"));
    focus?.focus();
  }

  /** A step, with what went wrong to show on it (none by default). */
  function go(step, error = "") {
    st.step = step;
    st.error = error;
    render();
  }

  async function preview() {
    if (!ad.preview) {
      st.preview = localPreview({ ...form(), diag: st.diag });
      return render();
    }
    const r = await write((h) => ad.preview(form(), h), "report-preview");
    if (!r) return render();
    if (r.status !== 200) {
      st.error = r.data.error || `${r.status}`;
      st.preview = null;
    } else st.preview = r.data;
    render();
  }

  async function saveDraft() {
    const r = await write(
      (h) =>
        ad.saveDraft(
          { ...form(), ...(st.draftId ? { id: st.draftId } : {}) },
          h,
        ),
      "save-report-draft",
      dlg.querySelector('[data-act="later"]'),
    );
    if (!r) return render();
    if (r.status !== 200) {
      st.error = r.data.error || `${r.status}`;
      return render();
    }
    st.draftId = r.data.draft?.id || st.draftId;
    // The screenshot stays in this browser, never on the product's server.
    if (shots && st.draftId)
      await (st.shot
        ? shots.keepShot(st.draftId, st.shot, st.masks, st.noShot)
        : shots.dropShot(st.draftId));
    go("later");
  }

  /** Sent: then the masked screenshot is saved and copied to paste. */
  function sent(data) {
    st.sent = data || {};
    if (shots && st.draftId) void shots.dropShot(st.draftId);
    go("sent");
    if (!shotOn()) return;
    void shots.saveAndCopy(maskedShot()).then((r) => {
      st.saved = r.saved || r.copied ? r : null;
      if (current === self && st.step === "sent") render();
    });
  }

  function onAnswer(r) {
    if (r.status === 200 && r.data.ok) return sent(r.data);
    if (r.status === 429) {
      const next = r.data.nextAt ? Date.parse(r.data.nextAt) : Date.now();
      st.limit = {
        n: r.data.limit ?? st.info.maxPerHour,
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
      if (r.data.deviceFlow && ad.githubSend) return viaApp();
      st.flow = null;
      return go("signin");
    }
    go("failed", r.data.error || `${r.status}`);
  }

  async function send() {
    if (!ad.send && ad.fileReport) return fileIt();
    if (st.viaApp) return viaApp();
    const r = await write(
      (h) =>
        ad.send(
          {
            ...form(),
            ...(st.addTo !== null ? { addTo: st.addTo } : {}),
            ...(st.fileNew ? { fileNew: true } : {}),
          },
          h,
        ),
      "send-report",
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
      (h) =>
        ad.githubSend(
          {
            ...form(),
            ...(st.addTo !== null ? { addTo: st.addTo } : {}),
            ...(st.fileNew ? { fileNew: true } : {}),
          },
          h,
        ),
      "send-report",
    );
    if (!r) return render();
    st.link = r.data.newIssueUrl || st.link;
    if (r.status !== 200 || !r.data.flow) {
      if (r.status === 429 || (r.status === 409 && r.data.duplicate))
        return onAnswer(r);
      st.flow = null;
      return go("signin", r.data.error || "");
    }
    st.flow = r.data.flow;
    go("signin");
    const id = st.flow.id;
    const poll = async () => {
      if (current !== self || st.step !== "signin" || st.flow?.id !== id)
        return;
      const p = await Promise.resolve(ad.githubPoll(id)).catch(() => ({
        data: {},
      }));
      const f = p?.data?.flow;
      if (!f || f.state === "pending") return setTimeout(poll, 2000);
      if (f.state === "ok") return sent(f.result);
      go(
        "failed",
        f.message ||
          (f.state === "expired"
            ? t("kit.report.expired")
            : t("kit.report.denied")),
      );
    };
    setTimeout(poll, 2000);
  }

  /**
   * The simple adapter: fileReport(payload) → { number, url } or
   * { error }. Filed: "Filed as #N" with its link.
   */
  async function fileIt() {
    // The masked screenshot as a PNG data URL; null with "Don't include"
    // (or none taken).
    const payload = {
      ...form(),
      preview: st.preview,
      shot: shotOn() ? maskedShot().toDataURL("image/png") : null,
    };
    let r = null;
    const call = () =>
      Promise.resolve(ad.fileReport(payload)).then((x) => {
        r = x || { error: "" };
        return { status: r.error ? 400 : 200, data: r };
      });
    await write(call, "send-report", dlg.querySelector('[data-act="send"]'));
    if (!r) return render();
    if (r.error || r.number == null) return go("failed", r.error || "");
    sent({ filed: true, number: r.number, url: r.url || "" });
  }

  /** No adapter: the report as text, to paste where the team tracks issues. */
  async function copyIt() {
    const pv = st.preview || localPreview({ ...form(), diag: st.diag });
    try {
      await copyReport(`${pv.title}\n\n${pv.body}`);
      st.copied = "ok";
    } catch {
      st.copied = "failed";
    }
    render('[data-act="copy"]');
  }

  function close() {
    if (current === self) current = null;
    if (dlg.open) dlg.close();
    dlg.remove();
    focusBack(opener);
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
  // ⌘↵ (Ctrl+Enter) is the primary on Write and Include, as in every
  // pop-up. Review is left out: nothing is sent without a click.
  dlg.addEventListener("keydown", (e) => {
    if (
      e.key === "Enter" &&
      (e.metaKey || e.ctrlKey) &&
      !e.isComposing &&
      (st.step === "write" || st.step === "include")
    ) {
      e.preventDefault();
      e.stopPropagation();
      dlg.querySelector(".fb-btns .fb-pri")?.click();
      return;
    }
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
    if (f === "noshot") {
      st.noShot = el.checked;
      render('[data-f="noshot"]');
    }
    if (f === "repo") {
      st.repo = el.value;
      render('[data-f="repo"]');
      void preview();
    }
  });
  // The mask tool: drag on the screenshot to black out a rectangle.
  const frac = (e, c) => {
    const r = c.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / r.width,
      y: (e.clientY - r.top) / r.height,
    };
  };
  dlg.addEventListener("pointerdown", (e) => {
    const c = e.target.closest?.("canvas[data-shot]");
    if (!c) return;
    e.preventDefault();
    c.setPointerCapture?.(e.pointerId);
    st.drag = { a: frac(e, c), b: null };
  });
  dlg.addEventListener("pointermove", (e) => {
    const c = e.target.closest?.("canvas[data-shot]");
    if (!c || !st.drag) return;
    st.drag.b = frac(e, c);
    paintShot();
  });
  dlg.addEventListener("pointerup", (e) => {
    const c = e.target.closest?.("canvas[data-shot]");
    const d0 = st.drag;
    st.drag = null;
    if (!c || !d0) return;
    const r = shots.rectOf(d0.a, frac(e, c));
    if (r.w * r.h > 0.0001) st.masks.push(r);
    render('[data-act="undo"]');
  });
  dlg.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-act]");
    if (!b) return;
    const act = b.getAttribute("data-act");
    if (act === "next") {
      if (!st.title.trim()) {
        st.error = t("kit.report.needTitle");
        return render();
      }
      return go("include");
    }
    if (act === "undo") {
      st.masks.pop();
      return render('[data-act="undo"]');
    }
    if (act === "addmask") {
      const v = (k) => dlg.querySelector(`[data-m="${k}"]`)?.value;
      const m = shots.rectOfPercent(v("x"), v("y"), v("w"), v("h"));
      st.kbd = true;
      if (m.w > 0 && m.h > 0) st.masks.push(m);
      return render('[data-act="addmask"]');
    }
    if (act === "maskall") {
      st.kbd = true;
      st.masks.push({ x: 0, y: 0, w: 1, h: 1 });
      return render('[data-act="maskall"]');
    }
    if (act === "rmmask") {
      st.masks.splice(Number(b.getAttribute("data-i")), 1);
      return render('[data-act="addmask"]');
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
    if (act === "copy") return void copyIt();
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
    // A failed send: the same text again. The server answered the first
    // (nothing was filed), so it goes as a new request.
    if (act === "retry") return void send();
    if (act === "mine") {
      // Typed text is kept or discarded first, then My reports opens.
      if (dirty()) {
        st.then = "mine";
        return go("keep");
      }
      close();
      return void cfg.mine?.();
    }
    if (act === "back-write") {
      st.then = null;
      return go("write");
    }
    if (act === "back-include") return go("include");
    if (act === "back-review") {
      go("review");
      return void preview();
    }
    if (act === "cancel") return dirty() ? go("keep") : close();
    if (act === "discard" || act === "done") {
      const then = st.then;
      close();
      if (then === "mine") void cfg.mine?.();
      return;
    }
  });

  render();
  dlg.showModal();
  render();
  return self;
}
