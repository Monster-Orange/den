/**
 * One repo health rollup for the header row, its chip, the graph and
 * `<cli> status` (0.3.0-dev.10). Before, the header and status read only the
 * entry service, so a repo whose web answered but whose mailpit was down
 * read healthy while the graph showed the down service.
 *
 * Only checked signals count: a repo of 26 services with one probe is
 * judged by that probe, and a repo with nothing checked is unknown.
 */
import { describe, expect, it } from "@jest/globals";
import {
  compareRepos,
  describeRollup,
  rollupRepo,
} from "../../../src/shared/health/rollup.js";
import {
  rollupRepoHealth,
  type ServiceHealthResult,
} from "../../../src/shared/environment-manager/health.js";
import {
  buildRow,
  moreChip,
} from "../../../src/ui/server/public/health-fit.js";
import { repoRollup } from "../../../src/ui/server/public/graph-model.js";

const sig = (service: string, ok: boolean | null, isEntrypoint = false) => ({
  service,
  ok,
  isEntrypoint,
});

describe("rollupRepo", () => {
  it("entry service down → down, naming it", () => {
    const r = rollupRepo("shop", [sig("web", false, true), sig("db", true)]);
    expect(r).toMatchObject({ state: "down", entry: "web", down: ["web"] });
    expect(describeRollup(r)).toBe("down (web down)");
  });

  it("another checked service down → degraded, naming it", () => {
    const r = rollupRepo("arbor", [
      sig("web", true, true),
      sig("mailpit", false),
    ]);
    expect(r).toMatchObject({ state: "degraded", down: ["mailpit"] });
    expect(describeRollup(r)).toBe("degraded (mailpit down)");
  });

  it("all up → healthy", () => {
    expect(
      rollupRepo("shop", [sig("web", true, true), sig("db", true)]).state,
    ).toBe("ok");
  });

  it("no data → unknown", () => {
    expect(rollupRepo("shop", []).state).toBe("unknown");
  });

  it("a single service is the entry: its own name or not", () => {
    expect(rollupRepo("api", [sig("server", false)]).state).toBe("down");
    expect(rollupRepo("api", [sig("api", false), sig("db", true)]).state).toBe(
      "down",
    );
  });

  describe("unchecked services never count", () => {
    it("1 probed-up service and 25 unchecked → healthy, 25 not checked", () => {
      const r = rollupRepo("platform", [
        sig("gateway", true),
        ...Array.from({ length: 25 }, (_, i) => sig(`svc-${i}`, null)),
      ]);
      expect(r).toMatchObject({ state: "ok", checked: 1, unchecked: 25 });
      expect(describeRollup(r)).toBe("healthy, 25 not checked");
    });

    it("every service unchecked and no repo URL → unknown", () => {
      const r = rollupRepo("platform", [
        sig("a", null),
        sig("b", null),
        sig("c", null),
      ]);
      expect(r.state).toBe("unknown");
      expect(describeRollup(r)).toBe("unknown (not checked)");
    });

    it("the repo URL answers and every other service is unchecked → healthy", () => {
      expect(
        rollupRepo("site", [
          sig("site", true),
          sig("worker", null),
          sig("cron", null),
        ]).state,
      ).toBe("ok");
    });

    it("pending (not probed yet) is unknown, never down", () => {
      expect(rollupRepo("x", [{ service: "x", ok: undefined }]).state).toBe(
        "unknown",
      );
      expect(
        rollupRepo("x", [sig("x", true, true), { service: "y", ok: undefined }])
          .state,
      ).toBe("ok");
    });

    it("an unchecked entry with a checked sidecar down → degraded", () => {
      expect(
        rollupRepo("x", [sig("web", null, true), sig("mailpit", false)]).state,
      ).toBe("degraded");
    });
  });
});

describe("compareRepos", () => {
  it("problems first; within a state the focused workspace's, then by name", () => {
    const repos = [
      { repo: "b", state: "ok" as const },
      { repo: "z", state: "ok" as const, focused: true },
      { repo: "q", state: "unknown" as const },
      { repo: "a", state: "ok" as const },
      { repo: "m", state: "degraded" as const },
      { repo: "d", state: "down" as const },
    ];
    expect(repos.sort(compareRepos).map((r) => r.repo)).toEqual([
      "d",
      "m",
      "q",
      "z",
      "a",
      "b",
    ]);
  });
});

describe("the header, the chip, the graph and status agree (one service down)", () => {
  // The repo's own URL (web, its entrypoint) answers; mailpit is down.
  const health = [
    { repo: "arbor", service: "web", ok: true, isEntrypoint: true },
    { repo: "arbor", service: "mailpit", ok: false },
    { repo: "arbor", service: "worker", ok: null },
    { repo: "calm", service: "calm", ok: true },
  ];
  const status: ServiceHealthResult[] = health.map((h) => ({
    address: h.service === h.repo ? h.repo : `${h.repo}/${h.service}`,
    repoName: h.repo,
    subsystem: h.service,
    repoPath: `/repos/${h.repo}`,
    mode: "managed",
    branch: "main",
    health: h.ok === true ? "ok" : h.ok === false ? "error" : "unknown",
  }));

  it("all say degraded, naming mailpit", () => {
    // The header row's model, from the /api/health rows it reads.
    const { flat } = buildRow(health, null);
    const arbor = flat.find((r: { repo: string }) => r.repo === "arbor");
    expect(arbor.state).toBe("degraded");
    expect(arbor.rollup.down).toEqual(["mailpit"]);
    // It sorts ahead of the healthy repo, and a hidden one counts in the chip.
    expect(flat.map((r: { repo: string }) => r.repo)).toEqual([
      "arbor",
      "calm",
    ]);
    expect(moreChip(flat).text).toBe("+2, 1 degraded");
    // The graph's repo card.
    const m = {
      byRepo: new Map([
        [
          "arbor",
          health
            .filter((h) => h.repo === "arbor")
            .map((h) => ({
              name: h.service,
              entry: !!h.isEntrypoint,
              health: { ok: h.ok },
            })),
        ],
      ]),
    };
    expect(repoRollup(m, "arbor")).toEqual(arbor.rollup);
    // `<cli> status`.
    const rows = rollupRepoHealth(status, (repo) =>
      repo === "arbor" ? "web" : undefined,
    );
    const row = rows.find((r) => r.repoName === "arbor")!;
    expect(row.address).toBe("arbor");
    expect(row.health).toBe("error");
    expect(row.rollup).toEqual(arbor.rollup);
    expect(describeRollup(row.rollup!)).toBe("degraded (mailpit down)");
  });
});
