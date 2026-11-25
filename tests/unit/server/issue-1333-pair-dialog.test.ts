/**
 * Issue 1333 (tests first), without a browser: "Allow this computer?"
 * popped up unasked, looked as if it showed the code, and didn't say
 * where the request came from.
 *
 *  1. The dialog's code box has no example code in it, and a label.
 *  2. A request carries the Den address it opened, and the dialog says
 *     where it came from and when.
 *  3. The signed-out page asks for no code until its button is clicked; a
 *     sign-in link's own request still opens at once; a page restored
 *     from the back-forward cache doesn't ask by itself.
 *  4. The dialog says to Deny an unexpected request, and Deny has the
 *     focus first.
 *  5. Each request's start and end is logged with no code and no poll id,
 *     and doctor counts the last day's, and those nobody approved.
 *  Every new word is in en, es and ja.
 * Invented names and addresses only.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as vm from "vm";
import { PairRequests } from "../../../src/ui/server/pair-requests.js";
import {
  denAddressOf,
  handlePairRoutes,
  type PairRouteDeps,
} from "../../../src/ui/server/pair-routes.js";
import {
  pairEventDetail,
  signinRequestCounts,
} from "../../../src/ui/server/signin-request-log.js";
import { wirePair } from "../../../src/ui/server/public/error-page.js";
import { signinRequestLines } from "../../../src/ui/cli/doctor-command.js";
import * as os from "os";

const PUBLIC = path.join(process.cwd(), "src", "ui", "server", "public");
const read = (f: string) => fs.readFileSync(path.join(PUBLIC, f), "utf-8");
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

type Table = Record<string, string>;
function catalogs(): Record<string, Table> {
  const window: Record<string, unknown> = {};
  const document = {
    getElementById: () => null,
    documentElement: { lang: "en" },
    addEventListener: () => {},
  };
  const ctx = vm.createContext({ window, document, Intl });
  for (const f of ["i18n/es.js", "i18n/ja.js", "shell.js"]) {
    try {
      vm.runInContext(read(f), ctx, { filename: f });
    } catch {
      // shell.js stops at its first DOM use; its catalog is set before it.
    }
  }
  return window.denMessages as Record<string, Table>;
}

describe("issue 1333 (1, 4): the dialog's markup", () => {
  const shell = read("shell.js");
  const markup = shell.slice(
    shell.indexOf('d.id = "den-pair-dlg"'),
    shell.indexOf("function prShow("),
  );

  it("the code box has no example code (no placeholder) and a label for it", () => {
    const input = /<input id="den-pair-code-in"[^>]*>/.exec(markup)?.[0] ?? "";
    expect(input).not.toBe("");
    expect(input).not.toMatch(/placeholder=/);
    expect(input).not.toMatch(/autofocus/);
    expect(markup).toMatch(/<label for="den-pair-code-in"/);
  });

  it("says where it came from, and to Deny an unexpected one; Deny is focused first", () => {
    expect(markup).toMatch(/id="den-pair-from"/);
    expect(markup).toMatch(/id="den-pair-unexpected"/);
    const show = shell.slice(
      shell.indexOf("function prShow("),
      shell.indexOf("function prPoll("),
    );
    expect(show).toMatch(/\$\("den-pair-deny"\)\.focus\(\)/);
    expect(show).not.toMatch(/\$\("den-pair-code-in"\)\.focus\(\)/);
  });
});

describe("issue 1333 (2): a request knows the Den address it opened", () => {
  it("denAddressOf: the Host header, kept only when it is a plain host[:port]", () => {
    const of = (host: unknown) => denAddressOf({ headers: { host } } as never);
    expect(of("den.example.test")).toBe("den.example.test");
    expect(of("den.example.test:7000")).toBe("den.example.test:7000");
    expect(of("[fd00::1]:7000")).toBe("[fd00::1]:7000");
    expect(of(undefined)).toBeUndefined();
    expect(of("evil<script>")).toBeUndefined();
    expect(of("a".repeat(300))).toBeUndefined();
  });

  it("the waiting list gives each request's address, Den address and time; never its code", async () => {
    const pairs = new PairRequests();
    const sent: unknown[] = [];
    const deps = {
      pairs,
      sendJson: (_r: unknown, b: unknown) => sent.push(b),
      readBody: async () => "",
      signIn: () => ({ cookie: "", approveKey: "" }),
      client: () => "100.101.102.103",
      approver: () => null,
      audit: () => {},
    } as unknown as PairRouteDeps;
    const res = { setHeader: () => {} } as never;
    await handlePairRoutes(
      {
        method: "POST",
        headers: { host: "den.example.test", "user-agent": UA },
      } as never,
      res,
      "/api/signin/code",
      deps,
    );
    const code = (sent[0] as { code: string }).code;
    await handlePairRoutes(
      { method: "GET", headers: {} } as never,
      res,
      "/api/web/waiting",
      deps,
    );
    const w = (sent[1] as { waiting: Record<string, unknown>[] }).waiting[0];
    expect(w).toMatchObject({
      client: "100.101.102.103",
      host: "den.example.test",
      device: "Safari on macOS",
    });
    expect(Date.parse(String(w.createdAt))).not.toBeNaN();
    expect(JSON.stringify(w)).not.toContain(code);
  });
});

describe("issue 1333 (5): each request's start and end is logged, never its code", () => {
  function clock(start = 1_000_000) {
    let t = start;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it("start, then each way it ends: approved, denied, withdrawn, expired", () => {
    const c = clock();
    const events: Record<string, unknown>[] = [];
    const pairs = new PairRequests({
      now: c.now,
      onEvent: (e) => events.push({ ...e }),
    });
    const meta = {
      userAgent: UA,
      client: "100.101.102.103",
      host: "den.example.test",
    };
    const a = pairs.create(meta);
    const b = pairs.create(meta);
    const d = pairs.create(meta);
    const x = pairs.create(meta);
    pairs.approve({ ref: a.ref, code: a.code });
    pairs.deny({ ref: b.ref });
    pairs.withdraw(d.id);
    c.advance(11 * 60_000);
    pairs.waiting();
    const starts = events.filter((e) => e.event === "start");
    expect(starts).toHaveLength(4);
    expect(starts[0]).toMatchObject({
      ref: a.ref,
      client: "100.101.102.103",
      device: "Safari on macOS",
      host: "den.example.test",
    });
    const ends = Object.fromEntries(
      events
        .filter((e) => e.event === "end")
        .map((e) => [e.ref as string, e.outcome]),
    );
    expect(ends).toEqual({
      [a.ref]: "approved",
      [b.ref]: "denied",
      [d.ref]: "withdrawn",
      [x.ref]: "expired",
    });
    const all = JSON.stringify(events);
    for (const r of [a, b, d, x]) {
      expect(all).not.toContain(r.code);
      expect(all).not.toContain(r.code.replace("-", ""));
      expect(all).not.toContain(r.id);
    }
  });

  it("pairEventDetail: a line for the activity trail, with no code", () => {
    expect(
      pairEventDetail({
        event: "start",
        ref: "r1",
        device: "Safari on macOS",
        client: "100.101.102.103",
        host: "den.example.test",
      }),
    ).toBe(
      "start r1: Safari on macOS from 100.101.102.103, opened den.example.test",
    );
    expect(
      pairEventDetail({
        event: "end",
        ref: "r1",
        device: "Safari on macOS",
        outcome: "denied",
      }),
    ).toBe("end r1: denied");
  });

  it("doctor's counts: the last day's requests, and those nobody approved", () => {
    const now = Date.parse("2026-11-23T20:00:00Z");
    const at = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const entries = [
      { ts: at(30), verb: "signin-request", detail: "start old: x" },
      { ts: at(5), verb: "signin-request", detail: "start r1: x" },
      { ts: at(5), verb: "signin-request", detail: "end r1: approved" },
      { ts: at(3), verb: "signin-request", detail: "start r2: x" },
      { ts: at(3), verb: "signin-request", detail: "end r2: withdrawn" },
      { ts: at(1), verb: "signin-request", detail: "start r3: x" },
      { ts: at(1), verb: "approve", detail: "start r9: x" },
    ];
    expect(signinRequestCounts(entries, now)).toEqual({
      requests: 3,
      notApproved: 2,
    });
  });
});

describe("issue 1333 (5): doctor's Sign-in requests row", () => {
  it("reads the trail: the last day's count, and those nobody approved; never a code", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "den-1333-"));
    const now = Date.now();
    const at = (m: number) => new Date(now - m * 60_000).toISOString();
    fs.writeFileSync(
      path.join(dir, "audit.jsonl"),
      [
        {
          ts: at(50),
          verb: "signin-request",
          detail: "start r1: Safari on macOS from 100.101.102.103",
        },
        { ts: at(49), verb: "signin-request", detail: "end r1: withdrawn" },
        {
          ts: at(20),
          verb: "signin-request",
          detail: "start r2: Chrome on Windows from 192.0.2.7",
        },
        { ts: at(19), verb: "signin-request", detail: "end r2: approved" },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n") + "\n",
    );
    const r = signinRequestLines("Den", { stateDir: () => dir });
    expect(r.check).toMatchObject({ id: "signin_requests", status: "warn" });
    expect(r.check!.detail).toMatch(
      /2 sign-in requests in the last day, 1 nobody approved/,
    );
    const none = fs.mkdtempSync(path.join(os.tmpdir(), "den-1333-"));
    expect(
      signinRequestLines("Den", { stateDir: () => none }).check,
    ).toMatchObject({
      status: "ok",
    });
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(none, { recursive: true, force: true });
  });
});

describe("issue 1333 (3): the signed-out page asks for no code until clicked", () => {
  /** A small stand-in DOM: the box's HTML and its buttons' handlers. */
  let calls: { url: string; method: string }[] = [];
  let winHandlers: Record<string, ((e: unknown) => void)[]> = {};
  let box: { innerHTML: string; buttons: Record<string, () => void> };
  const saved: Record<string, unknown> = {};
  const g = globalThis as Record<string, unknown>;

  beforeEach(() => {
    calls = [];
    winHandlers = {};
    box = { innerHTML: "", buttons: {} };
    const el = (id: string) => ({
      id,
      textContent: "",
      addEventListener: (_ev: string, fn: () => void) => {
        box.buttons[id] = fn;
      },
    });
    for (const k of [
      "window",
      "document",
      "fetch",
      "sessionStorage",
      "navigator",
      "location",
    ])
      saved[k] = g[k];
    g.window = {
      addEventListener: (ev: string, fn: (e: unknown) => void) =>
        (winHandlers[ev] ??= []).push(fn),
    };
    g.document = {
      visibilityState: "visible",
      addEventListener: () => {},
    };
    g.sessionStorage = { setItem: () => {} };
    g.navigator = {};
    g.location = { origin: "http://den.example.test", pathname: "/" };
    g.fetch = (url: string, o: { method?: string } = {}) => {
      calls.push({ url, method: o.method ?? "GET" });
      return new Promise(() => {});
    };
    (
      box as unknown as { querySelector: (s: string) => unknown }
    ).querySelector = (s: string) => {
      const id = s.replace(/^#/, "");
      return box.innerHTML.includes(`id="${id}"`) ? el(id) : null;
    };
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) g[k] = v;
  });
  const root = () => ({
    querySelector: (s: string) => (s === "#den-pair" ? box : null),
  });
  const t = (k: string) => k;
  const posts = () =>
    calls.filter((c) => c.method === "POST" && c.url === "/api/signin/code");

  it("on load: no request; a button to start one; its click asks for a code", () => {
    wirePair(root(), t, { name: "Den" });
    expect(posts()).toHaveLength(0);
    expect(box.innerHTML).toContain('id="den-pair-start"');
    box.buttons["den-pair-start"]();
    expect(posts()).toHaveLength(1);
  });

  it("a sign-in link's own request opens at once (no new one is asked for)", async () => {
    jest.useFakeTimers();
    wirePair(root(), t, {
      name: "Den",
      pair: {
        id: "p".repeat(24),
        ref: "r1",
        code: "ABC-DEF",
        expiresIn: 600_000,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(posts()).toHaveLength(0);
    expect(box.innerHTML).toContain("ABC-DEF");
    expect(box.innerHTML).not.toContain('id="den-pair-start"');
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("a request the server ended (gone) offers the button again, even with the page in front: no new request by itself", async () => {
    jest.useFakeTimers();
    (globalThis as Record<string, unknown>).fetch = (
      url: string,
      o: { method?: string } = {},
    ) => {
      calls.push({ url, method: o.method ?? "GET" });
      return Promise.resolve({
        json: () => Promise.resolve({ ok: false, state: "gone" }),
      });
    };
    wirePair(root(), t, {
      name: "Den",
      pair: {
        id: "p".repeat(24),
        ref: "r1",
        code: "ABC-DEF",
        expiresIn: 600_000,
      },
    });
    for (let i = 0; i < 4; i++) await Promise.resolve();
    jest.advanceTimersByTime(1600);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(calls.some((c) => c.method === "GET")).toBe(true);
    expect(posts()).toHaveLength(0);
    expect(box.innerHTML).toContain('id="den-pair-start"');
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it("a page restored from the back-forward cache doesn't ask by itself", () => {
    wirePair(root(), t, { name: "Den" });
    for (const fn of winHandlers.pageshow ?? []) fn({ persisted: true });
    expect(posts()).toHaveLength(0);
    expect(box.innerHTML).toContain('id="den-pair-start"');
  });
});

describe("issue 1333: every new word in en, es and ja", () => {
  const M = catalogs();
  const keys = [
    "pair.from",
    "pair.fromNamed",
    "pair.unknownAddr",
    "pair.unexpected",
    "pair.codeLabel",
    "err.signin.pairStart",
    "err.signin.pairStartLead",
  ];
  it.each(keys)("%s", (k) => {
    for (const lang of ["en", "es", "ja"])
      expect([lang, M[lang]?.[k]]).toEqual([lang, expect.any(String)]);
  });
  it("the label says to type the code that computer shows", () => {
    expect(M.en["pair.codeLabel"]).toBe("Type the code that computer shows");
    expect(M.en["pair.unexpected"]).toBe(
      "If you didn't just try to sign in on another computer, Deny.",
    );
  });
});
