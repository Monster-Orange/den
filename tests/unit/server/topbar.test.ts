/**
 * The top bar's models (public/topbar.js, 0.3.0-dev.20): the status chip
 * (R6) from the shared rollup, the status drawer's cards and groups (R15),
 * the palette's ranking (R17) and what counts as a run (R7). And the
 * wiring the pages rely on: the health row and the sudo banner are gone,
 * every output pane is marked for the Runs chip, Local Dev runs Start and
 * Restart for the drawer and the palette.
 */
import { describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import { buildRow } from "../../../src/ui/server/public/health-fit.js";
import {
  checkLine,
  drawerGroups,
  problemCards,
  problemFix,
  rankCommands,
  runOf,
  statusChip,
  statusSummary,
} from "../../../src/ui/server/public/topbar.js";

type R = {
  repo: string;
  service: string;
  ok: boolean | null;
  isEntrypoint?: boolean;
  pending?: boolean;
  awaiting?: boolean;
  url?: string;
  status?: number;
  error?: string;
  ms?: number;
  workspaces?: string[];
};
const up = (repo: string, service = repo, ms = 12): R => ({
  repo,
  service,
  ok: true,
  url: `http://${repo}/${service}`,
  status: 200,
  ms,
});
const down = (repo: string, service = repo): R => ({
  repo,
  service,
  ok: false,
  url: `http://${repo}/${service}`,
  error: "connect ECONNREFUSED",
});
const row = (rows: R[]) => buildRow(rows, null);

describe("the status chip (R6): the rail badge's rollup", () => {
  it("reads All N healthy, N the checked services", () => {
    const sum = statusSummary(
      row([up("shop"), up("shop", "db"), up("billing")]),
    );
    expect(sum).toMatchObject({ state: "ok", n: 3, ok: 3, down: 0 });
    expect(statusChip(sum)).toMatchObject({
      dot: "",
      bad: false,
      lead: "",
      text: "All 3 healthy",
    });
  });

  it('reads "ok/N healthy · k down", the lead hidden when narrow, bad', () => {
    const sum = statusSummary(
      row([up("shop"), down("shop", "mailpit"), down("billing"), up("x")]),
    );
    expect(sum).toMatchObject({ state: "bad", n: 4, ok: 2, down: 2 });
    expect(statusChip(sum)).toMatchObject({
      dot: "bad",
      bad: true,
      lead: "2/4 healthy · ",
      text: "2 down",
    });
  });

  it("never counts a pending or unchecked service as down, or in N", () => {
    const sum = statusSummary(
      row([
        up("shop"),
        { repo: "shop", service: "slow", ok: null, pending: true },
        { repo: "jobs", service: "jobs", ok: null },
      ]),
    );
    expect(sum).toMatchObject({
      state: "ok",
      n: 1,
      down: 0,
      pending: 1,
      unchecked: 1,
    });
    expect(statusChip(sum).text).toBe("All 1 healthy");
    expect(statusChip(sum).title).toBe("1 checked · 1 not checked · 1 pending");
  });

  it("never counts a down service while its repo's checks are still out", () => {
    // healthCycle's partial paint: billing's web answered down, its other
    // check hasn't (an `awaiting` row): the repo is unknown, not down.
    const sum = statusSummary(
      row([
        up("shop"),
        down("billing", "web"),
        { repo: "billing", service: "…", ok: null, awaiting: true },
      ]),
    );
    expect(sum).toMatchObject({ state: "ok", down: 0, awaiting: 1 });
    expect(statusChip(sum).bad).toBe(false);
  });

  it("is neutral before data, with no services, and with nothing checked", () => {
    expect(statusChip(statusSummary(null))).toMatchObject({
      dot: "off",
      bad: false,
      text: "Checking…",
      busy: true,
    });
    expect(statusChip(statusSummary(row([]))).text).toBe("No services");
    expect(
      statusChip(statusSummary(row([{ repo: "a", service: "a", ok: null }]))),
    ).toMatchObject({ dot: "off", bad: false, text: "1 not checked" });
    // Only pending answers so far: still checking, never red.
    expect(
      statusChip(
        statusSummary(
          row([{ repo: "a", service: "a", ok: null, pending: true }]),
        ),
      ).text,
    ).toBe("Checking…");
  });
});

describe("the status drawer (R15)", () => {
  const r = row([
    up("shop", "web", 31),
    { ...down("shop", "mailpit"), workspaces: ["ws-a", "ws-b"] },
    { repo: "shop", service: "slow", ok: null, pending: true },
    up("billing", "api", 8),
    { repo: "billing", service: "jobs", ok: null },
  ]);

  it("Needs attention: one card per down service, what was checked and the error", () => {
    expect(problemCards(r)).toEqual([
      {
        id: "shop/mailpit",
        repo: "shop",
        service: "mailpit",
        entry: false,
        line: "http://shop/mailpit — connect ECONNREFUSED",
        workspaces: ["ws-a", "ws-b"],
      },
    ]);
    expect(problemCards(null)).toEqual([]);
  });

  it("a card's fix (R15; the Workspaces table's problem rows, R24d): its text and buttons, each named with the service", () => {
    const [c] = problemCards(r);
    expect(problemFix(c, "12:03")).toEqual({
      text: "http://shop/mailpit — connect ECONNREFUSED · failed at 12:03",
      actions: [
        {
          act: "start",
          label: "Start",
          name: "Start shop/mailpit",
          primary: true,
        },
        {
          act: "logs",
          label: "Logs",
          name: "Logs of shop/mailpit",
          primary: false,
        },
      ],
    });
    expect(problemFix(c).text).toBe(
      "http://shop/mailpit — connect ECONNREFUSED",
    );
  });

  it("Everything: per application ok/N, each service with its ms; pending is pending", () => {
    const groups = drawerGroups(r, [
      { app: { name: "store", title: "Store" }, repos: ["shop"] },
      { app: null, repos: ["billing"] },
    ]);
    expect(
      groups.map((g: { title: string; ok: number; checked: number }) => [
        g.title,
        `${g.ok}/${g.checked}`,
      ]),
    ).toEqual([
      ["Store", "1/2"],
      ["billing", "1/1"],
    ]);
    expect(
      groups[0].services.map(
        (s: { id: string; state: string; ms: number | null }) => [
          s.id,
          s.state,
          s.ms,
        ],
      ),
    ).toEqual([
      ["shop/web", "ok", 31],
      ["shop/mailpit", "down", null],
      ["shop/slow", "pending", null],
    ]);
    expect(groups[1].services[1]).toMatchObject({
      id: "billing/jobs",
      state: "unchecked",
      line: "not checked",
    });
  });

  it("says what each check said (the old row's tooltips)", () => {
    expect(checkLine(up("a"))).toBe("http://a/a → 200");
    expect(checkLine(down("a"))).toBe("http://a/a — connect ECONNREFUSED");
    expect(
      checkLine({
        repo: "a",
        service: "s",
        ok: false,
        check: "stack health",
      } as never),
    ).toBe("stack health");
    expect(
      checkLine({ repo: "a", service: "s", ok: null, pending: true, url: "u" }),
    ).toBe("u — pending");
    expect(checkLine({ repo: "a", service: "s", ok: null })).toBe(
      "not checked",
    );
  });
});

describe("the palette's ranking (R17)", () => {
  const items = [
    { key: "1", label: "Services", kind: "page", kindLabel: "Page" },
    { key: "2", label: "Logs", kind: "page", kindLabel: "Page" },
    { key: "3", label: "shop/web", kind: "service", kindLabel: "Service" },
    {
      key: "4",
      label: "Restart shop/web",
      kind: "action",
      kindLabel: "Action",
      hideEmpty: true,
    },
    {
      key: "5",
      label: "Appearance: Dark",
      kind: "action",
      kindLabel: "Action",
      keywords: ["mode", "theme"],
    },
    {
      key: "6",
      label: "Default IDE",
      kind: "setting",
      kindLabel: "Setting",
      keywords: ["editor"],
    },
  ];
  const keys = (q: string) =>
    rankCommands(items, q).map((x: { key: string }) => x.key);

  it("an empty query lists the rows not hidden until searched", () => {
    expect(keys("")).toEqual(["1", "2", "3", "5", "6"]);
    expect(rankCommands(items, "", { emptyLimit: 2 })).toHaveLength(2);
  });
  it("ranks a label prefix, then a word in it, then anywhere", () => {
    const list = ["Contests", "Run tests", "Tests"].map((label) => ({
      label,
      kind: "page",
    }));
    expect(
      rankCommands(list, "test").map((x: { label: string }) => x.label),
    ).toEqual(["Tests", "Run tests", "Contests"]);
    expect(keys("web")).toEqual(["3", "4"]);
    expect(keys("shop")).toEqual(["3", "4"]);
  });
  it("matches keywords and the kind label (settings rows by their kind)", () => {
    expect(keys("editor")).toEqual(["6"]);
    expect(keys("mode")).toEqual(["5"]);
    expect(keys("setting")).toEqual(["6"]);
  });
  it("every word must match: restart shop", () => {
    expect(keys("restart shop")).toEqual(["4"]);
    expect(keys("restart nothing")).toEqual([]);
  });
  it("is fuzzy: the letters in order", () => {
    expect(keys("srvc")).toEqual(["1"]);
    expect(keys("zzz")).toEqual([]);
  });
});

describe("runs (R7)", () => {
  it("names a stream to a run endpoint, and nothing else", () => {
    expect(
      runOf("/api/service/exec?repo=shop&service=web&cmd=restart&env=local"),
    ).toBe("restart shop/web");
    expect(
      runOf("/api/workspace/exec?cmd=up&workspace=ws-a&addresses=shop%2Fweb"),
    ).toBe("up shop/web");
    expect(runOf("/api/workspace/sync?repo=shop")).toBe("sync shop");
    expect(runOf("/api/run?suite=smoke")).toBe("tests smoke");
    expect(runOf("/api/release/deploy?session=1")).toBe("deploy");
    // Log tails and the health stream are not runs.
    expect(runOf("/api/service/logs?repo=shop&service=web")).toBeNull();
    expect(runOf("/api/service/taillog?repo=shop")).toBeNull();
    expect(runOf("/api/health/stream?env=local")).toBeNull();
  });
});

describe("the pages", () => {
  const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
  const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");

  it("the bar has the search field and the three chips, in the prototype's order", () => {
    const shell = read("shell.js");
    const at = (s: string) => shell.indexOf(s);
    const order = [
      'id="den-search"',
      'id="den-status"',
      'id="den-runs"',
      'id="den-lock"',
      'id="version-pill"',
      'id="den-user"',
    ].map(at);
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(shell).toContain('<kbd aria-hidden="true">⌘K</kbd>');
    // The dot row and the "+N" chip are gone from the bar.
    expect(shell).not.toContain('id="health"');
    expect(read("header.js")).not.toMatch(/health-more|_layoutHealthRow/);
  });

  it("the sudo banner is gone: the lock chip is the one unlock, on every page", () => {
    for (const f of fs.readdirSync(PUBLIC).filter((x) => x.endsWith(".html")))
      expect(read(f)).not.toMatch(/sudo-banner|sudo-lock|\/api\/sudo-password/);
    const local = read("local-dev.html");
    // Local Dev keeps its lock rule, now the shared one.
    expect(local).toMatch(
      /function requireSudo\(\) \{\s*return requireUnlock\(\);/,
    );
    expect(local.match(/if \(!requireSudo\(\)\) return;/g)?.length).toBe(6);
    // …and runs Start and Restart for the drawer and the palette.
    expect(local).toMatch(
      /setServiceRunner\(\(cmd, s\) =>\s*window\.runCmd\(s\.address, s\.repo, s\.service, cmd\)/,
    );
    expect(local).toMatch(/takePendingAction\(\)/);
  });

  it.each([
    ["local-dev.html", "runs().append(address, text, cls)"],
    ["services.html", "runs().append(runId, text, cls)"],
    ["index.html", "runs().append(TEST_RUN, text, cls)"],
    ["index.html", "runs().append(execRun, text, cls)"],
    ["release.html", "runs().append(curRun, text, cls)"],
  ])(
    "%s keeps no output pane of its own: its runs go to the shell's dock (R16)",
    (f, call) => {
      const html = read(f);
      expect(html).toContain(call);
      expect(html).toContain("window.denShell.runs");
      expect(html).not.toMatch(
        /data-den-output|id="output-panel"|id="output-pane"|id="test-output"|id="cmd-output"|<pre id="output"/,
      );
    },
  );

  it("is served", async () => {
    const { UI_MODULES } = await import("../../../src/ui/server/ui-assets.js");
    expect(UI_MODULES).toContain("/topbar.js");
  });
});
