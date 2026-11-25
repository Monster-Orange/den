// A child for reap-1132.test.ts: a real `gate run` (cpu) in DEN_GATE_DIR
// around a node command that starts three node workers (sleepers, no
// suite) in its own process group and prints their pids.
//   REAP_MODE=exit      the command exits after starting them
//   REAP_MODE=stay      the command stays
//   REAP_STUBBORN=1     the workers ignore SIGTERM (only KILL ends them)
import { cmdGate } from "../../../src/ui/cli/gate-command.js";

const worker =
  (process.env.REAP_STUBBORN === "1"
    ? "process.on('SIGTERM', () => {});"
    : "") + "setInterval(() => {}, 1000);";
const command = [
  "const { spawn } = require('child_process');",
  `const w = [0, 1, 2].map(() => spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: 'ignore' }));`,
  "console.error('workers ' + process.pid + ' ' + w.map((k) => k.pid).join(','));",
  process.env.REAP_MODE === "exit"
    ? "setTimeout(() => process.exit(0), 300);"
    : "setInterval(() => {}, 1000);",
].join("\n");

void cmdGate([
  "run",
  "--kind",
  "cpu",
  "--label",
  "reaper",
  "--",
  process.execPath,
  "-e",
  command,
]).then((code) => process.exit(code));
