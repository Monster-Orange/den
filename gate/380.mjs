// Live check for #380: config files are written whole (a temp file beside them, then a rename), so a reader
// never gets half a file. Settings saves the install's approval policy with the value already there, over
// and over, while this check reads config/local/user.yml; every read must be the whole file.
// Nothing changes: each save carries the current value (null when unset clears nothing).
import fs from "node:fs/promises";
import path from "node:path";

export const issue = 380;
export const clauses = [
  "a reader never gets a partial config file while Den rewrites it",
  "the write leaves no temp file beside the config file",
];
export const timeoutMs = 120000;
const SAVES = 150;

// The bed's own folder: the harness's driver knows it (ctx.o.bed); the contract has no way to read a file.
const bedDir = (ctx) => ctx.o?.bed ?? null;

export async function setup(ctx) {
  const now = await ctx.api("/api/settings");
  return { policy: now?.approvals_policy ?? null };
}

export async function run(ctx, s) {
  const bed = bedDir(ctx);
  if (!bed) return { ...s, bed: null };
  const dir = path.join(bed, "config", "local");
  const file = path.join(dir, "user.yml");
  const save = () =>
    ctx.api("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvals_policy: s.policy }),
    });
  const before = new Set(await fs.readdir(dir));
  await save();
  const whole = await fs.readFile(file, "utf8");
  let reads = 0;
  const torn = [];
  let done = false;
  const reader = (async () => {
    while (!done) {
      const t = await fs.readFile(file, "utf8").catch((e) => `<${e.code}>`);
      reads++;
      if (t !== whole && torn.length < 5)
        torn.push({ len: t.length, head: t.slice(0, 24) });
      else if (t !== whole) torn.push(null);
    }
  })();
  let saved = 0;
  for (let i = 0; i < SAVES; i++) {
    const r = await save();
    if (r?.ok !== false) saved++;
  }
  done = true;
  await reader;
  await ctx.sleep(500);
  const left = (await fs.readdir(dir)).filter((f) => !before.has(f));
  return {
    ...s,
    bed: true,
    size: whole.length,
    saves: saved,
    reads,
    torn: torn.length,
    tornSample: torn.filter(Boolean),
    left,
  };
}

export function expect(r) {
  if (!r.bed)
    return clauses.map((clause) => ({
      clause,
      ok: null,
      skip: "needs-bed-path",
      detail: "ctx gives no path to the bed's config folder",
    }));
  return [
    {
      clause: clauses[0],
      ok: r.saves === SAVES && r.reads > 0 && r.torn === 0,
      detail: `${r.saves}/${SAVES} saves of user.yml (${r.size} bytes), ${r.reads} reads, ${r.torn} not whole ${JSON.stringify(r.tornSample)}`,
    },
    {
      clause: clauses[1],
      ok: r.left.length === 0,
      detail: r.left.length
        ? `left beside it: ${r.left.join(", ")}`
        : "no new file in config/local",
    },
  ];
}
