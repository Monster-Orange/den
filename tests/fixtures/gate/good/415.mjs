// A check that also proves another item's clauses names both (fixture).
export const issue = 415;
export const items = [415, 991];
export const clauses = ["a clause"];
export async function setup() {}
export async function run() {}
export function expect() {
  return [{ clause: clauses[0], ok: true }];
}
