// A child for gate-command.test.ts: `gate run` with the real runner and
// signal handling, in DEN_GATE_DIR, around a long sleep (node itself, no
// suite). Exits with gate run's code.
import { cmdGate } from "../../../src/ui/cli/gate-command.js";
void cmdGate([
  "run",
  "--kind",
  "browser",
  "--label",
  "sleeper",
  "--",
  process.execPath,
  "-e",
  "console.error('sleeper ' + process.pid); setTimeout(() => {}, 60000)",
]).then((code) => process.exit(code));
