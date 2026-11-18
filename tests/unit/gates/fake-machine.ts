/**
 * Issue 511: a quiet machine for the gate tests. Tests never read the real
 * machine's cores, load or PTYs: they spread this into every GateStore and
 * override what a test is about.
 */
export const FAKE_MACHINE = {
  cores: () => 8,
  loadPerCore: () => 0,
  ptys: () => ({ used: 10, max: 511 }),
};
