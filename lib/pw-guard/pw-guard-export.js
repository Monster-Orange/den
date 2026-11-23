/**
 * Issue 1010: `@monster-orange/den/pw-guard`, the box guard for other
 * projects that run browser tests through the gate: what a test box's
 * browser may load (pw-guard.ts) and the run's own ports a "host:*" base
 * URL covers (own-ports.ts). No Playwright dependency: the guard uses its
 * own small shapes.
 *
 * Semver: these names and their behaviour change only in a major version;
 * a new option is a minor; the guard never gets looser in a patch.
 *
 * The published files are lib/pw-guard/, built from this one by
 * `npm run build:pw-guard` (the release packs without scripts, so they
 * are committed; a test checks they match this source).
 */
export { allowedUrl, allowFromEnv, allowOf, checkBaseUrl, connectGuarded, connectOptions, guardBrowser, guardContext, isLoopbackHost, pinLoopbackNames, PW_EXPOSE_ENV, warnBoxExpose, } from "./pw-guard.js";
export { boxOwnPort, ownPorts } from "./own-ports.js";
