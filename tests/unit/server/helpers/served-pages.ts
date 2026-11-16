/**
 * The page paths in the server's own route list (route-classes.ts): GET,
 * no parameters, not an API, a page (.html or no extension). Not Den's
 * pages: the test runner's own report and the theme favicon. Shared by
 * the asset-stamp test and the one-URL-per-module browser test.
 */
import { ROUTES } from "../../../../src/ui/server/route-classes.js";

export const SERVED_PAGES: string[] = ROUTES.filter(
  (r) =>
    r.methods.includes("GET") &&
    !/[:*]/.test(r.path) &&
    !r.path.startsWith("/api/") &&
    !r.path.startsWith("/_den/") &&
    (r.path.endsWith(".html") || !/\.[a-z0-9]+$/i.test(r.path)),
)
  .map((r) => r.path)
  .filter((p) => !["/report", "/theme-favicon"].includes(p));
