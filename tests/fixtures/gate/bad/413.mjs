// items leaves out its own issue, and names something that is not an issue number (fixture).
export const issue = 413;
export const items = [991, 0];
export const clauses = ["a clause"];
export async function setup() {}
export async function run() {}
export function expect() {
  return [{ clause: clauses[0], ok: true }];
}
