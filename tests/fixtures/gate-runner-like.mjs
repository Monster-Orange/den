/**
 * Calls a live check exactly the way the bed's runner does (CONTRIBUTING.md,
 * "Live checks"): setup(ctx) → state; run(ctx, state) once per matrix cell
 * (or once); expect(result) with ONE argument; the rows checked with
 * scripts/gate-shape.mjs. A gate that needs anything else fails here as it
 * would on the bed.
 */
import { checkGateModule, checkRows } from "../../scripts/gate-shape.mjs";

/** The runner's withLimit (a race; the run itself goes on), its timer cleared after. */
function withLimit(p, ms, what) {
  if (!ms) return p;
  let timer;
  const late = new Promise((_, rej) => {
    timer = setTimeout(
      () => rej(new Error(`${what} timed out after ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** `limitMs`: a cell's time limit, as the runner's timeoutMs (none when unset). */
export async function runLikeBed(file, mod, ctx, { limitMs = 0 } = {}) {
  const shape = checkGateModule(file, mod);
  if (shape.length) return { error: "shape: " + shape.join("; ") };
  let state;
  try {
    state = await mod.setup(ctx);
    let result;
    if (mod.matrix) {
      result = [];
      for (const b of mod.matrix.browsers || ["chromium"])
        for (const w of mod.matrix.widths || [1280]) {
          Object.assign(ctx, { page: ctx.newPage(b, w), browser: b, width: w });
          result.push({
            cell: { browser: b, width: w },
            result: await withLimit(
              Promise.resolve(mod.run(ctx, state)),
              limitMs,
              `run ${b} ${w}`,
            ),
          });
        }
    } else
      result = await withLimit(
        Promise.resolve(mod.run(ctx, state)),
        limitMs,
        "run",
      );
    const rows = await mod.expect(result);
    const bad = checkRows(rows, mod.clauses);
    if (bad.length) return { error: "rows: " + bad.join("; ") };
    return { rows };
  } catch (e) {
    return { error: String(e?.stack || e) };
  } finally {
    if (typeof mod.teardown === "function") await mod.teardown(ctx, state);
  }
}
