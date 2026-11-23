/**
 * Issue 113 (AGENT-ORG, TUNE-5): the Coach reports asks that skipped a
 * project's lead. Across projects, a message goes to the other project's
 * lead (a persona whose role is lead or orchestrator), who answers or
 * forwards it. An agent that messages another project's member directly,
 * when that project has a lead, gets a `skipped_lead` finding: the sends,
 * the leads they should have gone to, and up to three samples.
 *
 * A send's "to" is a session's name, `<dist>-<project>:<name>` (or a bare
 * name), as SendMessage takes it. A target Den doesn't know (another
 * install's agent) is never counted.
 */
import { describe, expect, it } from "@jest/globals";
import {
  leadSkips,
  targetOf,
  type OrgAgent,
} from "../../../src/shared/coach/lead-skips.js";
import { coachFindings } from "../../../src/shared/coach/findings.js";
import { FINDING_DEFAULTS } from "../../../src/shared/coach/settings.js";
import type { CoachReport } from "../../../src/shared/coach/breakdown.js";
import type { SendSeen } from "../../../src/shared/coach/asks.js";
import { findingWords } from "../../../src/ui/server/public/coach-tab.js";
import { LEAD_ROLES } from "../../../src/shared/agents/lead-roles.js";
import { orgOf } from "../../../src/shared/coach/run.js";
import type { AgentRecord } from "../../../src/shared/agents/records.js";
import { LEAD_ROLES as ROUTING_LEAD_ROLES } from "../../../src/ui/server/lead-routing.js";

const ORG: OrgAgent[] = [
  { id: "a1", name: "Builder", workspace: "web" },
  { id: "b1", name: "Hub Lead", workspace: "hub", role: "lead" },
  { id: "b2", name: "Hub Lane 3", workspace: "hub" },
  { id: "c1", name: "Docs Writer", workspace: "docs" },
  { id: "w2", name: "Web Lane 2", workspace: "web" },
];

const send = (to: string, text = "can you look at this?", at = 1000) =>
  ({ at, to, hash: `${to}|${text}`, text }) as SendSeen;

describe("targetOf: a send's 'to' names one of this Den's agents", () => {
  it("reads <dist>-<project>:<name>, a [ref] suffix, case and an id", () => {
    expect(targetOf("acme-hub:Hub Lane 3", ORG)?.id).toBe("b2");
    expect(targetOf("acme-hub:hub lane 3 [3fa9c1]", ORG)?.id).toBe("b2");
    expect(targetOf("acme-hub:b2", ORG)?.id).toBe("b2");
    // A project name with a dash in it.
    const org = [...ORG, { id: "x1", name: "Lead", workspace: "my-app" }];
    expect(targetOf("acme-my-app:Lead", org)?.id).toBe("x1");
  });

  it("reads a bare name only when one agent has it", () => {
    expect(targetOf("Docs Writer", ORG)?.id).toBe("c1");
    const twice = [...ORG, { id: "c2", name: "Docs Writer", workspace: "web" }];
    expect(targetOf("Docs Writer", twice)).toBeUndefined();
  });

  it("is undefined for an agent Den doesn't know", () => {
    expect(targetOf("other-install:Someone", ORG)).toBeUndefined();
    expect(targetOf("", ORG)).toBeUndefined();
  });
});

describe("leadSkips: cross-project sends that didn't go to the lead", () => {
  it("counts a send to another project's member when that project has a lead", () => {
    const r = leadSkips(
      [
        send("acme-hub:Hub Lane 3"), // skipped hub's lead
        send("acme-hub:Hub Lead"), // to the lead: fine
        send("acme-docs:Docs Writer"), // docs has no lead: fine
        send("acme-web:Web Lane 2"), // its own project: not cross
        send("elsewhere:Stranger"), // unknown: not counted
      ],
      ORG[0],
      ORG,
    );
    expect(r.cross).toBe(3);
    expect(r.skipped.map((s) => s.to)).toEqual(["acme-hub:Hub Lane 3"]);
    expect(r.leads).toEqual({ hub: "Hub Lead" });
  });

  it("a lead messaging another project's member is counted too; within a project never is", () => {
    const lead = { id: "l1", name: "Web Lead", workspace: "web", role: "lead" };
    const org = [...ORG, lead];
    expect(
      leadSkips([send("acme-hub:Hub Lane 3")], lead, org).skipped,
    ).toHaveLength(1);
    expect(leadSkips([send("acme-web:Builder")], lead, org).cross).toBe(0);
  });

  it("uses the same lead roles as Den's ask routing", () => {
    expect([...LEAD_ROLES]).toEqual([...ROUTING_LEAD_ROLES]);
    const orch = ORG.map((a) =>
      a.id === "b1" ? { ...a, role: "orchestrator" } : a,
    );
    expect(
      leadSkips([send("acme-hub:Hub Lane 3")], ORG[0], orch).skipped,
    ).toHaveLength(1);
  });
});

function report(sends: SendSeen[]): CoachReport {
  return {
    ranAt: new Date(10_000).toISOString(),
    window: {
      days: 7,
      from: new Date(0).toISOString(),
      to: new Date(10_000).toISOString(),
    },
    agents: [
      {
        agent: "a1",
        workspace: "web",
        persona: "builder",
        runtime: "den-claude",
        conversations: { inWindow: 1, total: 1, byWhy: {} },
        transcripts: 1,
        asks: {
          metrics: {
            asks: 0,
            asks_unanswered: 0,
            ask_r12_pass_pct: 100,
            ask_wait_min: 0,
            sends: sends.length,
            sends_repeated: 0,
            sends_no_reply: 0,
          },
          stats: { asks: [], sends, received: [] },
        },
      },
    ],
  } as unknown as CoachReport;
}

describe("the skipped_lead finding", () => {
  it("is raised at the line, names the lead, and carries the sends as samples", () => {
    const sends = [
      send("acme-hub:Hub Lane 3", "first", 1000),
      send("acme-hub:Hub Lane 3", "second", 2000),
    ];
    const f = coachFindings(
      report(sends),
      { ...FINDING_DEFAULTS, skipped_lead: 2 },
      ORG,
    );
    const s = f.find((x) => x.kind === "skipped_lead");
    expect(s).toBeDefined();
    expect(s!.id).toBe("skipped_lead:a1");
    expect(s!.evidence).toEqual({ sends_cross: 2, sends_skipped_lead: 2 });
    expect(s!.proposal).toContain("Hub Lead");
    expect(s!.samples?.map((x) => x.text)).toEqual([
      "to acme-hub:Hub Lane 3: first",
      "to acme-hub:Hub Lane 3: second",
    ]);
  });

  it("isn't raised under the line, nor with no org given (a saved report)", () => {
    const sends = [send("acme-hub:Hub Lane 3")];
    const t = { ...FINDING_DEFAULTS, skipped_lead: 2 };
    expect(
      coachFindings(report(sends), t, ORG).some(
        (x) => x.kind === "skipped_lead",
      ),
    ).toBe(false);
    expect(
      coachFindings(report([...sends, ...sends]), t).some(
        (x) => x.kind === "skipped_lead",
      ),
    ).toBe(false);
  });

  it("is on by default: one skipped send is a finding", () => {
    expect(FINDING_DEFAULTS.skipped_lead).toBe(1);
    const f = coachFindings(
      report([send("acme-hub:Hub Lane 3")]),
      FINDING_DEFAULTS,
      ORG,
    );
    expect(f.some((x) => x.kind === "skipped_lead")).toBe(true);
  });

  it("the Coach tab has its words, from its numbers", () => {
    const w = findingWords(
      {
        id: "skipped_lead:a1",
        kind: "skipped_lead",
        agent: "a1",
        evidence: { sends_cross: 4, sends_skipped_lead: 3 },
      },
      { skipped_lead: 1 },
    );
    expect(w).toEqual({
      title: "co.f.skipped_lead.t",
      why: "co.f.skipped_lead.why",
      vars: { agent: "a1", n: 3, m: 4, line: 1 },
    });
  });
});

describe("orgOf: this Den's agents, with who leads", () => {
  const rec = (
    id: string,
    workspace: string,
    more: Partial<AgentRecord> = {},
  ) => ({ id, workspace, persona: "p", ...more }) as AgentRecord;

  it("takes each role from the persona; a stopped agent is a name but leads nothing", () => {
    const org = orgOf(
      [
        rec("b1", "hub", { displayName: "Hub Lead" }),
        rec("b0", "hub", {
          displayName: "Old Lead",
          stoppedAt: "2026-11-01T00:00:00Z",
        }),
        rec("b2", "hub"),
      ],
      (r) => (r.id === "b2" ? undefined : "lead"),
    );
    expect(org).toEqual([
      { id: "b1", workspace: "hub", name: "Hub Lead", role: "lead" },
      { id: "b0", workspace: "hub", name: "Old Lead" },
      { id: "b2", workspace: "hub" },
    ]);
  });

  it("a role lookup that throws leaves that agent with no role", () => {
    const org = orgOf([rec("x", "web")], () => {
      throw new Error("persona file unreadable");
    });
    expect(org).toEqual([{ id: "x", workspace: "web" }]);
  });
});
