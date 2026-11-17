// Live check for #172: when an agent needs the person, an alert goes out beyond the bell, in the bell's words.
// One bed stub agent, made as gate-172-wait and removed in teardown. No page is open on it, so it alerts.
export const issue = 172;
export const clauses = [
  "when an agent needs the person, they are told on the desktop, not only in the bell",
  "they are told on a phone",
  "it follows the approval policy (#160): people see what they watch or what is critical",
];
export const timeoutMs = 90000;
const ID = "gate-172-wait";
const SECRET = "gate-172-tool-line";

export async function setup(ctx) {
  const a = ctx.agent(ID);
  a.start("tester");
  return { runMs: await a.running(20000) };
}

export async function run(ctx, s) {
  const a = ctx.agent(ID);
  await ctx.sleep(2500);
  const before = await ctx.api("/api/alerts");
  const seq = Number.isInteger(before.seq) ? before.seq : 0;
  a.permissionRequest("Bash", { command: `echo ${SECRET}` });
  const raiseMs = await ctx.until(
    async () => (await a.waiting("permission")).length > 0,
    10000,
  );
  let mine = [];
  const alertMs = await ctx.until(async () => {
    const r = await ctx.api(`/api/alerts?after=${seq}`);
    mine = (r.alerts || []).filter((x) =>
      String(x.link || "").includes(`agent=${ID}`),
    );
    return mine.length > 0;
  }, 10000);
  const key = await ctx.api("/api/alerts/push-key");
  return {
    ...s,
    feedOk: before.ok === true,
    raiseMs,
    alertMs,
    alerts: mine.map((x) => ({
      why: x.why,
      title: x.title,
      body: x.body,
      link: x.link,
    })),
    leaks: mine.some((x) => JSON.stringify(x).includes(SECRET)),
    pushKey: typeof key.publicKey === "string" && key.publicKey.length > 20,
  };
}

export function expect(r) {
  const one = r.alerts.length === 1 ? r.alerts[0] : null;
  return [
    {
      clause: clauses[0],
      ok:
        r.feedOk &&
        r.raiseMs !== null &&
        r.alertMs !== null &&
        !!one &&
        one.why === "permission" &&
        /needs your permission/.test(one.body || "") &&
        !r.leaks,
      detail: `feed ${r.feedOk ? "answers" : "missing"}; wait raised ${r.raiseMs} ms; ${r.alerts.length} alert(s) after ${r.alertMs} ms: ${r.alerts.map((a) => `${a.why} "${a.body}" → ${a.link}`).join(" | ") || "none"}; tool line in the alert: ${r.leaks}`,
    },
    {
      clause: clauses[1],
      ok: null,
      skip: "needs-phone",
      detail: `a subscribed phone's push service is needed; this install's push key ${r.pushKey ? "is served" : "is not served"}`,
    },
    {
      clause: clauses[2],
      ok: null,
      skip: "needs-watched-item",
      detail:
        "needs a watched or critical item and a held write the policy holds for the person; the bed has neither",
    },
  ];
}

export async function teardown(ctx) {
  if (ctx.agent(ID).state()) ctx.agent(ID).remove();
}
