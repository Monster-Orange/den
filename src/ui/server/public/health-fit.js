/**
 * The health poll's model, shared by the rail and the top bar's status chip
 * and drawer (0.3.0-dev.20 retired the header's dot row and its "+N" chip).
 *
 * Each repo's state comes from health-rollup.js, the rule the graph and
 * `<cli> status` use too: "down", "degraded", "unknown" (nothing checked)
 * or "ok".
 *
 *   buildRow(rows, groups)  the model: application units, and every repo
 *                           flat, each in problem-first order
 *   paintGate(…)            when health data repaints: once per first
 *                           cycle, then debounced
 *   healthCycle(…)          one poll: the stream, completed by /api/health
 *                           when it breaks, painted through the gate
 *   shellHealth(row)        the rail's Services badge and pinned dots
 *
 * The pure parts take plain data, so tests need no browser.
 */
import { compareRepos, rollupRepo } from "./health-rollup.js";

/**
 * The row's model from /api/health rows and the application grouping
 * (`[{ app, repos }]`, app null for repos with no box of their own).
 * Repos sort down, degraded, ok, then unknown; within a state the
 * focused workspace's first, then by name. A box sorts by its worst repo.
 */
export function buildRow(rows, groups) {
  const byRepo = new Map();
  for (const r of rows || []) {
    if (!byRepo.has(r.repo)) byRepo.set(r.repo, []);
    byRepo.get(r.repo).push(r);
  }
  const repoOf = new Map(
    [...byRepo].map(([repo, signals]) => {
      const rollup = rollupRepo(repo, signals);
      return [
        repo,
        {
          repo,
          state: rollup.state,
          rollup,
          focused: signals.some((s) => s.focused),
          items: signals,
        },
      ];
    }),
  );
  const flat = [...repoOf.values()].sort(compareRepos);
  const units = [];
  for (const { app, repos } of groups || [
    { app: null, repos: [...repoOf.keys()] },
  ]) {
    const members = repos
      .map((r) => repoOf.get(r))
      .filter(Boolean)
      .sort(compareRepos);
    if (!members.length) continue;
    if (!app)
      for (const m of members) units.push({ app: null, repos: [m], ...key(m) });
    else
      units.push({
        app,
        repos: members,
        ...key({
          state: members[0].state,
          focused: members.some((m) => m.focused),
          repo: app.name,
        }),
      });
  }
  units.sort(compareRepos);
  return { units, flat };
}

const key = (x) => ({ state: x.state, focused: x.focused, repo: x.repo });

/**
 * When health data repaints (0.3.0-dev.13; the status chip since dev.20).
 * A fresh load streamed results in batches and the old row reshuffled with
 * each one, three or four times in as many seconds. Now:
 * - `hold()` starts a first cycle (a page load, an environment switch):
 *   data paints nothing (the chip stays "Checking…") until `done()`
 *   ends the cycle, or `cap` ms pass with a slow probe still out;
 * - after that, data paints at most once per `delay` ms of quiet (a
 *   trailing debounce), and so does the end of a later cycle.
 * Each call hands in the latest paint; only the last one runs.
 * `timers` is `{ setTimeout, clearTimeout }`, globalThis by default, so
 * tests can use a fake clock.
 */
export function paintGate({
  delay = 300,
  cap = 8000,
  timers = globalThis,
} = {}) {
  let ready = true;
  let pending = null;
  let timer = null;
  let capTimer = null;
  const stop = (t) => t !== null && timers.clearTimeout(t);
  const fire = () => {
    stop(timer);
    timer = null;
    const paint = pending;
    pending = null;
    paint?.();
  };
  const settle = () => {
    stop(capTimer);
    capTimer = null;
    ready = true;
    fire();
  };
  return {
    get ready() {
      return ready;
    },
    hold() {
      ready = false;
      stop(timer);
      timer = null;
      stop(capTimer);
      capTimer = timers.setTimeout(settle, cap);
    },
    data(paint) {
      pending = paint;
      if (!ready) return;
      stop(timer);
      timer = timers.setTimeout(fire, delay);
    },
    done(paint) {
      if (paint) pending = paint;
      if (!ready) return settle();
      if (!pending) return;
      stop(timer);
      timer = timers.setTimeout(fire, delay);
    },
  };
}

/**
 * One health poll, painted through `gate` (0.3.0-dev.14).
 *
 * - `seed`: the last poll's rows (`[key, row]` pairs); empty on a first
 *   cycle, which `hold()`s the gate so nothing paints until it completes.
 * - `stream(onResult)`: /api/health/stream. Resolves "done" when the server
 *   said so (every check answered), "partial" when it broke after some
 *   results, "none" when it gave nothing.
 * - `fetchAll()`: /api/health, every row or null. Only a "done" stream is a
 *   complete cycle: a broken one is completed from here, never painted as
 *   if it were whole (dev.13 painted a stream that broke after 0.6s).
 * - `paint(map)`: draw these rows. `current()`: false once a newer poll
 *   owns the row.
 * A cycle that never completes paints only by the gate's cap, with the rows
 * that did land; a check with no result has no row, so it is never shown
 * as down. Resolves with the cycle's rows, or null when incomplete.
 */
export async function healthCycle({
  seed = [],
  last = null,
  gate,
  stream,
  fetchAll,
  paint,
  current = () => true,
}) {
  const keyOf = (r) => `${r.repo}/${r.service}`;
  const acc = new Map(seed);
  if (acc.size === 0) gate.hold();
  const paintOf = (m) => () => {
    if (current()) paint(m);
  };
  // A paint before the cycle completes (0.3.0-dev.17). The rows that last
  // painted (`last()`, read at paint time: a poll that overlapped the first
  // started with nothing seeded) stand for checks not answered yet; a repo
  // they don't describe gets an `awaiting` row, so health-rollup.js holds it
  // at unknown: one answered down service must not paint its app down
  // while the app's other checks are still out.
  const partialOf = (m) => () => {
    if (!current()) return;
    const known = (last ? last() : null) ?? new Map();
    const out = new Map(known);
    for (const [k, r] of m) out.set(k, r);
    const described = new Set([...known.values()].map((r) => r.repo));
    for (const r of [...out.values()])
      if (!described.has(r.repo)) {
        described.add(r.repo);
        out.set(`${r.repo}/…`, {
          repo: r.repo,
          service: "…",
          ok: null,
          awaiting: true,
          idx: r.idx,
          focused: r.focused,
        });
      }
    paint(out);
  };
  const fresh = new Map();
  const end = await stream((r) => {
    acc.set(keyOf(r), r);
    fresh.set(keyOf(r), r);
    gate.data(partialOf(acc));
  });
  let complete = end === "done";
  if (!complete) {
    const rows = await fetchAll();
    if (Array.isArray(rows)) {
      fresh.clear();
      for (const r of rows) fresh.set(keyOf(r), r);
      complete = true;
    }
  }
  if (!current() || !complete) return null;
  // Settle on exactly what this poll returned, so a service removed from
  // the workspace disappears. A first cycle that answered with nothing
  // paints too ("no services").
  if (fresh.size > 0 || !gate.ready) gate.done(paintOf(fresh));
  else gate.done();
  return fresh;
}

/**
 * The rail's share of the health row (R13, R14): `down` for the Services
 * badge and `health` for the pinned rows' dots (`repo` and `repo/service`
 * → down | degraded | ok | unknown). Both read the rollup: a down service
 * counts only once every check of its repo has answered, so a cold load
 * never badges a service the row still shows as unknown. `row` is
 * buildRow's.
 */
export function shellHealth(row) {
  let down = 0;
  const health = {};
  for (const r of row.flat) {
    health[r.repo] = r.state;
    down += r.rollup.down.length;
    for (const i of r.items) {
      if (i.awaiting) continue;
      health[`${r.repo}/${i.service}`] = r.rollup.awaiting
        ? "unknown"
        : i.ok === true
          ? "ok"
          : i.ok === false
            ? "down"
            : "unknown";
    }
  }
  return { down, health };
}
