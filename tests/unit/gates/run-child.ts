// A child for gate-command.test.ts: `gate run` with the real runner and
// signal handling, in DEN_GATE_DIR, around a long sleep (node itself, no
// suite). Exits with gate run's code. The store sees a quiet fake machine
// (issue 511): a test never reads the real load or PTYs.
import { GateStore } from "../../../src/shared/gates/store.js";
import { cmdGate, realGateDeps } from "../../../src/ui/cli/gate-command.js";
import { FAKE_MACHINE } from "./fake-machine.js";
void cmdGate(
  [
    "run",
    "--kind",
    "browser",
    "--label",
    "sleeper",
    "--",
    process.execPath,
    "-e",
    "console.error('sleeper ' + process.pid); setTimeout(() => {}, 60000)",
  ],
  { ...realGateDeps(), store: new GateStore(FAKE_MACHINE) },
).then((code) => process.exit(code));
