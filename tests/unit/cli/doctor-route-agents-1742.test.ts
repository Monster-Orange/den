import { afterAll, describe, expect, it } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GateStore } from "../../../src/shared/gates/store.js";
import { routeAgentsRow } from "../../../src/ui/cli/doctor-route-agents.js";

const root = fs.realpathSync(
  fs.mkdtempSync(path.join(os.tmpdir(), "den-1742-")),
);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let n = 0;
function store(settings?: Record<string, unknown>): GateStore {
  const d = path.join(root, `g${n++}`);
  fs.mkdirSync(d);
  if (settings)
    fs.writeFileSync(path.join(d, "settings.json"), JSON.stringify(settings));
  return new GateStore({ dir: d });
}

describe("doctor: an unclear gate_slots.route_agents", () => {
  it.each([0.5, "maybe", 2, "", [1], { on: true }])(
    "%p: a warning naming the setting, the value, the forms and what Den reads",
    (v) => {
      const r = routeAgentsRow(store({ route_agents: v }), "den");
      expect(r.check).toEqual({
        id: "gate_route_agents",
        status: "warn",
        detail: expect.stringContaining("gate_slots.route_agents"),
      });
      const d = r.check!.detail;
      expect(d).toContain(JSON.stringify(v));
      expect(d).toContain("reads it as on");
      expect(d).toMatch(/on \(1, true, "yes", "on"\)/);
      expect(d).toMatch(/off \(0, false, "no", "off"\)/);
      expect(d).toContain("den gate settings --route-agents");
      expect(r.lines.join("\n")).toContain("⚠");
      expect(r.lines.join("\n")).toContain(d);
    },
  );

  it.each([1, 0, true, false, "yes", "no", " On ", "off"])(
    "%p is clear: no row",
    (v) => {
      expect(routeAgentsRow(store({ route_agents: v }), "den")).toEqual({
        lines: [],
        check: null,
      });
    },
  );

  it("not set, or no settings file: no row", () => {
    expect(routeAgentsRow(store({ cpu_slots: 2 }), "den").check).toBeNull();
    expect(routeAgentsRow(store(), "den").check).toBeNull();
    expect(
      routeAgentsRow(store({ route_agents: null }), "den").check,
    ).toBeNull();
  });

  it("an unreadable settings file: no row, and no throw", () => {
    const s = store();
    fs.writeFileSync(path.join(s.dir, "settings.json"), "{ not json");
    expect(routeAgentsRow(s, "den").check).toBeNull();
  });

  it("the row changes nothing in how the value is read", () => {
    const s = store({ route_agents: 0.5 });
    routeAgentsRow(s, "den");
    expect(s.settings().routeAgents).toBe(true);
    expect(
      JSON.parse(fs.readFileSync(path.join(s.dir, "settings.json"), "utf8")),
    ).toEqual({
      route_agents: 0.5,
    });
  });

  it("doctor shows the row in its report and its text", () => {
    const src = fs.readFileSync(
      path.resolve("src/ui/cli/doctor-command.ts"),
      "utf8",
    );
    expect(src.match(/await routeAgentsRows\(\)/g)?.length).toBe(2);
  });
});
