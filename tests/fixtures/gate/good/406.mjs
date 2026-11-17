// A well-formed live check (fixture for gate-checks.test.ts).
export const issue = 406;
export const clauses = ["two lines with a name"];
export async function setup() {
  return {};
}
export async function run() {
  return { lines: 2 };
}
export function expect(r) {
  return [{ clause: clauses[0], ok: r.lines === 2 }];
}
