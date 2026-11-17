// Every optional export, well-formed (fixture).
export const issue = 410;
export const clauses = ["shows on both engines", "the person allows it"];
export const matrix = { browsers: ["chromium", "webkit"], widths: [1280, 390] };
export const timeoutMs = 60000;
export async function setup() {
  return {};
}
export async function run() {
  return { shown: true };
}
export async function teardown() {}
export function expect(cells) {
  return [
    {
      clause: clauses[0],
      ok: cells.every((c) => c.result.shown),
      evidence: ["shot-1280"],
    },
    { clause: clauses[1], ok: null, skip: "person" },
  ];
}
