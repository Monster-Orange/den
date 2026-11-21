// expect reads a second argument the harness never passes (fixture).
export const issue = 410;
export const clauses = ["a clause"];
export async function setup() {
  return { seen: true };
}
export async function run() {
  return {};
}
export function expect(result, state) {
  return [{ clause: clauses[0], ok: !!state?.seen }];
}
