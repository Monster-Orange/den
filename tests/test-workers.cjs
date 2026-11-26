// Issue 1048: jest's worker count. DEN_TEST_WORKERS (a number, or 50%) wins;
// else the gate slot's cap, DEN_GATE_WORKERS (the cores shared by the cpu
// slots); neither set: "" and jest's own default.
function testWorkers(env = process.env) {
  return (
    (env.DEN_TEST_WORKERS ?? "").trim() || (env.DEN_GATE_WORKERS ?? "").trim()
  );
}
module.exports = { testWorkers };
