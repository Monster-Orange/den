/**
 * Issue 171, the values the server sends: Edge, Environments, Tests,
 * Release and Logs drew their own words through the catalog, but showed
 * some values as the server sent them, in English in es and ja: a Docker
 * state ("running"), the TLS strategy ("none"), a health check's reason
 * ("fetch failed"), a GitHub state ("failure"), a perf report's status
 * ("passed") and metric labels, a log history's reason. The literal check
 * (i18n-pages-171.test.ts) reads only the pages' sources, so it never saw
 * these. Here each is drawn in es and ja and must not read in English.
 *
 * Data stays as sent: container names, ports, paths, versions, names.
 */
import { afterAll, describe, expect, it } from "@jest/globals";
import {
  edgeSub,
  edgeView,
  mountEdge,
} from "../../../src/ui/server/public/edge-page.js";
import { renderPerfReportHtml } from "../../../src/ui/server/public/perf-report.js";
import { resolveHistorySource } from "../../../src/ui/server/log-history.js";
import { installShell } from "./helpers/en-catalog.js";

type Vars = Record<string, unknown>;
const tOf = () =>
  (
    globalThis as unknown as {
      window: { denShell: { t: (k: string, v?: Vars) => string } };
    }
  ).window.denShell.t;

/** What a person reads: the HTML's text, with data (code, mono, translate="no") cut. */
function shown(html: string): string {
  return html
    .replace(/<(code|kbd)\b[^>]*>[\s\S]*?<\/\1>/g, " ")
    .replace(/<span class="mono[^"]*"[^>]*>[^<]*<\/span>/g, " ")
    .replace(/<li class="mono">[^<]*<\/li>/g, " ")
    .replace(/<[^>]*\stranslate="no"[^>]*>[^<]*<\/[a-z]+>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/g, " ")
    .replace(/\s+/g, " ");
}

/** The English words of `list` that `text` shows, as whole words. */
function english(text: string, list: string[]): string[] {
  return list.filter((w) =>
    new RegExp(`(^|[^\\w-])${w.replace(/[()/.]/g, "\\$&")}(?![\\w-])`).test(
      text,
    ),
  );
}

const edge = {
  configured: true,
  org: "acme",
  container: "acme-edge",
  up: true,
  ports: { http: 80, https: 443 },
  network: "acme-edge",
  domains: ["acme.localhost"],
  routes: [],
  certNames: ["acme.localhost"],
  certIssued: true,
  caTrusted: true,
  included: [],
  stacks: [],
};

const STATES = [
  "running",
  "exited",
  "created",
  "paused",
  "restarting",
  "removing",
  "dead",
  "absent",
];

const savedWindow = (globalThis as Record<string, unknown>).window;
afterAll(() => {
  (globalThis as Record<string, unknown>).window = savedWindow;
});

describe.each(["es", "ja"])("issue 171 values in %s", (lang) => {
  it("Edge: the container's state, the TLS strategy, a lost server", async () => {
    installShell(lang);
    const found: string[] = [];
    for (const state of STATES) {
      const st = { ...edge, state, up: state === "running" };
      const sub = edgeSub(st);
      found.push(...english(sub, [state]).map((w) => `sub ${state}: ${w}`));
      const view = shown(
        edgeView({ ...st, tls: { strategy: "mkcert", from: "set" } }),
      );
      found.push(...english(view, [state]).map((w) => `card ${state}: ${w}`));
    }
    for (const strategy of ["none", "files"]) {
      const view = shown(
        edgeView({
          ...edge,
          state: "running",
          ports: strategy === "none" ? { http: 80 } : edge.ports,
          tls: { strategy, from: "set" },
        }),
      );
      found.push(...english(view, [strategy]).map((w) => `tls: ${w}`));
    }
    const root = {
      innerHTML: "",
      removeAttribute: () => {},
    } as unknown as HTMLElement;
    const sub = { textContent: "" } as unknown as HTMLElement;
    await mountEdge(root, sub, () =>
      Promise.reject(new TypeError("Failed to fetch")),
    );
    found.push(
      ...english(shown(root.innerHTML) + " " + sub.textContent, [
        "Failed",
        "fetch",
      ]).map((w) => `lost: ${w}`),
    );
    expect(found).toEqual([]);
  });

  it("Environments: a down service's reason", async () => {
    installShell(lang);
    // The words the health checks send (health.ts, compose-health.ts).
    const reasons: Array<[string, string[]]> = [
      ["fetch failed", ["fetch", "failed"]],
      ["unreachable", ["unreachable"]],
      ["dns", ["dns"]],
      ["timeout", ["timeout"]],
      ["no route (edge 404)", ["no route", "edge"]],
      ["fallback got non-2xx", ["fallback", "got"]],
      ["no answer within 30s", ["no answer", "within"]],
      ["killed (SIGTERM)", ["killed"]],
      ["exit 1", ["exit"]],
      ["timeout (twice in a row)", ["timeout", "twice"]],
      ["connect ECONNREFUSED 127.0.0.1:3000", ["connect", "ECONNREFUSED"]],
      ["getaddrinfo ENOTFOUND web.local", ["getaddrinfo", "ENOTFOUND"]],
      ["read ECONNRESET", ["read", "ECONNRESET"]],
      ["socket hang up", ["socket", "hang"]],
      ["self-signed certificate", ["certificate", "signed"]],
      [
        "acme-web-1\texited\tExited (1) 2 hours ago",
        ["exited", "Exited", "hours", "ago"],
      ],
      [
        "acme-web-1\trunning\tUp 3 hours (unhealthy)",
        ["running", "Up", "unhealthy"],
      ],
      [
        "acme-web-1\trunning\tUp 1 second (health: starting)",
        ["running", "starting"],
      ],
      ["acme/web: no container", ["no container"]],
      ["container state unknown: docker timed out", ["container", "unknown"]],
      ["something nobody planned for", ["something", "nobody"]],
    ];
    let words: (r: Vars) => { what: string; title: string };
    try {
      ({ healthCellWords: words } =
        (await import("../../../src/ui/server/public/value-words.js")) as unknown as {
          healthCellWords: typeof words;
        });
    } catch {
      // Before issue 171's fix the page showed r.error itself.
      words = (r) => ({
        what: String(r.error),
        title: String(r.error),
      });
    }
    const found: string[] = [];
    for (const [error, en] of reasons) {
      const w = words({ ok: false, error, ms: 2000, url: "http://x" });
      for (const x of english(`${w.what}`, en))
        found.push(`${error}: cell "${w.what}" (${x})`);
    }
    expect(found).toEqual([]);
  });

  it("Release and Environments: a GitHub state in a status line", async () => {
    installShell(lang);
    const t = tOf();
    let vars: (v: Vars) => Vars = (v) => v;
    try {
      ({ statusVars: vars } =
        (await import("../../../src/ui/server/public/value-words.js")) as unknown as {
          statusVars: typeof vars;
        });
    } catch {
      /* before the fix: the vars as sent */
    }
    const found: string[] = [];
    for (const state of [
      "failure",
      "error",
      "cancelled",
      "timed_out",
      "inactive",
      "in_progress",
      "queued",
      "pending",
    ])
      for (const key of [
        "rel.st.lastFailed",
        "rel.st.runConcl",
        "rel.st.newer",
      ]) {
        const s = t(key, vars({ state, at: "12:00" }));
        // "error" is the same word in Spanish.
        if (lang === "es" && state === "error") continue;
        for (const w of english(s, [state])) found.push(`${key}: ${w}`);
      }
    expect(found).toEqual([]);
  });

  it("Tests: a perf report's status and metric labels", () => {
    installShell(lang);
    const html = renderPerfReportHtml({
      environment: "local",
      status: "passed",
      startedAt: null,
      finishedAt: null,
      modules: [
        {
          module: "smoke",
          status: "failed",
          coreMetrics: [
            { label: "HTTP requests", value: 10 },
            { label: "Iterations", value: 5 },
            { label: "Virtual users", value: 2 },
          ],
          latencyMetrics: [
            { label: "HTTP avg", value: 12, unit: "ms" },
            { label: "HTTP max", value: 40, unit: "ms" },
          ],
          throughputMetrics: [
            { label: "Requests / sec", value: 3 },
            { label: "Iterations / sec", value: 1 },
            { label: "Failure rate", value: 0.1 },
          ],
          thresholds: [],
          checks: [],
          scenarios: [],
          customMetrics: [],
        },
      ],
    });
    expect(
      english(shown(html), [
        "passed",
        "failed",
        "requests",
        "Iterations",
        "Virtual users",
        "avg",
        "max",
        "Requests",
        "sec",
        "Failure rate",
      ]),
    ).toEqual([]);
  });

  it("Logs: why a service has no history", async () => {
    installShell(lang);
    const t = tOf();
    const found: string[] = [];
    for (const [repo, env, en] of [
      ["../x", "local", ["invalid", "name"]],
      ["acme", "staging", ["history", "supported", "local only"]],
    ] as const) {
      const src = (await resolveHistorySource(repo, "web", env)) as {
        reason?: string;
        t?: { key: string; vars?: Vars };
      };
      // What logs.html shows: the catalog's words when the server names a key.
      const why = src.t ? t(src.t.key, src.t.vars) : (src.reason ?? "");
      const line = t("lg.hist.unavailable", { reason: why });
      for (const w of english(line, [...en]))
        found.push(`${repo} ${env}: ${w}`);
    }
    expect(found).toEqual([]);
  });
});

describe("issue 171 values in en", () => {
  it("a health reason stays as sent: the words the CLI prints", async () => {
    installShell("en");
    const { healthCellWords, healthReason } =
      (await import("../../../src/ui/server/public/value-words.js")) as unknown as {
        healthCellWords: (r: Vars) => { what: string; title: string };
        healthReason: (e: string, ms?: number) => string | null;
      };
    expect(healthReason("connect ECONNREFUSED 127.0.0.1:9")).toBeNull();
    expect(
      healthCellWords({ ok: false, error: "timeout", ms: 5000 }).what,
    ).toBe("timed out after 5 s");
  });
});

/**
 * A check that couldn't reach its target ("fetch failed") has its own
 * plain line: the cell says it didn't answer and what to try; its title
 * names what didn't answer. In en, es and ja; never the raw words.
 */
describe("issue 188: Environments, a check that got no answer", () => {
  const url = "https://web.acme.localhost/health";
  it.each([
    ["en", "No answer: is it running?", `${url} didn't answer.`],
    ["es", "Sin respuesta: ¿está en marcha?", `${url} no respondió.`],
    ["ja", "応答なし: 起動していますか?", `${url} が応答しませんでした。`],
  ] as Array<[Parameters<typeof installShell>[0], string, string]>)(
    "%s: its own line, never 'fetch failed'",
    async (lang, cell, head) => {
      installShell(lang);
      const { healthCellWords } =
        (await import("../../../src/ui/server/public/value-words.js")) as unknown as {
          healthCellWords: (r: Vars) => { what: string; title: string };
        };
      const w = healthCellWords({
        ok: false,
        error: "fetch failed",
        label: "web",
        url,
      });
      expect(w.what).toBe(cell);
      expect(w.title).toContain(head);
      // What to try: that it runs, and that this computer can reach it.
      expect(w.title.length).toBeGreaterThan(head.length + 20);
      expect(`${w.what} ${w.title}`).not.toMatch(/fetch failed/i);
      // "Twice in a row" keeps the same line.
      expect(
        healthCellWords({
          ok: false,
          error: "fetch failed (twice in a row)",
          url,
        }).what,
      ).not.toMatch(/fetch failed/i);
    },
  );
});

describe("issue 171 values in en, after 188", () => {
  it("a timeout still reads in words", async () => {
    installShell("en");
    const { healthCellWords } =
      (await import("../../../src/ui/server/public/value-words.js")) as unknown as {
        healthCellWords: (r: Vars) => { what: string; title: string };
      };
    expect(
      healthCellWords({ ok: false, error: "timeout", ms: 5000 }).what,
    ).toBe("timed out after 5 s");
  });
});
