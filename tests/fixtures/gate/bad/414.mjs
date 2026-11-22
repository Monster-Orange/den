// items over several lines: the bed reads items from the source without loading it (fixture).
export const issue = 414;
// prettier-ignore
export const items = [
  414, 991,
];
export const clauses = ["a clause"];
export async function setup() {}
export async function run() {}
export function expect() {
  return [{ clause: clauses[0], ok: true }];
}
