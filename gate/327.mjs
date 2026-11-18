/* eslint-env browser */
// Live check for #327: the permission wait names its prompt, and a stopped or removed agent leaves no wait.
// Bed stub agents only; answering the prompt is a person's act and is not run.
export const issue = 327;
export const clauses = [
  'the bell row names the prompt: "<agent> needs your permission: Bash"',
  "stopping the agent clears its permission wait",
  "removing an ended agent clears what it was waiting on",
  "answering the prompt clears the wait",
];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280] };
export const timeoutMs = 120000;
const STOP = "m1";

export async function setup() {
  return {};
}

export async function run(ctx) {
  const tag = `${ctx.browser}-${ctx.width}`;
  const a = ctx.agent(STOP);
  await a.running(20000);
  await ctx.sleep(2500);
  const r = { badgeBefore: (await ctx.api("/api/notifications")).unread };
  a.permissionRequest("Bash");
  r.raiseMs = await ctx.until(
    async () => (await a.waiting("permission")).length > 0,
    10000,
  );
  r.what = (await a.waiting("permission"))[0]?.what ?? null;
  await ctx.goto(ctx.page, "/agents");
  r.bell = await ctx.bell(ctx.page);
  // Bell rows exist only while the panel is open (bell.js): open it, read, close.
  await ctx.page.click("#den-bell").catch(() => {});
  await ctx.page
    .waitForSelector(".den-bell-row", { timeout: 3000 })
    .catch(() => {});
  r.row = await ctx.page.evaluate(
    () =>
      [
        ...document.querySelectorAll(
          '.den-bell-row[data-kind] a[data-bell="open"]',
        ),
      ]
        .map((e) => e.innerText.replace(/\s+/g, " "))
        .find((t) => /needs your permission/.test(t)) ?? null,
  );
  await ctx.page.keyboard.press("Escape").catch(() => {});
  const n = await ctx.api("/api/notifications");
  r.apiRow =
    n.groups
      ?.flatMap((g) => g.subjects)
      .filter((s) => s.subject === `agent:${STOP}`)
      .flatMap((s) => s.items)
      .find((i) => i.kind === "waiting")?.text ?? null;
  await ctx.shot(`raised-${tag}`);

  a.stop();
  r.stopGoneMs = await ctx.until(
    async () => (await a.waiting("permission")).length === 0,
    10000,
  );
  r.badgeAfterStop = (await ctx.api("/api/notifications")).unread;
  await ctx.goto(ctx.page, "/agents");
  await ctx.shot(`after-stop-${tag}`);

  // remove: an agent whose session ended still holds a question; forgetting it clears that wait
  const b = ctx.agent(`gauto327${ctx.browser[0]}`);
  b.start("tester");
  await b.running(20000);
  await ctx.sleep(2500);
  b.askHuman("Gate check: remove me?");
  r.rmRaiseMs = await ctx.until(
    async () => (await b.waiting()).length > 0,
    10000,
  );
  b.exit();
  await ctx.until(() => b.state() !== "running", 10000);
  r.rmHeldAfterExit = (await b.waiting()).length;
  b.remove();
  r.rmGoneMs = await ctx.until(
    async () => (await b.waiting()).length === 0,
    10000,
  );
  return r;
}

export function expect(cells) {
  const all = (f) => cells.every(({ result }) => f(result));
  const d = (f) =>
    cells.map(({ cell, result }) => `${cell.browser}: ${f(result)}`).join("; ");
  const shots = (p) =>
    cells.map(({ cell }) => `${p}-${cell.browser}-${cell.width}.png`);
  return [
    {
      clause: clauses[0],
      ok: all(
        (r) =>
          r.raiseMs !== null &&
          r.what === "Bash" &&
          /needs your permission: Bash/.test(r.apiRow || "") &&
          /needs your permission: Bash/.test(r.row || ""),
      ),
      detail: d(
        (r) =>
          `"${r.apiRow}", page row ${r.row ? "shown" : "not found"}, badge ${r.badgeBefore}→${r.bell.unread}`,
      ),
      evidence: shots("raised"),
    },
    {
      clause: clauses[1],
      ok: all((r) => r.stopGoneMs !== null),
      detail: d(
        (r) =>
          `gone ${r.stopGoneMs} ms after the CLI stop, badge ${r.bell.unread}→${r.badgeAfterStop}`,
      ),
      evidence: shots("after-stop"),
    },
    {
      clause: clauses[2],
      ok: all(
        (r) =>
          r.rmRaiseMs !== null && r.rmHeldAfterExit > 0 && r.rmGoneMs !== null,
      ),
      detail: d(
        (r) =>
          `question raised ${r.rmRaiseMs} ms, held after exit ${r.rmHeldAfterExit}, gone ${r.rmGoneMs} ms after the CLI remove`,
      ),
    },
    {
      clause: clauses[3],
      ok: null,
      skip: "person",
      detail: "answering a permission prompt is a person's act",
    },
  ];
}

export async function teardown(ctx) {
  for (const id of ["gauto327c", "gauto327w"])
    if (ctx.agent(id).state()) ctx.agent(id).remove();
}
