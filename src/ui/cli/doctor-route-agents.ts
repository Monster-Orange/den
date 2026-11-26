import type { OnboardCheck } from "./doctor-onboard.js";
import { onOff } from "../../shared/gates/rules.js";
import type { GateStore } from "../../shared/gates/store.js";

export function routeAgentsRow(
  store: GateStore,
  cli: string,
): { lines: string[]; check: OnboardCheck | null } {
  const v = store.savedValue("route_agents");
  if (v === undefined || v === null || onOff(v) !== null)
    return { lines: [], check: null };
  const now = store.settings().routeAgents ? "on" : "off";
  const detail = `gate_slots.route_agents is ${JSON.stringify(v)}, neither on nor off, so Den reads it as ${now}. Set it on (1, true, "yes", "on") or off (0, false, "no", "off"): ${cli} gate settings --route-agents 1`;
  return {
    lines: ["", "Agents' routing (gate)", "", `  ⚠  ${detail}`],
    check: { id: "gate_route_agents", status: "warn", detail },
  };
}
