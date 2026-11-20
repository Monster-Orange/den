/**
 * The Start agent form's choices (AG-10.0), shared by the Agents tab's
 * dialog and the Workspaces page's agents section. DOM-free.
 *
 * A persona option shows its id only: its role sentence is the help line
 * under the select (personaHelp), so a long role can't widen the select
 * past the dialog. The runtime's first option names what it resolves to,
 * "Claude Code (persona default)", from the persona picked; a runtime that
 * can't run here says why, and one that can shows its version.
 *
 * AG-0.2, readiness before Start: the line under the runtime names the CLI
 * it will run (its version and path); when that runtime can't run here,
 * Start is disabled and the line says why and how to fix it (install it,
 * or set agents.runtimes.<id>.bin in the user.yml it names, or run
 * `<cli> agents doctor`). Nothing fails only after Start.
 *
 * AG-0.5: the runtimes come installed first (the server's order). One
 * that runs as its own CLI, without Den's tools yet, says "Den tools:
 * coming"; one not installed is disabled; generic is startable only for a
 * persona with an argv template. Nothing is offered that can't start.
 */

function escHtml(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

/** The persona select's options: the id only. */
export function personaOptions(personas) {
  return (personas ?? [])
    .map((p) => `<option value="${escHtml(p.id)}">${escHtml(p.id)}</option>`)
    .join("");
}

/** The help line under the persona select: the picked persona's description. */
export function personaHelp(personas, id) {
  const p = (personas ?? []).find((x) => x.id === id);
  return p?.description ?? p?.role ?? "";
}

/** A runtime's name for people ("Claude Code"); its id when it has none. */
export function runtimeName(runtimes, id) {
  const r = (runtimes ?? []).find((x) => x.id === id);
  return r?.label || r?.id || id || "";
}

/**
 * The runtime a persona runs on when the agent names none: the persona's
 * own, else the default runtime.
 */
export function defaultRuntimeOf(personas, runtimes, personaId) {
  const p = (personas ?? []).find((x) => x.id === personaId);
  if (p?.runtime) return p.runtime;
  return (runtimes ?? []).find((r) => r.default)?.id ?? "";
}

/** A catalog runtime the search didn't find (not a path someone set). */
const notFound = (r) =>
  !r.available &&
  r.denTools !== undefined &&
  r.source !== "setting" &&
  r.source !== "workspace";

/** Why runtime `r` can't start for persona `personaId`, or "" when it can. */
export function cantStart(personas, r, personaId, t) {
  if (!r.available) return r.why || t("ag.unavailable");
  // generic runs the persona's own argv: none, nothing to run.
  if (r.id === "generic") {
    const p = (personas ?? []).find((x) => x.id === personaId);
    if (!p?.argv?.length) return t("ag.rt.needsArgv");
  }
  return "";
}

/**
 * The runtime select's options. The first ("" = the persona's) reads
 * "<name> (persona default)"; one that can't run here is disabled and
 * says why; one without Den's tools yet says so.
 */
export function runtimeOptions(personas, runtimes, personaId, t) {
  const name = runtimeName(
    runtimes,
    defaultRuntimeOf(personas, runtimes, personaId),
  );
  const first = name ? t("ag.runtime.default", { name }) : t("ag.runtime.auto");
  return (
    `<option value="">${escHtml(first)}</option>` +
    (runtimes ?? [])
      .map((r) => {
        const label = runtimeName(runtimes, r.id);
        const no = cantStart(personas, r, personaId, t);
        const parts = [
          label,
          r.version,
          // Issue 479: never run, so Start says why (readiness).
          r.quarantined ? t("set.ui.rt.quarantined") : "",
          r.denTools === false ? t("ag.rt.denTools") : "",
        ];
        return no
          ? `<option value="${escHtml(r.id)}" disabled>${escHtml(
              `${label} — ${notFound(r) ? t("ag.rt.notInstalled") : no}`,
            )}</option>`
          : `<option value="${escHtml(r.id)}">${escHtml(
              parts.filter(Boolean).join(" · "),
            )}</option>`;
      })
      .join("")
  );
}

/** The most searched directories named inline; the rest are counted. */
const SHOWN_DIRS = 4;

/**
 * Whether Start can run, and the line that says so (AG-0.2): for the
 * runtime picked (`runtimeId`, "" = the persona's), { ok, tone, html }.
 * `tone` is "" (ready), "warn" (can't start) or "none" (nothing to say).
 */
export function readiness(data, personaId, runtimeId, t) {
  const personas = data?.personas ?? [];
  const runtimes = data?.runtimes ?? [];
  const id = runtimeId || defaultRuntimeOf(personas, runtimes, personaId);
  const r = runtimes.find((x) => x.id === id);
  if (!r)
    return {
      ok: false,
      tone: "warn",
      html: escHtml(t("ag.rt.unknown", { id: id || "?" })),
    };
  const name = runtimeName(runtimes, r.id);
  const mono = (x) => `<span class="mono">${escHtml(x)}</span>`;
  // Issue 479: a quarantined copy is never run: Start is off, and the
  // line offers the choices.
  if (r.available && r.quarantined && r.path)
    return {
      ok: false,
      tone: "warn",
      html: quarantinedHtml(
        {
          runtime: r.id,
          name,
          path: r.path,
          dir: dirOf(r.path),
          scope: r.source === "workspace" ? "workspace" : "global",
          setting: r.setting || `agents.runtimes.${r.id}.bin`,
          others: r.others ?? [],
        },
        t,
      ),
    };
  if (r.available) {
    const no = cantStart(personas, r, personaId, t);
    if (no)
      return {
        ok: false,
        tone: "warn",
        html: escHtml(t("ag.rt.refused", { name, why: no })),
      };
    if (!r.path) return { ok: true, tone: "none", html: "" };
    return {
      ok: true,
      tone: "",
      html:
        escHtml(
          r.version
            ? t("ag.rt.ready", { name, version: r.version })
            : t("ag.rt.readyNoVer", { name }),
        ) +
        " " +
        mono(r.path) +
        (r.denTools === false
          ? ` <span class="tagx" data-den-tools="coming">${escHtml(t("ag.rt.denTools"))}</span> ${escHtml(t("ag.rt.ownCli"))}`
          : ""),
    };
  }
  const file = data?.userConfig || "config/local/user.yml";
  const fix = t("ag.rt.fix", {
    key: "\u0000k",
    file: "\u0000f",
    cmd: "\u0000c",
  });
  const fixHtml = escHtml(fix)
    .replace("\u0000k", mono(r.setting || `agents.runtimes.${r.id}.bin`))
    .replace("\u0000f", mono(file))
    .replace("\u0000c", mono("__DEN_CLI__ agents doctor"));
  let what;
  if (r.source === "setting" || !r.searched)
    what = escHtml(t("ag.rt.refused", { name, why: r.why || "" }));
  else {
    const dirs = r.searched;
    const shown = dirs.slice(0, SHOWN_DIRS).map(mono).join(", ");
    const more =
      dirs.length > SHOWN_DIRS
        ? " " + escHtml(t("ag.rt.more", { n: dirs.length - SHOWN_DIRS }))
        : "";
    what =
      escHtml(t("ag.rt.notFound", { name })) +
      " " +
      escHtml(t("ag.rt.searched")) +
      " " +
      (shown || escHtml(t("ag.rt.nowhere"))) +
      more +
      ".";
  }
  return { ok: false, tone: "warn", html: `${what} ${fixHtml}` };
}

/** A path's folder ("/" for a file at the root). */
const dirOf = (p) => {
  const i = String(p).lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
};

/**
 * Issue 479: why a quarantined runtime copy wasn't started, its path, and
 * the choices: "Use this" for each other copy found that isn't
 * quarantined (pins agents.runtimes.<id>.bin at `scope`, as Settings ›
 * Runtimes does), clear it yourself, and check again. The path is
 * selectable text with Copy path: the page may be a browser on another
 * machine, so nothing here opens a folder on the Den machine (a page
 * can't tell reliably that it runs on that machine). `q` is the server's
 * runtime_quarantined detail (or a runtime row's). Den never clears the
 * quarantine. wireQuarantine handles the buttons.
 */
export function quarantinedHtml(q, t) {
  const mono = (x) => `<span class="mono">${escHtml(x)}</span>`;
  const others = (q.others ?? []).filter((o) => !o.quarantined);
  const btn = (attrs, label, aria) =>
    `<button type="button" class="den-btn sm" ${attrs}${aria ? ` aria-label="${escHtml(aria)}"` : ""}>${escHtml(label)}</button>`;
  return (
    `<span data-quarantined="${escHtml(q.runtime)}">` +
    escHtml(t("ag.rt.quarantined", { name: q.name })) +
    " " +
    `<span class="mono ag-q-path" style="user-select:all;-webkit-user-select:all">${escHtml(q.path)}</span> ` +
    btn(`data-q-copy="${escHtml(q.path)}"`, t("ag.rt.copyPath")) +
    (q.dir
      ? " " + btn(`data-q-term="${escHtml(q.dir)}"`, t("ag.rt.openTerminal"))
      : "") +
    (others.length
      ? ` <span class="ag-q-others" role="list">` +
        escHtml(t("ag.rt.useOther")) +
        others
          .map(
            (o) =>
              ` <span role="listitem">${mono(o.path)} (${escHtml(o.version || t("set.ui.rt.versionUnknown"))}) ` +
              btn(
                `data-q-pin="${escHtml(q.runtime)}" data-q-scope="${escHtml(q.scope)}" data-bin="${escHtml(o.path)}"`,
                t("set.ui.rt.useThis"),
                t("set.ui.rt.useThisFor", { path: o.path, name: q.name }),
              ) +
              `</span>`,
          )
          .join("") +
        `</span>`
      : "") +
    " " +
    escHtml(t("ag.rt.clearSelf")) +
    " " +
    btn("data-q-again", t("ag.rt.checkAgain")) +
    `<span class="ag-q-err" role="alert" hidden></span>` +
    `</span>`
  );
}

/**
 * Issue 479: the buttons quarantinedHtml draws, under `host` (bound once):
 * Use this pins that copy (POST /api/agents/runtimes/<id>/path, a
 * person's own change, on the working pop-up) then `reload()`; Copy path puts the path on the
 * clipboard, or, where the page has none (plain http from another
 * machine), selects it to copy by hand; Check again is `reload()`. A refusal
 * shows in the line, never as a toast. `ws` (a value or a function): the
 * project shown, for a pin at project scope.
 */
export function wireQuarantine(
  host,
  { api, reload, ws, t, open = (u) => globalThis.window?.location?.assign(u) },
) {
  if (!host || host.dataset.qWired) return;
  host.dataset.qWired = "1";
  host.addEventListener("click", async (e) => {
    const b = e.target?.closest?.(
      "button[data-q-pin],button[data-q-copy],button[data-q-term],button[data-q-again]",
    );
    if (!b || !host.contains(b)) return;
    e.preventDefault();
    const err = b.closest("[data-quarantined]")?.querySelector(".ag-q-err");
    if (err) err.hidden = true;
    b.disabled = true;
    try {
      if (b.dataset.qPin) {
        const w = typeof ws === "function" ? ws() : ws;
        const scope =
          b.dataset.qScope === "workspace" && w ? "workspace" : "global";
        // BUSY-1: a write goes through the working pop-up, which says
        // why when it is refused.
        const url = `/api/agents/runtimes/${encodeURIComponent(b.dataset.qPin)}/path`;
        const body = {
          scope,
          ...(scope === "workspace" ? { workspace: w } : {}),
          bin: b.dataset.bin,
        };
        const done = await globalThis.window?.denShell?.busyAction?.(
          "save",
          (headers) => api("POST", url, body, { headers }),
          { button: b },
        );
        if (done) await reload();
      } else if (b.dataset.qTerm) {
        // Open a terminal there: Den's own terminal (a plain shell in the
        // project shown, started in the copy's folder), in this browser.
        const w = typeof ws === "function" ? ws() : ws;
        if (!w) throw new Error(t("ag.term.noWs"));
        const url = `/api/workspaces/${encodeURIComponent(w)}/sessions`;
        const run = (headers) =>
          api("POST", url, { cwd: b.dataset.qTerm }, { headers });
        const busy = globalThis.window?.denShell?.busyAction;
        const r = busy
          ? await busy("open-terminal", run, { button: b })
          : await run({});
        const id = r?.session?.id;
        if (id)
          open(
            `/agents?ws=${encodeURIComponent(w)}&open=${encodeURIComponent(id)}`,
          );
      } else if (b.dataset.qCopy) {
        b.textContent = (await copyPath(b))
          ? t("ag.rt.copied")
          : t("ag.rt.copyByHand");
      } else await reload();
    } catch (x) {
      if (err) {
        err.textContent = x?.message || t("ag.rt.notDone");
        err.hidden = false;
      }
    } finally {
      b.disabled = false;
    }
  });
}

/** Copy path: the clipboard when the page has one, else the path selected. */
async function copyPath(b) {
  try {
    await globalThis.navigator.clipboard.writeText(b.dataset.qCopy);
    return true;
  } catch {
    const el = b.parentElement?.querySelector(".ag-q-path");
    const sel = globalThis.getSelection?.();
    if (el && sel && globalThis.document?.createRange) {
      const r = globalThis.document.createRange();
      r.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    return false;
  }
}

/**
 * Issue 479: Settings › Agents › Runtimes at runtime `q.runtime`'s row,
 * where Use this lives; at project `ws` when a project's setting chose
 * the copy.
 */
export function runtimeSettingsUrl(q, ws) {
  const p = new URLSearchParams({ runtime: q.runtime });
  if (q.scope === "workspace" && ws) p.set("project", ws);
  return `/settings?${p.toString()}#agents.runtimes`;
}

/**
 * Issue 479: the one way on from a refused start or resume of a
 * quarantined runtime ({ label, href }: Settings at its row), or null
 * for any other refusal. The working pop-up offers it (opts.next).
 */
export function quarantineNext(err, t, ws) {
  const q = err?.data?.quarantined;
  if (!q?.runtime) return null;
  return { label: t("ag.rt.openRuntimes"), href: runtimeSettingsUrl(q, ws) };
}

/**
 * Fill a form's persona and runtime selects, its help line and its
 * readiness line ([data-runtime-ready]), keep them in step when the
 * persona or the runtime changes, and disable its submit button while
 * the runtime can't run. Returns nothing; idempotent per form (the
 * change listeners are bound once).
 */
export function fillStartForm(form, data, t) {
  const personas = data?.personas ?? [];
  const runtimes = data?.runtimes ?? [];
  const ps = form.querySelector('select[name="persona"]');
  const rs = form.querySelector('select[name="runtime"]');
  const help = form.querySelector("[data-persona-help]");
  const ready = form.querySelector("[data-runtime-ready]");
  const go = form.querySelector('button[type="submit"]');
  ps.innerHTML = personaOptions(personas);
  const check = () => {
    const r = readiness(data, ps.value, rs.value, t);
    if (ready) {
      ready.innerHTML = r.html;
      ready.hidden = !r.html;
      ready.dataset.tone = r.tone;
    }
    if (go) {
      go.disabled = !r.ok;
      go.dataset.blocked = r.ok ? "" : "runtime";
    }
  };
  const sync = () => {
    const keep = rs.value;
    rs.innerHTML = runtimeOptions(personas, runtimes, ps.value, t);
    if ([...rs.options].some((o) => o.value === keep && !o.disabled))
      rs.value = keep;
    if (help) {
      const role = personaHelp(personas, ps.value);
      help.textContent = role;
      help.hidden = !role;
    }
    check();
  };
  ps.onchange = sync;
  rs.onchange = check;
  sync();
}

/** Whether a form's Start is held back by its runtime (readiness). */
export function blockedByRuntime(form) {
  return (
    form.querySelector('button[type="submit"]')?.dataset.blocked === "runtime"
  );
}
