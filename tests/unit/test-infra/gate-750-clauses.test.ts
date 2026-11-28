import { describe, expect, it } from "@jest/globals";
import { spawnSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "../../..");
const HUB = "https://hub.example.test/acme";

interface Row {
  clause: string;
  ok: boolean | null;
  detail?: string;
}

const seen = (groupUi: number) => ({
  tag: "chromium-1280",
  groups: {
    switch: [
      ["need", "false"],
      ["project", "false"],
      ["group", "true"],
    ],
    lead: "★Lead: Gate Member",
    leadMark: true,
    nameHref: `${HUB}/groups/g750-group`,
    nameTarget: "_blank",
    sideScroll: false,
  },
  lines: {
    none: {
      note: "groups-hub",
      link: "/settings#agents.hub",
      groupUi,
      byProject: 0,
    },
    unavailable: { note: "groups-plan", link: HUB, groupUi },
    refused: { note: "groups-guest", link: null, groupUi },
  },
});

function rows(result: unknown): Row[] {
  const js = `const g = await import("./gate/750.mjs"); console.log(JSON.stringify(g.expect([{ cell: {}, result: ${JSON.stringify(result)} }])));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", js], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(r.stderr || `exit ${r.status}`);
  return JSON.parse(r.stdout.trim().split("\n").pop()!) as Row[];
}

describe("gate/750.mjs with By need beside By project and By group", () => {
  it("the switch as the 11-27 nightly saw it (By need first, By group pressed) passes the By group row", () => {
    expect(rows(seen(0))[0].ok).toBe(true);
  });

  it("no Hub, the plan and a guest: no group UI passes their rows", () => {
    const r = rows(seen(0));
    expect([r[4].ok, r[5].ok]).toEqual([true, true]);
  });

  it("a group tab or group section left on those pages fails their rows", () => {
    const r = rows(seen(1));
    expect([r[4].ok, r[5].ok]).toEqual([false, false]);
  });

  it("a two-tab switch with no By need fails the By group row", () => {
    const s = seen(0);
    s.groups.switch = s.groups.switch.slice(1);
    expect(rows(s)[0].ok).toBe(false);
  });
});
