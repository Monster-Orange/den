/**
 * /api/activity's filter: an entry for a repo-level refusal (an agent that
 * named only the repo) must show for that repo and its services (F2).
 */
import { describe, expect, it } from "@jest/globals";
import { activityFor } from "../../../src/ui/server/readonly-routes.js";
import type { AuditEntry } from "../../../src/ui/server/audit.js";

const at = (verb: string, detail: string, extra: Partial<AuditEntry> = {}) =>
  ({
    ts: "2026-11-04T00:00:00Z",
    actor: "agent",
    verb,
    detail,
    ...extra,
  }) as AuditEntry;

const entries = [
  at("exec", "core/api up (local) [r1]"),
  at("exec", "core down (local)", { outcome: "refused", reason: "remote" }),
  at("exec", "core-web down (local)", { outcome: "refused", reason: "x" }),
  at("exec", "shop/web up (local) [r2]"),
];

describe("activityFor", () => {
  it("a repo shows its services' entries and its repo-level refusals", () => {
    expect(activityFor(entries, { repo: "core" }).map((e) => e.detail)).toEqual(
      ["core down (local)", "core/api up (local) [r1]"],
    );
  });

  it("a service shows its own entries and its repo's repo-level refusals", () => {
    expect(
      activityFor(entries, { address: "core/api" }).map((e) => e.detail),
    ).toEqual(["core down (local)", "core/api up (local) [r1]"]);
  });

  it("never matches a repo that merely shares a prefix", () => {
    expect(
      activityFor(entries, { repo: "core" }).some((e) =>
        e.detail.startsWith("core-web"),
      ),
    ).toBe(false);
  });

  it("a refused non-lifecycle call shows for each service it named, and for their repos", () => {
    const refused = [
      ...entries,
      at("logs_search", "out of scope", {
        outcome: "refused",
        reason: "out of scope",
        addresses: ["core/api", "shop/web"],
      }),
      at("logs_tail", "out of scope", {
        outcome: "refused",
        reason: "out of scope",
        addresses: ["core-web/ui"],
      }),
    ];
    const verbs = (t: { address?: string; repo?: string }) =>
      activityFor(refused, t).map((e) => e.verb);
    expect(verbs({ address: "core/api" })).toEqual([
      "logs_search",
      "exec",
      "exec",
    ]);
    expect(verbs({ address: "shop/web" })).toEqual(["logs_search", "exec"]);
    expect(verbs({ repo: "core" })).toEqual(["logs_search", "exec", "exec"]);
    expect(verbs({ address: "core/db" })).toEqual(["exec"]);
  });
});
