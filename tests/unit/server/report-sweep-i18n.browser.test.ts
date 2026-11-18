/**
 * Issue 81: the Report sweep (report-sweep-lib.ts) in Spanish and
 * Japanese, Chromium and WebKit, 1440 and 390 px. Not in the smoke set
 * (it would slow every pull request's gate): it runs in the browser
 * shards, and whenever a page changes (it opens no page by name, so the
 * affected-tests map runs it for any page).
 *
 * The demo distribution (helpers/agents-page-server.ts). Invented names.
 */
import { startAgentsPageServer } from "./helpers/agents-page-server.js";
import { reportSweep } from "./report-sweep-lib.js";

reportSweep(["es", "ja"], () => startAgentsPageServer());
