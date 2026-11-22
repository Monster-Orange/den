// Live check for #380: config files are written whole (a temp file beside them, then a rename), so a reader
// never gets half a file. Settings saves the page language with the value already there, over and over
// (a field anyone signed in may change, so the fixture person's saves are taken; every save rewrites
// user.yml), while this check reads config/local/user.yml (ctx.readBed); every read must be the whole
// file, and the folder (ctx.listBed) has no new name after.
// Nothing changes: each save carries the current value ("en" leaves the file without a language line).
// No save taken means nothing was measured: not run (needs-settings-save), never a FAIL.
export const issue = 380;
export const clauses = [
  "a reader never gets a partial config file while Den rewrites it",
  "the write leaves no temp file beside the config file",
];
export const timeoutMs = 120000;
const SAVES = 150;
const DIR = "config/local";
const FILE = `${DIR}/user.yml`;

export async function setup(ctx) {
  const now = await ctx.api("/api/settings");
  return { language: typeof now?.language === "string" ? now.language : "en" };
}

export async function run(ctx, s) {
  const save = () =>
    ctx.fetch("/api/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ language: s.language }),
    });
  const before = ctx.listBed(DIR);
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
  let refused = null;
  for (let i = 0; i < SAVES; i++) {
    const r = await save();
    if (r.status === 200) saved++;
    else
      refused ??= {
        status: r.status,
        body: String(r.body ?? "").slice(0, 200),
      };
  }
  done = true;
  await reader;
  await ctx.sleep(500);
  const after = ctx.listBed(DIR);
  const left =
    before && after ? after.filter((f) => !before.includes(f)) : null;
  return {
    ...s,
    read: true,
    size: whole.length,
    saves: saved,
    reads,
    torn: torn.length,
    tornSample: torn.filter(Boolean),
    refused,
    left,
  };
}

export function expect(r) {
  if (r.read && r.saves === 0) {
    const detail = `no save of user.yml was taken (${JSON.stringify(r.refused)}), so nothing was measured`;
    return clauses.map((clause) => ({
      clause,
      ok: null,
      skip: "needs-settings-save",
      detail,
    }));
  }
  return [
    r.read
      ? {
          clause: clauses[0],
          ok: r.saves === SAVES && r.reads > 0 && r.torn === 0,
          detail: `${r.saves}/${SAVES} saves of user.yml (${r.size} bytes), ${r.reads} reads, ${r.torn} not whole ${JSON.stringify(r.tornSample)}${r.refused ? `; first refusal ${JSON.stringify(r.refused)}` : ""}`,
        }
      : {
          clause: clauses[0],
          ok: null,
          skip: "needs-bed-file",
          detail: `ctx.readBed("${FILE}") gave nothing`,
        },
    r.left
      ? {
          clause: clauses[1],
          ok: r.left.length === 0,
          detail: r.left.length
            ? `new beside it: ${r.left.join(", ")}`
            : `no new name in ${DIR} after ${r.saves} saves`,
        }
      : {
          clause: clauses[1],
          ok: null,
          skip: "needs-bed-dir-listing",
          detail: `ctx.listBed("${DIR}") gave nothing`,
        },
  ];
}
