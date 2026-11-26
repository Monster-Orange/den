// mo/wall-clock-bound: a test that bounds elapsed real time under 1 s: expect(Date.now() - t0).toBeLessThan(100),
// or the same through a name (const ms = performance.now() - t0; expect(ms).toBeLessThan(200)). Under load such a
// bound fails with nothing wrong.
const NOW = /\b(?:Date|performance)\.now\(\s*\)\s*-/;
const DELTA = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*\b(?:Date|performance)\.now\(\s*\)\s*-[^;\n]*)/g;
// A delta divided into other units (seconds, minutes) has a bound in those units, not ms.
const SCALED = /\)\s*\/\s*[\d_]/;
const BOUND = /\bexpect\(\s*([^;]{1,200}?)\s*\)\s*\.(?:not\.)?toBeLessThan(?:OrEqual)?\(\s*([\d_]+)\s*\)/g;
const LIMIT = 1000;

export function check(src) {
  const deltas = new Set([...src.matchAll(DELTA)].filter((m) => !SCALED.test(m[2])).map((m) => m[1]));
  const hits = [];
  for (const m of src.matchAll(BOUND)) {
    const arg = m[1];
    const timed = (NOW.test(arg) && !SCALED.test(arg)) || deltas.has(arg.trim());
    if (!timed || Number(m[2].replace(/_/g, "")) >= LIMIT) continue;
    const line = src.slice(0, m.index).split("\n").length;
    hits.push({ line, end: line + (m[0].match(/\n/g)?.length ?? 0) });
  }
  return hits;
}
