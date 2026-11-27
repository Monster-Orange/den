import { newTerminalChoices } from "/terminals-list.js";
import { shellUsed, viewWorkspaces } from "/agents-url.js";
import { displayName, exitedShell, isStopped } from "/agents-rows.js";
import { bringShell, closePane, openPane, openTerminal } from "/agents-panes.js";
import { visibleRows } from "/agents-list.js";
import { refresh } from "/agents-data.js";
import { quarantineNext } from "/agent-start.js";
import { UNDO_MS, agentPath, api, rowOf, st, t } from "/agents-core.js";

/**
 * D28: a relaunch Den did by itself since the last look: a toast saying
 * so, and that the old conversation is kept. The first look only notes
 * what is there.
 */
function toastAutoRelaunches(rows) {
  const seen = (st.rotSeen ??= new Map());
  const first = !st.rotLooked;
  st.rotLooked = true;
  for (const r of rows) {
    const last = r.kind === "agent" ? r.lastRotation : undefined;
    if (!last) continue;
    const key = `${r.workspace}/${r.agent}`;
    if (seen.get(key) === last.at) continue;
    seen.set(key, last.at);
    if (first || !last.auto) continue;
    window.denShell?.toast?.(
      t("ag.rc.autoRelaunched", {
        id: r.agent,
        why:
          last.reason === "pr-merged"
            ? t("ag.rot.merged")
            : t(
                last.compactions === 1
                  ? "ag.rot.compactions.one"
                  : "ag.rot.compactions",
                { n: last.compactions },
              ),
        old: last.conversation ?? "?",
      }),
    );
  }
}


// Held while the server answers. Every redraw (the list's poll, a pane's
// header) paints the agent's buttons disabled, the pressed one held with
// the kit's dots (issue 698),
// so a second click can't send it again; the server answers a repeat
// with the first result anyway. Success clears it; an error is shown and
// the buttons come back.
const busyActs = new Map();

const busyKey = (r) => `${r.workspace}/${r.agent}`;

const BUSY_ACTS = ["resume", "fresh", "relaunch", "rot-write", "stop"];

async function oneAtATime(r, verb, fn) {
  const k = busyKey(r);
  if (busyActs.has(k)) return;
  busyActs.set(k, verb);
  paintBusy();
  try {
    await fn();
  } finally {
    busyActs.delete(k);
    paintBusy();
  }
}

/** Each pressed button held with dots here, with its release. */
const dotsHeld = new WeakMap();

/** Paint every busy agent's buttons: disabled, the pressed one's dots. */
function paintBusy() {
  const root = st.root;
  if (!root) return;
  const keyOf = (el) => {
    const row = el.closest(".agst, .agr, [data-agent][data-ws]");
    if (row?.dataset.agent && row.dataset.ws)
      return `${row.dataset.ws}/${row.dataset.agent}`;
    const pane = el.closest(".pane[data-id]");
    const r = pane ? rowOf(pane.dataset.id) : null;
    return r?.agent ? busyKey(r) : null;
  };
  const sel = BUSY_ACTS.map((a) => `button[data-act="${a}"]`).join(",");
  for (const b of root.querySelectorAll(sel)) {
    const verb = busyActs.get(keyOf(b));
    if (verb) {
      if (!b.disabled) b.disabled = true;
      b.setAttribute("aria-busy", verb === b.dataset.act ? "true" : "false");
      // Issue 698: the kit's dots in place of the label (a redrawn
      // button too), never words of its own.
      if (verb === b.dataset.act && !dotsHeld.has(b))
        dotsHeld.set(b, window.denShell?.holdDots?.(b) ?? (() => {}));
    } else if (dotsHeld.has(b)) {
      const release = dotsHeld.get(b);
      dotsHeld.delete(b);
      void release();
      b.removeAttribute("aria-busy");
      b.disabled = false;
    }
  }
}

/**
 * Resume (the same conversation), Start fresh, or Relaunch from handoff
 * (den#4: a new conversation that starts from handoff.md); its pane opens
 * on it.
 */
function restartRow(r, verb, button, body) {
  return oneAtATime(r, verb, () => restartRowNow(r, verb, button, body));
}

async function restartRowNow(r, verb, button, body) {
  if (button) button.disabled = true;
  const name = { name: r.agent };
  // BUSY-1: the working pop-up while Den starts it, then what happened.
  let opened;
  const out = await window.denShell.busyAction(
    "start-agent",
    (headers) => api("POST", agentPath(r, verb), body, { headers }),
    {
      button,
      vars: name,
      success: (o) =>
        t(
          verb === "relaunch"
            ? "ag.relaunched"
            : verb !== "resume"
              ? "ag.startedFresh"
              : o?.handoff
                ? // Issue 658: never written; its last handoff began it.
                  "ag.resumedHandoff"
                : o?.fresh
                  ? "ag.resumedFresh"
                  : "ag.resumed",
          { id: r.agent },
        ),
      // Its open pane follows it to the new session (followAgents, in
      // refresh); one that couldn't (not running yet) is closed for it.
      onDone: (o) => (opened = follow(o)),
      // Issue 479: a quarantined runtime: Settings at its row, not a
      // dead end (Try again would refuse the same way).
      next: (err) => quarantineNext(err, t, r.workspace),
    },
  );
  await (out ? opened : refresh());
  async function follow(o) {
    await refresh();
    const next = o?.agent?.sessionId;
    if (next && next !== r.id && st.panes.has(r.id))
      closePane(r.id, { quiet: true });
    if (next) await openPane(next);
  }
}

/**
 * D28 Relaunch now: from the handoff when it passes; else Den asks for it
 * first (a stopped agent resumes to write it) and relaunches it once it
 * passes, by itself.
 */
function relaunchNow(r, button) {
  if (r.rotation?.ready) return restartRow(r, "relaunch", button);
  return oneAtATime(r, "relaunch", () => askRelaunch(r, button));
}

async function askRelaunch(r, button) {
  const release = window.denShell?.holdDots
    ? window.denShell.holdDots(button)
    : () => {};
  try {
    const out = await api("POST", agentPath(r, "handoff"), { relaunch: true });
    window.denShell?.toast?.(
      t(out?.resumed ? "ag.rc.askedResumed" : "ag.rc.askedRelaunch", {
        id: r.agent,
      }),
    );
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
  try {
    await refresh();
  } finally {
    void release();
  }
}

/** D28 Write handoff: the prompt, typed into its session at idle. */
function writeHandoff(r, button) {
  return oneAtATime(r, "rot-write", () => writeHandoffNow(r, button));
}

async function writeHandoffNow(r, button) {
  const release = window.denShell?.holdDots
    ? window.denShell.holdDots(button)
    : () => {};
  try {
    await api("POST", agentPath(r, "handoff"), {});
    window.denShell?.toast?.(t("ag.rc.asked", { id: r.agent }));
  } catch (err) {
    // Mid-turn is expected, not an error: say when to try again.
    if (/mid-turn/.test(String(err?.message ?? "")))
      window.denShell?.toast?.(t("ag.rc.midTurn", { id: r.agent }));
    else window.denShell?.errorToast?.(err);
  }
  try {
    await refresh();
  } finally {
    void release();
  }
}

/**
 * D59: "Resume after a restart", a check in an agent's ⋯ (its persona's,
 * tagged "default", until a person sets it).
 */
function restartResumeItem(r) {
  const on = !!r.resumesOnRestart;
  return {
    label: t("ag.rr.item"),
    checked: on,
    ...(r.resumeOnRestart === undefined ? { tag: t("ag.rr.default") } : {}),
    onSelect: () => void setRestartResume(r, !on),
  };
}

async function setRestartResume(r, on) {
  try {
    // busy-ok: a check in the closed menu saves on select; the toast answers
    await api("POST", agentPath(r, "settings"), { resumeOnRestart: on });
    window.denShell?.toast?.(
      t(on ? "ag.rr.on" : "ag.rr.off", { id: displayName(r) }),
    );
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
  await refresh();
}

/** D28 Keep this conversation (and "don't ask again": never, for it). */
async function keepConversation(r, button) {
  const never = !!button
    ?.closest(".agacts, .agrot")
    ?.querySelector("[data-rot-never]")?.checked;
  const release = window.denShell?.holdDots
    ? window.denShell.holdDots(button)
    : () => {};
  try {
    await api("POST", agentPath(r, "keep"), never ? { never: true } : {});
    window.denShell?.toast?.(
      t(never ? "ag.rc.keptNever" : "ag.rc.kept", { id: r.agent }),
    );
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
  try {
    await refresh();
  } finally {
    void release();
  }
}

/** Undo: the removed agents come back (POST /api/agents/restore). */
async function undoRemove(ids) {
  try {
    // busy-ok: fired from a toast's Undo, which is gone once it is pressed
    const out = await api("POST", "/api/agents/restore", { agents: ids });
    const back = out?.restored ?? [];
    if (back.length)
      window.denShell?.toast?.(t("ag.restored", { ids: back.join(", ") }));
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
  await refresh();
}

/** The removal's toast, with Undo for UNDO_MS. */
function removedToast(msg, ids) {
  const shell = window.denShell;
  if (shell?.toastAction)
    shell.toastAction(msg, t("ag.undo"), () => void undoRemove(ids), UNDO_MS);
  else shell?.toast?.(msg);
}

/** Remove: one click, no confirm (AG-14.1b). */
async function removeRow(r, button) {
  const release = window.denShell?.holdDots
    ? window.denShell.holdDots(button)
    : () => {};
  try {
    const out = await api("POST", agentPath(r, "remove"));
    if (st.panes.has(r.id)) closePane(r.id, { quiet: true });
    const ids = (out?.removed ?? []).map((x) => x.agent);
    await refresh();
    removedToast(
      t("ag.removed", { id: r.agent }),
      ids.length ? ids : [r.agent],
    );
  } catch (err) {
    window.denShell?.errorToast?.(err);
    await refresh();
  } finally {
    void release();
  }
}

/**
 * 0.4.45: Remove on an exited shell: the host forgets it (the close route,
 * which never ends a running one: this is only offered once it exited).
 */
async function removeShell(r, button) {
  if (!exitedShell(r)) return;
  const release = window.denShell?.holdDots
    ? window.denShell.holdDots(button)
    : () => {};
  try {
    await api("POST", `/api/sessions/${encodeURIComponent(r.id)}/close`);
    if (st.panes.has(r.id)) closePane(r.id, { quiet: true });
    window.denShell?.toast?.(t("ag.removed", { id: r.label || r.name }));
  } catch (err) {
    window.denShell?.errorToast?.(err);
  } finally {
    void release();
  }
  await refresh();
}

/**
 * Issue 482: Restart on an exited terminal: a new one in the same folder
 * (its project's when the host didn't say), in front; the exited one is
 * removed, so the list keeps one row for it.
 */
async function restartShell(r, button) {
  if (!exitedShell(r)) return;
  const url = `/api/workspaces/${encodeURIComponent(r.workspace)}/sessions`;
  // One request (the pop-up's id runs once): the server starts the new
  // one, then forgets the exited one it replaces.
  const body = { ...(r.cwd ? { cwd: r.cwd } : {}), replaces: r.id };
  const out = await window.denShell.busyAction(
    "open-terminal",
    (headers) => api("POST", url, body, { headers }),
    { button },
  );
  const id = out?.session?.id;
  if (!id) return;
  if (st.panes.has(r.id)) closePane(r.id, { quiet: true });
  await refresh();
  await bringShell(id);
}

/**
 * Issue 482: the Terminals page's New terminal: one click in a project;
 * under All projects a small picker of projects, the one used last first
 * (its first item, where the keyboard starts).
 */
async function newTerminal(button) {
  const view = viewWorkspaces();
  if (view.length === 1)
    return void openTerminal(view[0], { fresh: true, button });
  const choices = newTerminalChoices(
    st.data?.workspaces ?? [],
    st.data?.sessions ?? [],
    shellUsed(),
  );
  if (!choices.length) return void openTerminal("", { fresh: true, button });
  window.denShell?.openMenu?.(button, {
    label: t("tm.pick"),
    items: choices.map((ws) => ({
      label: ws,
      onSelect: () => void openTerminal(ws, { fresh: true }),
    })),
  });
}

/** Clear stopped: every stopped agent and exited shell in view (AG-14.1b). */
async function clearStopped(button) {
  const workspaces = [
    ...new Set(
      visibleRows()
        .filter(isStopped)
        .map((r) => r.workspace),
    ),
  ];
  const shells = visibleRows().filter(exitedShell);
  if (!workspaces.length && !shells.length) return;
  const release = window.denShell?.holdDots
    ? window.denShell.holdDots(button)
    : () => {};
  try {
    const out = workspaces.length
      ? await api("POST", "/api/agents/clear-stopped", { workspaces })
      : null;
    const ids = (out?.removed ?? []).map((x) => x.agent);
    for (const r of visibleRows())
      if (ids.includes(r.agent) && st.panes.has(r.id))
        closePane(r.id, { quiet: true });
    // 0.4.45: the exited shells too (nothing to undo: a shell can't come
    // back).
    let gone = 0;
    for (const r of shells)
      try {
        await api("POST", `/api/sessions/${encodeURIComponent(r.id)}/close`);
        if (st.panes.has(r.id)) closePane(r.id, { quiet: true });
        gone++;
      } catch {
        /* still listed: its row says so */
      }
    await refresh();
    const n = ids.length + gone;
    if (gone && n)
      removedToast(
        t(n === 1 ? "ag.clearedMany.one" : "ag.clearedMany", { n }),
        ids,
      );
    else if (ids.length)
      removedToast(
        t(ids.length === 1 ? "ag.removedMany.one" : "ag.removedMany", {
          n: ids.length,
        }),
        ids,
      );
  } catch (err) {
    window.denShell?.errorToast?.(err);
    await refresh();
  } finally {
    void release();
  }
}

/** Resume all: every interrupted agent in view that can resume (AG-14.3). */
async function resumeAll(button) {
  const workspaces = [
    ...new Set(
      visibleRows()
        .filter((r) => r.state === "interrupted")
        .map((r) => r.workspace),
    ),
  ];
  if (!workspaces.length) return;
  const release = window.denShell?.holdDots
    ? window.denShell.holdDots(button)
    : () => {};
  try {
    const out = await window.denShell.api(
      "POST",
      "/api/agents/resume-interrupted",
      { workspaces },
    );
    const n = out?.resumed?.length ?? 0;
    window.denShell?.toast?.(
      t(n === 1 ? "ag.resumedAll.one" : "ag.resumedAll", { n }),
    );
  } catch (err) {
    window.denShell?.errorToast?.(err);
  }
  try {
    await refresh();
  } finally {
    void release();
  }
}

/**
 * Switch to ?ws='s workspace: make it active (as Local Dev's Activate
 * does), then view it (POST /api/scope, the top bar's Workspace switch),
 * then reload, as that switch does.
 */
async function switchWorkspace(button) {
  const ws = st.data?.requested?.workspace;
  if (!ws) return;
  // The dots stay until the page reloads; an error gives the label back.
  const release = window.denShell?.holdDots
    ? window.denShell.holdDots(button)
    : () => {};
  try {
    await api("POST", "/api/workspaces", { name: ws, action: "activate" });
    await api("POST", "/api/scope", { scope: ws });
  } catch (err) {
    window.denShell?.errorToast?.(err);
    void release();
    return;
  }
  location.reload();
}

/** Review: the first interrupted agent, scrolled to and focused. */
function review() {
  const first = st.root.querySelector('#agl .agst[data-state="interrupted"]');
  if (!first) return;
  for (const el of st.root.querySelectorAll("#agl .agst[data-review]"))
    el.removeAttribute("data-review");
  for (const el of st.root.querySelectorAll(
    '#agl .agst[data-state="interrupted"]',
  ))
    el.setAttribute("data-review", "");
  first.scrollIntoView({ block: "nearest" });
  (
    first.querySelector('[data-act="resume"]') ?? first.querySelector(".agr")
  )?.focus();
}

export { BUSY_ACTS, askRelaunch, busyActs, busyKey, clearStopped, dotsHeld, keepConversation, newTerminal, oneAtATime, paintBusy, relaunchNow, removeRow, removeShell, removedToast, restartResumeItem, restartRow, restartRowNow, restartShell, resumeAll, review, setRestartResume, switchWorkspace, toastAutoRelaunches, undoRemove, writeHandoff, writeHandoffNow };
