// A child for gate-cancel.test.ts: `gate run` with the real runner, in
// DEN_GATE_DIR, around GATE_CHILD_SCRIPT (node itself, no suite). It runs
// as the agent in DEN_AGENT, if any. Exits with gate run's code.
import { cmdGate } from "../../../src/ui/cli/gate-command.js";
void cmdGate([
  "run",
  "--kind",
  "browser",
  "--label",
  "cancelme",
  "--",
  process.execPath,
  "-e",
  process.env.GATE_CHILD_SCRIPT ?? "setTimeout(() => {}, 60000)",
]).then((code) => process.exit(code));
