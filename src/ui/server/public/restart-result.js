/**
 * Issue 1407: one agent's answer to a restart for its tools, the one
 * source for Settings › Hub (after "Restart N agents at their next idle")
 * and the Agents page (each row's Restart, and Restart all):
 *
 *   now      restarting now, in the same conversation
 *   turn     restarts when its turn ends
 *   job      waiting: a background job it started (what, how long), with
 *            Restart now (ends the job)
 *   unknown  Den can't tell when its turn ends, with Restart now
 *   done, failed: after Restart now
 *
 * Part 2: the status is live. followRestarts reads the server's
 * (GET /api/agents/restart-status) while rows remain: restarted (then
 * gone), a wait that ran out (timedOut, with Restart now), failed.
 *
 * Restart now is the agent route's when: now (a person's only), busy in
 * its own button. Two or more waiting on the person get Restart all now.
 */
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

/**
 * Whether entry `a` waits on the person: a job, a turn Den can't read, a
 * wait that ran out, or a restart that failed (issue 1407 part 2).
 */
export const waitsOnPerson = (a) =>
  a?.state === "job" ||
  a?.state === "unknown" ||
  a?.state === "timedOut" ||
  a?.state === "failed";

/** Entry `a`'s line, in the page's language. */
export function restartLine(a, t) {
  const id = String(a?.id ?? "");
  switch (a?.state) {
    case "job":
      return t("rs.job", {
        id,
        cmd: String(a.job?.command ?? ""),
        min: Number(a.job?.minutes) || 0,
      });
    case "unknown":
      return t("rs.unknown", { id });
    case "turn":
      return t("rs.turn", { id });
    case "done":
    case "restarted":
      return t("rs.done", { id });
    case "timedOut":
      return t("rs.timedOut", { id, min: Number(a.minutes) || 0 });
    case "failed":
      return t("rs.failed", { id });
    default:
      return t("rs.now", { id });
  }
}

/** Entry `a`'s row: its line, and Restart now when it waits on the person. */
export function restartRowHtml(a, t) {
  const id = String(a?.id ?? "");
  const btn = waitsOnPerson(a)
    ? `<button type="button" class="den-btn sm" data-rs-now="${esc(id)}" data-rs-ws="${esc(String(a.workspace ?? ""))}">${esc(t(a.state === "job" ? "rs.nowJob" : "rs.nowBtn"))}</button>`
    : "";
  return `<div class="hub-rs-row" data-rs-agent="${esc(id)}" data-rs-state="${esc(String(a?.state ?? ""))}"><span class="set-note" data-rs-line>${esc(restartLine(a, t))}</span>${btn}</div>`;
}

/** Restart all now, for two or more waiting on the person; else "". */
export function restartAllHtml(list, t) {
  const n = (Array.isArray(list) ? list : []).filter(waitsOnPerson).length;
  return n >= 2
    ? `<button type="button" class="den-btn sm primary" data-rs-all>${esc(t("rs.all", { n }))}</button>`
    : "";
}

/** The whole answer: a row per agent, then Restart all now. */
export function restartResultHtml(agents, t) {
  const list = Array.isArray(agents) ? agents : [];
  if (!list.length)
    return `<p class="set-note" role="status" data-rs-result="0">${esc(t("rs.none"))}</p>`;
  return (
    `<div role="status" data-rs-result="${list.length}">` +
    list.map((a) => restartRowHtml(a, t)).join("") +
    restartAllHtml(list, t) +
    `</div>`
  );
}

/**
 * Restart now for the agent of button `btn` (data-rs-now, data-rs-ws), busy
 * in its own button. Resolves true when it restarted.
 */
export async function restartNow(btn, o) {
  const id = btn.dataset.rsNow;
  const ws = btn.dataset.rsWs;
  const run = (headers) =>
    o.api(
      "POST",
      `/api/workspaces/${encodeURIComponent(ws)}/agents/${encodeURIComponent(id)}/restart`,
      { when: "now" },
      { headers },
    );
  try {
    return Boolean(
      o.busyAction
        ? await o.busyAction("restart-agent", run, {
            button: btn,
            vars: { name: id },
          })
        : await run({}),
    );
  } catch {
    return false;
  }
}

/**
 * Wire Restart now and Restart all now under `root`. Each row then says
 * restarted, or not; `onDone(id, ws, ok)` hears each.
 */
export function wireRestartNow(root, o) {
  const one = async (b) => {
    const row = b.closest("[data-rs-agent]");
    const ok = await restartNow(b, o);
    const a = { id: b.dataset.rsNow, state: ok ? "done" : "failed" };
    const line = row?.querySelector("[data-rs-line]");
    if (line) line.textContent = restartLine(a, o.t);
    if (row) row.dataset.rsState = a.state;
    if (ok) b.remove();
    o.onDone?.(b.dataset.rsNow, b.dataset.rsWs, ok);
    return ok;
  };
  root.querySelectorAll("[data-rs-now]").forEach((b) =>
    b.addEventListener("click", async () => {
      await one(b);
      if (root.querySelectorAll("[data-rs-now]").length < 2)
        root.querySelector("[data-rs-all]")?.remove();
    }),
  );
  const all = root.querySelector("[data-rs-all]");
  all?.addEventListener("click", async () => {
    all.disabled = true;
    all.setAttribute("aria-busy", "true");
    for (const b of [...root.querySelectorAll("[data-rs-now]")]) await one(b);
    all.remove();
  });
}

const same = (a, b) =>
  String(a?.id) === String(b?.id) &&
  String(a?.workspace) === String(b?.workspace);

/**
 * Issue 1407 part 2: the rows a page shows (`shown`, this page's run) as
 * the server has them now (`live`). An agent the server no longer lists has
 * cleared; the server's other agents are another run's.
 */
export function mergeLive(shown, live) {
  const now = Array.isArray(live) ? live : [];
  return (Array.isArray(shown) ? shown : [])
    .map((a) => now.find((b) => same(a, b)))
    .filter(Boolean);
}

/**
 * Issue 1407 part 2: read the live status every `everyMs` (2 s) and hand
 * each list to `onRows`, until it is empty (then `onEnd`) or `stop()`. A
 * read that fails is tried again next time.
 */
export function followRestarts(o) {
  let stopped = false;
  let timer = null;
  const every = o.everyMs ?? 2000;
  const tick = async () => {
    if (stopped) return;
    let rows = null;
    try {
      const r = await o.api("GET", "/api/agents/restart-status");
      rows = Array.isArray(r?.agents) ? r.agents : [];
    } catch {
      rows = null;
    }
    if (stopped) return;
    if (rows) {
      o.onRows(rows);
      if (!rows.length) {
        stopped = true;
        o.onEnd?.();
        return;
      }
    }
    timer = setTimeout(tick, every);
  };
  timer = setTimeout(tick, every);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * Issue 1406: "Restart all idle agents (n)" above the list, when two or
 * more agents are running; else "".
 */
export function restartIdleBarHtml(n, t) {
  return n >= 2
    ? `<div class="agnote" data-note="restart-idle"><button type="button" class="den-btn sm" data-act="restart-idle">${esc(t("ag.ri.all", { n }))}</button></div>`
    : "";
}

/** Issue 1406: a project's "Restart this project's idle agents", for two or more. */
export function restartIdleWsHtml(ws, n, t) {
  return n >= 2
    ? `<button type="button" class="den-btn sm" data-act="restart-idle-ws" data-ws="${esc(ws)}">${esc(t("ag.ri.ws", { n }))}</button>`
    : "";
}

/**
 * Issue 1406: what Restart all idle agents did: how many restart now, and
 * the agents that wait (their turn, a job, or the person).
 */
export function restartIdleSaid(plan, t) {
  const list = Array.isArray(plan) ? plan : [];
  if (!list.length) return t("ag.ri.none");
  const now = list.filter((a) => a?.state === "now").length;
  const wait = list
    .filter((a) => a?.state !== "now")
    .map((a) => String(a?.id ?? ""));
  return wait.length
    ? t("ag.ri.said", { n: now, wait: wait.join(", ") })
    : t("ag.ri.saidAll", { n: now });
}
