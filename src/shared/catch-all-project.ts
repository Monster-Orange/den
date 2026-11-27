/**
 * Den's catch-all project: it holds whatever has no project of its own.
 * Issue 649: Den never links it to a Hub project on its own (Connect,
 * Unclear matches, the bell's pick count, `hub link --suggested`); a
 * person can still link it by hand in Settings › Project setup.
 */
export const CATCH_ALL_PROJECT = "default";

export function isCatchAllProject(key: string): boolean {
  return key === CATCH_ALL_PROJECT;
}
