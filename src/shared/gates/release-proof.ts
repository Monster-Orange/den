/** Issue 498: whether a tag proves a release-candidate run (red-first stub). */
export type ReleaseProof =
  | { ok: true; tag: string; commit: string; taggedAt: string }
  | { ok: false; error: string };

export function proveReleaseTag(
  _tag: string,
  _repo: string,
  _maxAgeHours: number,
  _now: number,
): ReleaseProof {
  return { ok: false, error: "not built yet" };
}
