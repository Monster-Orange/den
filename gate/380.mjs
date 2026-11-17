// Live check for #380: config files are written whole (a temp file beside them, then a rename), so a reader
// never gets half a file. Settings saves the install's approval policy with the value already there, over
// and over, while this check reads config/local/user.yml (ctx.readBed); every read must be the whole file.
// Nothing changes: each save carries the current value (null when unset clears nothing).
export const issue = 380;
export const clauses = [
  "a reader never gets a partial config file while Den rewrites it",
  "the write leaves no temp file beside the config file",
];
export const timeoutMs = 120000;
const SAVES = 150;
const FILE = "config/local/user.yml";

export async function setup(ctx) {
  const now = await ctx.api("/api/settings");
  return { policy: now?.approvals_policy ?? null };
}

export async function run(ctx, s) {
  const save = () =>
    ctx.fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvals_policy: s.policy }),
    });
  await save();
  const whole = ctx.readBed(FILE);
  if (whole === null) return { ...s, read: false };
  let reads = 0;
  const torn = [];
  let done = false;
  // Reads between the saves' network waits: each is a whole read of the file as it is then.
  const reader = (async () => {
    while (!done) {
      const t = ctx.readBed(FILE) ?? "<gone>";
      reads++;
      if (t !== whole)
        torn.push(
          torn.length < 5 ? { len: t.length, head: t.slice(0, 24) } : null,
        );
      await new Promise((r) => setImmediate(r));
    }
  })();
  let saved = 0;
  for (let i = 0; i < SAVES; i++) if ((await save()).status === 200) saved++;
  done = true;
  await reader;
  return {
    ...s,
    read: true,
    size: whole.length,
    saves: saved,
    reads,
    torn: torn.length,
    tornSample: torn.filter(Boolean),
  };
}

export function expect(r) {
  return [
    r.read
      ? {
          clause: clauses[0],
          ok: r.saves === SAVES && r.reads > 0 && r.torn === 0,
          detail: `${r.saves}/${SAVES} saves of user.yml (${r.size} bytes), ${r.reads} reads, ${r.torn} not whole ${JSON.stringify(r.tornSample)}`,
        }
      : {
          clause: clauses[0],
          ok: null,
          skip: "needs-bed-file",
          detail: `ctx.readBed("${FILE}") gave nothing`,
        },
    {
      clause: clauses[1],
      ok: null,
      skip: "needs-bed-dir-listing",
      detail:
        "the temp file's name is random, and ctx has no read-only listing of a bed folder",
    },
  ];
}
