// A child process for slots.test.ts: asks for a browser slot in DEN_GATE_DIR
// and prints whether it was granted. Holds until killed.
import { GateStore } from "../../../src/shared/gates/store.js";
import { FAKE_MACHINE } from "./fake-machine.js";
// All children ask at the same moment, so a missing lock shows.
const at = Number(process.env.GATE_RACE_AT ?? 0);
while (Date.now() < at) {
  /* wait for the moment */
}
// Issue 511: one browser slot, and never the real machine's numbers.
const e = new GateStore({ ...FAKE_MACHINE, cores: () => 4 }).ask({
  kind: "browser",
  who: `child ${process.pid}`,
  label: "race",
  pid: process.pid,
  estimateMin: 5,
});
process.stdout.write(`${e.grantedAt ? "granted" : "waiting"}\n`);
setInterval(() => {}, 1000);
