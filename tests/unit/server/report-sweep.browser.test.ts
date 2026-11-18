/**
 * Issue 81: a visible Report on every nav page and in every pop-up the
 * shell opens, in English, Chromium and WebKit, 1440 and 390 px
 * (report-sweep-lib.ts). In the smoke set: every pull request runs it.
 * Spanish and Japanese: report-sweep-i18n.browser.test.ts.
 *
 * The demo distribution (helpers/agents-page-server.ts). Invented names.
 */
import { startAgentsPageServer } from "./helpers/agents-page-server.js";
import { reportSweep } from "./report-sweep-lib.js";

reportSweep(["en"], () => startAgentsPageServer());
