/**
 * The shell (0.3.0-dev.14, rail rebuilt in 0.3.0-dev.17): one top bar and
 * one left rail, the same on every page. A page holds only its content;
 * its markup starts with
 *
 *   <div id="den-shell" data-page="<id>"></div>
 *   <script src="/shell.js"></script>
 *
 * A classic script, run where it stands: the frame is in the DOM before the
 * page's own scripts look for #health, #env-sel, #version-pill or #ws-pill.
 * header.js then drives it (health row, changelog, workspace and env
 * pickers); appearance.js adds ◐ at the end of the bar.
 *
 * The acceptance bar is the shell prototype (den-merge-notes/shell-proto/
 * den-shell.html): its sizes, weights, spacing and states are ported here
 * as they are, its colors mapped onto the theme tokens (--r-btn is
 * --radius-button, --bar-grad is --bar). scripts/shell-fidelity.mjs
 * measures the two side by side.
 *
 *   top bar  ☰ (narrow) · brand mark and title · the scope breadcrumb
 *            (R4, dev.18): / ORG <org> ▾ / WORKSPACE <ws> ▾ / ENV <env> ▾,
 *            each part an .ib button with a .pop menu (an ARIA menu: ↑/↓,
 *            Home, End, Enter; Escape and a click outside close it) ·
 *            the ⌘K search field (R5) · the status chip (R6) · the Runs
 *            chip (R7) · the sudo chip (R8, only while asked) · What's new · ◐ ▾ (R10).
 *            shell.js draws them; topbar.js (through header.js) drives the
 *            chips, the command palette (R17), the status drawer (R15) and
 *            the admin-password prompt; appearance.js the user menu (dev.20).
 *   rail     Pinned, then the NAV registry by GROUPS (Develop, Verify,
 *            Ship, a distribution's own), then Settings and the collapse
 *            toggle. One tab stop (the current page); ↑/↓, Home and End
 *            move within it, Delete unpins a pinned row. Collapsed: icons
 *            only, the headings kept for screen readers. Below 720px it is
 *            a drawer behind ☰.
 *
 * The registries and the scope (window.denShell, the spec's NAV and GROUPS):
 *   registerGroup({ id, label, order, from? })
 *   registerNav({ id, label, icon, group, order, href, badge?(state),
 *                 when?(state) })   a non-number order warns
 *                 (console.warn); a page whose group isn't registered
 *                 waits for it, and warns only if the group is still
 *                 missing a tick after the queue has drained
 *   registerSettingsCategory({ id, label, order, description?, from? })
 *   registerSetting({ id, category, label, description, keywords, scope,
 *                 control, read, write?, keys? })   the SETTINGS registry
 *                 (R21): the Settings page (/settings) draws every row
 *                 from it. scope is "user", "workspace" or "distribution";
 *                 a distribution row is read-only (no write). Any change
 *                 fires `den:settings` on window. Each row is also a ⌘K
 *                 palette command (kind "setting", id "setting:<id>"):
 *                 Enter opens /settings?q=<label>#<category>.
 *   settings(), settingsCategories()  the registry, categories by order
 *   pages()                          every page the rail leads to: NAV,
 *                                    hidden and conditional ones too, then
 *                                    Settings ({ id, href } each)
 *   setNavPrefs({ hidden?, order? }), setPins(ids), setCollapsed(bool)
 *                 Navigation (R21): the rail pages hidden, their order,
 *                 the pins; saved to /api/settings `shell`
 *   addMessages(lang, { key: text }), t(key, vars)
 *   setState(partial): health { repo|address: state }, openLogs, …
 *   pin(id), unpin(id), isPinned(id): pins are user prefs (/api/settings
 *   `shell.pins`), nothing else. Issue 402: a pin is (project or none,
 *   item), made for the project in view (none under All); these read and
 *   change the pins of the project in view, or every pin under All. Any
 *   change fires `den:pins` on window (detail { pins }: the items in
 *   view), and every [data-pin-toggle] repaints from it.
 *   setOrg({ id, title })            one org: a static label, no menu (C4)
 *   setOrgs([{ id, title, workspaces? }], currentId, onSelect?)
 *                                    two or more: the Org ▾ menu; a pick
 *                                    calls onSelect(id), fires `den:org`
 *   setWorkspaces({ label, title, items, focus, names, onSelect })
 *                                    the Workspace ▾ menu (header.js)
 *   workspaceNames()                 every workspace's name, from it
 *   syncEnv()                        repaint Env ▾ from #env-sel
 *   registerCommand({ id, label, keywords?, kind?, run, href? })
 *     href: the page run() goes to, if any; ⌘K's ⌘/Ctrl-Enter opens it
 *     in a new tab (H4)
 *                                    a ⌘K palette row (R17, dev.20). label
 *                                    is a string or a function returning
 *                                    one; keywords a string or an array;
 *                                    kind "action" (the default), "setting"
 *                                    (the Settings registry's rows, dev.19)
 *                                    or any word, shown as the row's kind
 *                                    label. Pages, services and apps are
 *                                    added by the palette itself.
 *   unregisterCommand(id), commands()
 *   openMenu(anchor, menu)           a .pop menu below anchor (the scope
 *                                    parts' and the user menu's)
 *   topLayer.show(el, anchor, opts)  a page's own menu in the top layer
 *                                    (0.4.17), placed by anchor; hide(el)
 *
 * Loading before shell.js: push functions onto window.denShellQueue (an
 * array); each runs with denShell once it exists, and a later push runs at
 * once. `den-shell:ready` fires on window when the shell is up.
 *
 * Every page wraps its content in <main id="den-content">, its one main
 * landmark (the skip link's target). Its one h1 is the page's own (the
 * brand title is a span); a page without one gets a visually hidden h1
 * named from its <title>.
 *
 * data-health-env pins the health row's env on pages that are local by
 * nature (Workspaces, Releases), whatever the env picker says.
 *
 * Every color and font is a theme token.
 */
(function () {
  "use strict";
  // ── i18n (R19, 0.3.0-dev.39) ───────────────────────────────────────────
  // Every word the shell shows is a key in MESSAGES, looked up with
  // t(key, vars). en is here, the fallback for any key a catalog lacks;
  // every other language is a classic script, /i18n/<lang>.js, that the
  // server loads before this one for a page in that language (with
  // <html lang>, ui-language.ts), adding its table to window.denMessages.
  // A page, a plugin or a distribution adds its own keys with
  // denShell.addMessages(lang, table).
  //
  //   {name}       a var; a number is formatted by Intl.NumberFormat
  //   key.one      the plural form t(key, { n }) uses where Intl.PluralRules
  //                says "one" for n (any CLDR category works: key.few, …)
  //
  // Names (services, workspaces, repos, themes, languages), logs and
  // command output are never translated. tests/unit/server/i18n.test.ts
  // fails when a key is missing from any catalog.
  var MESSAGES = (window.denMessages = window.denMessages || {});
  MESSAGES.en = {
    "g.pinned": "Pinned",
    "g.develop": "Develop",
    "g.verify": "Verify",
    "g.ship": "Ship",
    "n.workspaces": "Projects",
    "n.graph": "Graph",
    "n.services": "Services",
    "n.logs": "Logs",
    "n.tests": "Tests",
    // Issue 209: the Verify page (direction C, "Can we ship?").
    "n.verify": "Checks",
    "v.ov_t": "Can we ship?",
    "v.ov_s": "One answer for each environment, in plain words.",
    "v.loading": "Reading the latest results…",
    "v.env_local": "Local",
    "v.env_staging": "Staging",
    "v.env_prod": "Production",
    "v.v_notready": "Not ready",
    "v.v_ready": "Ready",
    "v.v_nothing": "Nothing ran",
    "v.v_notrun": "Not run yet",
    "v.v_partly": "Looks fine, partly checked",
    "v.v_none": "No checks yet",
    "v.a_fail1": "{e} is not ready: {m} failed.",
    "v.a_failn": "{e} is not ready: {n} checks failed.",
    "v.a_blockedonly": "{e} is not ready: {n} checks could not run.",
    "v.a_blockedonly.one": "{e} is not ready: {n} check could not run.",
    "v.a_waiting": "{n} more checks wait on it.",
    "v.a_waiting.one": "{n} more check waits on it.",
    "v.a_nonehere":
      "No check runs on {e} yet, so nothing ran there. This is not a pass.",
    "v.a_nothingran": "Nothing ran on {e} in the last run. This is not a pass.",
    "v.a_notrun": "{e} has not been checked yet.",
    "v.a_partly":
      "{e} looks fine so far: {p} of {n} checks passed. The rest have not run here yet.",
    "v.a_ready": "{e} is ready: all {n} checks passed.",
    "v.a_ready.one": "{e} is ready: {n} check passed.",
    "v.m_agent": "Started by {a} (agent).",
    "v.m_person": "Started by a person.",
    "v.m_allowed": "Allowed by a person.",
    "v.m_allowed_den": "Allowed by Den.",
    "v.m_commit": "Commit {c}.",
    "v.m_when": "Finished {t}.",
    "v.b_why": "See why",
    "v.b_report": "Open report",
    "v.back": "Back to the answer",
    "v.ac_n": "All checks ({n})",
    "v.ac_mod": "Check",
    "v.ac_kind": "Kind",
    "v.dep_on": "needs {l} to pass first",
    "v.k_smoke": "smoke",
    "v.k_synthetic": "synthetic",
    "v.k_security": "security",
    "v.k_performance": "speed",
    "v.k_integration": "integration",
    "v.s_passed": "passed",
    "v.s_failed": "failed",
    "v.s_blocked": "blocked",
    "v.s_error": "error",
    "v.s_none": "not run yet",
    "v.s_off": "doesn't run here",
    "v.fd_t": "Activity",
    "v.fd_none": "No runs yet.",
    "v.actor_agent": "agent",
    "v.actor_person": "person",
    "v.actor_den": "Den",
    "v.who_person": "A person",
    "v.fd_asked": "asked to run {n} checks on {e}.",
    "v.fd_asked.one": "asked to run {n} check on {e}.",
    "v.fd_allowed": "allowed the run on {e}.",
    "v.fd_finished": "Run on {e} finished: {v}.",
    "v.why_t": "Why we think so",
    "v.why_fail": "{m} failed: “{x}”.",
    "v.why_failq": "{m} failed.",
    "v.why_err": "{m} could not run: “{x}”.",
    "v.why_errq": "{m} could not run.",
    "v.why_wait": "These could not run, because they wait on the {l} layer:",
    "v.why_wait_smoke":
      "These could not run, because a smoke check failed first:",
    "v.why_rest": "Everything else here passed: {n} checks.",
    "v.why_rest.one": "Everything else here passed: {n} check.",
    "v.no_report": "This check kept no output to open.",
    "v.em_h": "Add a check",
    "v.em_p": "A check is three lines in a repo's manifest:",
    "v.em_where": "Den reads it the next time you plan a run.",
    "v.old_t":
      "The older test kinds still run on the Tests page while they retire.",
    "v.old_link": "Open Tests",
    "v.err_load": "Verify couldn't load results.",
    "v.retry": "Try again",
    "v.sch_link": "Schedules",
    "v.sch_t": "Schedules",
    "v.sch_s": "Checks that run on their own. Heavy ones run in their window.",
    "v.sch_tz":
      "“When” and “Window” are in this Den's time zone, {z}. Heavy checks run one at a time.",
    "v.sch_when": "When",
    "v.sch_window_h": "Window",
    "v.sch_next_h": "Next",
    "v.sch_last_h": "Last run",
    "v.sch_hourly": "Every hour",
    "v.sch_daily": "Every day at {t}",
    "v.sch_weekly": "{d} at {t}",
    "v.sch_d0": "Sundays",
    "v.sch_d1": "Mondays",
    "v.sch_d2": "Tuesdays",
    "v.sch_d3": "Wednesdays",
    "v.sch_d4": "Thursdays",
    "v.sch_d5": "Fridays",
    "v.sch_d6": "Saturdays",
    "v.sch_any": "Any time",
    "v.sch_night": "At night (22:00 to 06:00)",
    "v.sch_span": "{a} to {b}",
    "v.sch_st_allowed": "Allowed",
    "v.sch_st_free": "No Allow needed",
    "v.sch_st_expiring": "Allow expiring",
    "v.sch_st_paused": "Paused",
    "v.sch_free_code": "Reads code only, so it needs no Allow.",
    "v.sch_free_local": "Runs on local, so it needs no Allow.",
    "v.sch_needs": "It needs an Allow before it runs.",
    "v.sch_needs_h": "Nothing runs until someone allows this schedule.",
    "v.sch_lapsed": "The Allow from {t} lapsed when the plan changed.",
    "v.sch_expired": "The Allow expired on {t}.",
    "v.sch_allow_until": "Allowed until {t}.",
    "v.sch_changed": "The plan changed, so this schedule needs a new Allow.",
    "v.sch_expiring":
      "The Allow expires {t}. When it does, this schedule stops until someone allows it again.",
    "v.sch_code": "Code",
    "v.sch_ro": "read-only",
    "v.sch_ro_h":
      "On production it is read-only: only GET, HEAD and OPTIONS, plus the writes the repo allows in write_allow.",
    "v.sch_never": "Not run yet",
    "v.sch_ask": "Allow this schedule",
    "v.sch_ask_t": "Allow the schedule “{s}” on {e}?",
    "v.sch_ask_h":
      "One Allow covers every run of this plan until it changes or expires on {t}.",
    "v.sch_does": "What each run does",
    "v.sch_mk_enforced": "enforced by Den",
    "v.sch_mk_declared": "declared read-only",
    "v.sch_mk_code": "reads the code only",
    "v.sch_touch_writes": "writes",
    "v.sch_touch_reads": "reads only",
    "v.sch_mk_service": "declared by the service",
    "v.sch_decline": "Decline",
    "v.sch_decline_h":
      "Decline leaves the schedule paused. Nothing runs until someone allows it.",
    "v.sch_revoke": "Take back Allow",
    "v.sch_revoked": "Allow taken back. The schedule waits for a new one.",
    "v.sch_run": "Run now",
    "v.sch_runs": "See runs",
    "v.sch_ch_h": "What changed",
    "v.sch_ch_added": "{m} joined the schedule",
    "v.sch_ch_removed": "{m} left the schedule",
    "v.sch_ch_cmd": "{m}: its command changed",
    "v.sch_ch_writes": "{m} now writes",
    "v.sch_ch_window": "Its window changed",
    "v.sch_ch_cron": "Its times changed",
    "v.sch_missed_h": "Missed while paused",
    "v.sch_sk_allow": "needs an Allow",
    "v.sch_sk_changed": "needs a new Allow",
    "v.sch_sk_expired": "its Allow expired",
    "v.sch_sk_window": "its window closed first",
    "v.sch_sk_busy": "another run was going",
    "v.sch_sk_cmdoff": "commands are off here",
    "v.sch_sk_prodoff": "production schedules are off here",
    "v.sch_sk_often": "it runs too often for production",
    "v.sch_sk_host": "it reaches a host production may not",
    "v.sch_lim_prod_off":
      "Schedules don't run on production here. To turn them on, set this in Den's verify: block:",
    "v.sch_lim_often":
      "This runs on production more often than Den allows. Run it less often, or set the shortest gap in Den's verify: block:",
    "v.sch_lim_host":
      "A production run may not reach these hosts. Add them to verify.schedule.production.hosts, or point the check elsewhere:",
    "v.sch_sk_unclear": "Den couldn't follow its command",
    "v.sch_lim_off":
      "Commands don't run on their own on a shared environment here. To turn them on, set this in Den's verify: block:",
    "v.sch_lim_unclear":
      "Den can't follow this command, so it can't run on its own:",
    "v.sch_empty":
      "No schedules yet. Add {c} to a module to run it on its own.",
    "v.sch_empty_h":
      "A schedule on staging or production asks for an Allow once. Code-only and local schedules run without one.",
    "v.sch_how":
      "Schedules come from {a} in the repo's {b} block. To add, change or remove one, change the repo.",
    "v.sch_started": "Started. Its result comes to the bell.",
    "v.sch_allowed": "Allowed. It runs at its next time.",
    "v.sch_declined": "Declined. The schedule stays paused.",
    "v.sch_err": "That didn't work: {e}",
    // Issue 441: an outside runner's gate results on Checks.
    "v.m_ran": "Ran {a} to {b}.",
    "v.m_runner": "From an outside runner.",
    "v.i_nothing":
      "{t} ran on {e}, but no clause ran there. This is not a pass.",
    "v.i_fail": "{t} on {e} failed: {a}, {b}, {c}.",
    "v.i_pass": "{t} on {e} passed: {a}, {b}, {c}.",
    "v.i_np": "{n} clauses passed",
    "v.i_np.one": "{n} clause passed",
    "v.i_nm": "{n} need a person",
    "v.i_nm.one": "{n} needs a person",
    "v.i_nf": "{n} failed",
    "v.i_nf.one": "{n} failed",
    "v.i_from": "From imported results.",
    "v.i_cfg": "Imported results are off: {e}",
    "v.i_b_failed": "Failed",
    "v.i_b_passed": "Passed",
    "v.i_nchecks": "{n} checks",
    "v.i_nchecks.one": "{n} check",
    "v.i_nclauses": "{n} clauses",
    "v.i_nclauses.one": "{n} clause",
    "v.i_sizes": "{a}, {b}.",
    "v.n_passed": "passed",
    "v.n_failed": "failed",
    "v.n_needs": "needs you",
    "v.n_cantrun": "couldn't run",
    "v.i_failed_h": "Failed ({n})",
    "v.i_cantrun_h": "Couldn't run ({n})",
    "v.i_needs_h": "Needs you ({n})",
    "v.i_needs_p":
      "A check never makes a person's decision. These are yours to try on {e}.",
    "v.i_issue": "issue {n}",
    "v.i_checks_h": "Checks on this tag",
    "v.i_chk": "{p} of {n} clauses passed",
    "v.i_chk.one": "{p} of {n} clause passed",
    "v.i_chk_needs": ", {n} need you",
    "v.i_chk_needs.one": ", {n} needs you",
    "v.i_on": "on {t}",
    "v.i_allran": "Every clause here passed.",
    "v.c_passed": "passed",
    "v.c_failed": "failed",
    "v.c_error": "error",
    "v.c_needs": "Needs you",
    "v.c_cantrun": "couldn't run",
    "v.ct_result": "Result",
    "v.ct_clause": "Clause",
    "v.ct_note": "Note",
    "v.ct_time": "Time",
    "v.t_ms": "{n} ms",
    "v.t_s": "{n} s",
    "v.who_runner": "An outside runner",
    "v.actor_runner": "outside runner",
    "v.fd_imported": "sent its results for {t} on {e}.",
    "n.environments": "Environments",
    "n.releases": "Releases",
    "n.edge": "Edge",
    "n.settings": "Settings",
    // FB (den#81): Report an issue.
    "fb.rail": "Report an issue",
    "fb.tip": "Report an issue (⌘⇧F)",
    "fb.word": "Report",
    "fb.palette": "Report an issue",
    "fb.title": "Report an issue",
    "fb.sub":
      "Tell us what is wrong, or what you wish __DEN_TITLE__ did. It becomes a GitHub issue, filed as you.",
    "fb.step1": "1 Write",
    "fb.step2": "2 Include",
    "fb.step3": "3 Review and send",
    "fb.stepOf": "{i}/{n}",
    "fb.kind": "What is it?",
    "fb.k.bug": "Bug",
    "fb.k.idea": "Idea",
    "fb.k.question": "Question",
    "fb.titleL": "Title",
    "fb.desc": "What happened, and what did you expect?",
    "fb.shot": "Screenshot of this page",
    "fb.ncap":
      "This page couldn't be captured. You can send the report without a screenshot.",
    "fb.shotNote":
      "Includes the open dialog or drawer. Drag on it to black out anything private.",
    "fb.nos": "Don't include a screenshot",
    "fb.undo": "Undo",
    "fb.masks": "{n} areas hidden",
    "fb.masks.one": "{n} area hidden",
    "fb.kbdMask": "Mask by size and position",
    "fb.mx": "Left %",
    "fb.my": "Top %",
    "fb.mw": "Width %",
    "fb.mh": "Height %",
    "fb.addMask": "Add area",
    "fb.maskAll": "Mask the whole screenshot",
    "fb.rmMask": "Remove",
    "fb.area": "{x}% from the left, {y}% from the top, {w}% × {h}%",
    "fb.revShot": "Screenshot after masking ({n} areas hidden)",
    "fb.revShot.one": "Screenshot after masking ({n} area hidden)",
    "fb.mine": "My reports",
    "fb.myS":
      "Shown live from GitHub. It works while you are signed in to GitHub.",
    "fb.tabMine": "Mine",
    "fb.tabDraft": "Drafts from agents ({n})",
    "fb.r3": "Draft: Finish later",
    "fb.r3s": "Saved on this computer · not sent",
    "fb.openL": "Open on GitHub",
    "fb.cont": "Continue",
    "fb.myE": "No reports yet. Press Report on any page to send one.",
    "fb.myOpen": "Open",
    "fb.myClosed": "Closed",
    "fb.myLast": "last reply: “{text}” {when}",
    "fb.myNone": "no replies yet",
    "fb.myNew": "New reply",
    "fb.myNoGh":
      "Sign in to GitHub to see your reports here. Drafts are shown either way.",
    "fb.myBy": "From {agent} · {when}",
    "fb.myAgE": "No drafts from agents.",
    "fb.myLoading": "Loading…",
    "fb.untitled": "(no title)",
    "fb.next": "Next: Include",
    "fb.back": "Back",
    "fb.send": "Send as a GitHub issue",
    "fb.later": "Finish later",
    "fb.cancel": "Cancel",
    "fb.dest": "Goes to",
    "fb.pub": "Public repository",
    "fb.pubW":
      "Screenshots and text are visible to everyone. Mask anything private.",
    "fb.incH": "What goes with your report",
    "fb.incN":
      "Each part says how __DEN_TITLE__ uses it. Secrets, tokens, emails, IP addresses and store references are always removed, whatever is ticked.",
    "fb.all": "Include all",
    "fb.none": "Include none",
    "fb.remember": "Remember my choices",
    "fb.redact":
      "Redact names (companies, projects, repos, services) as <org-1>, <repo-1> …",
    "fb.dgi": "How __DEN_TITLE__ uses this",
    "fb.sec.Den": "__DEN_TITLE__",
    "fb.sec.Browser": "Browser",
    "fb.sec.Machine": "Machine",
    "fb.sec.Page": "Page",
    "fb.use.Den": "Which version you run, to find the change that caused it.",
    "fb.use.Browser": "The browser and window size, to see it as you do.",
    "fb.use.Machine": "The system it runs on, never who or where.",
    "fb.use.Page": "Which page and dialog were open.",
    "fb.revH": "Review: this is exactly what will be posted",
    "fb.siH": "Sign in with GitHub to send",
    "fb.siB":
      "Reports are filed as you, so GitHub's replies reach you. __DEN_TITLE__ shows a code; enter it at github.com/login/device. This is not __DEN_TITLE__'s own sign-in.",
    "fb.noApp":
      "Sending needs GitHub. Save it with Finish later, or file it in a GitHub tab.",
    "fb.open": "Open github.com/login/device",
    "fb.codeL": "Your code",
    "fb.waiting": "Waiting for you to approve in GitHub…",
    "fb.siAlt": "Or open a new GitHub tab with the report filled in.",
    "fb.siAltLink": "Open a filled-in GitHub tab",
    "fb.expired": "The code expired before it was approved. Nothing was sent.",
    "fb.denied": "GitHub sign-in was cancelled. Nothing was sent.",
    "fb.dupH": "A report with this title is already open",
    "fb.dupB":
      "“{title}” is already open. Add your details to it instead of opening a second one?",
    "fb.addTo": "Add to the existing report",
    "fb.fileNew": "File a new report",
    "fb.sentH": "Report sent",
    "fb.sentB": "Your report is a GitHub issue now: “{title}”.",
    "fb.addedB": "Your details were added to the open report.",
    "fb.openIssue": "Open the issue",
    "fb.done": "Done",
    "fb.limH": "You have sent {n} reports this hour",
    "fb.limB":
      "Try again in {min} minutes. Your report is not lost: save it with Finish later and send it then.",
    "fb.latH": "Saved. Nothing was sent.",
    "fb.latB":
      "It is saved on this computer with your text, choices and screenshot. Find it under My reports, at the top of Report an issue or in the command palette.",
    "fb.failH": "Not sent",
    "fb.retry": "Try again",
    "fb.keepH": "Keep what you wrote?",
    "fb.keep": "Keep it (Finish later)",
    "fb.discard": "Discard",
    "fb.needTitle": "A title is needed.",
    "fb.busyPreview": "Making the preview…",
    "fb.busySend": "Sending the report…",
    "fb.busySave": "Saving the report…",
    "fb.busyDone": "Done",
    "fb.busyFailed": "Couldn't reach __DEN_TITLE__. Nothing was sent.",
    "k.org": "Company",
    "k.repoOwner": "Repo owner",
    "k.ws": "Project",
    "k.env": "Env",
    scope: "Scope",
    "org.title": "Org: {title}",
    "org.titleId": "Org: {title} ({id})",
    "ws.all": "All active",
    "ws.focus": "CLI default",
    "ws.hubChip": "Hub: {name}",
    "ws.hubChipCo": "{company} · {name}",
    "ws.hubChipTip": "Connected to {company} ({host}). This project: {name}.",
    "ws.hubAway": "Another Hub",
    "ws.hubAwayTip":
      "This project's link points at another Hub, so it doesn't count here. Relink it in Project setup.",
    "ws.hubUnseen": "Den Hub can't see {n} repos",
    "ws.hubTip":
      "This project's agents file their Hub work in this Hub project. Change it in Project setup.",
    "ws.noServices": "No services in this project yet",
    "ws.focusTip":
      "CLI commands run here when you don't name a project. Picking a project in the top bar also makes it the CLI default.",
    "ws.pickTip":
      "Picking a project here also makes it the CLI default, so __DEN_CLI__ commands run there.",
    "ws.none": "No active projects",
    "pc.title": "Colour for {name}",
    "pc.help":
      "Used for its agents, tabs and the To line. Yours only, never shared. Automatic picks one for you.",
    "pc.auto": "Automatic",
    "pc.autoIs": "Automatic ({colour})",
    "pc.save": "Save",
    "pc.change": "Change colour",
    "pc.changeFor": "Change the colour for {name}",
    "pc.failed": "The colour wasn't saved: {err}",
    "pc.blue": "Blue",
    "pc.teal": "Teal",
    "pc.green": "Green",
    "pc.purple": "Purple",
    "pc.pink": "Pink",
    "pc.gold": "Gold",
    "pc.brown": "Brown",
    "pc.slate": "Slate",
    "set.workspace.colour": "Colour",
    "set.workspace.colour.d":
      "The colour of this project's agents, tabs, To line and top bar chip. Automatic picks one, the same every time; yours only, never shared or sent to Hub.",
    "ws.manage": "Manage projects…",
    "ws.order.az": "Sorted A to Z",
    "ws.order.mine": "Your order",
    "ws.order.reset": "Reset to A to Z",
    "ws.order.help":
      "Drag a row by its handle, or use Move up / Move down in its ⋮ menu. A new project slots in A to Z until you move it.",
    "ws.order.drag": "Drag to reorder",
    "ws.order.up": "Move up",
    "ws.order.down": "Move down",
    "ws.named.hub": "Named in Hub",
    "pname.label": "Project name",
    "pname.hubChip": "Named in Hub",
    "pname.hubHelp":
      "The name comes from Hub. To change it, ask Hub; a person decides there.",
    "pname.localHelp":
      "Shown in Den's header, lists and pages. Link this project to Hub to use Hub's name instead.",
    "pname.save": "Save name",
    "pname.saved": "Saved.",
    "pname.empty": "Enter a name. It can't be empty.",
    "pname.failed": "The name wasn't saved.",
    "pname.offline":
      "Hub can't be reached. Showing the last name Den got from Hub (checked {n} min ago).",
    "pname.offlineNever":
      "Hub can't be reached. Showing the last name Den got from Hub.",
    "pname.retry": "Try again",
    "pname.retryW": "Asking Hub for its names…",
    "pname.retryS": "Hub answered. The name is up to date.",
    "pname.retryF": "Hub still can't be reached.",
    "pname.rename": "Rename…",
    "pname.newName": "New name",
    "pname.ask": "Ask Hub to rename",
    "pname.cancel": "Cancel",
    "pname.askHelp":
      "This sends a held change to Hub. The name here stays as it is until it is approved.",
    "pname.pending": "Rename to “{to}” is waiting for a decision in Hub.",
    "pname.openHub": "Open in Hub",
    "pname.askW": "Asking Hub to rename it to {name}…",
    "pname.askS": "Asked. A person decides it in Hub.",
    "pname.askF": "Hub didn't take the rename. The name is unchanged.",
    "set.workspace.name": "Name",
    "set.ui.rt.toolsComing": "Den tools: coming",
    "set.ui.rt.installed": "installed",
    "set.ui.rt.notInstalled": "Not installed",
    "set.ui.rt.src.workspace": "project",
    "set.ui.rt.src.setting": "global",
    "set.ui.rt.src.login-shell": "detected · login shell",
    "set.ui.rt.src.PATH": "detected · PATH",
    "set.ui.rt.src.well-known": "detected · install directory",
    "set.ui.rt.src.interactive-shell": "detected · interactive shell",
    "set.ui.rt.setPath": "Set path…",
    "set.ui.rt.quarantined": "quarantined, not run",
    "set.ui.rt.alsoFound": "Also found:",
    "set.ui.rt.versionUnknown": "version unknown",
    "set.ui.rt.useThis": "Use this",
    "set.ui.rt.useThisFor": "Use {path} for {name}",
    "set.ui.rt.clear": "Clear",
    "set.ui.rt.pathToIn": "Path to {name} for {ws}",
    "set.ui.rt.pathToAll": "Path to {name} (every project)",
    "set.ui.rt.save": "Save",
    "set.ui.rt.cancel": "Cancel",
    "set.ui.rt.pathsFor": "Paths for",
    "set.ui.rt.everyProject": "every project (user.yml)",
    "set.ui.rt.fixConfig":
      "Fix the config first: the runtimes are read from it.",
    "set.ui.rt.noLoad": "The runtimes did not load.",
    "pj.expand": "Expand the project list",
    "gr.act.autostartOff": "Auto-start: off (turn on)",
    "gr.act.autostartOn": "Auto-start: on (turn off)",
    "gr.act.clone": "Clone",
    "gr.act.cmd": "Run {cmd}",
    "gr.act.copy": "Copy address",
    "gr.act.downDeps": "Stop with dependencies",
    "gr.act.editor": "Open in editor",
    "gr.act.logs": "Logs",
    "gr.act.logsPage": "Open in Logs",
    "gr.act.open": "Visit ↗",
    "gr.act.output": "Show output pane",
    "gr.act.recheck": "Re-check health",
    "gr.act.restart": "Restart",
    "gr.act.start": "Start",
    "gr.act.stop": "Stop",
    "gr.act.syncFull": "Sync (down, pull, setup)",
    "gr.act.terminal": "Terminal in repo",
    "gr.act.upDeps": "Start with dependencies",
    "gr.act.useLocal": "Use my local checkout",
    "gr.act.useManaged": "Use a managed clone",
    "gr.add": "Add",
    "gr.bar": "Graph view options",
    "gr.cardLabel": "{name} in {repo}, {status}. Open details.",
    "gr.cardLabelRemote":
      "{name} in {repo}, {status}, runs remotely. Open details.",
    "gr.cards": "Cards",
    "gr.cards.compact": "Compact",
    "gr.cards.detailed": "Detailed",
    "gr.checkedN": "Checked {n} services",
    "gr.checkedOne": "Checked {id}",
    "gr.closeDetails": "Close details",
    "gr.collapse": "Collapse",
    "gr.collapseAll": "Collapse all",
    "gr.confirm": "Confirm: {label}",
    "gr.copied": "Copied {id}",
    "gr.dependsOn": "Depends on",
    "gr.details": "Details",
    "gr.dir.down": "Top-down",
    "gr.dir.right": "Left-right",
    "gr.dock": "Dock as side panel",
    "gr.expand": "Expand",
    "gr.expandAll": "Expand all",
    "gr.find": "Find",
    "gr.findPh": "service, repo…",
    "gr.fit": "Fit",
    "gr.group": "Group",
    "gr.group.app": "Application",
    "gr.group.owner": "Repo owner",
    "gr.group.org": "Company",
    "gr.grp.commands": "Manifest commands",
    "gr.grp.common": "More actions",
    "gr.grp.danger": "Careful",
    "gr.grp.tools": "Tools",
    "gr.h.checking": "checking…",
    "gr.h.none": "no health check",
    "gr.h.notChecked": "not checked",
    "gr.h.reachable": "reachable",
    "gr.h.unreachable": "unreachable",
    "gr.inProjects": "{id}: in {list}",
    "gr.k.application": "Application",
    "gr.k.branch": "Branch",
    "gr.k.check": "Check",
    "gr.k.healthCheck": "Health check",
    "gr.k.logsFrom": "Logs from",
    "gr.k.manifest": "Manifest",
    "gr.k.mode": "Mode",
    "gr.k.onDisk": "On disk",
    "gr.k.opens": "Opens",
    "gr.k.placement": "Placement",
    "gr.k.repo": "Repo",
    "gr.k.role": "Role",
    "gr.k.services": "Services",
    "gr.k.starts": "Starts",
    "gr.k.status": "Status",
    "gr.layout": "Layout",
    "gr.lg.click": "click a card for details",
    "gr.lg.cross": "local → remote",
    "gr.lg.event": "event",
    "gr.lg.hard": "hard dependency",
    "gr.lg.intra": "within a repo",
    "gr.lg.soft": "soft",
    "gr.location": "Location",
    "gr.log.ended": "The log stream ended.",
    "gr.log.filter": "Filter log lines",
    "gr.log.filterPh": "Filter lines",
    "gr.log.pause": "Pause",
    "gr.log.resume": "Resume",
    "gr.log.waiting": "Waiting for log lines…",
    "gr.log.wrap": "Wrap",
    "gr.max": "Maximize graph",
    "gr.maxTip": "Maximize graph (F)",
    "gr.missingTip": "Missing: {list}",
    "gr.missingWhy": "Declared but not in this project.",
    "gr.more": "More",
    "gr.n.loading": "Loading…",
    "gr.n.noActivity":
      "No actions yet. Starts, restarts and syncs, yours and agents', show here.",
    "gr.n.noneDeclared": "none declared",
    "gr.n.noneFound": "none found",
    "gr.n.noneRemote": "none here: it runs remotely",
    "gr.n.nothing": "nothing",
    "gr.n.nothingHere": "nothing in this project",
    "gr.n.ownLog": "the service's own log file",
    "gr.n.remoteEnv": "the remote env",
    "gr.n.unknown": "unknown",
    "gr.noElk":
      "The graph layout library did not load. Reload the page; if it persists, reinstall {cli}.",
    "gr.notClonedYet": "not cloned yet: Sync clones it",
    "gr.okOf": "{ok}/{n} healthy",
    "gr.pinX": "Pin {s}",
    "gr.pl.allLocal": "all local",
    "gr.pl.allRemote": "all remote",
    "gr.pl.hybrid": "hybrid",
    "gr.pl.hybridList": "hybrid: {list}",
    "gr.pl.local": "local",
    "gr.pl.none": "no runtime",
    "gr.pl.remote": "remote",
    "gr.pl.svcRuns": "{name} {runs}",
    "gr.popout": "Expand to pop-up",
    "gr.project": "Project",
    "gr.refused": "refused: {reason}",
    "gr.remoteEnv": "a remote env",
    "gr.remoteNote":
      "Runs in {env}. Start, stop and logs happen there, not on this machine.",
    "gr.remoteNoteAcct":
      "Runs in {env} · {account}. Start, stop and logs happen there, not on this machine.",
    "gr.remoteWhy": "runs in {env}; nothing to start here",
    "gr.remoteWhyAcct": "runs in {env} ({account}); nothing to start here",
    "gr.repoDetails": "Repo details",
    "gr.repoLabel":
      "{repo}, {status}, {n} services, {ok} healthy. Open details.",
    "gr.repos": "{n} repos",
    "gr.repos.one": "{n} repo",
    "gr.resize": "Drag to resize",
    "gr.restoreTip": "Restore (Esc)",
    "gr.role.entry": "entry point",
    "gr.role.infra": "infrastructure",
    "gr.role.service": "service",
    "gr.roll.awaiting": "unknown (still checking)",
    "gr.roll.okExtra": "healthy, {extra}",
    "gr.roll.redirect": "{n} redirect",
    "gr.roll.state": "{state} ({down} down)",
    "gr.roll.unchecked": "{n} not checked",
    "gr.roll.unknown": "unknown (not checked)",
    "gr.roll.unknownWhy": "unknown ({why})",
    "gr.run": "Run",
    "gr.runs.local": "local",
    "gr.runs.none": "none",
    "gr.runs.remote": "remote",
    "gr.sec.about": "About",
    "gr.sec.aboutRepo": "About",
    "gr.sec.commands": "Commands",
    "gr.sec.connections": "Connections",
    "gr.sec.health": "Health",
    "gr.sec.healthRoll": "Health",
    "gr.sec.missing": "Missing dependencies",
    "gr.sec.source": "Where it comes from",
    "gr.services": "{n} services",
    "gr.st.down": "down",
    "gr.st.healthy": "healthy",
    "gr.st.unknown": "unknown",
    "gr.starts.auto": "with the project",
    "gr.starts.demand": "on demand (auto-start off)",
    "gr.state.degraded": "degraded",
    "gr.state.down": "down",
    "gr.state.ok": "ok",
    "gr.state.unknown": "unknown",
    "gr.tab.activity": "Activity",
    "gr.tab.config": "Config",
    "gr.tab.logs": "Logs",
    "gr.tab.overview": "Overview",
    "gr.tab.services": "Services",
    "gr.tag.entry": "entry",
    "gr.tag.infra": "infra",
    "gr.tag.missing": "missing",
    "gr.tag.notCloned": "not cloned",
    "gr.unpinX": "Unpin {s}",
    "gr.usedBy": "Used by",
    "gr.vp":
      "Service graph. Drag to pan, scroll to move, Ctrl or Cmd + scroll to zoom.",
    "gr.who.agent": "agent",
    "gr.who.you": "you",
    "gr.who.youVia": "you · {client} (unverified)",
    "gr.zoom": "Zoom",
    "gr.zoomIn": "Zoom in",
    "gr.zoomOut": "Zoom out",
    "gr.zoomReset": "Reset zoom to 100%",
    "term.input": "Terminal input",
    "term.tooMuch":
      "Too much output to announce, navigate to rows manually to read",
    "pj.title": "Projects",
    "pj.collapse": "Collapse the project list",
    "pj.loading": "Loading…",
    "pj.newPh": "new-project",
    "pj.newLabel": "New project's name",
    "pj.delete": "Delete",
    "pj.activeTag": "(active)",
    "pj.openTerm": "Open in terminal",
    "pj.openEditor": "Open in editor",
    "pj.moreActions": "More actions",
    "pj.moreFor": "More for {ws}",
    "pj.deactivate": "Deactivate",
    "pj.activate": "Activate",
    "pj.rename": "Rename",
    "pj.activateFirst": "Activate this project first",
    "pj.noManaged": "No managed services in this project",
    "pj.active": "active",
    "pj.makeDefault": "Make CLI default",
    "pj.deactivateLc": "deactivate",
    "pj.activateLc": "activate",
    "pj.activateDefault": "activate + make CLI default",
    "pj.openGraph": "Open in Graph →",
    "pj.moreProject": "More for this project",
    "pj.setup": "Project setup",
    "pj.renameDots": "Rename…",
    "pj.deleteDots": "Delete…",
    "pj.project": "Project",
    "pj.up": "Up",
    "pj.down": "Down",
    "pj.restart": "Restart",
    "pj.setupBtn": "Setup",
    "pj.sync": "Sync",
    "pj.addService": "Add Service",
    "pj.find": "Find",
    "pj.findPh": "repo, service…",
    "pj.groupBy": "Group by",
    "pj.group.none": "None",
    "pj.group.app": "Application",
    "pj.group.owner": "Repo owner",
    "pj.group.org": "Company",
    "pj.reposIn": "Repos in {ws}",
    "pj.th.repo": "Repo",
    "pj.th.health": "Health",
    "pj.th.branch": "Branch",
    "pj.th.mode": "Mode",
    "pj.th.lastRun": "Last test run",
    "pj.th.actions": "Actions",
    "pj.addRepo": "Add repo",
    "addSvc.title": "Add Service: {ws}",
    "addSvc.filter": "Filter repos",
    "addSvc.filterPh": "Filter repos…",
    "addSvc.tab.local": "Local",
    "addSvc.tab.gh": "GitHub",
    "addSvc.sortBy": "Sort by",
    "addSvc.sort.name": "Name",
    "addSvc.sort.project": "Project",
    "addSvc.loading": "Loading…",
    "addSvc.noLocal": "No repos found on this machine",
    "addSvc.noResults": "No repos match",
    "addSvc.added": "added",
    "addSvc.group.dev": "Dev-managed",
    "addSvc.group.managed": "Managed by __DEN_TITLE__",
    "addSvc.ghLoading": "Loading GitHub repos…",
    "addSvc.ghNoMatch": "No repos match “{q}”",
    "addSvc.ghNone": "No GitHub repos found",
    "addSvc.noManifest": "no manifest",
    "addSvc.group.supported": "Ready for __DEN_TITLE__",
    "addSvc.group.unsupported": "No __DEN_MANIFEST_YML__",
    "addSvc.refresh": "Refresh",
    "addSvc.refreshTip": "Fetch the GitHub repo list again",
    "addSvc.refreshing": "Refreshing…",
    "addSvc.manage": "Manage",
    "addSvc.mode.dev": "Dev-managed",
    "addSvc.mode.managed": "Managed",
    "addSvc.branch": "Branch",
    "addSvc.newBranch": "New branch",
    "addSvc.optional": "optional",
    "addSvc.add": "Add",
    "addSvc.done": "✓ Added {name}",
    "addSvc.doneSetup": "✓ Added {name} · setup is running (see Logs)",
    "addSvc.missingDeps": "Missing dependencies: {deps}",
    "pj.validate.title": "Validate a manifest",
    "pj.validate.path": "Path or dir",
    "pj.validate.pathPh": "/absolute/path/to/repo  or  /path/to/{file}",
    "pj.validate.go": "Validate",
    "pj.validate.paste": "…or paste {file} content here",
    "pj.checking": "checking…",
    "pj.noRuntime": "no runtime",
    "pj.noRuntimeTip":
      "This repo runs nothing: nothing to start or health-check. Agents can work in it.",
    "pj.checkingTip": "waiting for the first health check",
    "pj.noUp": "{id} has no up command",
    "pj.start": "Start",
    "pj.startX": "Start {id}",
    "pj.stop": "Stop",
    "pj.stopX": "Stop {id}",
    "pj.restartX": "Restart {id}",
    "pj.logs": "Logs",
    "pj.logsX": "Logs of {id}",
    "pj.useLocalX": "{repo}: use local",
    "pj.useManagedX": "{repo}: use managed",
    "pj.useLocal": "use local",
    "pj.useManaged": "use managed",
    "pj.mode.dev-managed": "dev-managed",
    "pj.mode.managed": "managed",
    "set.ui.justNow": "just now",
    "set.ui.minAgo": "{n} min ago",
    "set.ui.hAgo": "{n} h ago",
    "set.ui.dAgo": "{n} d ago",
    "set.ui.viaGithubAs": "signed in with GitHub (@{login})",
    "set.ui.viaGithub": "signed in with GitHub",
    "set.ui.viaCode": "approved with a code",
    "set.ui.viaAgentView": "{agent}'s read-only view",
    "set.ui.viaClaim": "claimed with a setup link",
    "set.ui.viaLink": "signed in with a one-time link",
    "set.ui.unknownBrowser": "Unknown browser",
    "set.ui.deviceOn": "{browser} on {os}",
    "set.ui.aBrowserOn": "A browser on {os}",
    "set.ui.tzBrowser": "Your browser's ({zone})",
    "set.ui.created": "created {ago}",
    "set.ui.fromAt": "from {from} ({name})",
    "set.ui.lastSeen": "last seen {ago}",
    "set.ui.ownerIs": "Owner:",
    "set.ui.unlink": "Unlink",
    "set.ui.noOwner": "This Den has no owner identity yet.",
    "set.ui.linkGithub": "Link your GitHub account", // words-ok: moved word for word into the catalog (0.4.45)
    "set.ui.noClient":
      "Linking needs a GitHub App client id, and none is configured: set {key} in config/local/user.yml, then restart the server.", // words-ok: moved word for word into the catalog (0.4.45)
    "set.ui.linkFailed": "Linking failed. Try again.",
    "set.ui.noAnswer": "The server didn't answer. Try again.", // words-ok: moved word for word into the catalog (0.4.45)
    "set.ui.enterCode":
      "Enter this code at {link} and approve the app. It asks for no permissions.",
    "set.ui.openGithub": "Open GitHub",
    "set.ui.waitingGithub": "Waiting for GitHub…",
    "set.ui.ownerSignedIn": "The owner can only be shown signed in.",
    "set.ui.noDevices":
      "No linked devices. A browser that signs in with GitHub, is approved with a code, or opens a one-time link appears here.",
    "set.ui.thisDevice": "This device",
    "set.ui.revoke": "Revoke",
    "set.ui.signOutAll": "Sign out everywhere",
    "set.ui.signOutAllB":
      "This signs out every browser and phone, including this one. Each signs in again the usual way.",
    "set.ui.signOutRotate":
      "Also replace the sign-in secret. Running agents stop until they are restarted.",
    "set.ui.signOutAllW": "Signing out everywhere…",
    "set.ui.signOutAllF": "Not signed out",
    "set.ui.signOutAllDone": "Signed out everywhere",
    "set.ui.devicesSignedIn": "The devices can only be listed signed in.",
    "set.ui.asked": "asked {ago}",
    "set.ui.appKeyAllow": "Allow it in the dialog.",
    "set.ui.appKeyAgent": "Agent",
    "set.ui.appKeyOrigin": "Web app",
    "set.ui.appKeyLabel": "Name (optional)",
    "set.ui.appKeyMake": "Make key",
    "set.ui.appKeyNoOrigin": "Add the web app to the list above first.",
    "set.ui.appKeyNone": "No app keys yet.",
    "set.ui.appKeyUsed": "last used {when}",
    "set.ui.appKeyUnused": "never used",
    "set.ui.appKeyRevoked": "revoked {when}",
    "set.ui.appKeyRevoke": "Revoke",
    "set.ui.runnerNone": "No runner tokens yet.",
    "set.ui.boxName": "Name",
    "set.ui.boxSsh": "ssh (login@host)",
    "set.ui.boxPort": "ssh port",
    "set.ui.boxKey": "ssh key file",
    "set.ui.boxPw": "Playwright address (ws://)",
    "set.ui.boxSlots": "Browser slots",
    "set.ui.boxHold": "Hold file (on the box)",
    "set.ui.boxScale": "Time scale",
    "set.ui.boxSave": "Save box",
    "set.ui.boxMem": "Keep free memory (MB)",
    "set.ui.boxPwv": "Playwright version on the box",
    "set.ui.boxPwsEx": "1.61=ws://box:3931, 1.63=ws://box:3932",
    "set.ui.boxPws": "Or Playwright by version (1.61=ws://…, 1.63=ws://…)",
    "set.ui.boxNone": "No test boxes. Browser runs use this machine only.",
    "set.ui.boxSlotsN": "{n} browser slots",
    "set.ui.boxHoldIs": "hold file {path}",
    "set.ui.boxScaleIs": "time ×{n}",
    "set.ui.boxRemove": "Remove",
    "set.ui.boxWindow": "Window (this machine's time)",
    "set.ui.boxRecheck": "Recheck after, in seconds",
    "set.ui.boxOn": "On",
    "set.ui.boxWindowIs": "{window}, this machine's time",
    "set.ui.boxIsOff": "turned off",
    "set.ui.boxTurnOn": "Turn on",
    "set.ui.boxTurnOff": "Turn off",
    "set.ui.reRepo": "Repo (owner/name)",
    "set.ui.reBox": "Test box",
    "set.ui.reLabels": "Runner labels (comma-separated)",
    "set.ui.reVar": "Routing variable",
    "set.ui.reSlots": "At a time",
    "set.ui.reHeavy": "Takes the box's heavy slot",
    "set.ui.reOwner": "Who answers for it",
    "set.ui.reSave": "Save entry",
    "set.ui.reNone": "No runner entries. CI jobs use hosted runners.",
    "set.ui.reNoBox": "Set a test box first, under Test boxes.",
    "set.ui.reHeavyIs": "heavy",
    "set.ui.reLightIs": "light",
    "set.ui.reSlotsN": "{n} at a time",
    "set.ui.reVarIs": "variable {v}",
    "set.ui.reOwnerIs": "owner {who}",
    "set.ui.appKeyOnce":
      "Copy this key into the web app's backend now. It is not shown again.",
    "set.ui.appKeyNew": "New app key",
    "set.ui.copy": "Copy",
    "set.ui.saveOrigins": "Save list",
    "set.ui.approve": "Approve",
    "set.ui.deny": "Deny",
    "set.ui.codeLabel": "Code on its screen",
    "set.ui.fromLogin": "from the web login run at {time}",
    "set.ui.noWaiting":
      "No computers are waiting. A signed-out page on another computer shows a code; it appears here to approve.",
    "set.ui.waitingSignedIn":
      "Waiting devices can only be listed signed in, or on this machine.",
    "set.ui.testInstallYes": "This is a test install.",
    "set.ui.testInstallNo":
      "Not a test install. Live checks can't sign in here. A person marks a test install by hand in the distribution config (web.test_install: true).",
    "set.ui.testPersonReady": "The test person is set up.",
    "set.ui.testPersonMissing": "The test person isn't set up yet.",
    "set.ui.testInstallsNone":
      "No test install on this computer is waiting for its test person.",
    "set.ui.testInstallsOne": "{where} (test install {id})",
    "set.ui.testInstallsSignedIn":
      "Only the signed-in person sees the test installs on this computer.",
    "set.ui.testPersonSetUp": "Set up test person",
    "set.ui.testInstallSignedIn":
      "The test install can only be read signed in, or on this machine.",
    "set.ui.noPairHost":
      "No edge hostname routes to __DEN_TITLE__, so there is no address another device could open. Add one to the config's edge block (edge.aliases for a VPN name), then use the button below: it starts the edge, or applies the change to the one running. {cmd}",
    "set.ui.edgeStart": "Start the edge",
    "set.ui.edgeApply": "Apply",
    "set.ui.edgeStarted": "Edge started",
    "set.ui.edgeCurrent": "Edge up to date, nothing restarted",
    "set.ui.edgeRecreated":
      "Edge recreated because {why}; it was unreachable for about {s} s",
    "set.ui.edgeWhy": "its settings changed",
    "set.ui.edgeHost": "Edge hostname",
    "set.ui.pairScan":
      "Scan it with the other device, or open the link there. It works once, until it expires (below), and signs that browser in for good.",
    "set.ui.expiresIn": "Expires in {s} s.",
    "set.ui.pairExpired": "This link expired. Pair again for a new one.",
    "set.ui.pairSignedIn": "Pairing works only signed in.",
    "set.ui.themeUnset": "{name} (not set: Den's own)",
    "set.ui.notSet": "not set",
    "set.ui.terminalTag": "terminal",
    "set.ui.notFound": "not found",
    "set.ui.off": "Off",
    "set.ui.on": "On",
    "set.ui.nLines": "{n} lines",
    "set.ui.portUnset": "Not set: the distribution's applies",
    "set.ui.signedIn": "Signed in",
    "set.ui.signOut": "Sign out",
    "set.ui.notSignedIn": "Not signed in",
    "set.ui.signIn": "Sign in",
    "set.ui.savedIn": "Saved in {vault}",
    "set.ui.theVault": "the vault",
    "set.ui.savedMemory": "Held in memory until Den restarts",
    "set.ui.notSaved": "Not saved",
    "set.ui.forget": "Forget",
    "set.ui.none": "none",
    "set.ui.portDefault": "not set ({port})",
    "set.ui.envsAll": "not set: all",
    "set.ui.rot.auto": "Auto",
    "set.ui.rot.ask": "Ask",
    "set.ui.rot.relaunch": "Relaunch",
    "set.ui.rot.keep": "Keep going",
    "set.ui.rot.org": "org config: {v}", // words-ok: moved word for word into the catalog (0.4.45)
    "set.ui.rot.default": "default: {v}",
    "set.ui.rot.install": "this install",
    "set.ui.rot.inherit": "inherit ({v})",
    "set.ui.rot.thScope": "Scope",
    "set.ui.rot.thFor": "For",
    "set.ui.rot.gone": "{name} (gone)",
    "set.ui.rot.thSetting": "Setting",
    "set.ui.rot.thValue": "Value",
    "set.ui.rot.remove": "Remove",
    "set.ui.rot.clear": "Clear",
    "set.ui.save": "Save",
    "set.ui.rot.caption": "Overrides (the most specific wins)",
    "set.ui.rot.thActions": "Actions",
    "set.ui.rot.none": "No overrides: every agent uses this install's values.",
    "set.ui.rot.findAgent": "Type to find an agent",
    "set.ui.rot.findPersona": "Type to find a persona",
    "set.ui.rot.findProject": "Type to find a project",
    "set.ui.rot.findService": "Type to find a service",
    "set.ui.rot.never": "never",
    "set.ui.rot.add": "Add override",
    "set.ui.hub.badConfig": "hub in user.yml is not valid",
    "set.ui.hub.addrNotUrl":
      "That isn't a web address. It starts with https://",
    "set.ui.hub.addrHttps":
      "Hub's address must start with https:// (http:// only for this machine).",
    "set.ui.hub.save": "Save",
    "set.ui.hub.clear": "Clear",
    "set.ui.hub.saveNote":
      "Save keeps it in your settings and restarts Den. Clear disconnects; agents lose Hub's tools when they next restart.",
    "set.ui.hub.empty":
      "No Hub yet. Type your company's Hub address, then Connect. Save only keeps the address.",
    "set.ui.hub.saved": "Saved. Den restarted with Hub's new address.",
    "set.ui.hub.cleared": "Cleared. Den restarted without Hub.",
    "set.ui.hub.address": "Hub's address",
    "set.ui.hub.connect": "Connect",
    "set.ui.hub.connectLinks":
      "After Connect, each project here shows its suggested Hub project. Check them, then press Connect and link all.",
    "set.ui.hub.connectNote":
      "Connect opens Hub. Sign in there and approve this install; you come back here connected. The token is kept in this install's secrets store, never shown.",
    "set.ui.hub.teams": "a shared Hub at {host}.",
    "set.ui.hub.ent":
      "your own isolated runtime, at your own domain or a unique subdomain on {domain}.",
    "set.ui.hub.talk": "Talk to us",
    "set.ui.hub.connected": "Connected",
    "set.ui.hub.rejected": "Token not accepted",
    "set.ui.hub.forbidden": "Not allowed",
    "set.ui.hub.unreachable": "Can't reach Hub",
    "set.ui.hub.notConnected": "Not connected",
    "set.ui.hub.status": "Status",
    "set.ui.hub.company": "Company",
    "set.ui.hub.role": "Role",
    "set.ui.hub.signedInAs": "Signed in as",
    "set.ui.hub.thisInstall": "This install",
    "set.ui.hub.whyRejected":
      "Hub no longer accepts this install's token (revoked or expired). Reconnect signs you in again.",
    "set.ui.hub.whyForbidden":
      "Your role on Hub no longer allows connecting installs. Ask a Hub admin to change your role, then Reconnect.",
    "set.ui.hub.noAnswer": "Hub didn't answer.",
    "set.ui.hub.tools": "Agents use Hub's tools without asking",
    "set.ui.hub.toolsOn":
      "Agents can publish and comment in Hub without asking; writes are versioned and stay in this install's team.", // words-ok: moved word for word into the catalog (0.4.45)
    "set.ui.hub.toolsOff": "Agents ask before each Hub tool runs.",
    "set.ui.hub.disconnect": "Disconnect",
    "set.ui.hub.disconnectWarn":
      "This revokes this Den's Hub key on Hub. Agents lose Hub until you Connect again.",
    "set.ui.cancel": "Cancel",
    "set.ui.rot.fixConfig":
      "Fix the config first: the org's rotation is read from it.", // words-ok: moved word for word into the catalog (0.4.45)
    "set.ui.rot.loadFailed": "The rotation settings did not load.",
    "set.ui.rot.pickPW": "Pick a persona and a project.",
    "set.ui.countNone": "No settings match",
    "set.ui.count": "{n} settings match",
    "set.ui.count.one": "{n} setting matches",
    "set.ui.scopeDist": "Distribution · read-only",
    "set.ui.scopeWs": "Project setup · {ws}",
    "set.ui.scopeWsNone": "Project setup",
    "set.ui.scopeUser": "User",
    "set.ui.noMatch": "No settings match “{q}”.",
    "set.ui.clearSearch": "Clear search",
    "set.ui.project": "Project",
    "set.ui.pickProject":
      "You view All active: pick the project these are for.",
    "set.ui.noActive": "No active projects.",
    "set.ui.swatches": "The theme's colors",
    "set.ui.inherit": "Default (inherit)",
    "set.ui.moveUp": "Move {name} up",
    "set.ui.moveDown": "Move {name} down",
    "set.ui.unpinX": "Unpin {name}",
    "set.ui.noPins": "Nothing pinned",
    "set.ui.setByIn": "Set by the distribution in {file}.",
    "set.ui.setBy": "Set by the distribution in its config.",
    "set.ui.showX": "Show {name}",
    "set.ui.hideX": "Hide {name}",
    "set.ui.show": "Show",
    "set.ui.hide": "Hide",
    "set.ui.noProject": "No project",
    "set.ui.default": "Default",
    "set.ui.saved": "✓ Saved",
    "set.ui.saveFailed": "✗ Save failed",
    "set.ui.loadFailed": "Settings did not load.",
    "set.ui.reload": "Reload to try again.",
    "set.ui.matching": "{n} matching",
    "set.ui.from": "from {from}",
    "set.ui.sub":
      "Saved to your __DEN_TITLE__ preferences and remembered on every page",
    "set.ui.search": "Search settings",
    "set.ui.slashTip": "Press / to search",
    "set.ui.cats": "Settings categories",
    "set.ui.rot.scope.agent": "Agent",
    "set.ui.rot.scope.persona-workspace": "Persona in a project",
    "set.ui.rot.scope.persona": "Persona",
    "set.ui.rot.scope.workspace": "Project",
    "set.ui.rot.scope.service": "Service",
    "set.ui.rot.key.after_compactions": "After compactions",
    "set.ui.rot.key.on_due": "When due",
    "set.ui.rot.key.on_pr_merged": "When its PR merges",
    "set.ui.rot.pick.agent": "Pick an agent.",
    "set.ui.rot.pick.persona": "Pick a persona.",
    "set.ui.rot.pick.workspace": "Pick a project.",
    "set.ui.rot.pick.service": "Pick a service.",
    "setc.appearance": "Appearance",
    "setc.appearance.d": "Mode follows your system unless you pick one.",
    "setc.editor": "Editor & terminal",
    "setc.editor.d":
      "Where ↗ opens a repository and >_ opens a terminal to a service.",
    "setc.navigation": "Navigation",
    "setc.navigation.d":
      "Hide pages you never use and choose their order. Pins sit at the top of the rail.",
    "setc.graph": "Graph",
    "setc.graph.d":
      "How the graph is laid out, and how the Projects page shows its projects. The pages' own controls set these too.",
    "setc.workspace": "Project setup",
    "setc.workspace.d":
      "Settings for one project. They follow the project you view in the top bar.",
    "setc.agents": "Agents",
    "setc.agents.d":
      "The runtimes agents run on, installed first. Paths you set are this machine's only: everywhere (config/local/user.yml) or for one project (config/local/workspaces.yml), which wins.",
    "setc.access": "Access",
    "setc.access.d":
      "Reach this Den from your other devices: sign in with GitHub as its owner, or pair a device with a one-time link. On localhost nothing asks.",
    "setc.embed": "Embedding",
    "setc.embed.d":
      "Let other web apps link to your agents. A link fills an agent's message box. Nothing is sent until you press Send.",
    "setc.secrets": "Secrets",
    "setc.secrets.d":
      "Where this machine gets the credentials Den resolves secrets with. Per machine (config/local/user.yml); only the source is shown, never a secret.",
    "setc.server": "Server",
    "setc.server.d":
      "The Den web server this page talks to. A restart keeps agents and services running.", // words-ok: the Settings row's text, moved word for word
    "setc.cli": "Command line",
    "setc.cli.d":
      "Also yours (config/local/user.yml), set from the command line: __DEN_CLI__ config <key>=<value>.",
    "setc.distribution": "Distribution",
    "setc.distribution.d":
      "What the distribution sets for everyone. Read-only here: it lives in the distribution's tracked config.",
    "set.server.restart.d":
      "Restarts the web server on the same port. Agents, services and deploys keep running; this page reconnects in place. Same as __DEN_CLI__ web restart.", // words-ok: the Settings row's text, moved word for word
    "set.appearance.mode.d":
      "System follows your computer's light or dark setting.",
    "set.appearance.mode.o.system": "System",
    "set.appearance.mode.o.dark": "Dark",
    "set.appearance.mode.o.light": "Light",
    "set.appearance.theme.d":
      "Org default follows the distribution's theme. Picking a theme by name keeps it, even when the distribution changes its own.", // words-ok: the Settings row's text, moved word for word
    "set.language.d":
      "The language of Den's own words. Names, logs and command output stay as they are. Changing it reloads the page.",
    // issue 206: Settings › Time zone.
    "set.time_zone.d":
      "Dates and times on these pages show in this zone. They are stored the same either way.",
    "set.appearance.org-theme.d":
      "The theme everyone gets until they pick one (brand.theme).",
    "set.editor.d":
      "__DEN_TITLE__ opens repositories in this editor when you click ↗.",
    "set.editor.open.d":
      "⌘-click (Ctrl-click on Windows and Linux) on a file path in an agent's pane opens it here, at the line. None copies the path instead.",
    "set.editor.open.o.vscode": "VS Code",
    "set.editor.open.o.cursor": "Cursor",
    "set.editor.open.o.zed": "Zed",
    "set.editor.open.o.none": "None (copy)",
    "set.editor_overrides.d":
      "For repos whose stack.yml names a language, open this editor instead of the default.",
    "set.terminal.d":
      "__DEN_TITLE__ opens a terminal to the service directory when you click >_.",
    "set.shell.pages.d":
      "Show or hide each page, and move it within its group.",
    "set.shell.projectOrder.d":
      "The order of projects in the header's picker and Manage projects. A to Z by the name shown unless you move them in Manage projects. Yours only: never shared and never sent to Hub.",
    "set.shell.pins.d":
      "Services and repos at the top of the rail. Pin them from Services, the graph or the health row.",
    "set.shell.collapsed.d":
      "Icons only. The rail's own button at the bottom does the same.",
    "set.shell.dock.d":
      "The output of runs, at the foot of every page. Off, it is just its bar: a run's tab appears and the Runs chip pulses, and you open it. Drag its top edge to resize it, up to half the window.",
    "set.graph.workspaces.d":
      "The Projects page's project list, open or collapsed to a strip so the table gets the width.",
    "set.graph.workspaces.o.open": "Open",
    "set.graph.workspaces.o.collapsed": "Collapsed",
    "set.graph.groupBy.d":
      "The Projects page's repo table: one list, or grouped by application (as __DEN_CLI__ apps) or by company.",
    "set.graph.groupBy.o.none": "None",
    "set.graph.groupBy.o.app": "Application",
    "set.graph.groupBy.o.org": "Company",
    "set.graph.direction.d": "Lay the graph out top-down or left to right.",
    "set.graph.direction.o.down": "Top-down",
    "set.graph.direction.o.right": "Left to right",
    "set.graph.group.d": "The outer frames: by company or by application.",
    "set.graph.group.o.org": "By company",
    "set.graph.group.o.app": "By application",
    "set.graph.density.d":
      "Detailed cards show more; compact ones fit more on screen.",
    "set.graph.density.o.detailed": "Detailed",
    "set.graph.density.o.compact": "Compact",
    "set.graph.panelWidth.d":
      "The width of the graph's details panel, in pixels (360 to 760).",
    "set.workspace.name.d":
      "The name Den shows for this project in the header, lists and pages. Linked to a Hub project, it is Hub's name. The slug never changes.",
    "set.workspace.editor.d":
      "Opening this project, or a repo in it without a per-language override, uses this editor instead of your default.",
    "set.workspace.hub.d":
      "The Hub project this project's agents file their Hub work in: docs, mocks, comments. Den never links on its own: Hub suggests one with the same repos or name, and you confirm. Not linked, Hub files the work in Unfiled. __DEN_CLI__ hub link -p <project>",
    "set.agents.layout.d":
      "Focus shows one agent, Tabs shows one with a tab for each, Tile shows up to four in a grid. The Agents tab's switch, ⌃⇧1, ⌃⇧2, ⌃⇧3 and ⌘K set it too.",
    "set.agents.layout.o.focus": "Focus",
    "set.agents.layout.o.tabs": "Tabs",
    "set.agents.layout.o.tile": "Tile",
    "set.agents.coach_counts.d":
      "Total shows the window's counts; Per day divides them by its days. Percents and averages stay the same. The Coach tab's switch sets it too.",
    "set.agents.coach_counts.o.total": "Total",
    "set.agents.coach_counts.o.per_day": "Per day",
    "set.agents.helpers_shown": "Show up to this many helpers under an agent",
    "set.agents.helpers_shown.d":
      "More open in Show all. The badge always counts every running helper.",
    "set.agents.helpers_shown.o.1": "1",
    "set.agents.helpers_shown.o.3": "3",
    "set.agents.helpers_shown.o.5": "5",
    "set.agents.helpers_shown.o.10": "10",
    "setc.hub": "Hub",
    "setc.hub.d":
      "Den Hub is where your company's docs, mocks, comments and approvals live. Connect this install, and every agent can search and publish there, and gets the comments and decisions on its work. See docs/hub.md in Den's docs.",
    "setc.notifications": "Notifications",
    "setc.notifications.d":
      "What shows in the bell and counts on its badge. These are your own choices. Off means no bell item and no badge. The activity trail still records it.",
    "set.notifications.waiting": "Agent is waiting for you",
    "set.notifications.waiting.d":
      "An agent is waiting for you, or asked you a question, and can't go on.",
    "set.notifications.waiting.warn":
      "While this is off, agents waiting for you won't show here or on the badge.",
    "set.notifications.finished": "Agent finished its turn",
    "set.notifications.finished.d":
      "An agent stopped and is idle. Off by default.",
    "set.notifications.hub": "Replies and comments in Hub",
    "set.notifications.hub.d":
      "Someone answered a comment on something you made.",
    "set.notifications.pr": "Pull requests",
    "set.notifications.pr.d": "A pull request needs a look or changed state.",
    "set.notifications.release": "Releases and checks",
    "set.notifications.release.d": "A release shipped, or a check failed.",
    "set.notifications.pick": "Projects need your pick",
    "set.notifications.pick.d":
      "Den can't tell which Hub project fits a project.",
    "set.notifications.shared": "Shared with you",
    "set.notifications.shared.d": "An agent shared a doc or mock with you.",
    "set.notifications.fold_days": "Fold items older than",
    "set.notifications.fold_days.d":
      "Older items move under “Older than N days”. Nothing is deleted.",
    "set.notifications.fold_days.o.3": "3 days",
    "set.notifications.fold_days.o.7": "7 days",
    "set.notifications.fold_days.o.14": "14 days",
    "set.notifications.fold_days.o.30": "30 days",
    "set.notifications.phone": "Alerts on this device by push",
    "set.notifications.phone.d":
      "Open __DEN_TITLE__ on your phone and turn this on there: when an agent needs you, the phone shows it, even with __DEN_TITLE__ closed. Here it works with every tab closed. Each device turns it on for itself.",
    "set.notifications.phone.none":
      "This browser can't get push. On an iPhone, add __DEN_TITLE__ to the Home Screen (Share, then Add to Home Screen) and open it from there.",
    "set.notifications.phone.failed": "Couldn't turn on push here.",
    "set.notifications.push_devices": "Devices that get push",
    "set.notifications.push_devices.d":
      "Each device that turned on push. Send a test alert to check that your phone gets it: each device says whether its push service took it. Forget one you no longer use.",
    "set.notifications.devices.none":
      "No device gets push yet. Open __DEN_TITLE__ on your phone (Pair a device, under Access, signs it in), then turn on Alerts on this device by push there.",
    "set.notifications.devices.this": "(this device)",
    "set.notifications.devices.added": "Added {t}",
    "set.notifications.devices.forget": "Forget",
    "set.notifications.devices.test": "Send a test alert",
    "set.notifications.test.reached": "Sent: its push service took it.",
    "set.notifications.test.gone":
      "Gone: this device no longer takes push, so it was removed.",
    "set.notifications.test.refused":
      "Not sent: its push service answered {status}.",
    "set.notifications.test.noAnswer":
      "Not sent: no answer from its push service in time (Push wait).",
    "set.notifications.svc.apple": "Apple push",
    "set.notifications.svc.google": "Google push",
    "set.notifications.svc.mozilla": "Firefox push",
    "set.notifications.svc.microsoft": "Microsoft push",
    "set.notifications.svc.other": "Other push service",
    "set.notifications.quiet_from": "Quiet hours start",
    "set.notifications.quiet_from.d":
      "From this time, no alerts outside the bell until quiet hours end. The bell still has everything. In your time zone.",
    "set.notifications.quiet_to": "Quiet hours end",
    "set.notifications.quiet_to.d":
      "Alerts outside the bell start again at this time.",
    "set.notifications.quiet.off": "Off",
    "set.notifications.quiet.half": "Quiet hours need a start and an end.",
    "set.notifications.push_timeout": "Push wait",
    "set.notifications.push_timeout.d":
      "How long __DEN_TITLE__ waits for a push service to take one alert for a device. After this, that alert is left; the next one tries again. __DEN_CLI__ config alerts.push_timeout_seconds=30",
    "set.notifications.push_ttl": "Push kept for",
    "set.notifications.push_ttl.d":
      "How long a push service keeps an alert for a device that is off or offline, in seconds. 86400 is a day; 0 drops it unless the device is on now. __DEN_CLI__ config alerts.push_ttl_seconds=86400",
    "set.notifications.desktop": "Desktop alerts",
    "set.notifications.desktop.d":
      "When an agent needs you (a permission, a question, an Allow), this browser shows a notification, even while __DEN_TITLE__ is in the background. Click it to open the agent. The browser asks once.",
    "set.notifications.desktop.denied":
      "This browser blocks notifications from this page. Allow them in its site settings, then turn this on.",
    "set.notifications.desktop.none": "This browser can't show notifications.",
    "hp.showAll": "Show all ({n})",
    "set.agents.runtimes.d":
      "Each runtime's status and version, the path in use and where it came from. Set path… runs its version command first and refuses a path that isn't that runtime.",
    "set.agents.rotation.d":
      "When an agent's conversation has compacted this many times (or its pull request merged), Den starts it again from its handoff: a fresh conversation, the same name, persona, project and folder. Auto asks the agent for its handoff when it is idle, then relaunches it by itself; Ask shows buttons on the agent; Off does nothing. Overrides win over this install's value: agent, persona in a project, persona, project, service. __DEN_CLI__ agents rotate",
    "set.agents.hub.d":
      "Connect this install to your company's Hub: sign in there and approve it. Every agent then gets Hub's tools: search Hub, publish docs and mocks there. Its company comes from this install's token, its Hub project from Project setup › Hub project.",
    "set.agents.hub_github.d":
      "How many of your company's GitHub repos Den Hub can read, asked live from Hub, with GitHub's link to give it access or change its repos.",
    "set.agents.personas.d":
      "Agent setups you can start from. Built-in ones ship with Den, distribution ones with your distribution, and yours live on this machine. View or Edit, Duplicate, + New persona; only your own can be edited or deleted.",
    "set.agents.keep_running.d":
      "On (the default for a new install): __DEN_TITLE__ runs as a LaunchDaemon, so agents keep running after you log out. There they sign in with a long-lived token from your secrets store, not the login keychain: your agents' CLI makes it when you sign in to it, and you paste it into Sign-in token below. Off: agents stop when you log out. __DEN_CLI__ config agents.keep_running_after_logout=true, then __DEN_CLI__ service install",
    "set.cli.local_dev.d":
      "Off hides Projects and the project APIs for you. __DEN_CLI__ config local_dev=false",
    "set.cli.cli_tabs.d":
      "Whether up and restart open terminal tabs by default. __DEN_CLI__ config cli_tabs=true",
    "set.cli.log_window_lines.d":
      "How many lines a Logs pane keeps loaded; full-history search is unaffected. __DEN_CLI__ config log_window_lines=50000",
    "set.cli.web_port.d":
      "web.port in config/local/user.yml overrides the distribution's. It applies when the web server next starts.", // words-ok: the Settings row's text, moved word for word
    "set.cli.signin.d":
      "Every browser signs in once, on this machine too, and stays signed in. Here, __DEN_CLI__ web up opens a one-time sign-in link; a browser that isn't signed in can look but change nothing. From another machine: Sign in with GitHub, or a one-time link (__DEN_CLI__ web login). Settings › Access lists the signed-in browsers.",
    "set.cli.sudo.d":
      "Used only when a command Den runs needs sudo, and asked for only then. It is no sign-in: nothing else needs it.",
    "set.cli.op_token.d":
      "Where this machine's 1Password service-account token comes from, for a Den running as a service. Set secrets.onepassword.token in config/local/user.yml: keychain:<service>, file:<path> or env:<VAR>. The token itself is never shown.", // words-ok: the Settings row's text, moved word for word
    "set.access.owner.d":
      "The GitHub account this Den belongs to. Linking stores only its id (the token is thrown away), and from then on that account can sign in from any device. __DEN_CLI__ web owner link does the same from the command line.", // words-ok: the Settings row's text, moved word for word
    "set.access.devices.d":
      "The browsers signed in to this Den. Revoke ends one at once. __DEN_CLI__ web logout --all ends them all.",
    "set.access.waiting.d":
      "Computers whose signed-out page shows a code. Type the code that computer's screen shows to approve it, and its page signs in by itself; a request lasts 10 minutes. __DEN_CLI__ web approve --list lists them.",
    "set.embed.url_max.d":
      "The longest web address a link to an agent may carry for its message box. A longer one opens a page that says so.",
    "set.embed.app_keys.d":
      "A key for a web app's own backend on this computer: it can pass on its person's messages to one agent, typed after the agent's turn, and read that agent's state. Nothing else. You allow each key, it is shown once, and you can revoke it here.",
    "set.embed.app_key_audit.d":
      "An app key's state reads go into the activity trail as one line per this many seconds, with how many there were, so a web app that checks often doesn't flood it.",
    "set.embed.origins.d":
      "Each web app's address, exactly, one a line: https://app.example.com. Only these can show an agent pane inside their pages, and only after you allow it. No other site can show any page of this Den inside its own.",
    "set.embed.key_minutes.d":
      "How long an embedded agent pane may send before it asks again.",
    "set.embed.context_max_kb.d":
      "The largest page another web app may share with an agent. A larger one is refused, and the pane says why.",
    "set.access.machine_name.d":
      'What the signed-out page calls this machine ("runs on <name>"), so people on other computers know where to run a command. Empty: its short hostname.',
    "set.access.pair.d":
      "Without GitHub, or offline: a one-time link and QR code for one edge hostname (__DEN_CLI__ web login --host <name>).",
    "set.access.test_installs_here.d":
      "Test installs on this computer whose launcher announces them and that wait for their test person. Set up test person sets it up from here, in any browser, on your own Allow.",
    "set.access.test_install.d":
      "Whether this install is marked a test install: web.test_install in the distribution config, set by hand. Only then can live checks sign in, as a test person (never you, never an agent). Set up test person makes it once, here in your browser.",
    "set.distribution.brand.d":
      "brand.name: the name on pages, the CLI banner and help.",
    "set.distribution.github_org.d":
      "github_org: the org whose repos Den clones and lists.", // words-ok: the Settings row's text, moved word for word
    "set.distribution.hub_github.d":
      "How many of your company's GitHub repos Den Hub can read, asked live from Hub. Den Hub reads a repo only through your company's GitHub App install; the button opens GitHub to install it or change its repos. When you come back, Den sends its projects to Hub again and the repos link by themselves.",
    "set.distribution.orgs.d":
      "orgs: display names for the GitHub orgs repos belong to.", // words-ok: the Settings row's text, moved word for word
    "set.distribution.web_port.d":
      "web.port: the port the web UI listens on, unless yours overrides it.",
    "set.distribution.environments.d":
      "environments: the envs the Env menu offers.",
    "set.distribution.domain.d":
      "edge.domain: services are served at https://<service>.<domain>.",
    "set.shell.projectOrder": "Project order",
    "ws.allN": "All active ({n})",
    "ws.allTip":
      "Every active project; a service several define is listed once",
    "ws.noneLabel": "none",
    "ws.viewTitle":
      "View: what every page shows ({ws}). A view filter only: it starts, stops and routes nothing.",
    "ws.viewTitleFocus":
      "View: what every page shows ({ws}). It starts, stops and routes nothing. CLI default: {focus}.",
    "ws.viewFailed": "Could not change the view: {msg}",
    "ws.focusFailed": "Could not change the CLI default: {msg}",
    // A count's singular is its .one (0.3.0-dev.40: en had none, so the org
    // menu said "1 workspaces").
    "org.n": "{n} projects",
    "org.n.one": "{n} project",
    from: "from {d}",
    "act.pin": "Pin",
    "act.unpin": "Unpin",
    "act.visit": "Visit",
    "act.visitX": "Visit {s} (opens a new tab)",
    "act.pinX": "Pin {s}",
    "act.unpinX": "Unpin {s}",
    "toast.pinned": "Pinned {s}",
    "toast.unpinned": "Unpinned {s}",
    // Issue 402: ★ under All unpins the item in every project.
    "toast.unpinnedAll": "Unpinned {s} in every project",
    "toast.undo": "Undo",
    // 0.4.18: the service panel (svc-panel.js) and Start's Folder.
    "svp.label": "{s}: quick panel",
    "svp.more": "Quick panel for {s}",
    "svp.notRunning": "Not running",
    "svp.up": "up {d}",
    "svp.upNow": "up",
    "svp.down": "down: {c}",
    "svp.downNone": "down",
    "svp.starting": "starting…",
    "svp.stopped": "stopped",
    "svp.noUrl": "No URL",
    "svp.start": "Start",
    "svp.stop": "Stop",
    "svp.restart": "Restart",
    "svp.logs": "Logs",
    "svp.stopping": "Stopping {s}",
    "svp.tests": "Last test run",
    "svp.testsOk": "✓ {t}",
    "svp.testsBad": "✗ failed {t}",
    "svp.testsRun": "running…",
    "svp.testsNone": "—",
    "svp.runTests": "Run tests",
    "svp.testsDone": "Tests passed: {s}",
    "svp.testsFailed": "Tests failed: {s}",
    "svp.agents": "Agents",
    "svp.noAgents": "No agents on this repo.",
    "svp.onRepo": "On this repo",
    "svp.alsoIn": "Also in {p} · {n}",
    "svp.startAg": "Start {s}",
    "svp.open": "Open",
    "svp.openAg": "Open {s}",
    "svp.startHere": "Start agent here",
    "svp.openSvc": "Open in Services",
    "svp.openGraph": "Open in Graph",
    "graph.outside": "{s} is in {ws}, outside this View.",
    "graph.showWs": "Show {ws}",
    "svp.close": "Close",
    "ag.new.folder": "Folder (optional)",
    "ag.repo": "Repo",
    "ag.repo.help":
      "Its repo's service cards list it. None: it shows under the whole project.",
    "ag.repo.auto": "From its folder",
    "ag.repo.none": "None (the whole project)",
    "ag.link.change": "Change",
    "ag.link.relink": "Re-link",
    "ag.link.changeName": "Change the repo {id} works on",
    "ag.link.missing": "repo missing",
    "ag.link.title": "The repo {id} works on",
    "ag.link.help":
      "Its repo's service cards list it. None: it shows under Also in {p}.",
    "ag.link.save": "Save",
    "ag.new.folderHelp":
      "Inside the project's folder. Empty: the project's own.",
    collapse: "Collapse",
    expand: "Expand",
    menu: "Menu",
    skip: "Skip to content",
    pages: "Pages",
    // The top bar (dev.20): the prototype's strings.
    "search.ph": "Search pages, services, actions…",
    "status.checking": "Checking…",
    "status.none": "No services",
    "status.unchecked": "{n} not checked",
    "status.all": "All {n} healthy",
    "status.all.one": "{n} healthy",
    "status.some": "{ok}/{n} healthy",
    "status.down": "{n} down",
    "status.down.one": "{n} down",
    "status.title": "{n} checked",
    "status.title.one": "{n} checked",
    "status.pending": "{n} pending",
    "status.pending.one": "{n} pending",
    "status.awaiting": "{n} still checking",
    "status.unknown": "Status unknown",
    "status.unknownTip":
      "Den's server isn't responding, so service health is unknown",
    // What a check said (the words; the URL and the error are output).
    "chk.awaiting": "still checking",
    "chk.pending": "{what} — pending",
    "chk.check": "check",
    "chk.unchecked": "not checked",
    "chk.healthy": "healthy",
    "chk.down": "down",
    "chk.pendingWord": "pending",
    "chk.checking": "checking…",
    ms: "{n} ms",
    "fix.failedAt": "{line} · failed at {at}",
    "fix.start": "Start",
    "fix.startX": "Start {s}",
    "fix.logs": "Logs",
    "fix.logsX": "Logs of {s}",
    "row.name": "{id}, {state}",
    "row.nameMs": "{id}, {state}, {ms}",
    // The status drawer (R15).
    "drawer.title": "Status",
    "drawer.refresh": "Check again",
    "drawer.close": "Close",
    "drawer.attention": "Needs attention",
    "drawer.nothing": "Nothing needs attention.",
    "drawer.everything": "Everything",
    "drawer.okTip": "{ok} of {n} checked services healthy",
    "drawer.okTip.one": "{ok} of {n} checked service healthy",
    "toast.openWs": "Open Projects to run this",
    // The command palette (R17).
    "kind.page": "Page",
    "kind.service": "Service",
    "kind.app": "App",
    "kind.action": "Action",
    "kind.setting": "Setting",
    "kind.workspace": "Project",
    "pal.goWs": "Go to project {ws}",
    "pal.repos": "{n} repos",
    "pal.repos.one": "{n} repo",
    "pal.restart": "Restart {s}",
    "pal.results": "Results",
    "pal.move": "↑↓ to move",
    "pal.open": "↵ to open",
    "pal.newTab": "{mod}↵ new tab",
    "pal.close": "esc to close",
    "pal.none": "No matches",
    "pal.count": "{n} results",
    "pal.count.one": "{n} result",
    // The runs chip and dock (R7, R16).
    "runs.title": "Runs",
    "runs.n": "{n} running",
    "runs.aria": "Runs, {n} running",
    "runs.last": "Last run: {s}",
    "runs.none": "No runs",
    "runs.empty": "Nothing has run yet. Output from any page lands here.",
    "runs.toast": "Nothing has run yet. A page's output shows here.",
    "runs.all": "All runs",
    "runs.allTip": "Showing {ws}'s runs; press for every run",
    "runs.allOn": "Showing every run; press for {ws}'s only",
    "dock.done": "done in {s}s",
    "dock.failed": "failed in {s}s",
    "run.nothingRan": "– Nothing ran in {d}. No test passed or failed.",
    "run.nothingRanShort": "nothing ran ({d})",
    // A run a person or an agent stopped: never a pass (issue 207).
    "v.v_cancelled": "Cancelled",
    "dock.close": "Hide runs",
    "dock.show": "Show runs",
    "dock.copy": "Copy",
    "dock.copied": "Copied!",
    "dock.clear": "Clear",
    "dock.closeRun": "Close {s}",
    "dock.err": "failed",
    "dock.last": "Last run: {s} ↗",
    "dock.resize": "Drag to resize",
    // The admin password, asked only when a command needs sudo (R8, LK-0).
    "lock.waiting": "Admin password needed",
    "lock.needs": "{cmd} needs your admin password",
    "lock.cmd": "A command",
    "lock.cfg":
      "Saving the password is off: set secrets.provider and secrets.refs.sudo in {file}.",
    "lock.update": "Update stored password",
    "lock.saveTo": "Save to {s}",
    "lock.pw": "Admin password",
    "lock.go": "Continue",
    "lock.note": "Den uses it only for sudo. Agents can't enter it.",
    "lock.saved": "Admin password kept for this session",
    "lock.savedTo": "Admin password kept for this session and saved to {s}",
    "lock.saveFailed": "Kept for this session, but saving to {s} failed: {err}",
    "lock.wrong": "Incorrect password — try again",
    "lock.reqFailed": "Request failed — is the server running?",
    // What's new (R9) and the stale-server pill.
    "v.title": "View changelog",
    "cl.title": "What's new",
    "cl.close": "Close",
    "cl.gotIt": "Got it",
    "cl.none": "No entries found.",
    "cl.copyMd": "Copy as Markdown",
    "cl.copyMdX": "Copy v{v} as Markdown",
    "cl.copySlack": "Copy for Slack",
    "cl.copySlackX": "Copy v{v} for Slack",
    "cl.copyFailed": "Copy failed — try again",
    "cl.latest": "Show latest only",
    "cl.all": "Show all versions ({n} earlier)",
    "cl.all.one": "Show all versions ({n} earlier)",
    "stale.title":
      "This {cli} web server is running code older than your working tree — click to restart and pick up your changes. Running deploys continue on GitHub; an open deploy log reattaches after the reload.",
    "stale.aria": "Stale server: restart",
    "stale.label": "stale server",
    "stale.restart": "Restart",
    // D64: Restart Den, in place.
    "rd.menu": "Restart Den…",
    "rd.title": "Restart Den?",
    "wsd.title": "“{ws}” has agents ({n})",
    "wsd.running": "running",
    "wsd.move": "Move them to",
    "wsd.moveRunning":
      "A running one moves when its turn ends, with the same conversation.",
    "wsd.stop": "Stop them and remove them",
    "wsd.stopHelp":
      "Their conversations stay. Undo brings one back for an hour.",
    "wsd.cancel": "Cancel",
    "wsd.go": "Delete project",
    // issue 133: the kit's dialogs (dialog-den.js), in place of confirm(),
    // prompt() and alert().
    "dlg.ok": "OK",
    "dlg.cancel": "Cancel",
    // Issue 670: a large dialog's Close (the kit's frame).
    "dlg.close": "Close",
    "dlg.keep": "Keep",
    "dlg.delete": "Delete",
    "dlg.remove": "Remove",
    "dlg.removeSvcT": "Remove the service?",
    "dlg.removeSvc": "Remove “{svc}” from “{ws}”?",
    "dlg.delProjT": "Delete the project?",
    "dlg.delProj": "Delete project “{ws}”?",
    "dlg.dirT": "Delete its folder too?",
    "dlg.dir":
      "Also delete the project's directory from your machine?\n\n{dir}\n\nThis removes all files in the directory. Any unpushed commits will be lost.",
    "dlg.reposT": "Delete its repos too?",
    "dlg.devRepos.one":
      "Also delete {n} dev-managed repo from your machine?\n\n{list}\n\nAny unpushed commits will be lost.",
    "dlg.devRepos":
      "Also delete {n} dev-managed repos from your machine?\n\n{list}\n\nAny unpushed commits will be lost.",
    "dlg.denRepos.one":
      "Also delete {n} managed repo only used by this project?\n\n{list}\n\nNo other project uses these clones.",
    "dlg.denRepos":
      "Also delete {n} managed repos only used by this project?\n\n{list}\n\nNo other project uses these clones.",
    "dlg.renameT": "Rename the project",
    "dlg.rename": "Rename project “{ws}” to:",
    "dlg.renameGo": "Rename",
    "dlg.openT": "Run it yourself",
    "dlg.editorFail":
      "Could not open Terminal.app automatically.\n\nRun this in your terminal:\n\n  {cmd}\n\n{msg}",
    "dlg.termFail":
      "Could not open the terminal automatically.\n\nRun this in your terminal:\n\n  {cmd}\n\n{msg}",
    "dlg.autoOffT": "Turn off auto-start for {repo}?",
    "dlg.autoOff":
      "It is a hard dependency of: {list}. Their project's Up may fail readiness while it's off.",
    "dlg.autoOffGo": "Turn off",
    "rd.keepsHead": "Keeps running:",
    "rd.keepsAgents": "Agents and their terminals",
    "rd.keepsServices": "Services, and deploys on GitHub",
    "rd.pausesHead": "Pauses for a few seconds, then reconnects:",
    "rd.pausesLive":
      "This page's live views: terminals, logs, an open deploy log",
    "rd.go": "Restart",
    "rd.cancel": "Cancel",
    "rd.restarting": "Restarting Den…",
    "rd.back": "Den is back.",
    "rd.reconnects": "This page reconnects by itself when Den is back.",
    "rd.version": "Version {v}.",
    "rd.notBack": "Den didn't come back.",
    "rd.notBackB": "It may still be starting. Check again in a moment.",
    "rd.setButton": "Restart Den",
    // BUSY-1: the working pop-up (busy.js). {who}: Den, Hub or GitHub.
    "busy.linkW": "Linking projects…",
    "busy.linkS.one": "Done: {names} is linked to Hub.",
    "busy.linkS": "Done: {names} are linked to Hub.",
    "busy.linkF": "Couldn't link the projects.",
    "busy.connW": "Connecting to Hub…",
    "busy.connS": "Connected to Hub.",
    "busy.connF": "Couldn't connect to Hub.",
    "busy.startW": "Starting {name}…",
    "busy.startS": "{name} started.",
    "busy.startF": "Couldn't start {name}.",
    "busy.termW": "Opening a terminal…",
    "busy.termS": "Terminal open.",
    "busy.schAllowW": "Allowing the schedule…",
    "busy.schAllowS": "Allowed. It runs at its next time.",
    "busy.schAllowF": "Couldn't allow the schedule.",
    "busy.schRunW": "Starting the scheduled checks…",
    "busy.schRunS": "Started. Its result comes to the bell.",
    "busy.schRunF": "Couldn't start the scheduled checks.",
    "busy.termF": "Couldn't open a terminal.",
    "busy.sayW": "Sending to {name}…",
    "busy.sayS": "Sent to {name}.",
    "busy.sayF": "Couldn't send to {name}.",
    "busy.emcW": "Allowing the web app…",
    "busy.emcS": "Web app allowed.",
    "busy.emcF": "Couldn't allow the web app.",
    "agc.kept": "Your message is still here.",
    "busy.restartW": "Restarting {name}…",
    "busy.restartS": "{name} restarted.",
    "busy.restartF": "Couldn't restart {name}.",
    "busy.modeW": "Setting {name}'s mode…",
    "busy.modeS": "{name}'s mode is set.",
    "busy.modeF": "Couldn't set {name}'s mode. Nothing changed.",
    "keep.label": "Keep agents running after logout",
    "keep.warn":
      "Agents there sign in with a long-lived token from your secrets store, not the login keychain.",
    "keep.apply": "Apply",
    "keep.pending": "Saved, not applied yet: press Apply.",
    "keep.w": "Applying…",
    "keep.s": "Applied. __DEN_TITLE__ restarts.",
    "keep.needs": "Needs your admin password.",
    "keep.failed": "Not applied. Nothing changed.",
    "busy.edgeW": "Starting the edge…",
    "busy.edgeS": "Edge started",
    "busy.edgeF": "The edge didn't start.",
    "busy.testPersonW": "Setting up the test person…",
    "busy.testPersonS": "Test person set up",
    "busy.testPersonF": "The test person wasn't set up.",
    "keep.onNow": "On: agents keep running after you log out.",
    "keep.offNow": "Off: agents stop when you log out.",
    "keep.saved": "Saved. __DEN_TITLE__ already runs this way.",
    "keep.noService":
      "Saved. It applies when __DEN_TITLE__ runs as a service: __DEN_CLI__ service install",
    "keep.refused": "No admin password: nothing changed.",
    "keep.offer":
      "Not set yet, so agents stop when you log out. Turn it on and press Apply (it asks for your admin password once).",
    "keep.noToken":
      "No sign-in token is set: agents will not be able to sign in after logout. {runtime} makes one when you sign in to it ({docs}); paste it into {field} below.",
    "keep.credKeychain":
      "The store's credential is in the login keychain, which the always-on service may not reach; use file: or env: (see docs/always-on-gate.md).",
    "keep.setup":
      "The only terminal step: run this, sign in in the browser it opens, and paste its token here.",
    "keep.copy": "Copy",
    "keep.tokenLabel": "Sign-in token",
    "keep.tokenSave": "Save",
    "keep.tokenFailed": "Not saved: {error}",
    "keep.tokenClear": "Clear",
    "gate.priorityOffTitle": "Turn release priority off?",
    "gate.priorityOffAsk":
      "0 turns release priority off for every repo on this machine. A release run a person waits on then waits behind plain runs.",
    "gate.priorityOffOk": "Turn it off",
    "keep.clearTitle": "Remove the sign-in token?",
    "keep.clearAsk":
      "It's removed from the secrets store. Agents under Keep agents running after logout can't sign in until a new one is set.",
    "keep.clearOk": "Remove",
    "keep.clearW": "Removing the sign-in token…",
    "keep.clearS": "Removed.",
    "keep.clearF": "Couldn't remove the sign-in token.",
    "keep.noTokenNotNeeded":
      "No sign-in token is set; it's needed only under Keep agents running after logout.",
    "keep.processLocal": "Process-local: kept only until Den restarts.",
    "keep.noStore":
      "There's no secrets store for this install, so the sign-in token can't be kept. Set secrets.provider to 1password or doppler first.",
    "keep.tokenSet": "Agents sign in with the token set {date}.",
    "keep.tokenStore": "Agents sign in with the token in {store}.",
    "keep.tokenOld":
      "The sign-in token was set {n} days ago, and it lasts about a year. {runtime} makes a new one when you sign in to it ({docs}); paste it into {field} below.",
    "keep.docs": "its sign-in docs",
    "keep.runtimeAny": "Your agents' CLI",
    "acct.title": "{vendor} accounts",
    "acct.default": "{vendor} account {letter}",
    "acct.add": "Add {vendor} account",
    "acct.none": "No token.",
    "acct.set": "Token set {date}.",
    "acct.setUnknown": "Token set.",
    "acct.first": "Agents sign in with this one.",
    "acct.tokenLabel": "Sign-in token for {name}",
    "acct.tokenSave": "Set sign-in token",
    "acct.up": "Move up",
    "acct.down": "Move down",
    "acct.failed": "Not saved: {error}",
    "busy.askAllowW": "Asking…",
    "busy.askAllowS": "Asked. Allow it in the dialog.",
    "busy.askAllowF": "Couldn't ask.",
    "busy.pushTestW": "Sending a test alert…",
    "busy.pushTestS": "Test alert done. Each device says how it went.",
    "busy.pushTestF": "Couldn't send the test alert.",
    "busy.pushForgetW": "Forgetting this device…",
    "busy.pushForgetS": "This device no longer gets push.",
    "busy.pushForgetF": "Couldn't forget this device.",
    "busy.saveW": "Saving…",
    "busy.saveS": "Saved.",
    "busy.saveF": "Couldn't save.",
    // The user menu (R10) and its palette commands (R17).
    "um.label": "Appearance",
    "um.title": "Appearance and theme",
    "um.appearance": "Appearance",
    "um.system": "System",
    "um.dark": "Dark",
    "um.light": "Light",
    "um.theme": "Theme",
    "um.language": "Language",
    "um.all": "All settings",
    "cmd.appearance": "Appearance: {mode}",
    "cmd.theme": "Theme: {name}",
    "cmd.language": "Language: {name}",
    "theme.orgDefault": "Org default ({name})",
    "theme.pinned": "{name} (pinned)",
    "theme.notInstalled":
      "Your theme {id} isn't installed, so {inUse} is in use",
    "theme.invalid":
      "Your theme {id} isn't valid ({why}), so {inUse} is in use",
    "theme.invalidBare": "Your theme {id} isn't valid, so {inUse} is in use",
    // Errors (R26, 0.3.0-dev.38).
    "api.network": "Den's server didn't answer {what}",
    "api.failed": "{what} failed",
    "api.request": "Request {id}",
    "api.retry": "Retry",
    "api.copy": "Copy details",
    "api.copied": "Copied",
    "api.close": "Dismiss",
    "api.retried": "Done",
    "net.down": "Den's server isn't responding — retrying",
    "net.next": "next try in {s}s",
    "net.now": "Retry now",
    // The shared update pill (den-ui): a newer Den on disk (MD-2).
    "upd.msg": "A new version of Den is available.",
    "upd.reload": "Reload",
    "upd.notNow": "Not now",
    "upd.cancel": "Cancel",
    "upd.ask": "You have unsaved text on this page. Reload anyway?",
    "upd.region": "Update",
    // The error page (R26a, error-page.js).
    "err.404.title": "Page not found",
    "err.404.sub": "Nothing here at {path}",
    "err.404.lead": "There is no page at this address.",
    "err.404.mean": "Did you mean {page}?",
    "err.404.stale":
      "This page may be new in Den {onDisk}: the server is still running {loaded}.",
    "err.404.plugin":
      "This page belongs to the {name} plugin, which isn't installed in this distribution.",
    "err.404.pluginLocked":
      "This page belongs to the {name} plugin. It is in plugins.lock.json, but its files are missing.",
    "err.404.pluginNoPage":
      "The {name} plugin is installed, but it has no page here.",
    "err.404.workspaces": "Go to Projects",
    "err.404.search": "Search",
    "err.404.pages": "Pages",
    "err.500.title": "Something went wrong",
    "err.500.sub": "{what} failed on the server",
    "err.500.lead":
      "The server hit an error answering this page. Retry, or copy the details for a report: the server log has the full error under the same request id.",
    "err.500.what": "What failed",
    "err.500.time": "Time",
    "err.500.id": "Request id",
    "err.500.version": "Version",
    "err.421.title": "Wrong address",
    "err.421.lead":
      "This server answers only on its own addresses, so a page on another name can't reach it.",
    "err.421.open": "Open on localhost",
    "err.link.title": "This agent link can't open",
    "err.link.project": "There is no project {project} in this Den.",
    "err.link.agent":
      "Project {project} has no agent {agent}. It may have been removed.",
    "err.link.context_scheme":
      "The link's context must be an http or https web address.",
    "err.link.context_long":
      "The link's context is longer than {max} characters. Settings › Embedding sets the limit.",
    "err.link.agents": "Open Agents",
    "err.refused.title": "Request refused",
    "err.signin.terminal": "Sign in to use the terminal",
    "err.signin.agents": "Sign in to start agents",
    "err.signin.sub": "This browser isn't signed in",
    "err.signin.lead": "Run {cmd} and open the link.",
    "err.signin.expiredTitle": "Sign-in link expired",
    "err.signin.local":
      "A sign-in belongs to one address. This page is on {host}: open the same page on localhost, where this browser is signed in.",
    "err.signin.atAddress": "{name} signs in at {address}",
    "err.signin.offerTitle": "Make {alias} {name}'s address",
    "err.signin.offerLoop":
      "{name}'s address is {url}, which only opens on its own machine, so sign-in can't send you there.",
    "err.signin.offerWrong":
      "{name}'s address is {url}, and it isn't working from here.",
    "err.signin.offerUnset": "{name} has no address yet.",
    "err.signin.offerHow":
      "Sign in below as {name}'s owner: with GitHub, or with a code you approve on its machine. Then make {alias} its address, and sign-in works here.",
    "err.signin.copy": "Copy command",
    "err.signin.title": "Sign in to {name}",
    "err.signin.where":
      "You're opening {name} from another computer. {name} runs on {host}, so it needs to know this is you.",
    "err.signin.ghStep1":
      "On {host}, run {cmd}, or use Settings › Access there.",
    "err.signin.ghStep2":
      "It shows a code. Enter it at github.com/login/device and approve.",
    "err.signin.ghStep3":
      "Then come back here and press Sign in with GitHub, with the same GitHub account.",
    "err.signin.ghOwner": "Owner: @{login}",
    "err.signin.ghOnly":
      "Only the owner's GitHub account can sign in this way. For anyone else, use Approve this computer.",
    "err.signin.ghLearn": "Learn more",
    "err.signin.claimTitle": "Connect your GitHub account",
    "err.signin.claimLead":
      "{name} has no owner yet. Connect your GitHub account to make it yours.",
    "err.signin.claimOrg":
      "Members of the {org} GitHub org can claim it, in a browser on {host}.",
    "err.signin.claimHere": "This is my computer: connect GitHub",
    "err.signin.claimHereOn": "On {host} itself: connect GitHub",
    "err.signin.claimOrgOnly":
      "Members of the {org} GitHub org can claim it, from a browser on {host}. Open this page on {host}, or set web.owner_github to sign in from anywhere.",
    "err.signin.claimAs": "Sign in as @{login}",
    "err.signin.claimChecking": "Checking this is {host}…",
    "err.signin.githubRefused":
      "@{login} isn't the owner of this {name}. Only the owner's account can use Sign in with GitHub. Use Approve this computer instead.",
    "err.signin.approveOr": "Or approve this computer",
    "err.signin.approve": "Approve this computer",
    "err.signin.step1": "On {host} (not this computer), run:",
    "err.signin.step1Or":
      "Or open {name} on {host} itself and go to Settings › Access › Waiting devices.",
    "err.signin.step2":
      "This page signs you in by itself once approved. The code expires in 10 minutes.",
    "err.signin.waiting": "Waiting for approval…",
    "err.signin.allowFrom":
      "Open {name} in a browser that is signed in, on {host} or another computer. It asks “Allow this computer?” with this code. Allow it there.",
    "err.signin.pairOther": "Other ways: a command on the Den computer",
    "err.signin.windowsSteps":
      "Open Windows Terminal or PowerShell, paste this, and press Enter.",
    "err.signin.nothingOpened":
      "Nothing opened? Copy the command below and paste it into your terminal app.",
    "err.signin.noTerminal":
      "Don't have a terminal on {host}? From this computer, run:",
    "err.signin.openTerminal": "Open Terminal",
    "err.signin.sshUserNote":
      "Log in with your {host} account ({user}) and its password, or an SSH key.",
    "err.signin.sshNote":
      "Open Terminal opens ssh://{target} in your terminal app. It needs SSH access to {target}.",
    "err.signin.whyTitle": "Why?",
    "err.signin.whyText":
      "{name} can start terminals and agents on {host}, so it only lets in people who prove they're the owner. You only do this once per computer: you stay signed in.",
    "err.signin.other": "Other ways (the one-time link with {cmd})",
    "err.signin.otherStep":
      "On {host} (not this computer), run this, then open the link it prints in this browser:",
    "err.signin.whereLocal":
      "{name} runs on this computer. Sign in once so it knows this browser is you. You stay signed in.",
    "err.signin.step1Local": "In a terminal on this computer, run:",
    "err.signin.otherLocal": "Other ways ({cmd} opens a one-time sign-in link)",
    "err.signin.otherStepLocal":
      "In a terminal on this computer, run this. It opens this page signed in:",
    "shell.signin.line": "Sign in to make changes here.",
    "shell.signin.btn": "Sign in",
    "shell.view.title": "Read-only view",
    "shell.view.line":
      "{agent} is viewing these pages. Nothing can be changed here, and the view ends in a few minutes.",
    "shell.view.off": "Read-only view: this changes nothing here",
    "err.signin.codeExpired": "This code expired.",
    "err.signin.codeDenied": "This computer was denied on {host}.",
    "err.signin.codeFailed": "{name} didn't give this page a code. Try again.",
    "err.signin.pairStartLead":
      "Sign in with a code from a browser already signed in to {name}, on {host} or another computer.",
    "err.signin.pairStart": "Sign in from another computer",
    "err.signin.newCode": "Get a new code",
    "err.signin.youreIn": "You're in.",
    "err.signin.expiredLead":
      "That sign-in link expired or was used. Sign in again below.",
    "err.signin.pairLinkLead":
      "To let this browser in, approve it from a browser that is already signed in: open Settings › Access there and approve the code below.",
    "err.signin.pairLinkWaiting":
      "Waiting for you to approve it from a signed-in browser…",
    "err.signin.pairLinkDenied":
      "This browser was denied. To sign in, get a new code and approve it from a signed-in browser.",
    "err.signin.pairLinkEnded":
      "This request ended. Get a new code and approve it again.",
    "err.signin.confirmLead":
      "Enter the code that web login printed on {host}:",
    "err.signin.confirmGo": "Sign in",
    "err.signin.confirmWrong":
      "That code isn't right. Check what web login printed and try again.",
    "err.signin.confirmBusy": "Too many tries. Wait a minute and try again.",
    "err.signin.confirmGone":
      "This link no longer works. On {host}, run web login again for a new one.",
    "err.signin.confirmWhy":
      "The link alone isn't enough: it needs the code shown on {host} too, so a link someone else sees can't sign them in.",
    // Issue 868: the ways in this install has, on the signed-out page.
    "err.signin.methods.title": "Ways to sign in to {name}",
    "err.signin.methods.ready": "Set up here",
    "err.signin.methods.notReady": "Not set up here",
    "err.signin.methods.hostOnly": "Only on {host}",
    "err.signin.methods.github": "Sign in with GitHub",
    "err.signin.methods.githubReady":
      "Use Sign in with GitHub below, from any computer.",
    "err.signin.methods.githubNoClient":
      "No GitHub App client id is set ({setting}). A person sets it in {file} on {host}, then runs {restart} there.",
    "err.signin.methods.githubNoOwner":
      "No owner is linked on GitHub yet, so nobody can use it from another computer.",
    "err.signin.methods.pair": "Ask to sign in from this device",
    "err.signin.methods.pairReady":
      "A browser already signed in to {name} approves this one by typing the code this page shows.",
    "err.signin.methods.pairNone":
      "No browser is signed in to {name} yet, so nobody can approve this one.",
    "err.signin.methods.ask": "Ask to sign in",
    "err.signin.methods.terminal": "A link from a terminal on {host}",
    "err.signin.methods.terminalHow":
      "Run {cmd} in a terminal on {host}, then open the link it prints.",
    "err.signin.methods.stuck":
      "{name} can't be signed into from another computer yet. Sign in with GitHub isn't set up, and no browser is signed in to {name} to approve this one.",
    "err.signin.methods.fixClient":
      "To fix it, on {host} set {setting} to a GitHub App client id in {file}, then run {restart}. Then Sign in with GitHub works from any computer.",
    "err.signin.methods.fixOwner":
      "To fix it, link the owner on GitHub: on {host}, run {cmd}. Then Sign in with GitHub works from any computer.",
    "err.signin.methods.fixFirst":
      "Or finish the first sign-in on {host} itself: then that browser can approve this one.",
    "err.signin.firstRunHere":
      "{name} isn't set up yet. Finish its first sign-in on {host} itself: open the setup link there, or run web login in your own terminal there.",
    "err.signin.tooManyRequests":
      "Too many sign-in requests from this address. Wait a minute, then open the link again.",
    "err.signin.tooManyWaiting":
      "Too many devices are waiting to be approved on {name}. Wait a few minutes, then open the link again.",
    "err.signin.claimSetUp":
      "{name} is already set up, so the setup link doesn't sign in by itself. Approve this browser from one that is signed in: Settings › Access, then the code below.",
    "err.signin.github": "Sign in with GitHub",
    "err.signin.githubEnter": "Enter this code at {url}:",
    "err.signin.githubOpen": "Open GitHub",
    "err.signin.githubWaiting": "Waiting for you to approve it on GitHub…",
    "err.signin.githubDone": "Signed in. Loading…",
    "err.signin.githubExpired": "The code expired before it was approved.",
    "err.signin.githubDenied": "The request was cancelled on GitHub.",
    "err.signin.githubBusy":
      "Too many sign-ins are in progress. Try again in a few minutes.",
    "err.signin.githubFailed": "GitHub couldn't be reached. Try again.",
    "err.signin.githubAgain": "Start again",
    "err.422.title": "Config is invalid",
    "err.422.sub": "The distribution config fails validation",
    "err.422.lead":
      "Pages that read the config wait until it validates. Fix each key below; Settings and Logs still work meanwhile.",
    "err.422.file": "File",
    "err.422.key": "Key",
    "err.422.problem": "Problem",
    "err.422.cmd": "To see the same in a terminal, run:",
    "err.422.reload": "Reload once fixed",
    "err.422.logs": "Open Logs",
    "err.422.settings": "Open Settings",
    // The Settings registry's built-in rows, as the palette shows them
    // (set.<row id>; settings-registry.js keeps the English label).
    "set.appearance.mode": "Mode",
    "set.appearance.theme": "Theme",
    "set.language": "Language",
    "set.time_zone": "Time zone",
    "set.appearance.org-theme": "Org default theme",
    "set.editor": "Default IDE",
    "set.editor.open": "Open file links in",
    "set.editor_overrides": "Per-language IDE",
    "set.terminal": "Default terminal",
    "set.shell.pages": "Pages",
    "set.shell.pins": "Pinned",
    "set.shell.collapsed": "Collapse the rail",
    "set.shell.dock": "Open the runs dock",
    "set.graph.workspaces": "Project list",
    "set.graph.groupBy": "Group repos by",
    "set.graph.direction": "Direction",
    "set.graph.group": "Frames",
    "set.graph.density": "Cards",
    "set.graph.panelWidth": "Details panel",
    "set.workspace.hub": "Hub project",
    "hubp.offline": "This install isn't connected to Hub yet.",
    "hubp.connect": "Connect in Settings › Hub",
    "hubp.suggested": "Suggested by Hub",
    "hubp.others": "Your company's other Hub projects",
    "hubp.whyRepo": "has these repos",
    "hubp.whyName": "same name",
    "hubp.link": "Link",
    "hubp.elsewhere":
      "{project} points at “{name}” on another Hub ({host}, {company}). This Den is connected to {nowHost} ({nowCompany}), so the link doesn’t count. Relink it here, or unlink it.",
    "hubp.relink": "Relink",
    "hubp.unlink": "Unlink",
    "hubp.none": "Your company has no Hub projects yet.",
    "hubp.noOther": "Your company has no other Hub projects to switch to.",
    "hubp.failed": "Den couldn't reach Hub's projects.",
    "hubp.cantSee": "Den Hub can't see {repo}.",
    "hubp.giveAccess": "Give Den Hub access to {org}",
    "hubp.noHub":
      "This install isn't connected to Hub, so there is nothing to link yet.",
    "hubp.connectBtn": "Connect to Hub",
    "hubp.sideProject": "Project",
    "hubp.sideHub": "Hub project",
    "hubp.byId":
      "Den links to a Hub project by its hidden ID, so renaming the project or its short name in Hub doesn't break the link.",
    "hubp.linkedWhen": "Linked when this install connected to Hub.",
    "hubp.does":
      "Docs, mocks and comments that {project}'s agents make go to {hub} in Hub.",
    "hubp.more": "More",
    "hubp.moreNote":
      "Den linked this when it connected to Hub. Change it only if Den picked the wrong Hub project.",
    "hubp.switchL": "Use a different Hub project",
    "hubp.switch": "Switch",
    "hubp.unlinkDoes":
      "Unlink stops that. New docs, mocks and comments from {project}'s agents go to Unfiled in Hub. What is already in {hub} stays there. The name Den shows does not change.",
    "hubp.cliL": "From a terminal:",
    "hubp.unlinkAsk": "Unlink {project} from the Hub project {hub}?",
    "hubp.unlinkYes": "Yes, unlink",
    "hubp.cancel": "Cancel",
    "hubp.waiting":
      "Den can't tell which Hub project fits {project}, so nothing is filed for {project} until you pick one.",
    "hubp.pickBtn": "Pick a Hub project",
    "hubp.notLinked":
      "Not linked. Docs, mocks and comments that {project}'s agents make are filed in Unfiled in Hub.",
    "hubp.linkProject": "Link {project} to a Hub project",
    "hubp.scope":
      "Linking affects only the project {project}. Your other projects aren't changed.",
    // Issue 271: Create a Hub project from the link picker.
    "hubp.createOpt": "Create a Hub project named {name}",
    "hubp.newName": "Name in Hub",
    "hubp.create": "Create",
    "hubp.nameEmpty": "Type a name for the Hub project.",
    "hubp.nameLong": "A Hub project's name is up to 80 characters.",
    "hubp.asked":
      "Den asked Hub to create the Hub project {name} for {project}.",
    "hubp.youAllow":
      "You're an owner in Hub. Allow it there, and Den links {project} to it.",
    "hubp.allowBtn": "Allow in Hub",
    "hubp.ownerMust":
      "An owner of {company} in Hub must allow it. Den links {project} on its own when they do.",
    "hubp.ownerMustAny":
      "An owner of your company in Hub must allow it. Den links {project} on its own when they do.",
    "hubp.declined":
      "An owner in Hub declined the Hub project {name}. Pick a Hub project, or ask again.",
    "hubp.ended": "Hub's ask for {name} ended with no change. Ask again.",
    "hubp.createW": "Asking Hub to create {name}…",
    "hubp.createS": "Asked. An owner allows it in Hub.",
    "hubp.createF": "Hub didn't take the ask. Nothing was created.",
    "hub.legacy":
      "This install is on an older Hub token, kept where Den can't replace it. Reconnect to move it to a new one.",
    "hub.addressMore": "Hub address…",
    "hub.justConnected":
      "Connected to {company} ({host}). Not the company you meant?",
    "hub.switching":
      "Switching to {to}: sign in there to finish. __DEN_TITLE__ stays on {from} until then.",
    "hub.switchEnded":
      "The switch to {to} waited too long for a sign-in and has ended. __DEN_TITLE__ stays on {from}.",
    "hub.switchSignin": "Sign in to the new Hub",
    "hub.reconnect": "Reconnect",
    "hub.cw.done": "Connected to Hub ({company}).",
    "hub.cw.doneNoCo": "Connected to Hub.",
    "hub.cw.linked": "Linked {n} projects in the same approval.",
    "hub.cw.linked.one": "Linked {n} project in the same approval.",
    "hub.cw.linkedNew":
      "Linked {n} projects in the same approval ({made} new).",
    "hub.cw.linkedNew.one":
      "Linked {n} project in the same approval ({made} new).",
    "hub.cw.notCreated": "{key}: not created.",
    "hub.cw.notCreatedWhy": "{key}: not created ({detail}).",
    "hub.cw.notDone": "{key}: not done on Hub.",
    "hub.cw.notDoneWhy": "{key}: not done on Hub ({detail}).",
    "hub.cw.later": "{key}: waits for your review.",
    "hub.cw.fb.oldHub":
      "This Hub doesn't link projects in Connect yet, so they wait for your review here.",
    "hub.cw.fb.otherList":
      "Hub's answer is for another list of projects, so they wait for your review here.",
    "hub.cw.fb.badAnswer":
      "Den couldn't read Hub's answer about the projects, so they wait for your review here.",
    "hub.cw.fb.rebind":
      "Den couldn't move its Hub records to this Hub, so the projects wait for your review here.",
    "hub.cw.fb.tooMany":
      "Connect sends at most 50 projects to Hub, so they wait for your review here.",
    "hub.cw.fb.tooBig":
      "The list of projects was over 6 KB, so they wait for your review here.",
    "hub.cw.fb.badKey":
      "A project's name has letters Hub can't match, so they wait for your review here.",
    "hub.cw.fb.twice":
      "A project was listed twice, so they wait for your review here.",
    "hub.cw.review":
      "Review {n} projects below, then press Connect and link all.",
    "hub.cw.review.one":
      "Review {n} project below, then press Connect and link all.",
    "hub.cw.cannot":
      "Hub can't list its projects yet: link them in Settings › Hub when it can.",
    "hubgh.offline": "This install isn't connected to Hub yet.",
    "hubgh.failed": "Den couldn't ask Hub about GitHub access.",
    "hubgh.noOrgs": "No repos sent to Hub yet.",
    "hubgh.line": "{org}: Den Hub can read {what}.",
    "hubgh.all": "all repos",
    "hubgh.some": "{n} of {m} repos",
    "hubgh.none": "no repos (no access)",
    "hubgh.give": "Give Den Hub access",
    "hubgh.change": "Change repos",
    "hubgh.error":
      "Den Hub couldn't check {org} on GitHub: {reason}. Try again later.",
    "hubgh.errorNoReason":
      "Den Hub couldn't check {org} on GitHub. Try again later.",
    "hubgh.retry": "Check again",
    "set.distribution.hub_github": "Den Hub's GitHub access",
    "set.agents.hub_github": "Den Hub's GitHub access",
    "hubla.noProjects": "No projects here yet.",
    "hubla.linked.one": "Linked {n} project.",
    "hubla.linked": "Linked {n} projects.",
    "hubla.failed": "{n} couldn't be linked: {names}. Try again.",
    "hubla.failedAll": "Couldn't link {names}. Try again.",
    "hubrv.title": "Connect this Den to {company}",
    "hubrv.titleNo": "Link this Den's projects to Hub",
    "hubrv.offline":
      "Hub didn't answer. The company is known, but its projects can't be listed. Nothing was changed.",
    "hubrv.youAre": "you are {role}",
    "hubrv.signedAs": "signed in as {login}",
    "hubrv.role.owner": "owner",
    "hubrv.role.member": "member",
    "hubrv.retry": "Try again",
    "hubrv.allMatch.one": "{n} project matches. Nothing to pick.",
    "hubrv.allMatch": "All {n} projects match. Nothing to pick.",
    "hubrv.why.repo": "same repo",
    "hubrv.why.name": "same name",
    "hubrv.why.picked": "your pick",
    "hubrv.why.linked": "linked",
    "hubrv.why.new": "no Hub project fits: a new one",
    "hubrv.why.pick": "two Hub projects fit: choose one",
    "hubrv.waiting": "a new Hub project, waiting for an owner's Apply in Hub",
    "hubrv.was": "was linked to “{name}” on {host}; {why} here",
    "hubrv.wasCo":
      "was linked to “{name}” on {host} (company {company}); {why} here",
    "hubrv.offlineRow": "Hub didn't answer for the project list",
    "hubrv.create": "Create “{name}”",
    "hubrv.suggested": "Suggested",
    "hubrv.choose": "Choose a Hub project for “{project}”",
    "hubrv.search.one": "Search {n} project",
    "hubrv.search": "Search {n} projects",
    "hubrv.noMatch": "No Hub project matches.",
    "hubrv.noProjects": "Hub has no projects in this company yet.",
    "hubrv.use": "Use {name}",
    "hubrv.createInstead": "Create “{name}” instead",
    "hubrv.cancel": "Cancel",
    "hubrv.change": "Change",
    "hubrv.openPlan": "Open Hub's plan page",
    "hubrv.apply": "Connect and link all",
    "hubrv.applyNote":
      "Links apply at once. Any new projects open Hub's plan page: one Apply there creates them all.",
    "hubrv.member.one":
      "{n} new project goes to an owner for approval. You are a member, so Hub asks an owner to Apply it. The links apply at once.",
    "hubrv.member":
      "These {n} new projects go to an owner for approval. You are a member, so Hub asks an owner to Apply them. The links apply at once.",
    "hubrv.doneTitle": "Connected to {company}",
    "hubrv.doneTitleNo": "Done",
    "hubrv.linkedLine": "{project} → {name} ({why})",
    "hubrv.creatingLine":
      "{project}: a new Hub project, {name}, waiting for an Apply in Hub. It links when it is applied.",
    "hubrv.skip.duplicate": "{project}: listed twice; done once.",
    "hubrv.skip.unknown": "{project}: not done: there is no such project here.",
    "hubrv.skip.offline": "{project}: not done: Hub didn't answer. Try again.",
    "hubrv.skip.stale":
      "{project}: not done: that isn't one of the company's Hub projects any more.",
    "hubrv.skip.waiting":
      "{project}: not done: a new Hub project is already waiting for an owner.",
    "hubrv.skip.hub": "{project}: not done: Hub said: {why}",
    "hubrv.skip.name":
      "{project}: not done: the name must be 1 to 80 characters.",
    "hubrv.asked": "Asked Hub for the new projects.",
    "hubrv.switch": "Switch company",
    "set.agents.hub_link_all": "Unclear matches",
    "set.agents.hub_link_all.d":
      "Linking ties a project to its Hub project, so its agents file docs, mocks and comments there. Den lists a project here only when it can't tell which Hub project fits. Pick one and press Link. Until then, nothing is filed for that project.",
    "set.agents.hub_delivery_loop": "Hub delivery loop",
    "set.agents.hub_delivery_loop.d":
      "On, every agent Den starts in a project connected to Hub gets the delivery loop in its instructions: requirement docs in Hub, issues linked in full, review and feedback in Hub's threads, status from git. Off for every project here unless a project turns it on. Reaches an agent at its next start.",
    "set.agents.hub_groups": "Groups from Hub",
    "set.agents.hub_groups.d":
      "Whether the Agents page shows your Hub's groups (By group, beside By project). Auto: when your Den Hub supports groups. Off: Den never asks Hub for them. __DEN_CLI__ config hub.groups=auto",
    "set.agents.hub_groups.o.auto": "Auto",
    "set.agents.hub_groups.o.on": "On",
    "set.agents.hub_groups.o.off": "Off",
    "set.agents.hub_groups_cache": "Groups kept for",
    "set.agents.hub_groups_cache.d":
      "How long Den keeps a copy of Hub's groups in memory before it asks Hub again: 5 to 3600 seconds. Try again on the Agents page asks Hub now. __DEN_CLI__ config hub.groups_cache_seconds=30",
    "set.workspace.hub_delivery_loop": "Hub delivery loop: this project",
    "set.workspace.hub_delivery_loop.d":
      "Whether this project's agents get the Hub delivery loop in their instructions, over the install's Hub delivery loop. Reaches an agent at its next start.",
    "set.workspace.hub_delivery_loop.o.install": "As everywhere",
    "set.workspace.hub_delivery_loop.o.on": "On",
    "set.workspace.hub_delivery_loop.o.off": "Off",
    "set.workspace.agents_max_per_project": "Agents per project: this project",
    "set.workspace.agents_max_per_project.d":
      "How many of this project's agents may run at once. Empty or 0 uses Agents per project. It can only be lower than that. A start past it is refused, and says which cap holds it.",
    "set.workspace.hub_delivery_loop_extra": "Added to the Hub delivery loop",
    "set.workspace.hub_delivery_loop_extra.d":
      "This project's own text, added after Den's copy of the loop in its agents' instructions. Den's copy can't be edited. Empty adds nothing.",
    "ub.intro":
      "Den can't tell which Hub project fits these. Pick one for each, then press Link.",
    "ub.why.repos": "Two Hub projects share its repos",
    "ub.why.split": "Its repos match one Hub project; its name matches another",
    "ub.why.names": "Two Hub projects have its name",
    "ub.pick": "Pick the Hub project for {project}",
    "ub.link": "Link",
    "ub.waiting": "Nothing is filed for this project yet.",
    "ub.empty":
      "Every match is clear. Den lists a project here only when it can't tell which Hub project fits.",
    "ub.repos": "same repos",
    "ub.name": "same name",
    "ub.clear": "{project}: Hub suggests",
    "set.workspace.editor": "IDE for this project",
    "set.agents.runtimes": "Runtimes",
    "set.server.self_update": "New versions",
    "set.server.self_update.d":
      "When a new __DEN_TITLE__ is out. Ask: an update waits in the bell for your Allow. Auto: __DEN_TITLE__ updates at a quiet moment, and goes back by itself if the new version doesn't come up.",
    "set.server.self_update.o.ask": "Ask",
    "set.server.self_update.o.auto": "Auto",
    "set.server.update_check": "Update checks",
    "set.server.update_check.d":
      "Where the New versions choice comes from, and when __DEN_TITLE__ last looked for a new version and looks next.",
    "set.ui.suFrom.user": "Set by you (config/local/user.yml)",
    "set.ui.suFrom.dist":
      "From the distribution's config, copied to config/local/user.yml at the next start",
    "set.ui.suFrom.default": "The default: Ask",
    "set.ui.ucOff": "Checks are off",
    "set.ui.ucNone": "No check yet",
    "set.ui.ucLast": "Last check {t}: {did}",
    "set.ui.ucNext": "next {t}",
    "set.ui.ucDid.asked": "{v} is out, waiting for your Allow",
    "set.ui.ucDid.waiting": "{v} is out, waiting for a quiet moment",
    "set.ui.ucDid.waitAllow":
      "{v} is out, waiting: the __DEN_TITLE__ agent is waiting on your Allow",
    "set.ui.ucDid.waitAsked":
      "{v} is out, waiting: the __DEN_TITLE__ agent asked you a question",
    "set.ui.ucDid.updating": "updating to {v}",
    "set.ui.ucDid.failed": "couldn't update to {v}",
    "set.ui.ucDid.skipped": "skipped",
    "set.ui.ucDid.current": "on the newest version",
    "set.server.crash_loop": "Restart guard",
    "set.server.crash_loop.d":
      "When __DEN_TITLE__'s web app stops without a clean stop this many times within the minutes below, the next start waits before it serves, longer each time, and the bell says so. __DEN_CLI__ config web.crash_loop_restarts=5",
    "set.server.crash_loop_minutes": "Restart guard window, in minutes",
    "set.server.crash_loop_minutes.d":
      "The minutes the unclean stops above are counted in. __DEN_CLI__ config web.crash_loop_minutes=10",
    "set.server.lookup_first": "Process lookup wait",
    "set.server.lookup_first.d":
      "How long __DEN_TITLE__ waits on its first try when it asks the system which process holds a connection (lsof, ps). An agent's own calls are placed this way. __DEN_CLI__ config process_lookup.first_seconds=5",
    "set.server.lookup_retry": "Process lookup retry wait",
    "set.server.lookup_retry.d":
      "How long the second try waits when the first ran out of time. A busy machine can be slow to answer. __DEN_CLI__ config process_lookup.retry_seconds=20",
    "set.server.address_check_timeout": "Address check wait",
    "set.server.address_check_timeout.d":
      "How long __DEN_TITLE__ waits for an address to answer when it checks that the address reaches this __DEN_TITLE__, before it prints or opens it. __DEN_CLI__ config web.address_check_timeout_seconds=5",
    "set.server.address_check_retries": "Address check retries",
    "set.server.address_check_retries.d":
      "How many more times __DEN_TITLE__ asks an address that didn't answer in time. __DEN_CLI__ config web.address_check_retries=2",
    "set.server.address_check_cache": "Address check kept for",
    "set.server.address_check_cache.d":
      "How long the page banner and Edge reuse the last check of __DEN_TITLE__'s address. 0 checks on every read. __DEN_CLI__ config web.address_check_cache_seconds=60",
    "set.server.address_check_drop_after":
      "Address failures before sign-in moves back",
    "set.server.address_unknown_keep": "Address held while checks can't tell",
    "set.server.address_unknown_keep.d":
      "Once __DEN_TITLE__'s https address is proven, how long checks that can't tell (no answer in time) keep sign-in there, from its last answer. After that they count as failures, so sign-in comes back on this machine's own name. Keep it short. __DEN_CLI__ config web.address_unknown_keep_seconds=300",
    "set.server.address_check_drop_after.d":
      "Once __DEN_TITLE__'s https address is proven, the sign-in lives only there. How many checks in a row must find something else, or nothing, answering at that address before sign-in works on this machine's own name again. A check that can't tell is ignored. __DEN_CLI__ config web.address_check_drop_after=2",
    "set.server.bridge_listen": "Docker bridge, for the edge",
    "set.server.bridge_listen.d":
      "Linux only, with an edge set up here: __DEN_TITLE__ also listens on the Docker bridge's address, where the edge reaches this machine. Off: only 127.0.0.1, and the edge can't reach __DEN_TITLE__. Applies at the next start. __DEN_CLI__ config web.bridge_listen=off",
    "set.server.bridge_listen.o.auto": "Auto",
    "set.server.bridge_listen.o.off": "Off",
    "set.server.bridge_probe": "Docker bridge check, in seconds",
    "set.server.bridge_probe.d":
      "How long __DEN_TITLE__ waits for Docker to name the bridge's address at its start. It never delays the start. __DEN_CLI__ config web.bridge_probe_seconds=10",
    "set.server.owner_name_timeout": "GitHub name check at start, in seconds",
    "set.server.owner_name_timeout.d":
      "How long __DEN_TITLE__ waits at its start for the owner's name from their public GitHub profile, when it doesn't have the name yet. It never delays the start. __DEN_CLI__ config web.owner_name_timeout_seconds=10",
    "set.server.github_watch_interval":
      "GitHub watch: first interval, in seconds",
    "set.server.github_watch_interval.d":
      "How often __DEN_TITLE__'s one GitHub watcher looks at the pull requests and runs agents watch (MCP github_watch). It doubles while nothing changes, and starts again on a change. __DEN_CLI__ config github.watch_interval_seconds=60",
    "set.server.github_watch_max_interval":
      "GitHub watch: longest interval, in seconds",
    "set.server.github_watch_max_interval.d":
      "The most the GitHub watcher waits between looks while nothing changes. __DEN_CLI__ config github.watch_max_interval_seconds=300",
    "set.server.github_api_budget_floor":
      "GitHub watch: API calls kept in reserve",
    "set.server.github_api_budget_floor.d":
      "Below this many GitHub API calls left this hour, the GitHub watcher asks GitHub nothing and refuses new watches until GitHub's reset, and says so with the reset time. __DEN_CLI__ config github.api_budget_floor=500",
    "set.server.github_watches_max": "GitHub watch: watches at once",
    "set.server.github_watches_max.d":
      "How many pull requests and runs the GitHub watcher watches at once, at least, for every agent here together. When GitHub's API budget has room, it watches more. Past that, a new watch waits in a queue and starts when one finishes. __DEN_CLI__ config github.watches_max=50",
    "set.server.github_watch_stale": "GitHub watch: minutes with no progress",
    "set.server.github_watch_stale.d":
      "A watch with no progress for this many minutes ends, and its agent is told why. A check still queued or running counts as progress, up to 4 times this long with nothing changed. The bound is never shorter than twice the watch interval. A watch also ends when its pull request merges or closes, or a newer push replaces its head. __DEN_CLI__ config github.watch_stale_minutes=60",
    "set.server.github_watch_max_open": "GitHub watch: most hours open",
    "set.server.github_watch_max_open.d":
      "Any watch open this many hours ends, whatever its checks say, and its agent is told why. This catches a check that never reports. __DEN_CLI__ config github.watch_max_open_hours=24",
    "set.server.github_rerun_look":
      "GitHub watch: minutes between re-run looks",
    "set.server.github_rerun_look.d":
      "For an hour after a run's result is told, the GitHub watcher looks this often for a re-run of it, and a re-run opens the watch again. Fewer looks spend less of GitHub's hourly budget. __DEN_CLI__ config github.rerun_look_minutes=5",
    "set.server.ready_probe": "Readiness check, in seconds",
    "set.server.ready_probe.d":
      "How long one check that __DEN_TITLE__ is up waits for its answer. A busy machine answers late; a late answer still counts. __DEN_CLI__ config web.ready_probe_seconds=10",
    "set.server.start_wait": "Start wait, in seconds",
    "set.server.start_wait.d":
      "How long `web up` waits for __DEN_TITLE__ to be ready before it says it didn't start. A start that fails ends the wait at once. __DEN_CLI__ config web.start_wait_seconds=120",
    "set.server.tools_probe": "Den tools' check of this install, in seconds",
    "set.server.tools_probe.d":
      "How long an agent's Den tools wait for __DEN_TITLE__ to say it is this install before a call is refused. A busy __DEN_TITLE__ answers late; a late answer still counts. The next call checks again. __DEN_CLI__ config web.tools_probe_seconds=30",
    "set.server.gate_cpu": "Unit test runs at once, on this machine",
    "set.server.gate_cpu.d":
      "How many unit-test runs (`gate run --kind cpu`) share this machine. Unit and browser test runs wait in separate lines. Every install and repo here shares the same queue. __DEN_CLI__ gate settings --cpu-slots 2",
    "set.server.gate_cpu_beside": "Unit test runs beside a browser test run",
    "set.server.gate_cpu_beside.d":
      "How many unit-test runs may run on this machine while a browser test run does, never more than the unit test runs at once. 0: a browser test run runs alone. A browser run on a test box doesn't count. __DEN_CLI__ gate settings --cpu-slots-beside-browser 2",
    "set.server.gate_cpu_beside_release":
      "Unit test runs beside a release browser test run",
    "set.server.gate_cpu_beside_release.d":
      "How many unit-test runs may run on this machine while a release-priority browser test run does. 0 (the default): a release run runs alone, so other runs don't slow its checks. Other browser runs use the setting above. __DEN_CLI__ gate settings --cpu-slots-beside-release-browser 0",
    "set.server.gate_load_hold_per_core":
      "Hold new unit test runs over this load per core",
    "set.server.gate_load_hold_per_core.d":
      "New unit-test runs wait while this machine's 5-minute load average is over this many times its cores, but only while another unit-test run is going: with none going, the next one starts whatever the load. Release runs and runs already going never wait. Each unit-test run also gets its share of the cores in DEN_GATE_WORKERS. 0 turns the hold off. __DEN_CLI__ gate settings --load-hold-per-core 3",
    "set.server.gate_memory_free_min_percent":
      "Hold new runs here under this much free memory (%)",
    "set.server.gate_memory_free_min_percent.d":
      "New test runs on this machine (unit and browser, release ones too) wait while its free memory is under this percent, but only while another run here is going: with none going, the next one starts. Test boxes still take their runs. 0 turns the hold off. __DEN_CLI__ gate settings --memory-free-min-percent 10",
    "set.server.gate_swap_hold_gb":
      "Hold new runs here over this much swap in use (GB)",
    "set.server.gate_swap_hold_gb.d":
      "New test runs on this machine wait while the swap in use is over this many GB, but only while another run here is going: with none going, the next one starts. A machine can show plenty of free memory while swap fills. Test boxes still take their runs. 0 turns the hold off. __DEN_CLI__ gate settings --swap-hold-gb 8",
    "set.server.gate_memory_reading_keep_seconds":
      "If a memory reading fails, keep the last one for (seconds)",
    "set.server.gate_memory_reading_keep_seconds.d":
      "When free memory or swap can't be read, the last good reading stands this many seconds. After that the reading is unknown, and an unknown reading holds new runs here while another run here is going. 0 holds at once. __DEN_CLI__ gate settings --memory-reading-keep-seconds 30",
    "set.server.gate_vm_memory_share":
      "Warn when VMs promise more than this share of memory",
    "set.server.gate_vm_memory_share.d":
      "Doctor warns when the memory that running VMs (OrbStack machines, Docker's VM) have reserved adds up to more than this share of the machine's RAM. 1 is all of it; under 1 warns sooner. __DEN_CLI__ gate settings --vm-memory-share 1",
    "set.server.gate_cpu_hold_load":
      "Machine load that holds unit test runs during a release browser run",
    "set.server.gate_cpu_hold_load.d":
      "While this machine's 5-minute load average is at or above this, and a release-priority browser test run holds a browser slot, unit-test runs wait. Runs already going are never stopped. The default is the machine's cores × 4 / 3. 0 turns it off. __DEN_CLI__ gate settings --cpu-hold-load 24",
    "set.server.gate_max_start_load":
      "Machine load at which no test run starts",
    "set.server.gate_max_start_load.d":
      "While this machine's 5-minute load average is at or above this (the total, not per core), a test run that has its slot waits before it starts its command, and says why. It stays under where the machine stalls: the default is the machine's cores × 1.5. 0 turns it off. __DEN_CLI__ gate settings --max-start-load 27",
    "set.server.gate_max_start_wait_minutes":
      "Minutes a run waits for the load",
    "set.server.gate_max_start_wait_minutes.d":
      "A run held by the load starts anyway after this many minutes, and its record says it started on a busy machine. The default is 10. 0 means it waits however long. __DEN_CLI__ gate settings --max-start-wait-minutes 10",
    "set.server.gate_reap_grace_seconds": "Seconds before leftovers are killed",
    "set.server.gate_reap_grace_seconds.d":
      "When a test run ends, or its folder is deleted, whatever it started that is still running is asked to stop, then killed after this many seconds. Nothing outside the run is touched. The default is 10. __DEN_CLI__ gate settings --reap-grace-seconds 10",
    "set.server.gate_local_browser": "Browser runs at once on this machine",
    "set.server.gate_local_browser.d":
      "How many browser test runs may run on this machine at once, each in its own container. A browser run on a test box doesn't count. 1: one at a time. __DEN_CLI__ gate settings --local-browser-slots 1",
    "set.server.gate_overrun_bell":
      "Test slot in the bell past this many times its estimate",
    "set.server.gate_overrun_bell.d":
      "A test slot held this many times longer than its estimate shows in the bell under Needs you, with End. If an agent holds it, Den tells that agent once to release it. 2: twice its estimate. __DEN_CLI__ gate settings --overrun-bell-multiple 2",
    "set.server.gate_overrun": "Test run flagged past its estimate, in minutes",
    "set.server.gate_overrun.d":
      "A test run still going this long after its estimate is flagged in `gate status` and on the Agents page. It is never stopped. __DEN_CLI__ gate settings --overrun-margin-minutes 15",
    "set.server.gate_remote_renew":
      "CI runner renews its gate slot every, in seconds",
    "set.server.gate_remote_renew.d":
      "A CI job in a runner VM holds its gate slot by renewing it this often (it is told the number when it asks). __DEN_CLI__ gate settings --remote-renew-seconds 30",
    "set.server.gate_remote_lapse":
      "CI runner's gate slot taken back after, in seconds",
    "set.server.gate_remote_lapse.d":
      "A CI runner that hasn't renewed its gate slot for this long loses it, and the next in line starts. At least twice the renew time. __DEN_CLI__ gate settings --remote-lapse-seconds 120",
    "set.server.gate_remote_slots": "Gate slots one CI runner may have at once",
    "set.server.gate_remote_slots.d":
      "Held or waiting. One more ask is refused, saying why, until the runner gives one back. __DEN_CLI__ gate settings --remote-max-slots 4",
    "set.server.gate_remote_asks":
      "Asks one CI runner may have waiting at once",
    "set.server.gate_remote_asks.d":
      "Asks for a gate slot still waiting on an answer. One more is refused, saying why, until one answers. __DEN_CLI__ gate settings --remote-max-asks 4",
    "set.server.gate_priority_max": "Release priority runs at a time, per kind",
    "set.server.gate_priority_max.d":
      "A release run a person waits on, marked for release priority, goes ahead of the other waiting runs of its kind. It never stops a running one. A second such run waits behind the first. 0 turns this off. __DEN_CLI__ gate settings --priority-max 1",
    "set.server.gate_priority_pass":
      "Waiting this long, a marked release run is never passed, in minutes",
    "set.server.gate_priority_pass.d":
      "A release run with priority goes ahead of every other waiting run of its kind. Among runs marked for release priority, it never passes one that has waited this long. 0: it never passes another marked run. __DEN_CLI__ gate settings --priority-pass-limit-minutes 0",
    "set.server.gate_release_pass_other":
      "A waiting release run goes ahead of earlier runs of the other kind that have waited up to this long, in minutes",
    "set.server.gate_release_pass_other.d":
      "While a release run with priority waits, a cpu or browser run of the other kind asked before it doesn't start in a slot it needs, unless it has waited longer than this. It never stops a running one. 0: it passes none of them. __DEN_CLI__ gate settings --release-pass-other-kind-minutes 30",
    "set.server.gate_priority_agents": "Agents may ask for release priority",
    "set.server.gate_priority_agents.d":
      "On, an agent may mark a release run for an issue you reported. Off, only you can. Every jump is in the slot log, with who and why. __DEN_CLI__ gate settings --priority-agents 1",
    "set.server.gate_priority_runners":
      "CI runners may ask for release priority",
    "set.server.gate_priority_runners.d":
      "On, a CI job with a runner token may mark its run as a release run, with a reason. Off, its ask is refused and it waits in the normal queue. Every jump is in the slot log, with the runner and why. __DEN_CLI__ gate settings --priority-runners 1",
    "set.server.gate_browser_container": "Browser runs need a container",
    "set.server.gate_browser_container.d":
      "On, a browser test run on this machine must say where its browser runs: a container's Playwright endpoint (ws:// or wss://, also from DEN_PW_WS, HUB_PW_WEBKIT_WS or E2E_WEBKIT_WS), or self when the run starts its own container. A run without one is refused, so no test starts a browser on this Mac itself. On by default on macOS, off elsewhere. __DEN_CLI__ gate settings --browser-requires-container 1",
    "set.server.gate_claim": "An agent's gate slot: minutes to claim it",
    "set.server.gate_claim.d":
      "When a slot an agent waited for is granted, Den tells the agent. Not claimed within this time, it goes to the next in line and the agent goes back in line. __DEN_CLI__ gate settings --claim-minutes 3",
    "set.server.gate_mcp_renew":
      "An agent's gate slot: renew it every, in minutes",
    "set.server.gate_mcp_renew.d":
      "How often an agent holding a slot is asked to renew it while it works. __DEN_CLI__ gate settings --mcp-renew-minutes 5",
    "set.server.gate_mcp_lapse":
      "An agent's gate slot lapses unrenewed after, in minutes",
    "set.server.gate_mcp_lapse.d":
      "A slot an agent holds and doesn't renew this long, once past its estimate plus the grace, goes to the next in line. The bell says so. __DEN_CLI__ gate settings --mcp-lapse-minutes 15",
    "set.server.gate_mcp_grace":
      "An agent's gate slot: grace past its estimate, in minutes",
    "set.server.gate_mcp_grace.d":
      "An unrenewed slot keeps holding until it is this far past its estimate. __DEN_CLI__ gate settings --mcp-grace-minutes 15",
    "set.server.gate_waiter_return":
      "A waiting test run keeps its place this long after it ends, in minutes",
    "set.server.gate_waiter_return.d":
      "When a waiting test run ends without giving up its place (a restart, or its window closed), its place in line is kept this long. Run again, it takes its place back. After that, the place is let go and the run says so the next time it asks. 0: let go at once. __DEN_CLI__ gate settings --waiter-return-minutes 10",
    "set.server.gate_class_order": "Gate classes, highest first",
    "set.server.gate_class_order.d":
      "Comma-separated, for example release, lane, other. A waiting run of a higher class starts first; within a class, first come. A run that holds its slot is never stopped. Empty: first come for all. __DEN_CLI__ gate settings --class-order release,lane,other",
    "set.server.gate_class_map": "Gate class of each project",
    "set.server.gate_class_map.d":
      "Comma-separated: <project>=<class>, label:<pattern>=<class> (* matches any text), and *=<class> for every other project. Without *, the last class. __DEN_CLI__ gate settings --class-map den=lane,label:release*=release,*=other",
    "set.server.gate_class_windows": "Gate class windows",
    "set.server.gate_class_windows.d":
      "Comma-separated: <class>=HH:MM-HH:MM/<minutes>, in this machine's time. Outside its window, a run of that class estimated at least that many minutes waits while a higher-class run holds or waits; with none, it runs at once. __DEN_CLI__ gate settings --class-windows other=22:00-06:00/30",
    "set.server.gate_runners": "CI runner tokens",
    "set.server.gate_runners.d":
      "Tokens that let a CI job in a runner VM ask for, renew and give back gate slots on this machine. Nothing else. An agent asks for one and you allow it; revoke one here.",
    "set.server.gate_boxes": "Test boxes",
    "set.server.gate_boxes.d":
      "Other machines that run browser tests. Each has its own browser slots. A browser run that may use a box takes whichever slot frees first, here or on a box. A box whose hold file is there takes no new runs. One that doesn't answer is skipped, never waited on. A box with a window takes runs only within it, in this machine's time. Outside it, or turned off, Den never contacts the box; a run already on it finishes. __DEN_CLI__ gate box add <name> --ssh login@host --slots 1",
    "set.server.gate_box_check": "Test box check waits, in seconds",
    "set.server.gate_box_check.d":
      "How long Den waits for a test box to answer when a slot on it is about to be given. No answer: the box is skipped. __DEN_CLI__ gate settings --box-check-timeout-seconds 8",
    "set.server.gate_box_recheck":
      "A skipped test box is checked again after, in seconds",
    "set.server.gate_runner_entries": "CI runner entries",
    "set.server.gate_runner_entries.d":
      "Which repos' CI jobs may run on which test box: the runner labels the jobs ask for, the repo variable that routes them, how many at a time, whether each takes the box's heavy slot, and who answers for it. For now these are settings only: Den doesn't start runners yet. An agent asks to add one and you allow it. __DEN_CLI__ gate runner add <owner/repo> --box <name> --labels self-hosted --routing-variable CI_RUNNER --owner <who>",
    "set.server.gate_box_recheck.d":
      "A box that was held or didn't answer is passed over this long, then checked again the next time a slot on it is wanted. Never on a timer. __DEN_CLI__ gate settings --box-recheck-seconds 30",
    "set.server.gate_box_default": "Browser runs go to",
    "set.server.gate_box_default.d":
      "Where a browser test run with no --box goes. Here or a test box: the first free browser slot, here or on a test box. A run with no --base-url, or no box for its Playwright version, stays here and says why. Here only: as before; a run goes to a box only with --box. __DEN_CLI__ gate settings --browser-box-default any",
    "set.server.gate_box_default.any": "Here or a test box",
    "set.server.gate_box_default.local": "Here only",
    "set.server.gate_host_only": "Browser runs kept here",
    "set.server.gate_host_only.d":
      "Comma-separated: <project>, label:<pattern> (* matches any text). These browser runs never go to a test box, for example layout suites or WebKit on macOS. Empty: none. __DEN_CLI__ gate settings --browser-host-only den,label:*webkit*",
    "set.server.gate_route_agents": "Agents' heavy runs go through the gate",
    "set.server.gate_route_agents.d":
      "On, an agent's single test, typecheck or browser run takes a gate slot like any other. Off, it runs as written and is counted below. __DEN_CLI__ gate settings --route-agents 1",
    "set.server.gate_route_commands": "Programs sent through the gate",
    "set.server.gate_route_commands.d":
      'Comma-separated program names, or npm test and npm run test* (* matches any end). Empty: jest, vitest, tsc, playwright, npm test, npm run test*. __DEN_CLI__ gate settings --route-commands "jest, vitest"',
    "set.server.gate_outside": "Runs outside the gate today",
    "set.server.gate_outside.d":
      "Agents' test, typecheck and browser runs that didn't take a gate slot today: a command with more than one part, or routing off. The program and the agent are recorded, never the arguments.",
    "set.ui.outsideNone": "None today.",
    "set.ui.outsideRuns": "{n} runs",
    "set.ui.outsideRuns.one": "{n} run",
    "set.ui.outsideFailed": "Couldn't read the gate's log.",
    "set.server.crash_loop_wait": "Restart guard's longest wait",
    "set.server.crash_loop_wait.d":
      "The longest the next start waits. 0 never waits. __DEN_CLI__ config web.crash_loop_max_wait_seconds=300",
    "set.server.report_screenshot_days": "Report screenshots, kept for",
    "set.server.report_screenshot_days.d":
      "How many days __DEN_TITLE__ keeps the masked screenshot of a report filed from here, for you and this install's own agent to read (report_screenshot). Then it is deleted. __DEN_CLI__ config reports.screenshot_keep_days=30",
    "set.server.server_log_max": "Warnings log, largest size",
    "set.server.server_log_max.d":
      "While __DEN_TITLE__ runs as a service, its warnings also go to logs/server.log in its state folder, so they are still there after a restart. At this size it moves to server.log.1 (once) and starts again. __DEN_CLI__ config server_log.max_mb=20",
    "set.server.slow_request_ms": "Slow request, log after",
    "set.server.slow_request_ms.d":
      "When a request takes longer than this, __DEN_TITLE__'s log gets one line with its route, who asked, and how long it took. Never its address, query, headers or body. __DEN_CLI__ config server_log.slow_request_ms=3000",
    "set.server.event_loop_lag_ms": "Stall, log after",
    "set.server.event_loop_lag_ms.d":
      "When __DEN_TITLE__ is busy and runs nothing else for longer than this, its log gets one line saying how long. __DEN_CLI__ config server_log.event_loop_lag_ms=1000",
    "set.server.report_screenshot_max": "Report screenshots, largest kept",
    "set.server.report_screenshot_max.d":
      "The largest masked screenshot __DEN_TITLE__ keeps with a report. A larger one is refused before anything is filed. __DEN_CLI__ config reports.screenshot_max_mb=8",
    "set.server.report_screenshot_hub_max":
      "Report screenshots, largest sent to Hub",
    "set.server.report_screenshot_hub_max.d":
      "The largest masked screenshot __DEN_TITLE__ sends to Hub. A larger one is still kept here, and the report is still filed. __DEN_CLI__ config reports.hub_screenshot_max_mb=6",
    "set.server.report_screenshot_hub_wait": "Report screenshots, wait for Hub",
    "set.server.report_screenshot_hub_wait.d":
      "How long __DEN_TITLE__ waits for Hub to take a report's screenshot. After this, the screenshot is kept here, and the report is already filed. __DEN_CLI__ config reports.hub_timeout_seconds=10",
    "set.server.report_visibility_cache":
      "Report: repository visibility kept for",
    "set.server.report_visibility_cache.d":
      "How long __DEN_TITLE__ keeps whether each Report repository is public or private. After this, it asks GitHub again. __DEN_CLI__ config feedback.visibility_cache_hours=24",
    "set.server.report_visibility_wait": "Report: repository visibility wait",
    "set.server.report_visibility_wait.d":
      "How long Report waits for GitHub to say whether a repository is public or private. After this, it says not known (with the caution), and the answer shows the next time. __DEN_CLI__ config feedback.visibility_timeout_seconds=3",
    "set.server.report_visibility_retry": "Report: repository visibility retry",
    "set.server.report_visibility_retry.d":
      "When GitHub doesn't answer whether a repository is public or private, how long before Report asks again. 0 asks on every open. __DEN_CLI__ config feedback.visibility_retry_seconds=60",
    "set.agents.pane_reconnect": "Terminal reconnect tries",
    "set.agents.pane_reconnect.d":
      "A terminal whose connection drops tries again on its own, waiting longer each time. After this many failed tries within the time below, it stops and shows Reconnect. __DEN_CLI__ config panes.reconnect_max_failures=20",
    "set.agents.pane_reconnect_window": "Terminal reconnect window",
    "set.agents.pane_reconnect_window.d":
      "The time the failed tries above are counted in. __DEN_CLI__ config panes.reconnect_window_seconds=300",
    "set.agents.pane_reconnect_wait": "Longest wait between tries",
    "set.agents.pane_reconnect_wait.d":
      "The first try waits 1 s, and each wait doubles, up to this. __DEN_CLI__ config panes.reconnect_max_seconds=30",
    "set.agents.shell_path_wait": "Shell PATH wait",
    "set.agents.shell_path_wait.d":
      "How long __DEN_TITLE__ waits for your shell to say its PATH when it looks for agent CLIs: the PATH a new shell gets, startup files and all. After this, it looks in the usual places instead. __DEN_CLI__ config agents.shell_path_timeout_seconds=10",
    "set.agents.draft_hold_max": "Draft hold before the bell",
    "set.agents.draft_hold_max.d":
      "While you have an unsent message typed into an agent's terminal, __DEN_TITLE__ holds what it would type there, and never sends your draft. After this long, the bell says messages are waiting. __DEN_CLI__ config agents.draft_hold_max_minutes=30",
    "set.agents.max_concurrent": "Agents at once",
    "set.agents.max_concurrent.d":
      "How many agents may run at once on this machine. Plain terminals never count. A start past this is refused, and says so. This wins over the distribution's value. __DEN_CLI__ config agents.max_concurrent=4",
    "set.agents.max_per_project": "Agents per project",
    "set.agents.max_per_project.d":
      "How many agents one project may run at once. 0 means no limit beyond Agents at once. A project may set a lower value of its own (agents.max_per_project in its entry in workspaces.yml). A start past this is refused, and says which cap holds it. __DEN_CLI__ config agents.max_per_project=10",
    "set.agents.list_host_wait": "Terminal host wait",
    "set.agents.list_host_wait.d":
      "How long the Agents list waits for the terminal host. After this, the list says it couldn't reach it and tries again. __DEN_CLI__ config agents_list.host_timeout_seconds=10",
    "set.server.sessions_max": "Terminals at once",
    "set.server.sessions_max.d":
      "How many plain terminals may run at once. Agents never count. A new one past this is refused, and says so. __DEN_CLI__ config sessions.max_concurrent=8",
    "set.server.sessions_close_grace": "Terminal close grace",
    "set.server.sessions_close_grace.d":
      "How long a terminal has to end after you close it before it is stopped by force. __DEN_CLI__ config sessions.close_grace_seconds=5",
    "set.server.sessions_pty_close": "Terminal close after exit",
    "set.server.sessions_pty_close.d":
      "How long after a terminal's program ends its terminal is closed. 0 closes it at once. Its scrollback stays readable either way. Applies when the terminal host next starts. __DEN_CLI__ config sessions.pty_close_seconds=0",
    "set.server.sessions_pty_warn": "Terminal count warning",
    "set.server.sessions_pty_warn.d":
      "Doctor fails when the terminal host holds more terminals than this. __DEN_CLI__ config sessions.pty_warn_above=400",
    "set.server.sessions_pty_machine": "Machine terminal warning, in percent",
    "set.server.sessions_pty_machine.d":
      "Doctor fails when the terminals in use on this machine reach this share of its limit. __DEN_CLI__ config sessions.pty_machine_warn_percent=90",
    "set.agents.hook_wait": "Agent hook wait",
    "set.agents.hook_wait.d":
      "How long an agent's hooks wait for __DEN_TITLE__ on each try when they tell it the agent needs you, or check the Hub inbox. A busy machine can be slow to answer. Applies when an agent next starts. __DEN_CLI__ config agent_hooks.timeout_seconds=20",
    "set.agents.hook_retries": "Agent hook retries",
    "set.agents.hook_retries.d":
      "How many more times an agent's hook tries when __DEN_TITLE__ didn't answer in time or turned the call away. Applies when an agent next starts. __DEN_CLI__ config agent_hooks.retries=2",
    "set.agents.hook_backoff": "Agent hook pause",
    "set.agents.hook_backoff.d":
      "How long an agent's hook waits before its first retry. Each later pause doubles. Applies when an agent next starts. __DEN_CLI__ config agent_hooks.backoff_seconds=1",
    "set.agents.compaction_loop": "Compacting repeatedly: compactions",
    "set.agents.compaction_loop.d":
      "How many automatic compactions an agent may have within the minutes below before the bell says it is compacting repeatedly. One bell per episode. __DEN_CLI__ config agent_context.compaction_loop_count=3",
    "set.agents.compaction_minutes": "Compacting repeatedly: minutes",
    "set.agents.compaction_minutes.d":
      "The window the compactions above are counted in. __DEN_CLI__ config agent_context.compaction_loop_minutes=10",
    "set.agents.compaction_pause": "Hold deliveries after a compaction loop",
    "set.agents.compaction_pause.d":
      "On: once the bell says an agent is compacting repeatedly, new deliveries to it (Hub comments, notes) wait until a person clears it on the Agents page. Off (the default): they go as usual. __DEN_CLI__ config agent_context.pause_after_loop=true",
    "set.agents.instruction_share": "Instruction files: warn above",
    "set.agents.instruction_share.d":
      "When the instruction files an agent loads at start (CLAUDE.md, AGENTS.md and the like, up its folders) are more than this share of its model's context, its row and doctor warn, naming the largest. Sizes are estimated as bytes / 4 tokens. __DEN_CLI__ config agent_context.instruction_share_percent=15",
    "set.agents.context_tokens": "Context size when unknown",
    "set.agents.context_tokens.d":
      "The context size, in tokens, the share above is taken of when __DEN_TITLE__ doesn't know the model's own. __DEN_CLI__ config agent_context.context_tokens=200000",
    "set.agents.list_refresh_wait": "Agents list wait",
    "set.agents.list_refresh_wait.d":
      "How long the Agents page waits for its list. After this, it says the list may be out of date and tries again. __DEN_CLI__ config agents_list.refresh_timeout_seconds=15",
    "set.server.address": "__DEN_TITLE__'s address",
    "set.server.address.d":
      "The address people and other devices open this __DEN_TITLE__ at, for example https://__DEN_CLI__.local.example.com. Check and save asks it to answer first, and saves only if it does. Same as __DEN_CLI__ web url.",
    "addr.now": "Set: {url}",
    "addr.unset": "Not set. The links __DEN_TITLE__ gives people need it.",
    "addr.label": "Address",
    "addr.check": "Check and save",
    "addr.checkW": "Checking that {url} answers",
    "addr.saved": "Saved: {url} answered.",
    "addr.notSaved": "Not saved. The old address stays.",
    "addr.empty": "Type an address first.",
    "addr.loopback":
      "{url} only opens on this machine: other devices can't reach it.",
    "addr.adopt": "Make {alias} __DEN_TITLE__'s address",
    "addr.adopted": "Saved: {url} is the address now.",
    "set.workspace.approvals_policy": "Agents' writes here",
    "set.workspace.approvals_policy.d":
      "What an agent in this project may do without your Allow, over Agent writes. A write that widens what an agent may do, touches secrets, deletes data or spends money always asks.",
    "set.workspace.approvals_policy.o.install": "As everywhere",
    "set.workspace.approvals_policy.o.auto": "Run, no note",
    "set.workspace.approvals_policy.o.notify": "Run and tell me",
    "set.workspace.approvals_policy.o.ask": "Ask me",
    "set.workspace.approvals_watch": "Watched here",
    "set.workspace.approvals_watch.d":
      "An agent's write on any of these asks you first, whatever its kind. Comma-separated: project:<name>, repo:<name>, service:<repo>/<name>, persona:<id>, agent:<id>, or a bare name.",
    "set.workspace.approvals_critical": "Critical here",
    "set.workspace.approvals_critical.d":
      "Kinds of agent write that always ask you in this project. Comma-separated, for example repo_clone, service_try.",
    "set.agents.approvals_policy": "Agent writes",
    "set.agents.approvals_policy.d":
      "What an agent may do without your Allow. Run and tell me: it runs, and your updates say so. A write that widens what an agent may do, touches secrets, deletes data or spends money always asks, as does one on something you watch or pinned.",
    "set.agents.approvals_policy.o.auto": "Run, no note",
    "set.agents.approvals_policy.o.notify": "Run and tell me",
    "set.agents.approvals_policy.o.ask": "Ask me",
    "set.agents.approvals_watch": "Watched",
    "set.agents.approvals_watch.d":
      "An agent's write on any of these asks you first, whatever its kind; so does one on a repo or service you pinned. Comma-separated: project:<name>, repo:<name>, service:<repo>/<name>, persona:<id>, agent:<id>, or a bare name.",
    "set.agents.approvals_critical": "Critical",
    "set.agents.approvals_critical.d":
      "Kinds of agent write that always ask you, in every project. Comma-separated, for example repo_clone, service_try.",
    "set.server.health_poll": "Health checks while you look",
    "set.server.health_poll.d":
      "How often an open, visible page checks every service's health: 2 to 300 seconds. __DEN_CLI__ config health_poll.visible_seconds=5",
    "set.server.health_poll_hidden": "Health checks in a hidden tab",
    "set.server.health_poll_hidden.d":
      "How often a page in a hidden tab checks health: 10 to 3600 seconds. With no page in view, the checks run at most this often. Back in view, the page checks at once. __DEN_CLI__ config health_poll.hidden_seconds=60",
    "set.server.git_reads": "Git reads at once",
    "set.server.git_reads.d":
      "How many git processes Den runs at once when a page reads its repos, such as the Tests page's branch and commit: 1 to 64. __DEN_CLI__ config git_reads.at_once=16",
    "set.agents.held_wait": "Requests wait for your Allow",
    "set.agents.held_wait.d":
      "How long an agent's request waits for your Allow before it lapses: 10 minutes to 7 days (10080). It stays in the bell the whole time, and survives a restart. Allowing an old one checks it again first. __DEN_CLI__ config held_writes.wait_minutes=1440",
    "set.server.install_mode": "This install is",
    "set.server.install_mode.d":
      "Personal: one person's own machine. Agents run outside the sandbox, so Docker, sockets and your tools work, and they change settings without asking, except money, deleting, security and acting on others. Strict: for a company's install or a shared machine. The sandbox is on, and agents' writes follow your approval policy. A setting you made yourself stays as you set it. __DEN_CLI__ config install_mode=strict",
    "set.server.install_mode.o.personal": "Personal",
    "set.server.install_mode.o.strict": "Strict",
    "set.agents.settings_limits":
      "Agents changing settings: Limits and performance",
    "set.agents.settings_limits.d":
      "Caps, timeouts and intervals: how many agents at once, how long Den waits. A change made without asking is noted in the audit, and your updates say so.",
    "set.agents.settings_limits.o.auto": "Change without asking (tell me)",
    "set.agents.settings_limits.o.ask": "Ask me",
    "set.agents.settings_limits.o.never": "Never",
    "set.agents.settings_look": "Agents changing settings: Look and layout",
    "set.agents.settings_look.d":
      "How Den looks and tells you: tabs, the rail, alerts and quiet hours. A change made without asking is noted in the audit, and your updates say so.",
    "set.agents.settings_look.o.auto": "Change without asking (tell me)",
    "set.agents.settings_look.o.ask": "Ask me",
    "set.agents.settings_look.o.never": "Never",
    "set.agents.settings_integrations":
      "Agents changing settings: Integrations",
    "set.agents.settings_integrations.d":
      "Editors, terminals, runtimes, Hub and GitHub. A change made without asking is noted in the audit, and your updates say so.",
    "set.agents.settings_integrations.o.auto":
      "Change without asking (tell me)",
    "set.agents.settings_integrations.o.ask": "Ask me",
    "set.agents.settings_integrations.o.never": "Never",
    "set.agents.settings_network":
      "Agents changing settings: Network and access",
    "set.agents.settings_network.d":
      "Den's address, the edge, sign-in limits and embedding. A change made without asking is noted in the audit, and your updates say so.",
    "set.agents.settings_network.o.auto": "Change without asking (tell me)",
    "set.agents.settings_network.o.ask": "Ask me",
    "set.agents.settings_network.o.never": "Never",
    "set.agents.settings_agent_powers":
      "Agents changing settings: Agent powers",
    "set.agents.settings_agent_powers.d":
      "The sandbox, grants, approvals, secrets and the install's mode. These always ask you, or are refused. A change made without asking is noted in the audit, and your updates say so.",
    "set.agents.settings_agent_powers.o.ask": "Ask me",
    "set.agents.settings_agent_powers.o.never": "Never",
    "set.server.restore_services": "Bring back services after a restart",
    "set.server.restore_services.d":
      "On, after the machine or __DEN_TITLE__ restarts, the services that were up come back by themselves, a few at a time. A service you stopped stays stopped. The bell says what came back. __DEN_CLI__ config services.restore_on_boot=true",
    "set.agents.resume_batch": "Agents restarted at a time",
    "set.agents.resume_batch.d":
      "After a restart, or when Hub's tools change, agents restart this many at a time; the ones that were working go first. 0 restarts every agent at once. __DEN_CLI__ config agents.resume.batch=4",
    "set.agents.resume_gap": "Wait between restart batches",
    "set.agents.resume_gap.d":
      "How long the next batch of agent restarts waits after one starts. __DEN_CLI__ config agents.resume.gap_seconds=30",
    "set.agents.resume_load": "Load that holds restarts",
    "set.agents.resume_load.d":
      "While the machine's 1-minute load is over this, the next batch of agent restarts waits. 0: no limit. The default is the number of cores × 2. __DEN_CLI__ config agents.resume.load_ceiling=16",
    "set.agents.resume_max_wait": "Longest a restart waits for the load",
    "set.agents.resume_max_wait.d":
      "Once an agent has waited this long, its batch restarts even if the load is still high, a few at a time as before. 0: the load may hold restarts as long as it stays high. __DEN_CLI__ config agents.resume.max_wait_seconds=600",
    "set.agents.issue_writes": "Who writes GitHub issues",
    "set.agents.issue_writes.d":
      "The roles whose agents may create issues, comment, label and set milestones in their own project's GitHub repos, at once and recorded. Comma-separated; empty: none. Unset: planner, orchestrator, lead, sde, builder, reviewer and install (__DEN_TITLE__'s own agent). __DEN_CLI__ config agents.issue_writes=[planner,sde]",
    "set.agents.issue_writes_per_hour": "GitHub issue writes an hour",
    "set.agents.issue_writes_per_hour.d":
      "How many issue writes all agents together may make in an hour. Past it, an agent is told how long to wait. __DEN_CLI__ config agents.issue_writes_per_hour=60",
    "set.agents.issue_writes_visibility_minutes":
      "Recheck a repo's visibility after",
    "set.agents.issue_writes_visibility_minutes.d":
      "Text an agent files in a public repo, or one whose visibility isn't known, is checked for listed names first. This is how many minutes a repo's visibility is kept before GitHub is asked again, so a repo made public is checked soon after. 1 to 1440. __DEN_CLI__ config agents.issue_writes_visibility_minutes=10",
    "set.agents.issue_writes_public": "Agents write issues in public repos",
    "set.agents.issue_writes_public.d":
      "On, agents may create issues and comments in public repos. Their text is first checked for listed names, and the footer names no agent or install. Off, a write to a public repo is refused. Turning it on needs your Allow. __DEN_CLI__ config agents.issue_writes_public=false",
    "ap.do.agent_import":
      'Bring in conversation {session} as a {persona} agent of project "{project}"',
    "ap.do.approval_policy":
      "Change the approval policy for every project to {to}",
    "ap.do.approval_policy.project":
      "Change project {where}'s approval policy to {to}",
    "ap.do.pr_close": "Close pull request {pr} on {repo}: {comment}",
    "set.agents.default_mode": "Agents' mode: Den-wide default",
    "set.agents.default_mode.d":
      "The mode every agent runs in, the __DEN_TITLE__ agent too, unless its project overrides it. Which wins: an agent's own setting, then the project, then the Den-wide default, then its persona. A change reaches running agents after their turn, on its own.",
    "set.agents.default_mode.o.persona": "Each persona's",
    "set.agents.default_mode.o.ask": "Ask for everything",
    "set.agents.default_mode.o.edits": "Auto-approve edits",
    "set.agents.default_mode.o.auto": "Auto mode",
    "set.agents.default_mode.o.all": "Auto-approve all",
    "set.agents.layout": "Agents tab layout",
    "set.agents.coach_counts": "Coach tab: show counts as",
    "set.agents.keep_running": "Keep agents running after logout",
    "set.cli.local_dev": "Local environment",
    "set.cli.cli_tabs": "Terminal tabs",
    "set.cli.log_window_lines": "Log pane lines",
    "set.cli.web_port": "Your web port",
    "set.server.restart": "Restart Den",
    "set.cli.signin": "Browser sign-in",
    "set.cli.sudo": "Admin password",
    "set.cli.op_token": "1Password token source",
    "set.access.owner": "Owner",
    "set.access.devices": "Linked devices",
    "ident.toast": "This device is signed in to {name} on {host}",
    // The install owner's role, beside their GitHub identity (the account entry's data).
    "acct.roleOwner": "Owner",
    "set.access.waiting": "Waiting devices",
    "set.embed.url_max": "Longest link context",
    "set.embed.app_keys": "App keys",
    "set.embed.app_key_audit": "App key reads in one activity line",
    "set.embed.origins": "Web apps that may embed agents",
    "set.embed.key_minutes": "Embedded pane's permission lasts",
    "set.embed.context_max_kb": "Largest shared page",
    "set.access.machine_name": "Machine name",
    "set.access.approveNeedsBrowser":
      "Approving a device needs a signed-in browser. Sign in again on this page, then approve it.",
    "set.access.approveNotAgent":
      "Only a person approves a device, from their own signed-in browser.",
    "set.access.wrongCode":
      "That code doesn't match the one on that computer's screen. Check it and type it again.",
    "set.access.tooManyTries": "Too many tries. Wait a minute and try again.",
    "set.access.ended": "That request ended or expired. Nothing was allowed.",
    "set.access.pair": "Pair a device",
    "set.access.pair_requests": "New sign-in requests per address, a minute",
    "set.access.pair_requests.d":
      "How many new devices one address may ask to sign in a minute. More are turned away until the minute is up. __DEN_CLI__ config web.pair_requests_per_minute=30",
    "set.access.approve_attempts": "Wrong codes allowed when approving",
    "set.access.approve_attempts.d":
      "How many wrong codes approving a device may take in the window below before it waits. __DEN_CLI__ config web.approve_attempts=10",
    "set.access.approve_window": "Wrong-code window, in seconds",
    "set.access.approve_window.d":
      "How long wrong codes are counted for. Once it passes, approving can be tried again. __DEN_CLI__ config web.approve_window_seconds=30",
    "set.access.agent_view": "Agents may view pages, read-only",
    "set.access.agent_view.d":
      "On, an agent running here may open these pages read-only, as itself, to look or take a screenshot (page_view). It changes nothing, and each page it opens is logged with its name. Off, the agent is told views are off. __DEN_CLI__ config web.agent_view=true",
    "set.access.agent_view_minutes": "An agent's view lasts, in minutes",
    "set.access.agent_view_minutes.d":
      "How long an agent's read-only view of these pages lasts, then it ends. __DEN_CLI__ config web.agent_view_minutes=10",
    "set.access.sessions_lock_wait":
      "Sign-in waits for the sign-ins file, in ms",
    "set.access.sessions_lock_wait.d":
      "How long a sign-in waits while another command changes the sign-ins file, then it asks to try again. __DEN_CLI__ config web.sessions_lock_wait_ms=2000",
    "set.access.test_installs_here": "Test installs on this computer",
    "set.access.test_install": "Test install",
    "set.distribution.brand": "Product name",
    "set.distribution.github_org": "GitHub org",
    "set.distribution.orgs": "Org labels",
    "set.distribution.web_port": "Web port",
    "set.distribution.environments": "Environments",
    "set.distribution.domain": "Edge domain",
    "err.retry": "Retry",
    "err.copy": "Copy details",
    "err.copied": "Copied",
    // The Workspaces page's Agents section (AG-4a, agents-section.js).
    "ag.title": "Agents",
    "ag.caption": "Agents in {ws}",
    "ag.count": "{n} agents",
    "ag.count.one": "{n} agent",
    "ag.col.agent": "Agent",
    "ag.col.runtime": "Runtime",
    "ag.col.state": "State",
    "ag.col.cwd": "Directory",
    "ag.col.started": "Started",
    "ag.col.actions": "Actions",
    "ag.listFailed": "Couldn't list this project's agents: {err}",
    "ag.loading": "Loading agents…",
    "ag.none": "No agents in this project yet",
    "ag.personaOf": "persona {persona}",
    "ag.state.running": "running",
    "ag.state.stopping": "stopping…",
    "ag.state.stopped": "stopped",
    "ag.state.ended": "ended",
    "ag.state.exited": "exited",
    "ag.state.exitedCode": "exited ({code})",
    "ag.stop": "Stop",
    "ag.closeShell": "Close shell",
    "ag.closeShellTip": "End this shell and anything running in it",
    "ag.newShell": "New terminal",
    "ag.newShellTip": "Start another shell in this project's folder",
    "ag.shellClosed": "Closed {id}",
    "ag.resume": "Resume",
    "ag.stopName": "Stop {id}",
    "ag.resumeName": "Resume {id}",
    "ag.start": "+ Start agent",
    "ag.persona": "Persona",
    "ag.runtime": "Runtime",
    "ag.runtime.auto": "The persona's",
    "ag.runtime.default": "{name} (persona default)",
    "ag.unavailable": "unavailable",
    "ag.go": "Start",
    "ag.cancel": "Cancel",
    "ag.started": "Started agent {id}",
    "ag.stopped": "Stopped agent {id}",
    "ag.stillStopping": "{id} is still stopping",
    "ag.resumedFresh": "{id}: nothing to resume yet; started fresh",
    "ag.resumedHandoff":
      "{id}: its conversation was never written; started fresh from its last handoff",
    "ag.inactive": "Project {ws} isn't active",
    "ag.otherTabs.one": "{n} tab from other projects hidden",
    "ag.otherTabs": "{n} tabs from other projects hidden",
    "ag.showAllActive": "Show in All active",
    "ag.switchedTo": "Switched to {ws}",
    "ag.backTo": "Back to {ws}",
    "ag.pickIn": "Pick an agent in {ws}",
    "ag.switchWs": "Switch to {ws}",
    "ag.unknownWs": "(no project has that name)",
    "ag.resumed": "Resumed agent {id}",
    "ag.state.interrupted": "interrupted",
    "ag.why.stopped": "Stopped by you {time}",
    "ag.why.interrupted": "Interrupted: {name} restarted",
    "ag.why.restartFailed": "Didn't come back after a restart: {why}",
    "ag.why.trustDeclined":
      "Didn't start: this folder isn't trusted. Resume and choose Yes.",
    "ag.why.exited": "Exited",
    "ag.why.exitedCode": "Exited (code {code})",
    "ag.fresh": "Start fresh",
    "ag.freshName": "Start {id} fresh",
    "ag.startedFresh": "Started {id} fresh",
    "ag.remove": "Remove",
    "ag.removed": "Removed {id}",
    "ag.removeShell": "Remove {id}",
    "ag.clearedMany": "Removed {n} from Stopped",
    "ag.clearedMany.one": "Removed {n} from Stopped",
    "ag.removedMany": "Removed {n} stopped agents",
    "ag.removedMany.one": "Removed {n} stopped agent",
    "ag.undo": "Undo",
    "ag.restored": "Back in the list: {ids}",
    "ag.clear": "Clear stopped",
    "ag.noResume": "{runtime} can't resume a conversation",
    // Session rotation (den#4).
    "ag.rot.ready": "Ready to relaunch ({why})",
    "ag.rot.due": "Handoff due ({why})",
    "ag.rot.compactions": "{n} compactions",
    "ag.rot.compactions.one": "{n} compaction",
    "ag.rot.merged": "PR merged",
    "ag.rot.noHandoff":
      "It rotated ({why}), but it wrote no handoff.md. Resume it to write one, or start fresh.",
    "ag.rot.badHandoff":
      "It rotated ({why}), but its handoff.md is not complete. Resume it to fix it, or start fresh.",
    "ag.relaunch": "Relaunch now",
    "ag.relaunchName": "Relaunch {id} now",
    "ag.relaunched": "Relaunched {id} from its handoff",
    "ag.relaunchHandoff": "Relaunch from its last handoff",
    "ag.rc.autoAsk":
      "Due ({why}). Den asks it for its handoff when it is idle, then relaunches it.",
    "ag.rc.waiting.one":
      "Due ({why}). Den waits for the {n} background task it started to finish, then rotates it.",
    "ag.rc.waiting":
      "Due ({why}). Den waits for the {n} background tasks it started to finish, then rotates it.",
    "ag.rc.autoReady":
      "Due ({why}). Its handoff is ready: Den relaunches it when it is idle.",
    "ag.rc.ready": "Due ({why}). Its handoff is ready.",
    "ag.rc.missing": "Due ({why}). It has no handoff yet.",
    "ag.rc.bad": "Due ({why}). Its handoff is not complete.",
    "ag.rc.fellBack": "Due ({why}). It wrote no handoff after 2 asks.",
    "ag.rc.wanted":
      "Due ({why}). Den relaunches it once its handoff is written.",
    "ag.rc.write": "Write handoff",
    "ag.rc.writeName": "Ask {id} to write its handoff",
    "ag.rc.keep": "Keep this conversation",
    "ag.rc.keepName": "Keep {id}'s conversation",
    "ag.rc.never": "Don't ask again for this agent",
    "ag.rc.settings": "Settings",
    "ag.rc.from":
      "Rotates after {n} compactions ({src}); when due: {mode} ({src2})",
    "ag.rc.fellBackBad":
      "Due ({why}). Its handoff still fails the check after 2 asks.",
    "ag.rc.from.one":
      "Rotates after {n} compaction ({src}); when due: {mode} ({src2})",
    "ag.rc.fromNever": "Never rotates ({src}); when due: {mode} ({src2})",
    "ag.rc.midTurn": "{id} is mid-turn: ask again when its turn ends",
    "ag.rc.neverN": "never",
    "ag.rc.mode.auto": "relaunch by itself",
    "ag.rc.mode.ask": "ask",
    "ag.rc.mode.off": "nothing",
    "ag.rc.menu": "Rotation settings",
    "ag.rr.item": "Resume after a restart",
    "ag.rr.default": "persona's",
    "ag.rr.on": "{id} resumes on its own after a restart",
    "ag.rr.off": "{id} stays stopped after a restart",
    "ag.rc.noState": "No rotation yet: it counts from its next start.",
    "ag.rc.asked": "Asked {id} for its handoff",
    "ag.rc.askedRelaunch":
      "Asked {id} for its handoff. Den relaunches it once it passes.",
    "ag.rc.askedResumed":
      "Resumed {id} to write its handoff. Den relaunches it once it passes.",
    "ag.rc.kept": "Kept {id}'s conversation: its count starts again",
    "ag.rc.keptNever": "Kept {id}'s conversation: it won't rotate again",
    "ag.rc.autoRelaunched":
      "Relaunched {id} from its handoff after {why}. The old conversation {old} is kept.",
    "ag.interrupted": "{n} agents were interrupted when {name} restarted",
    "ag.interrupted.one": "{n} agent was interrupted when {name} restarted",
    "ag.resumeAll": "Resume all",
    "ag.review": "Review",
    "ag.resumedAll": "Resumed {n} agents",
    "ag.resumedAll.one": "Resumed {n} agent",
    "pe.configFirst": "Fix the config first: the personas are read from it.",
    "ag.new.title": "Start an agent",
    "rt.missingLine": "Not found on this machine:",
    "rt.install": "Install…",
    // The Start dialog and personas (AG-10 to AG-13).
    "ag.new.what": "What's a persona?",
    "ag.new.details": "Details: {n}",
    "ag.new.hide": "Hide details",
    "ag.new.newP": "+ New persona",
    "ag.new.plain": "Plain shell",
    "ag.new.plainP": "A terminal in the project folder. No agent.",
    "ag.new.task": "First instruction (optional)",
    "ag.new.name": "Name (optional)",
    "ag.new.as": "Starts as {id}",
    "ag.new.openRunning": "Open the running one",
    "ag.new.isRunning": "{id} is already running",
    "ag.new.openIt": "Open it",
    "ag.new.isStopped": "{id} is stopped",
    "ag.new.resumeIt": "Resume it",
    "ag.new.orNext": "or Start makes {id}",
    "ag.new.taskPh":
      "e.g. Take the empty-state story. Match the design and add a test.",
    "ag.new.adv": "Advanced: model and permissions",
    "ag.new.advNote":
      "Defaults come from the persona. Changes here apply to this agent only, and the agent is marked in the list.",
    "ag.new.model": "Model",
    "ag.new.modelDef": "Persona default ({m})",
    "ag.new.ver": "Version",
    "ag.new.verDef": "Persona default ({v})",
    // AG-17.1, Bring in.
    "ag.bring": "Bring in",
    "ag.bring.title": "Bring in a conversation",
    "ag.bring.conv": "Conversation",
    "ag.bring.help":
      "Conversations started outside Den in this project's folder or its repos' folders, newest first.",
    "ag.bring.none":
      "No conversations started outside Den in this project's folder or its repos' folders.",
    "ag.bring.untitled": "Untitled conversation",
    "ag.bring.outside": "Started outside any project",
    "ag.bring.outsideHelp":
      "These ran in a folder outside every project, your home folder say. Bring one in and it runs there, in the folder shown under it, as an agent of this project.",
    "ag.outside": "started in {folder} (outside the project)",
    "ag.bring.open": "Open elsewhere",
    "ag.bring.openTip": "Still open in another terminal. Close it there first",
    "ag.bring.agent": "Agent {id}",
    "ag.bring.note":
      "Continues it in the folder it ran in, with Den's tools and guards from now on. It keeps running if you close the pane. Close it in any other terminal first: Den only sees a conversation as open if it was written in the last minute.",
    "ag.keep.model": "Keeps {m} from the conversation.",
    "ag.keep.modelNew": "Runs on {m} from now on.",
    "ag.keep.from":
      "From now on it works as {p}: its role, its permissions ({mode}), Den's tools and guards. Its history stays.",
    "ag.keep.lost":
      "It won't have: {s}. Den runs agents with Den's tools only.",
    "ag.keep.opt": "Keep {m}",
    "ag.keep.optNone": "Keep the model it runs",
    "ag.keep.advNote":
      "The model it runs stays unless you pick another here. Permissions come from the persona.",
    "ag.pc.item": "Change persona…",
    "ag.pc.title": "Change {id}'s persona",
    "ag.pc.note":
      "Den stops it and resumes the same conversation as the new persona. Its id, name, folder and tab stay.",
    "ag.pc.go": "Change persona",
    "ag.pc.current": "current",
    "ag.pc.busy": "It's working. Change after this turn, or stop it now?",
    "ag.pc.after": "After this turn",
    "ag.pc.now": "Stop it now",
    "ag.pc.fresh":
      "{id} is now {p}: nothing to resume yet; started fresh (same conversation id, folder and scope)",
    "ag.freshLine":
      "Nothing to resume yet; started fresh (same conversation id, folder and scope)",
    "ag.pc.done": "{id} is now {p}",
    "ag.pc.pending": "{id} becomes {p} when this turn ends",
    "ag.more": "More for {id}",
    "ag.chip.stopped": "Stopped",
    "ag.chip.exited": "Exited",
    "ag.chip.interrupted": "Interrupted",
    "agc.label": "Message to {name}",
    "agc.hint": "Nothing is sent until you press Send.",
    "agc.send": "Send",
    "agc.close": "Close",
    "agc.empty": "Write a message first.",
    "agc.sending": "Sending…",
    "agc.sent": "Sent to {name}.",
    "agc.failed": "Not sent: {e}",
    "agc.stopped": "{name} is stopped. Resume it, then open the link again.",
    "emb.open": "Open in __DEN_TITLE__",
    "emb.waiting": "Waiting for the page around this pane.",
    "emb.signin": "Sign in to __DEN_TITLE__",
    "emb.signinWhy": "Sign in to __DEN_TITLE__ to use this agent here.",
    "emb.connecting": "Connecting…",
    "emb.failed": "Something went wrong: {e}",
    "emb.notFramed":
      "This pane belongs inside another web app's page. Open the agent in __DEN_TITLE__ instead.",
    "emc.title": "Allow a web app",
    "emc.how":
      "It can put a page in the agent's message box. Nothing is sent until you press Send there. The permission lasts a short time.",
    "emc.what": "Let {origin} use agent {agent} in project {project}?",
    "emc.allow": "Allow",
    "emc.cancel": "Cancel",
    "emc.noOpener": "Open this from the agent pane inside the other web app.",
    "emc.done": "Allowed. This window closes now.",
    "agc.shared": "Pages shared with this message",
    "agc.removeShared": "Remove {title}",
    "emb.tooLarge":
      "This page is {size} KB, more than the {max} KB limit, so it was not added. Settings › Embedding sets the limit.",
    "emb.badShared":
      "A shared page must be text: an address, a title, and text or HTML.",
    "emb.badUrl": "A shared page needs an http or https address.",
    "ag.link.none": "No agent {id} here. It may have been removed.",
    "ag.apiOnly": "API only: {names}",
    "ag.apiOnlyTip":
      "This agent reaches {names} only through its API. Den blocks docker exec into it, its volumes and its data, and logs each try. A guardrail, not a security boundary.",
    "ag.apiOnlyOff": "API-only not enforced",
    "ag.apiOnlyOffTip":
      "This runtime has no hook Den can use, so it isn't held to {names}' API. Use den-claude for agents that must be.",
    "ag.mcp.adds": "Hub tools arrive on restart",
    "ag.mcp.addsTip":
      "Hub was connected after this agent started, so it doesn't have Hub's tools yet. Restart keeps its conversation and waits for its turn to end.",
    "ag.mcp.drops": "Hub tools go on restart",
    "ag.mcp.dropsTip":
      "Hub was disconnected after this agent started; its Hub tools no longer work. Restart keeps its conversation and waits for its turn to end.",
    "ag.mcp.reloading": "Restarting to load Hub's tools",
    "ag.mcp.reloadingTip":
      "Hub's tools changed. Den restarts this agent at its next idle so it can use them. It keeps its conversation.",
    "ag.mcp.failed": "Hub's tools didn't load",
    "ag.mcp.failedTip":
      "This agent couldn't load Hub's tools when it started ({error}), so it can't be reached on Hub. Restart keeps its conversation and waits for its turn to end.",
    "ag.mcp.den": "Den {to}'s tools arrive on restart",
    "ag.mcp.denTip":
      "Den was updated to {to} after this agent started, so its Den tools still run {from}'s code. Restart loads {to}'s, at its next idle, on the same conversation.",
    "ag.mcp.restart": "Restart",
    "ag.mcp.restartName": "Restart {id} at its next idle",
    "ag.by.label": "Show the list",
    "ag.by.need": "By need",
    "ag.by.project": "By project",
    "ag.by.group": "By group",
    "ag.grp.noHub": "Groups come with Den Hub.",
    "ag.grp.connect": "Connect Den Hub",
    "ag.grp.notInPlan": "Groups aren't in this company's Den Hub plan.",
    "ag.grp.openHub": "Open Hub",
    "ag.grp.guest":
      "You're a guest in this Hub company, so its groups aren't shown here.",
    "ag.grp.unreachable": "Can't reach Den Hub, so groups aren't shown.",
    "ag.grp.retry": "Try again",
    "ag.grp.noGroups": "No groups yet",
    "ag.grp.openGroups": "Open Groups in Hub",
    "ag.grp.lead": "Lead: {name}",
    "ag.grp.open": "Open {group} in Hub",
    "ag.grp.message": "Message group",
    "ag.grp.messageName": "Message {group} in Hub",
    "ag.grp.empty": "None of its members run on this Den.",
    "ag.grp.notIn": "Not in a group",
    "ag.mcp.restarting":
      "{id} restarts at its next idle, in the same conversation.",
    "ag.det.label": "Details for {id}",
    "ag.det.close": "Close",
    "ag.det.where": "Where",
    "ag.det.ended": "How it ended",
    "ag.det.lastLine": "Its last line",
    "ag.det.lastAsk": "Last ask",
    "ag.det.noAsk": "Nothing asked yet",
    "ag.det.reading": "Reading…",
    "ag.det.compactions": "{n} compactions in this conversation",
    "ag.det.output": "Show its output",
    "ag.det.handoffDue": "Handoff due ({why})",
    "ag.stoppedGroup": "Stopped ({n})",
    "ag.stoppedGroupTip":
      "Agents that aren't running. Open one for its details.",
    "ag.bring.go": "Bring in",
    "ag.bring.done": "Brought in as {id}",
    "ag.bring.now": "just now",
    "ag.bring.min": "{n} min ago",
    "ag.bring.h": "{n} h ago",
    "ap.title": "{agent} wants to:",
    "ap.agent": "The {name} agent",
    "ap.noAgent": "Something on this machine (no agent identity)",
    "ap.noAgentWarn": "If you didn't ask an agent to do this, Deny.",
    "ap.signin.title": "Something is waiting for your approval.",
    "ap.signin": "Sign in on this browser to see it and approve it.",
    "ap.signin.btn": "Sign in",
    "pair.title": "Allow this computer?",
    "pair.what": "{device} {client} wants to sign in to Den.",
    "pair.aDevice": "A browser",
    "pair.local": "on this computer, via localhost",
    "pair.help":
      "Typing it proves you are at that computer. Allow only a computer you are signing in yourself.",
    "pair.allow": "Allow",
    "pair.allowed": "That computer is signed in.",
    "pair.ended":
      "That request has ended: that computer closed its page or is already signed in. Nothing was allowed.",
    "pair.expired": "That code expired. Nothing was allowed.",
    "pair.close": "Close",
    "pair.from": "From {client}, asking for {host}, at {time}.",
    "pair.fromNamed":
      "From {client} (it calls itself {name}), asking for {host}, at {time}.",
    "pair.unknownAddr": "an address Den couldn't see",
    "pair.unexpected":
      "If you didn't just try to sign in on another computer, Deny.",
    "pair.codeLabel": "Type the code that computer shows",
    "pair.age": "Asked {n} min ago.",
    "pair.ageNow": "Asked just now.",
    "pair.fromLogin": "From the web login run at {time}.",
    "pair.wrong":
      "That code doesn't match the one on that computer's screen. Check it and type it again.",
    "pair.busy": "Too many tries. Wait a minute and try again.",
    "ap.do.workspace_create": 'Create the project "{name}"',
    "ap.do.repo_add": 'Add the repo at {path} to project "{workspace}"',
    "ap.do.repo_add.new":
      'Add the repo at {path} to a new project "{workspace}"',
    "ap.do.service_try": "Start {service}",
    "ap.do.den_restart": "Restart Den ({reason})",
    "ap.do.den_update": "Update Den to {version} ({reason})",
    "ap.do.hub_connect": "Set Hub's address to {url}",
    "ap.do.hub_connect.clear": "Clear Hub's address",
    "ap.do.persona_create": "Add the persona {name} ({id})",
    "ap.do.persona_update": "Change the persona {id}: {fields}",
    "ap.do.persona_create.project":
      "Add the persona {name} ({id}) to project {where}",
    "ap.do.persona_update.project":
      "Change the persona {id} in project {where}: {fields}",
    "ap.do.den_pin_commit": "Commit the distribution's pin to Den {version}",
    "ap.do.den_sandbox_on":
      "Turn on the agent sandbox for {count} agents started before it (each at its next start)",
    "ap.det.den_sandbox_on.sets":
      "Sets agents.sandbox: on in config/local/user.yml.",
    "ap.det.den_sandbox_on.next":
      "Each agent goes into the sandbox at its next start; one that runs now keeps running.",
    "ap.det.den_sandbox_on.off": "An agent set to off in user.yml stays off.",
    "ap.do.repo_clone": "Clone {source} into {path}",
    "ap.do.project_agent_cap": "Set project {project}'s agent cap: {from} → {to}",
    "ap.det.project_agent_cap.now": "Now: {v}",
    "ap.det.project_agent_cap.then": "Then: {v}",
    "ap.do.project_mode": "Set project {project}'s mode: {from} → {to}",
    "ap.do.agent_folder": "Move agent {agent} to {where}",
    "ap.do.embed_key_create":
      "Let {origin} message {agent} in {project} and read its state",
    "ap.do.embed_key_revoke": "Revoke {origin}'s key for {agent} in {project}",
    "ap.det.embed_key_create.reach":
      "Makes a key for {origin}'s own backend. It reaches only {agent} in {project}: its state, and messages typed after its turn ends.",
    "ap.det.embed_key_create.once":
      "The key is shown once, here, after you allow. Den keeps only its hash.",
    "ap.det.embed_key_create.revoke":
      "You can revoke it any time in Settings › Embedding.",
    "ap.do.gate_runner_token_create":
      "Make a gate-only token for the CI runner {name}",
    "ap.det.gate_runner_token_create.reach":
      "Makes a token for the CI runner {name}. It can only ask for, renew and give back gate slots on this machine: nothing else in Den.",
    "ap.det.gate_runner_token_create.onceAgent":
      "The token goes once to {agent}, the agent that asked, and is never shown again. Den keeps only its hash.",
    "ap.det.gate_runner_token_create.once":
      "The token goes once to whoever asked, and is never shown again. Den keeps only its hash.",
    "ap.det.gate_runner_token_create.revoke":
      "You can revoke it any time in Settings, under CI runner tokens.",
    "ap.do.gate_box_set": "Replace the test box {name}",
    "ap.do.gate_box_set.new": "Add the test box {name}",
    "ap.do.gate_box_remove": "Remove the test box {name}",
    "ap.det.gate_box_set.adds":
      "Adds the test box {name}. Its browser slots take gate runs from agents.",
    "ap.det.gate_box_set.replaces":
      "Replaces the test box {name} with these settings. Its browser slots take gate runs from agents.",
    "ap.det.gate_box_set.ssh": "SSH: {v}",
    "ap.det.gate_box_set.ssh_port": "SSH port: {v}",
    "ap.det.gate_box_set.ssh_identity": "SSH key file: {v}",
    "ap.det.gate_box_set.playwright": "Playwright address: {v}",
    "ap.det.gate_box_set.slots": "Browser slots: {v}",
    "ap.det.gate_box_set.hold_file": "Hold file: {v}",
    "ap.det.gate_box_set.time_scale": "Time scale: {v}",
    "ap.det.gate_box_set.playwright_version": "Playwright version: {v}",
    "ap.det.gate_box_set.min_free_mem_mb": "Least free memory (MB): {v}",
    "ap.det.gate_box_set.playwright_endpoints": "Playwright by version: {v}",
    "ap.det.gate_box_remove.what":
      "Removes the test box {name}. Runs on it now finish; no new run goes there.",
    "ap.do.test_person_setup": "Set up the test person on test install {id}",
    "ap.det.test_person_setup.which":
      "Test install {id}, state folder {where}, on this computer.",
    "ap.det.test_person_setup.what":
      "Its live checks can then sign in there as its test person. It can't sign in anywhere else.",
    "ap.do.web_url_set": "Make {url} this Den's address",
    "ap.det.web_url_set.newHost":
      "New host: {host} isn't this machine or an address Den serves. Sign-in and every link will go through it.",
    "ap.det.web_url_set.now": "Now: {from}.",
    "ap.det.web_url_set.nowUnconfirmed": "Now: {from} (not confirmed).",
    "ap.det.web_url_set.none": "Now: no address is set.",
    "ap.det.web_url_set.answers":
      "{url} answers as this Den now: Den asked it for a one-time token, through its name.",
    "ap.det.web_url_set.saves":
      "Saved as confirmed, the same way Settings saves the address; it takes effect without a restart, and Den tells the connected Hub.",
    "set.ui.hub.denUrlRefused":
      "Hub didn't take this Den's address ({url}): {why}",
    "ap.do.gate_runner_entry_set":
      "Let {repo}'s CI jobs run on the test box {box}",
    "ap.det.gate_runner_entry_set.reach":
      "Lets {repo}'s CI jobs with the labels {labels} run on the test box {box}, at most {n} at a time.",
    "ap.det.gate_runner_entry_set.change":
      "Changes the entry that lets {repo}'s CI jobs with the labels {labels} run on the test box {box}, at most {n} at a time.",
    "ap.det.gate_runner_entry_set.heavy":
      "Each job takes one of {box}'s gate slots, so it never runs beside another heavy job there.",
    "ap.det.gate_runner_entry_set.light":
      "Its jobs are light: they take no gate slot on {box}.",
    "ap.det.gate_runner_entry_set.route":
      "The repo variable {variable} sends its jobs to the box, or back to hosted runners. {owner} answers for it.",
    "ap.det.gate_runner_entry_set.private":
      "Box runners start only for a private repo: if {repo} is public, none starts unless a person allows public repos for this project.",
    "ap.det.gate_runner_entry_set.remove":
      "You can remove it any time in Settings, under CI runner entries.",
    "ap.do.host_restart": "Restart the terminal host when agents are idle",
    "ap.det.host_restart.wait":
      "Waits until no agent is mid-turn (at most {min} min), then restarts the terminal host on the installed Den.",
    "ap.det.host_restart.resume":
      "The agents it ran resume where they were; open terminals end. The activity trail says how it went.",
    "ap.do.report": "File a report on {repo}: {title}",
    "ap.det.report.to": "Goes to: {repo}",
    "ap.det.report.pub":
      "Public repository: the text is visible to everyone; the screenshot isn't posted there. Secrets, tokens, emails, IP addresses and store references are removed first.",
    "ap.det.report.priv":
      "Private repository: only people with access to this repository can see it.",
    "ap.det.report.int":
      "Internal repository: only people with access to this repository can see it.",
    "ap.det.report.unk":
      "Visibility not known: who can see this repository can't be told, so it is treated as public. The text may be visible to everyone; the screenshot isn't posted there.",
    "ap.det.report.title": "Title: {title}",
    "ap.det.report.addTo": "Added as a comment to issue {n}.",
    "ap.det.report.as":
      "Filed on GitHub as you (your gh sign-in). What will be posted:",
    "ap.det.report.shot":
      "With a screenshot the agent took. It isn't masked: only the text above is scrubbed.",
    "ap.det.embed_key_revoke.reach":
      "{origin} can no longer message {agent} or read its state with this key.",
    "ap.det.embed_key_revoke.held":
      "Messages it sent that wait for the agent's turn are still typed.",
    "ap.det.workspace_create.new":
      'A new, empty project named "{name}", made active so its services can start.',
    "ap.det.service_try.activates":
      'Activates the project "{project}" first, so it can run.',
    "ap.det.service_try.up":
      "Runs the service's local \"up\", as the Services page's Start does.",
    "ap.det.service_try.command": "Command: {command}",
    "ap.det.service_try.reports":
      "Den reports the exit code and the last lines of its output.",
    "ap.det.den_restart.restart":
      "Den stops and starts again at the same address, on the version installed now.",
    "ap.det.den.carryOn":
      "Agents and terminals carry on where they were; open pages reconnect.",
    "ap.det.den_restart.told": "The agent that asked is told when Den is back.",
    "ap.det.den_update.latest":
      "Den gets the latest version from npm for this distribution, checks it with doctor, and restarts on it.",
    "ap.det.den_update.version":
      "Den gets version {version} from npm for this distribution, checks it with doctor, and restarts on it.",
    "ap.det.den_update.rollback":
      "If the new version isn't up in time, Den rolls back by itself to the version it runs now, and says why.",
    "ap.det.repo_clone.fromBranch": "From: {source}, branch {branch}.",
    "ap.det.repo_clone.from": "From: {source}, its default branch.",
    "ap.det.repo_clone.gh": "With your gh login (a GitHub repo).",
    "ap.det.repo_clone.git":
      "With git and your own credentials (not gh: it isn't GitHub).",
    "ap.det.repo_clone.into":
      "Into: {path} (a new folder; nothing there changes).",
    "ap.det.repo_clone.then":
      "Then the agent drafts its manifest (manifest_draft) and asks to add it (repo_add): each asks you again.",
    "ap.det.agent_import.what": "Project: {project}. Persona: {persona}.",
    "ap.det.agent_import.whatRuntime":
      "Project: {project}. Persona: {persona}. Runtime: {runtime}.",
    "ap.det.agent_import.goesOn":
      "The conversation goes on as a Den agent, in the folder it ran in, under Den's token, hooks and guards.",
    "ap.det.agent_import.refused":
      "Refused if it is still open in another terminal, or an agent already continues it.",
    "ap.det.approval_policy.now": "Now: {v}.",
    "ap.det.approval_policy.nowNone": "Now: none.",
    "ap.det.approval_policy.then": "Then: {v}.",
    "ap.det.approval_policy.thenNone": "Then: none.",
    "ap.det.approval_policy.person":
      "Only a person changes the approval policy without an Allow: an agent always asks.",
    "ap.det.pr_close.what": "Repo: {repo}. Pull request: {pr}.",
    "ap.det.pr_close.comment": "Den closes it with this comment: {comment}",
    "ap.det.pr_close.nothing": "Nothing is merged and no branch is deleted.",
    "ap.det.hub_connect.set": "Hub's address: {was} → {url}.",
    "ap.det.hub_connect.setNew": "Hub's address: none → {url}.",
    "ap.det.hub_connect.clear":
      "Hub's address {was} is cleared; this Den stops using Hub.",
    "ap.det.hub_connect.leave":
      "Den disconnects from the Hub it uses now first, so that Hub revokes its key.",
    "ap.det.hub_connect.restart":
      "Then Den restarts, and agents get Hub's tools when they next restart.",
    "ap.det.hub_connect.connect":
      "You connect in Settings › Hub afterwards: Connect signs you in to Hub there.",
    "ap.det.hub_connect.keep":
      "Den stays on {was} with its key until you sign in to {url}.",
    "ap.det.hub_connect.signin":
      "After your Allow, {url}'s sign-in opens. Once that Hub answers, Den switches to it and {was} revokes its key; if it fails, Den stays on {was} and says why.",
    "ap.det.den_pin_commit.pr":
      "Den commits package.json and package-lock.json on the branch den/pin-{version} and opens a pull request.",
    "ap.det.den_pin_commit.push":
      "Den commits package.json and package-lock.json and pushes them to the branch's upstream.",
    "ap.det.den_pin_commit.only":
      "Nothing else in the distribution's folder is committed.",
    "ap.det.persona.local":
      "File: this machine's own personas (not shared with the project)",
    "ap.det.persona.newFile":
      "File: {file} (new; commit it so the project's other Dens get it)",
    "ap.det.persona.changedFile":
      "File: {file} (changed; commit it so the project's other Dens get it)",
    "ap.det.persona.name": "Name: {v}",
    "ap.det.persona.role": "Role: {v}",
    "ap.det.persona.category": "Category: {v}",
    "ap.det.persona.description": "Description: {v}",
    "ap.det.persona.runtime": "Runtime: {v}",
    "ap.det.persona.runtimeModel": "Runtime: {v}, model {model} ({version})",
    "ap.det.persona.mode": "Mode: {v}",
    "ap.det.persona.commands": "Allowed commands: {v}",
    "ap.det.persona.commandsNone": "Allowed commands: none",
    "ap.det.persona.instructions": "Instructions:",
    "ap.det.asWritten": "{v}",
    "ap.det.persona.field": "{field}: {v}",
    "ap.det.persona.fieldNone": "{field}: none",
    "ap.det.persona.asItWillRead": "As it will read:",
    "ap.det.agent_create.persona": "Persona: {v}",
    "ap.det.agent_create.project": "Project: {v}",
    "ap.det.agent_create.folder": "Folder: {v}",
    "ap.det.agent_create.runtime": "Runtime: {v}",
    "ap.det.agent_create.mode": "Mode: {mode} (the project's: {cap})",
    "ap.det.agent.who": "Agent: {agent}, project {project}",
    "ap.det.agent.sandboxOff":
      "{id} starts outside the sandbox: agents.{id}.sandbox is off in config/local/user.yml.",
    "ap.det.agent.sandboxOffAll":
      "Agents here start outside the sandbox (agents.sandbox: off), and so would this one.",
    "ap.det.agent.whoId": "Agent: {agent} ({id}), project {project}",
    "ap.det.agent_folder.from": "From: {v}",
    "ap.det.agent_folder.to": "To: {v}",
    "ap.det.agent_folder.running":
      "It is running: Den stops it, moves it, and starts it fresh there (a new conversation; the old one stays in its history).",
    "ap.det.agent_folder.stopped":
      "It is stopped and stays so: its next start is a new conversation there.",
    "ap.det.agent_folder.self":
      "This is the agent that asked: it stops when you Allow, and its answer to you ends there.",
    "ap.det.agent_restart_self.when":
      "Restarts {agent} at its next idle moment, on the same conversation. It never cuts a turn.",
    "ap.det.agent_restart_self.tools":
      "Why: to load new tools from its MCP servers.",
    "ap.det.agent_restart_self.update":
      "Why: to run on the updated Den and its tools.",
    "ap.det.agent_restart_self.why": "Why: {why}",
    "ap.det.agent_mode.loosens": "This lets {agent} act without asking you.",
    "ap.det.agent_mode.now": "Now: its own mode, {mode}",
    "ap.det.agent_mode.then": "Then: it follows the project, {mode}",
    "ap.det.agent_mode.running":
      "It is running: Den restarts it after its turn, on the same conversation, in {mode}.",
    "ap.det.agent_mode.stopped": "It is stopped: its next start is in {mode}.",
    "ap.det.agent_sandbox_set.self":
      "{agent} is asking for this itself: it wants its own sandbox {value}.",
    "ap.det.agent_sandbox_set.on":
      "This puts {agent} back in the sandbox: Den's own files are read-only to it again.",
    "ap.det.agent_sandbox_set.off":
      "This takes {agent} out of the sandbox: it can then write Den's own files and reach what the sandbox blocks.",
    "ap.det.agent_sandbox_set.why": "Why: {why}",
    "ap.det.agent_sandbox_set.writes":
      "Den writes agents.{id}.sandbox: {value} in config/local/user.yml, and nothing else there.",
    "ap.det.agent_sandbox_set.running":
      "It is running: Den restarts it after its turn, on the same conversation, with the change.",
    "ap.det.agent_sandbox_set.stopped":
      "It is stopped: its next start has the change.",
    "ap.do.agent_sandbox_set": "{agent}: back in the sandbox",
    "ap.do.agent_sandbox_set.loosens": "This takes {agent} out of the sandbox",
    "ap.det.setting_change.widens":
      "This widens what agents can do: only your own Allow runs it.",
    "ap.det.setting_change.key": "Setting: {key}",
    "ap.det.setting_change.now": "Now: {value}",
    "ap.det.setting_change.nowDefault": "Now: {value} (Den's default)",
    "ap.det.setting_change.nowDen": "Now: {value} (from den.yml)",
    "ap.det.setting_change.new": "New: {value}",
    "ap.det.setting_change.why": "Why: {why}",
    "ap.det.gate_settings_set.change": "{key}: {from} → {to}",
    "ap.det.gate_settings_set.why": "Why: {why}",
    "ap.det.gate_settings_set.writes":
      "Den writes these in the gates folder's settings.json, under the gate's lock, and nothing else there.",
    "ap.det.setting_change.by": "Asked by {agent}",
    "ap.det.setting_change.writes":
      "Den writes only {key} in config/local/user.yml, keeps a copy of the file first, and notes the change in the audit.",
    "ap.det.setting_change.restart":
      "Den reads it when it starts: it applies after a restart of Den (den_restart_server).",
    "ap.det.setting_change.atOnce": "It applies at once.",
    "ap.do.setting_change": "Change {key}: {now} → {value}",
    "ap.do.setting_change.loosens":
      "This widens what agents can do: {key}: {now} → {value}",
    "ap.do.gate_settings_set": "Change gate settings: {keys}",
    "ap.do.gate_settings_set.loosens":
      "This widens what agents can do: gate settings {keys}",
    "ap.do.agent_mode": "{agent}: {from} → follow project ({to})",
    "ap.do.agent_restart_self": "Restart agent {agent} when it's idle",
    "ap.do.agent_mode.loosens":
      "This lets {agent} act without asking you: {from} → follow project ({to})",
    "ap.pm.warn": "This lets agents in {project} act without asking you.",
    "ap.pm.project": "Project: {project}",
    // Issue 271: hub_project_create's Allow.
    "ap.do.hub_project_create":
      "Ask Hub to create the Hub project {name} for project {project}",
    "ap.hc.project": "Project: {project}",
    "ap.hc.name": "Name in Hub: {name}",
    "ap.hc.owner":
      "An owner in Hub allows it there; Den links the project to it once they do.",
    // Issue 647: hub_link's Allow.
    "ap.do.hub_link": "Link project {project} to the Hub project {hub}",
    "ap.hl.project": "Project: {project}",
    "ap.hl.now": "Now: {hub}",
    "ap.hl.nowNone": "Now: not linked to a Hub project",
    "ap.hl.then": "Then: {hub}",
    "ap.hl.filed": "Its agents' Hub work is filed there from their next call.",
    "ap.do.state_folder_own": "Give this install its own state folder",
    "ap.sf.new":
      "A new, empty state folder for this install, beside the shared one.",
    "ap.sf.empty":
      "Nothing is copied or moved: its agents, sign-ins and history stay with the other copy, and you sign in to this Den again.",
    "ap.sf.other": "The other copy keeps the shared folder as it is.",
    "ap.sf.restart":
      "Den restarts on its own folder, then carries on with Connect to {hub}.",
    "ap.sf.restartNone": "Den restarts on its own folder.",
    "hub.sf.shared":
      "Another copy of Den on this computer shares this install's state folder, and it is on another Hub.",
    "hub.sf.offer": "Give this install its own state folder",
    "hub.sf.allow":
      "Allow it in the dialog. Den restarts, then carries on with Connect.",
    "ap.pm.now": "Now: {mode}",
    "ap.pm.then": "Then: {mode}",
    "ap.pm.thenNone":
      "Then: none (agents start in the install's mode, else their persona's)",
    "ap.pm.switch":
      "New agents start in it; running agents switch after their current turn, in the same conversation.",
    "ap.pm.own":
      "These keep their own mode and won't follow the project: {list}",
    "ap.pm.follow":
      "And makes them follow the project: their own mode is cleared.",
    // Issue 208: a Verify run's Allow (verify-routes.ts).
    "ap.do.verify_run": "Run checks on {env} in project {project}: {list}",
    "ap.vr.scope.changed":
      "Scope: what changed (smoke, plus checks whose files changed since their last result).",
    "ap.vr.scope.all": "Scope: everything on this environment.",
    "ap.vr.scope.chosen": "Scope: the checks chosen by name.",
    "ap.vr.mod.enforced": "{module} ({kind}): enforced",
    "ap.vr.mod.declared-read-only": "{module} ({kind}): declared read-only",
    "ap.vr.mod.reads-code-only": "{module} ({kind}): reads code only",
    "ap.vr.mod.declared-by-service":
      "{module} ({kind}): declared by the service",
    "ap.vr.cant.environment":
      "{module} can't run here: it runs on {envs} only.",
    "ap.vr.cant.production":
      "{module} can't run on production yet: opting in to production comes in a later Den.",
    "ap.vr.cant.production-declared":
      "{module} is left out of a scheduled production run: Den can't keep a command read-only, so only smoke checks and code scans run there.",
    "ap.vr.cant.adapter-later":
      "{module} can't run yet: its adapter ({adapter}) comes in a later Den.",
    "ap.vr.cant.no-health-url":
      "{module} can't run here: no health URL for {env}.",
    "ap.vr.once":
      "This Allow covers this run only. Nothing runs until you Allow it.",
    "ap.own.h":
      "These agents keep their own mode and won't follow the project:",
    "ap.own.item": "{agent} (own mode: {mode})",
    "ap.own.follow": "Also make these follow the project",
    "ap.res.following": "Follow the project now: {list}.",
    "ap.res.own": "Keep their own mode: {list}.",
    "ap.do.project_mode.loosens":
      "This lets agents in {project} act without asking you. Set project {project}'s mode: {from} → {to}",
    "ap.do.agent_create":
      "Start agent {name} ({persona}) in {where}, mode {mode}",
    "ap.do.service_try.activates":
      "Start {service} (this activates project {workspace})",
    "ap.says": "Agent says:",
    "ap.review": "Review",
    "ap.hide": "Hide details",
    "ap.later": "Later",
    "ap.deny": "Deny",
    "ap.allow": "Allow",
    "ap.waits": "Nothing changes until you allow it. It waits until {time}.",
    "ap.more": "{n} more waiting",
    "ap.failed": "It ran, and failed: {error}",
    "ap.done": "Done: {what}",
    "ag.new.note":
      "Starts in the project folder. It keeps running if you close the pane.",
    "ag.new.started": "Started {p} in {w}",
    "pm.ask": "Ask for everything",
    "pm.edits": "Auto-approve edits in the worktree",
    "pm.auto": "Auto mode",
    "pm.all": "Auto-approve all",
    "pm.tag.ask": "asks for all",
    "pm.tag.edits": "auto-approve edits",
    "pm.tag.auto": "auto mode",
    "pm.tag.all": "auto-approve all",
    "pm.name.ask": "Ask",
    "pm.name.edits": "Edits",
    "pm.name.auto": "Auto",
    "pm.name.all": "All",
    "ag.mode.tag": "mode: {m}",
    "ag.mode.own": "mode: {m}, from its own setting",
    "ag.mode.ownNot": "mode: {m}, from its own setting (project: {p})",
    "ag.mode.drift": "Set to {want}. Runs as {running} until restarted.",
    "ag.mode.apply": "Restart to apply",
    "ag.mode.applyName": "Restart {id} now to run in its mode",
    "ag.mode.applied": "{id} restarts on the same conversation, in {m}.",
    "ag.mode.from": "mode: {m}, from {src}",
    "ag.mode.src.own": "its own setting",
    "ag.mode.src.project": "the project",
    "ag.mode.src.install": "the Den-wide default",
    "ag.mode.src.persona": "its persona",
    "ag.mode.src.default": "Den's built-in default",
    "ag.mode.item": "Mode: {m}",
    "ag.mode.menu": "{id}'s mode",
    "ag.mode.pick": "Change {id}'s mode",
    "ag.mode.follow": "Follow project",
    "ag.mode.setS":
      "{id}: {m}, its own setting. Den restarts it at its next idle to take it.",
    "ag.mode.setStopped":
      "{id}: {m}, its own setting. It takes it at its next start.",
    "ag.mode.followS":
      "{id} follows the project now: {m}. Den restarts it at its next idle to take it.",
    "ag.mode.followStopped":
      "{id} follows the project now: {m}. It takes it at its next start.",
    "set.workspace.agents_mode":
      "Agents' mode: this project (overrides the Den-wide default)",
    "set.workspace.agents_mode.d":
      "The mode this project's agents run in, over the Den-wide default. Which wins: an agent's own setting, then the project, then the Den-wide default, then its persona. Each agent below says its mode and where it comes from. A change reaches running agents after their turn, on its own.",
    "set.workspace.mcp_servers": "Agents' extra MCP servers: this project",
    "set.workspace.mcp_servers.d":
      "HTTP MCP servers this project's agents get, besides Den's and Hub's, by name and address. A bearer is read from the install's secrets store at each call and is never shown. Change or remove one here. An agent asks with project_mcp_add, project_mcp_update or project_mcp_remove, and you Allow it.",
    "pmcp.none": "No extra MCP servers for this project's agents.",
    "set.workspace.event_feeds": "App event feeds: this project",
    "set.workspace.event_feeds.d":
      "Events an app of this project sends on its own stream, for one agent. Den types the agent a short line when some are unread, when it is idle, never mid-turn; the agent reads them with app_feed_read. Each feed says whether it is connected and when its last event came. Add or remove one here; an agent asks with project_event_feed_add or project_event_feed_remove. A bearer is a secrets.refs name, never a value.",
    "set.embed.feed_max_streams": "App feeds read at once",
    "set.embed.feed_max_streams.d":
      "The most app event feeds Den reads at one time, across every project. Past it, a feed isn't read, and its project's notifications say so.",
    "set.embed.feed_event_max_kb": "Largest app feed event",
    "set.embed.feed_event_max_kb.d":
      "The largest event an app feed keeps for its agent. A larger one is kept as a note that it came, without its data, and the project's notifications say so.",
    "set.embed.feed_events_per_minute": "App feed events a minute",
    "set.embed.feed_events_per_minute.d":
      "How many events Den reads from one app feed in a minute. Past it, Den reads the rest as the rate allows, and the project's notifications say so.",
    "feed.none": "No app event feeds for this project.",
    "feed.row": "{name} to {agent}: {url}",
    "feed.last": "Last event {time}.",
    "feed.noEvents": "No events yet.",
    "set.embed.feed_keep_events": "Events one app feed keeps",
    "set.embed.feed_keep_events.d":
      "The most events Den keeps for one app feed. Past it, the oldest go, and the project's notifications say so when one wasn't read yet.",
    "set.embed.feed_read_max_kb": "Most app feed data in one read",
    "set.embed.feed_read_max_kb.d":
      "The most event data one app_feed_read call gives an agent. It reads the rest with another call.",
    "set.embed.feed_list_timeout": "App feed list wait",
    "set.embed.feed_list_timeout.d":
      "How long Den waits for an app's list of events (it fills a gap after a cut) before it tries again later.",
    "set.embed.feed_list_max_mb": "Largest app feed list answer",
    "set.embed.feed_list_max_mb.d":
      "The largest list of events Den reads from an app at once. A larger answer is refused and tried again later.",
    "set.embed.paste_max_kb": "Most text typed into an agent at once",
    "set.embed.paste_max_kb.d":
      "The most text Den types into an agent in one go: Hub comments, relayed messages and app feed lines. The rest are typed next.",
    "feed.unread": "Unread: {n}.",
    "bell.m.appFeed.dropped":
      "App feed {name} for {agent}: unread events went because the feed keeps at most its limit.",
    "feed.add": "Add feed",
    "feed.name": "Name",
    "feed.agent": "Agent",
    "feed.url": "Stream address",
    "feed.bearer": "Bearer (a secrets.refs name)",
    "feed.bearerNone": "none",
    "feed.noAgents":
      "This project has no agents yet. Start one, then add its feed.",
    "feed.addW": "Adding the feed…",
    "feed.addS": "Added.",
    "feed.addF": "Couldn't add the feed.",
    "feed.remove": "Remove",
    "feed.removeL": "Remove feed {name}",
    "feed.rmT": "Remove the feed?",
    "feed.rmAsk":
      "Remove feed {name} from project {project}? Den closes its stream, and {agent} gets no more lines from it.",
    "feed.rmW": "Removing the feed…",
    "feed.rmS": "Removed.",
    "feed.rmF": "Couldn't remove the feed.",
    "ap.do.project_event_feed_add":
      "Add event feed {name} ({url}) for {agent} in project {project}",
    "ap.do.project_event_feed_remove":
      "Remove event feed {name} from project {project}",
    "ap.feed.warn":
      "Den opens {url} and types {agent} a short line when its events are unread.",
    "ap.feed.feed": "Feed: {name}, for {agent}",
    "ap.feed.bearer":
      "Bearer: read from secrets.refs.{ref} at each connect; never shown or written to the agent's files.",
    "ap.feed.noBearer":
      "No bearer: the stream is opened with no Authorization header.",
    "ap.feed.removeWarn":
      "Den closes feed {name}; its agent gets no more lines from it.",
    "feed.problems": "Entries in agents.event_feeds that can't be read: {n}.",
    "feed.failed": "Couldn't read this project's app event feeds.",
    "feed.st.connecting": "Connecting",
    "feed.st.connected": "Connected",
    "feed.st.retrying": "Retrying",
    "feed.st.no_secret": "Its bearer isn't in the secrets store",
    "feed.st.over_limit": "Not read: over the limit of feeds",
    "feed.st.no_agent": "Not read: no such agent in this project",
    "feed.st.stopped": "Stopped",
    "bell.m.appFeed.no_secret":
      "App feed {name} for {agent}: its bearer can't be read from the secrets store. Den keeps trying.",
    "bell.m.appFeed.rejected":
      "App feed {name} for {agent}: the app refused Den's request. Den keeps trying.",
    "bell.m.appFeed.too_big":
      "App feed {name} for {agent}: an event was over the size limit. The agent was told it came, without its data.",
    "bell.m.appFeed.over_rate":
      "App feed {name} for {agent}: over the rate limit. Its events wait and are typed as the rate allows.",
    "bell.m.appFeed.over_streams":
      "App feed {name} for {agent}: not read, over the limit of feeds read at once.",
    "pmcp.row": "{name}: {url}",
    "pmcp.failed": "Couldn't read this project's MCP servers.",
    "pmcp.edit": "Change",
    "pmcp.editL": "Change {name}",
    "pmcp.remove": "Remove",
    "pmcp.removeL": "Remove {name}",
    "pmcp.url": "Address",
    "pmcp.bearer": "Bearer",
    "pmcp.bearerKeep": "a secrets.refs name; blank keeps it",
    "pmcp.noBearer": "No bearer",
    "pmcp.save": "Save",
    "pmcp.cancel": "Cancel",
    "pmcp.rmT": "Remove the MCP server?",
    "pmcp.rmAsk":
      "Remove {name} from project {project}'s agents? They lose its tools at their next start or resume.",
    "pmcp.rmW": "Removing the MCP server…",
    "pmcp.rmS": "Removed.",
    "pmcp.rmF": "Couldn't remove the MCP server.",
    "ap.do.project_mcp_add":
      "Add MCP server {name} ({url}) to project {project}'s agents",
    "ap.mcp.warn":
      "This gives agents in {project} new tools, and sends their calls to {url}.",
    "ap.mcp.server": "MCP: {name} at {url}",
    "ap.mcp.bearer":
      "Bearer: read from secrets.refs.{ref} at each call; never written to the agent's files or env.",
    "ap.mcp.noBearer": "No bearer: its calls carry no Authorization header.",
    "ap.mcp.next": "Agents in {project} get it at their next start or resume.",
    "ap.do.project_mcp_remove":
      "Remove MCP server {name} ({url}) from project {project}'s agents",
    "ap.do.project_mcp_update":
      "Change MCP server {name} for project {project}'s agents (now {url})",
    "ap.mcp.removeWarn":
      "Agents in {project} lose the tools of {name} at their next start or resume.",
    "ap.mcp.urlChange": "MCP {name}: {from} → {to}",
    "pmode.none": "Use Den-wide",
    "pmode.following": "Following Den-wide: {m}",
    "pmode.setHere": "Set for this project: {m} (Den-wide is {dw})",
    "pmode.changeDw": "Change the Den-wide default",
    "dwmode.now": "In effect Den-wide: {m}",
    "dwmode.persona": "each persona's own mode",
    "dwmode.over": "{n} projects override this:",
    "dwmode.over.one": "{n} project overrides this:",
    "dwmode.overNone": "No project overrides this.",
    "pmode.agent": "{name}: {m}, from {src}",
    "pmode.runsAs":
      "{name}: {m}, from {src}. Runs as {running} until restarted.",
    "pmode.stopped": "stopped",
    "pmode.noAgents": "No agents in this project yet.",
    "pmode.follow": "Also apply to the {n} agents with their own setting",
    "pmode.follow.one": "Also apply to the {n} agent with its own setting",
    "pmode.followW": "Making them follow the project…",
    "pmode.followS": "They follow the project now.",
    "pmode.followF": "Couldn't apply. Nothing changed.",
    "pmode.failed": "Couldn't read this project's mode.",
    "pm.wsDefault": "This project starts agents in {m}.",
    "ov.runtime": "runtime: {r}",
    "ov.model": "model: {m}",
    "ov.latest": "latest",
    "ov.tools": "custom tools",
    "pe.what":
      "A persona is a saved agent setup: a role, its instructions, a default runtime and model, and what it may do without asking. You can have several with the same role, each with its own name.",
    "pe.preset": "Role preset",
    "pe.extra": "Extra allowed commands",
    "pe.extraS": "extra",
    "pe.extraP":
      "Plain command prefixes, one per line. No patterns or regex. Den translates them for each runtime.",
    "pe.allows": "What this allows on {r}",
    "pe.ns": "not supported on {r}",
    "pe.nsMode": "{r} takes no permission mode from Den yet",
    "pe.nsModel": "{r} takes no model from Den",
    "pe.nsPat": "use a plain prefix, not a pattern",
    "pe.nsBad": "not a plain prefix",
    "pe.badCmd":
      '"{c}" isn\'t a plain command prefix: use letters, digits, single spaces and . _ / : = @ % + , -',
    "pe.raw": "Edit raw runtime config…",
    "pe.rawLater": "Opening a runtime's own config file is coming later.",
    "pe.vendor": "vendor-specific",
    "pe.instr": "Instructions",
    "pe.runtime": "Default runtime",
    "pe.model": "Model",
    "pe.ver": "Version",
    "pe.rtDefault": "the runtime's default",
    "pe.perms": "Permission mode",
    "pe.noneCmd": "none",
    "pe.loading": "Loading…",
    "pe.loadFail": "The personas did not load.",
    "pe.src.builtin": "built-in",
    "pe.src.distribution": "distribution",
    "pe.src.local": "mine",
    "pe.src.hub": "hub",
    "pe.src.project": "project",
    "pe.src.builtin.p":
      "Ships with Den. Read-only here; duplicate it to customize.",
    "pe.src.distribution.p":
      "Ships with your distribution. Read-only here; duplicate it to customize.",
    "pe.src.local.p": "Yours, on this machine.",
    "pe.src.hub.p": "Shared through Den Hub. Read-only here.",
    "pe.src.project.p":
      "From this project's repo (.den/personas). Read-only here; change it in the repo.",
    "pe.new": "New persona",
    "pe.dupT": "Duplicate persona",
    "pe.edit": "Edit persona",
    "pe.dup": "Duplicate",
    "pe.editB": "Edit",
    "pe.view": "View",
    "pe.save": "Save persona",
    "pe.del": "Delete",
    "pe.deleted": "Deleted {n}",
    "pe.name": "Name",
    "pe.nameP": "e.g. Rita",
    "pe.role": "Role",
    "pe.roleHelp":
      "A role sets this persona's starting template and lets Den hand work to it. It adds nothing hidden to the instructions.",
    "pe.desc": "One-line description",
    "pe.cat": "Category",
    "pe.copy": "{n} (copy)",
    "pe.saved": "Saved {n}",
    "pe.ro": "Read-only here. Duplicate it to make a copy of your own.",
    "pf.search": "Search personas by name, role or description",
    "pf.cat": "Category",
    "pf.src": "Source",
    "pf.all": "All",
    "pf.none": "No persona matches. Clear the filters or create one.",
    "pf.clear": "Clear filters",
    "cat.engineering": "Engineering",
    "cat.design": "Design",
    "cat.product": "Product",
    "cat.marketing": "Marketing",
    "cat.operations": "Operations",
    "rt.installed": "Installed",
    "rt.missing": "Not installed",
    "rt.notInst": "{r} not installed",
    "rt.later": "later",
    "rt.fallback":
      "{p}'s default runtime, {r}, isn't installed here, so this starts on {f}.",
    "ver.latest": "latest",
    "ver.latestP": "Latest (tracks the newest release)",
    "ver.newer": "newer available",
    "ver.newerP":
      "A newer version of this model is out. This one stays pinned until you change it.",
    "ver.newerOf": "Newer: {v}",
    "ver.use": "Use latest",
    "ver.pinned": "pinned {v}",
    "ver.usedLatest": "{n} now tracks the latest version",
    "set.agents.personas": "Personas",
    "set.agents.rotation": "Rotation",
    "set.agents.hub": "Hub",
    // The Agents tab (AG-4a-term, agents-page.js).
    "n.agents": "Agents",
    "n.terminal": "Terminals",
    "n.terminalTip": "Your terminals in one list, each in a project's folder",
    "ag.term.started": "Terminal opened in {w}",
    "ag.term.failed": "Den couldn't open a terminal: {e}",
    // Issue 503: the machine gave no PTY (the reason in {e}).
    "ag.start.lastLines": "What it printed before it stopped:",
    "ag.term.ptyFailed":
      "Den couldn't open a terminal: this machine gave it no PTY ({e}). Close terminals you no longer need, or run doctor.",
    "ag.term.noWs": "no project is active. Activate one first.",
    "ws.termHere": "New terminal",
    // Issue 482: the Terminals page (its own list; never "shell").
    "ws.termHereTip": "Open a new terminal in this project's folder, in Den",
    "tm.count": "{n} terminals",
    "tm.count1": "{n} terminal",
    "tm.running": "Running ({n})",
    "tm.exited": "Exited ({n})",
    "tm.lastUsed": "Last used {when}",
    "tm.restart": "Restart",
    "tm.restartName": "Restart {id} in the same folder",
    "tm.none": "No terminals yet",
    "tm.noneP": "Press New terminal to open one in {scope}.",
    "tm.empty":
      "Pick a terminal on the left to open it. Open more to tile them (up to 4).",
    "tm.pick": "New terminal in…",
    "tm.moved": "{n} terminals moved to Terminals. Nothing was closed.",
    "tm.moved1": "{n} terminal moved to Terminals. Nothing was closed.",
    "tm.openList": "Open Terminals",
    "tm.dismiss": "Dismiss",
    "kind.agent": "Agent",
    "kind.terminal": "Terminal",
    "ag.sub.agents": "{n} agents",
    "ag.sub.agent": "{n} agent",
    "ag.sub.shells": "{n} shells",
    "ag.sub.shell": "{n} shell",
    "ag.all": "all projects",
    "ag.waiting": "waiting",
    "ag.waiting.approval": "needs your Allow",
    "ag.waiting.permission": "needs permission",
    "ag.waiting.input": "waiting for you",
    "ag.waiting.asked": "asked you",
    "ag.waiting.trust": "Waiting: trust this folder?",
    "ag.band.needs": "Needs you",
    "ag.band.done": "Done, not seen",
    "ag.band.working": "Working",
    "ag.band.idle": "Idle",
    "ag.chip.needs": "Needs you",
    "ag.chip.needsWhy": "Needs you · {why}",
    "ag.chip.done": "Done",
    "ag.chip.working": "Working",
    "ag.chip.idle": "Idle",
    "ag.why.permission": "permission",
    "ag.why.asked": "question",
    "ag.why.approval": "Allow",
    "ag.why.trust": "folder trust",
    "ag.whyLong.permission": "asks for your permission",
    "ag.whyLong.asked": "asked you a question",
    "ag.whyLong.approval": "waits for your Allow",
    "ag.whyLong.trust": "asks to trust its folder",
    "ag.tag.server": "Server",
    "ag.sub.needs": "{n} need you",
    "ag.sub.needsOne": "{n} needs you",
    "ag.sub.done": "{n} done, not seen",
    "ag.sub.doneOne": "{n} done, not seen",
    "ag.sub.working": "{n} working",
    "ag.sub.idle": "{n} idle",
    "ag.sub.idleOne": "{n} idle",
    "ag.meta.finished": "finished {ago}",
    "ag.whyLong.command": "asks to run a command",
    "ag.whyLong.tool": "asks to use {tool}",
    "ag.meta.seen": "seen just now",
    "ag.list.failed": "The list could not load.",
    "ag.list.retry": "Retry",
    "ag.list.keepRunning": "Your agents keep running.",
    "ag.list.loading": "Loading the agents",
    "bell.doneRow": "{name} finished",
    "bell.seenSub": "{where} · seen",
    "bell.title": "Notifications",
    "bell.n": "Notifications: {n} unread",
    "bell.n.one": "Notifications: {n} unread",
    "bell.markAll": "Mark all read",
    "bell.empty": "Nothing needs you right now.",
    "bell.notShown": "Not shown: {kinds}.",
    "bell.sep": ", ",
    "bell.settings": "Notification settings",
    "bell.older": "Older than {d} days ({n})",
    "bell.updates": "Updates ({n})",
    "bell.rep": "{n} more like this",
    "bell.stop": "Stop showing this kind",
    "bell.askT": "Stop showing “{kind}”?",
    "bell.askB":
      "Only this kind. The activity trail still records it. You can turn it back on in Settings.",
    "bell.askYes": "Stop showing",
    "bell.cancel": "Cancel",
    "bell.undo": "Undo",
    "bell.undoMsg": "No longer showing “{kind}”.",
    "bell.clearRead": "Clear read",
    "bell.read": "Mark read",
    "bell.server": "__DEN_TITLE__ agent",
    "bell.hub": "Hub · {project}",
    "bell.hubAll": "Hub",
    "bell.m.permission": "{name} needs your permission",
    "bell.m.permissionWhat": "{name} needs your permission: {what}",
    "bell.m.input": "{name} is waiting for you",
    "bell.m.asked": "{name} asked: {text}",
    "bell.m.toLead": "{name} asked the lead, {lead}: {text}",
    "bell.m.settled":
      "{name} withdrew its question, settled: {reason} ({text})",
    "bell.m.settledYou":
      "You withdrew {name}'s question, settled: {reason} ({text})",
    "bell.m.settledLate":
      "{name}'s question was settled: {reason}; your answer came after it and was passed on ({text})",
    "bell.m.hubSwitchWaits":
      "Sign in to {to} to finish switching Hubs; __DEN_TITLE__ stays on {from} until then",
    "bell.m.hubSwitchExpired":
      "The switch to {to} waited {days} days for a sign-in and has ended. __DEN_TITLE__ stays on {from}; ask again to switch",
    "bell.m.hubSwitchFailed":
      "__DEN_TITLE__ couldn't switch to {to}: {why}. It stays on {from}; sign in again in Settings › Hub",
    "ap.hubSwitchSignin": "Opening {url}'s sign-in…",
    "bell.m.pick": "{n} projects need your pick",
    "bell.m.hubMoved":
      "Project {project} moved to {hub}. Switch this install to that Hub to keep it linked.",
    "bell.pickBody":
      "Den can't tell which Hub project fits them. Click to choose. Nothing is filed for them until then.",
    "bell.pickBody.one":
      "Den can't tell which Hub project fits it. Click to choose. Nothing is filed for it until then.",
    "bell.m.pick.one": "{n} project needs your pick",
    "bell.m.hostRestarted":
      "__DEN_TITLE__ restarted its terminal host on the installed version, so new agents and terminals start again. Agents resumed: {names}. Terminals that ended: {terminals}.",
    "bell.m.hostRestartedAgents":
      "__DEN_TITLE__ restarted its terminal host on the installed version, so new agents and terminals start again. Agents resumed: {names}. No terminal was running.",
    "bell.m.hostRestartedTerminals":
      "__DEN_TITLE__ restarted its terminal host on the installed version, so new agents and terminals start again. No agent was running. Terminals that ended: {terminals}.",
    "bell.m.hostRestartedNone":
      "__DEN_TITLE__ restarted its terminal host on the installed version, so new agents and terminals start again. No agent or terminal was running.",
    "bell.m.hostRestartedCut":
      "__DEN_TITLE__ restarted its terminal host on the installed version, so new agents and terminals start again. Agents resumed: {names}. Terminals that ended: {terminals}. Cut mid-turn, and told to check their last step and carry on: {cut}.",
    "bell.m.hostRestartedAgentsCut":
      "__DEN_TITLE__ restarted its terminal host on the installed version, so new agents and terminals start again. Agents resumed: {names}. No terminal was running. Cut mid-turn, and told to check their last step and carry on: {cut}.",
    "bell.m.rsTimedOut":
      "{id} was not restarted: still working after {min} min",
    "bell.m.rsJob":
      "{id} was not restarted: a background job is running ({cmd}, {min} min)",
    "bell.m.rsFailed": "{id} was not restarted",
    "bell.m.restartGroup": "Restart {n} agents when idle: {names}",
    "bell.m.noHub": "{n} agents started without Hub",
    "bell.m.restartFailed": "{name} didn't come back after a restart: {why}",
    "bell.m.unaskedExit":
      "{name} ended without Den asking (exit {code}): {why}",
    "bell.m.trust": "{name}: Waiting: trust this folder?",
    "bell.m.trustDeclined":
      "{name}: Didn't start: this folder isn't trusted. Resume and choose Yes.",
    "bell.m.policyRan": "{name} did this without your Allow: {what}",
    "bell.m.heldAllow": "{name} waits for your Allow: {what}",
    "bell.m.heldWithdrawn":
      "{name} withdrew its request: {what}. Withdrawn: {reason}",
    "bell.m.gateLapsed":
      '{name}\'s {kind} gate slot "{label}" lapsed: not renewed, and past its estimate. The next in line started.',
    "bell.m.vschedPass": "Scheduled run on {env}: {n} checks passed.",
    "bell.m.vschedPass.one": "Scheduled run on {env}: {n} check passed.",
    "bell.m.vschedFail":
      "Scheduled run on {env}: {n} of {total} checks failed.",
    "bell.m.vschedFail.one":
      "Scheduled run on {env}: {n} of {total} checks failed.",
    "bell.m.vschedExpire":
      'The Allow for the schedule "{name}" expires in {n} days.',
    "bell.m.vschedExpire.one":
      'The Allow for the schedule "{name}" expires in {n} day.',
    "bell.m.heldAllowAsk": "Waiting for your Allow: {what}",
    "bell.m.heldAllowClaimed":
      "Waiting for your Allow: {what}. You asked, as {name} (not verified).",
    "bell.m.shared": "{actor} shared {title} with you",
    "bell.m.sharedNote": "{actor} shared {title} with you: {note}",
    "bell.m.sharedAgent": "The agent {actor} shared {title} with you",
    "bell.m.sharedAgentNote":
      "The agent {actor} shared {title} with you: {note}",
    "bell.m.heldLapsed":
      "{name}'s request lapsed unanswered: {what}. Nothing ran; the agent was told to ask again.",
    "bell.m.heldLapsedAsk": "A request lapsed unanswered: {what}. Nothing ran.",
    "bell.m.heldLost":
      "{name}'s request was lost at a restart: {what}. Nothing ran from it; the agent was told to ask again.",
    "bell.m.heldLostAsk":
      "A request was lost at a restart: {what}. Nothing ran from it.",
    "bell.m.capHeld":
      "{name} didn't start: {n} of {limit} agents are running ({key}). Stop one, or raise {key}.",
    "bell.m.restartsWaiting": "{n} agents waiting to restart, a few at a time",
    "bell.m.heldLostAll":
      "Requests waiting for your Allow could not be read back after a restart. They are lost; agents that ask again are shown here.",
    "bell.go.h": "Test slots past their estimate",
    "bell.go.row": "{who} holds the {kind} test slot: {label}",
    "bell.go.sub": "Since {time} · estimate {est} min · {over} min over",
    "bell.go.end": "End",
    "bell.go.ended": "Ended the test slot. The next in line starts.",
    "bell.ap.h": "Waiting for your Allow",
    "bell.ap.row": "{name} asks: {what}",
    "bell.ap.rowAsk": "Asked: {what}",
    "bell.ap.rowClaimed": "You asked, as {name} (not verified): {what}",
    "bell.ap.waits": "Waiting {ago} · expires {time}",
    "bell.ap.allow": "Allow",
    "bell.ap.deny": "Deny",
    "bell.ap.done": "Allowed: {what}",
    "rs.now": "{id}: restarting now, in the same conversation.",
    "rs.turn": "{id}: restarts when its turn ends, in the same conversation.",
    "rs.job": "{id}: waiting: a background job ({cmd}, {min} min).",
    "rs.unknown":
      "{id}: Den can't tell when its turn ends, so it isn't restarted yet.",
    "rs.nowJob": "Restart now (ends the job)",
    "rs.nowBtn": "Restart now",
    "rs.all": "Restart all {n} now",
    "rs.none": "No agents need a restart.",
    "rs.bar": "{n} agents need a restart to load their tools.",
    "rs.barBtn": "Restart all {n} at their next idle",
    "rs.allName": "the agents",
    "rs.done": "{id}: restarted, in the same conversation.",
    "rs.timedOut":
      "{id}: not restarted, still working after {min} min. Restart now ends its turn.",
    "bell.rg.title": "Restart {n} agents when idle",
    "bell.rg.sub":
      "Each restarts at its next idle moment, on the same conversation.",
    "bell.rg.allow": "Allow {n}",
    "bell.rg.allowing": "Allowing…",
    "bell.rg.takeOut": "Take out",
    "bell.rg.putBack": "Put back",
    "bell.rg.out": "{name} (left out)",
    "bell.rg.done": "Allowed: {n} agents restart when idle",
    "bell.rg.partly": "Allowed {n}; {failed} could not be allowed",
    "ag.ri.all": "Restart all idle agents ({n})",
    "ag.ri.ws": "Restart this project's idle agents ({n})",
    "ag.ri.wsShort": "Restart idle ({n})",
    "ag.ri.said": "{n} restarting now. Waiting: {wait}.",
    "ag.ri.saidAll": "{n} restarting now.",
    "ag.ri.none": "No agents are running.",
    "rs.failed": "{id}: not restarted. Restart it from the Agents page.",
    "bell.ap.denied": "Denied: {what}",
    "bell.ap.failed": "That didn't work: {error}",
    "bell.m.ranAway":
      "While __DEN_TITLE__ was away, {kept} kept running and {back} came back: {names}",
    "bell.m.ranLoggedOut":
      "While you were logged out ({min} min), these agents ran: {names}",
    "bell.m.stoppedLoggedOut":
      "While you were logged out ({min} min), these agents stopped: {names}",
    "bell.m.keepOffer": "Keep agents running after logout: Apply",
    "bell.m.noHub.one": "{n} agent started without Hub",
    "bell.m.compacting":
      "{name} is compacting repeatedly: {n} times in {m} minutes",
    "bell.m.deliveryFileBad":
      "Den couldn't read {n} held deliveries; kept the file as {moved}.",
    "bell.m.deliveryFileBad.one":
      "Den couldn't read {n} held delivery; kept the file as {moved}.",
    "bell.m.deliveryFileBadUncounted":
      "Den couldn't read {file} or count its held deliveries; kept the file as {moved}.",
    "bell.m.deliveryFileBadKept":
      "Den couldn't read {file} and couldn't move it aside; delivery goes on without what it held.",
    "bell.m.notAtPrompt":
      "{name}: {n} messages wait for {m} min. Waiting: the agent isn't at its prompt",
    "bell.m.notAtPrompt.one":
      "{name}: {n} message waits for {m} min. Waiting: the agent isn't at its prompt",
    "bell.m.held.busy":
      "{name}: {n} messages wait for {m} min. Waiting: the agent is busy with a turn",
    "bell.m.held.busy.one":
      "{name}: {n} message waits for {m} min. Waiting: the agent is busy with a turn",
    "bell.m.held.trust":
      "{name}: {n} messages wait for {m} min. Waiting: a question about trusting its folder is on its screen",
    "bell.m.held.trust.one":
      "{name}: {n} message waits for {m} min. Waiting: a question about trusting its folder is on its screen",
    "bell.m.held.permission":
      "{name}: {n} messages wait for {m} min. Waiting: a permission question is on its screen",
    "bell.m.held.permission.one":
      "{name}: {n} message waits for {m} min. Waiting: a permission question is on its screen",
    "bell.m.held.approval":
      "{name}: {n} messages wait for {m} min. Waiting: it waits for you to Allow a change",
    "bell.m.held.approval.one":
      "{name}: {n} message waits for {m} min. Waiting: it waits for you to Allow a change",
    "bell.m.held.paused":
      "{name}: {n} messages wait for {m} min. Waiting: it is paused after a compaction loop until you go on",
    "bell.m.held.paused.one":
      "{name}: {n} message waits for {m} min. Waiting: it is paused after a compaction loop until you go on",
    "bell.m.held.stopped":
      "{name}: {n} messages wait for {m} min. Waiting: the agent isn't running",
    "bell.m.held.stopped.one":
      "{name}: {n} message waits for {m} min. Waiting: the agent isn't running",
    "bell.m.held.owner":
      "{name}: {n} messages wait for {m} min. Waiting: Den is still asking Hub who you are",
    "bell.m.held.owner.one":
      "{name}: {n} message waits for {m} min. Waiting: Den is still asking Hub who you are",
    "bell.m.held.unread":
      "{name}: {n} messages wait for {m} min. Waiting: Den couldn't read the agent's state in time",
    "bell.m.held.unread.one":
      "{name}: {n} message waits for {m} min. Waiting: Den couldn't read the agent's state in time",
    "bell.m.held.draft":
      "{name}: {n} messages wait for {m} min. Waiting: you're typing a message to it; they go once you send or clear it",
    "bell.m.held.draft.one":
      "{name}: {n} message waits for {m} min. Waiting: you're typing a message to it; it goes once you send or clear yours",
    "bell.m.held.hub_tools":
      "{name}: {n} messages wait for {m} min. Waiting: its Hub tools didn't load; restart it",
    "bell.m.held.hub_tools.one":
      "{name}: {n} message waits for {m} min. Waiting: its Hub tools didn't load; restart it",
    "bell.m.hubNoAnswer":
      "{name}: {n} Hub comments typed in, no answer yet after {m} min",
    "bell.m.hubNoAnswer.one":
      "{name}: {n} Hub comment typed in, no answer yet after {m} min",
    "bell.m.crashLoop":
      "__DEN_TITLE__'s web app stopped {n} times in {m} minutes without a clean stop; it waited {s} s before starting again",
    "bell.m.updateOut":
      "__DEN_TITLE__ {v} is out. Allow the update when it suits you (this install runs {have})",
    "bell.m.updateRollbackFailed":
      "__DEN_TITLE__ couldn't update to {v}, and the rollback failed too: __DEN_TITLE__ {from} may not start. Put the pin back on {from} in {root} and run npm install there. Why: {why}",
    "bell.m.updateFailed": "__DEN_TITLE__ couldn't update to {v}: {why}",
    "bell.m.updateWaits":
      "__DEN_TITLE__'s update to {v} waits: the __DEN_TITLE__ agent is waiting on your Allow",
    "bell.m.hubAgentsReconnect":
      "Reconnect to Hub so your agents sign their own work",
    "bell.m.updateWaitsAsked":
      "__DEN_TITLE__'s update to {v} waits: the __DEN_TITLE__ agent asked you a question",
    "bell.m.updateWaitsWhat":
      "__DEN_TITLE__'s update to {v} waits: the __DEN_TITLE__ agent is waiting on your Allow: {what} (since {since})",
    "bell.m.updatedSecurity":
      "__DEN_TITLE__ updated for a security fix while {agent} was waiting on you; its question is still open",
    "bell.m.serviceBack": "Brought back 1 service after the restart.",
    "bell.m.servicesBack": "Brought back {n} services after the restart.",
    "bell.m.serviceBackFailed":
      "Brought back 1 service after the restart. Not brought back: {failed}.",
    "bell.m.servicesBackFailed":
      "Brought back {n} services after the restart. Not brought back: {failed}.",
    "bell.m.toolsNoteHeld":
      "__DEN_TITLE__ reconnected Hub's tools for {agent}; its note waits until you answer {agent} in its terminal",
    "bell.m.toolsListFailed":
      "{agent} can't use Hub's tools: listing them failed again after __DEN_TITLE__ restarted it once. Restart it from Agents once Hub is fixed",
    "bell.m.backNoteHeld":
      "__DEN_TITLE__ is back; its note to {agent} waits until you answer {agent} in its terminal",
    "bell.m.restartedWhileWorking":
      "__DEN_TITLE__ restarted to finish an update while {agent} was working",
    "bell.m.updateWaitsAskedWhat":
      "__DEN_TITLE__'s update to {v} waits: the __DEN_TITLE__ agent asked you a question: {what} (since {since})",
    "bell.m.pinNotCommitted":
      "__DEN_TITLE__ {v} runs here, but its new pin isn't committed in the distribution's folder",
    "bell.m.pinPushed":
      "__DEN_TITLE__ updated to {v}: its pin is committed ({sha}) and pushed",
    "bell.m.pinPushFailed":
      "__DEN_TITLE__ {v}: its pin is committed ({sha}) but the push failed: {why}. __DEN_TITLE__ tries again at the next update check",
    "bell.m.pinCommitFailed":
      "__DEN_TITLE__ {v}: __DEN_TITLE__ couldn't commit its pin: {why}. It tries again at the next update check",
    "bell.m.pinPrOpened":
      "__DEN_TITLE__ updated to {v}: its pin is in a pull request ({branch})",
    "bell.m.pinPushedBehind":
      "__DEN_TITLE__ updated to {v}: its pin is pushed ({sha}), but the checkout is behind and has local changes, so pull to get the pin",
    "bell.m.pinPrAhead":
      "__DEN_TITLE__ updated to {v}: the checkout has commits not pushed, so its pin went to a pull request; opened #{n} ({branch})",
    "bell.m.pinPrFallback":
      "__DEN_TITLE__ updated to {v}: the branch needs a pull request; opened #{n} for its pin ({branch})",
    "bell.m.pinBranchPushed":
      "__DEN_TITLE__ {v}: the pin branch {branch} is pushed; open a pull request for it ({why})",
    "bell.m.pinHeld":
      "__DEN_TITLE__ {v}: committing its pin waits for your Allow",
    "bell.m.pinNotCommittedAllow":
      "__DEN_TITLE__ {v} runs here, but its new pin isn't committed: the __DEN_TITLE__ agent is waiting on your Allow",
    "bell.m.hubCommentsRejected":
      "Hub comments aren't arriving: Hub did not accept this install's token (Settings › Hub: Reconnect)",
    "bell.m.hubCommentsForbidden":
      "Hub comments aren't arriving: Hub refused this install's comment delivery",
    "bell.m.hubCommentsRefused":
      "Hub comments aren't arriving: Hub has no comment delivery for this install",
    "bell.m.hubCommentsUnreachable":
      "Hub comments aren't arriving: __DEN_TITLE__ can't reach Hub",
    "bell.m.hubCommentsClosed":
      "Hub comments aren't arriving: Hub keeps closing the comment stream",
    "bell.m.hubCommentsSilent":
      "Hub comments aren't arriving: the comment stream went silent",
    "bell.m.hubCommentsStale":
      "Hub comments aren't arriving: the comment stream is open, but Hub lists comments it hasn't sent",
    "bell.m.rolledBack":
      "__DEN_TITLE__ {v} didn't come up here and went back to {from}: {why}",
    "bell.m.turn": "{name} finished its turn",
    "bell.m.said": "{name}: {text}",
    "bell.m.hub": "{name} finished {n} Hub comments",
    "bell.m.hub.one": "{name} finished {n} Hub comment",
    "bell.m.hubOn": "{name} finished {n} Hub comments on {artifact}",
    "bell.m.hubOn.one": "{name} finished {n} Hub comment on {artifact}",
    "bell.now": "now",
    "bell.min": "{n} min",
    "bell.h": "{n} h",
    "ag.hub.working.one": "Working on {n} Hub comment",
    "ag.hub.working": "Working on {n} Hub comments",
    "ag.hub.queued.one": "{n} Hub comment waits for it",
    "ag.ctx.tag": "Compacting repeatedly",
    "ag.ctx.looping":
      "Compacting repeatedly: {n} automatic compactions in the last few minutes.",
    "ag.ctx.causeFiles":
      "Likely cause: its instruction files are {size}, more than {share}% of its context, and load again after every compaction. The largest is {path} ({big}).",
    "ag.ctx.causeOther":
      "Likely cause: its context fills again soon after each compaction (large tool output, or files read whole).",
    "ag.ctx.held": "New deliveries to it wait until you clear this.",
    "ag.ctx.clear": "Clear",
    "ag.ctx.clearHeld": "Let deliveries go",
    "ag.ctx.clearName": "Clear {id}'s compaction loop",
    "ag.ctx.cleared": "{id}: cleared",
    "ag.ins.tag": "Large instructions",
    "ag.ins.tip":
      "Its instruction files are {size}: more than {share}% of its context. The largest is {path} ({big}).",
    "ag.hub.queued": "{n} Hub comments wait for it",
    "ag.hub.notAtPrompt": "Waiting: the agent isn't at its prompt",
    "ag.draftWaiting": "{n} messages waiting: sent after your draft",
    "ag.draftWaiting.one": "{n} message waiting: sent after your draft",
    "ag.draftWaitingTip":
      "Den holds these while you type here. Send or clear your message, and they go in, in order.",
    "tx.asked": "Asked",
    "tx.result": "Result",
    "tx.error": "Error",
    "tx.omitted": "{n} earlier lines not shown",
    "tx.omitted.one": "{n} earlier line not shown",
    "tx.empty": "Nothing yet.",
    "tx.close": "Close",
    "tx.loading": "Loading…",
    "tx.failed": "Couldn't read it: {err}",
    "hp.title": "Helpers ({n})",
    "hp.bar": "Helpers: {n}",
    "hp.barRunning": "Helpers: {n}, {r} running",
    "hp.titlePlain": "Helpers",
    "hp.rowRunning": "{n} helpers running",
    "hp.rowRunning.one": "{n} helper running",
    "hp.runningN": "{n} running",
    "hp.chip": "{n} helpers",
    "hp.chip.one": "{n} helper",
    "hp.groupOf": "Helpers of {name}",
    "hp.open": "{what}, {status}: open its transcript",
    "hp.dlg": "{name}'s helpers",
    "hp.earlier": "Earlier conversations ({n})",
    "hp.none": "No helpers in this conversation.",
    "hp.clear": "Clear done",
    "hp.clearTip":
      "Hide every finished helper of {name} (done, failed or stopped). Running ones stay.",
    "hp.clearFailed": "Couldn't clear: {err}",
    "hp.cleared": "Show cleared ({n})",
    "hp.allCleared": "Every finished helper is cleared.",
    "hp.unsupported":
      "This agent's runtime can't tell which helpers it started.",
    "hp.workflow": "workflow {name}",
    "hp.note":
      "Helpers run inside this agent itself, so Den shows them but can't stop or steer them. To change what they do, tell the agent.",
    "hp.st.running": "running",
    "hp.st.idle": "idle",
    "hp.st.done": "done",
    "hp.st.failed": "failed",
    "hp.st.stopped": "stopped",
    "hub.rail": "Hub",
    "hub.railRejected":
      "Hub doesn't accept this install's token. Reconnect in Settings › Hub.",
    "hub.railForbidden":
      "Hub doesn't allow this install. Ask a Hub admin (Settings › Hub).",
    "hub.railNoToken": "Not connected to Hub yet. Connect in Settings › Hub.",
    "hub.railUnreachable": "Den can't reach Hub right now. See Settings › Hub.",
    "hub.railBadConfig":
      "Den's Hub settings have a problem. See Settings › Hub.",
    "hub.railBadUrl":
      "Hub's address isn't https, so Den won't open it. See Settings › Hub.",
    "ag.session": "shell",
    "ag.empty":
      "Pick an agent on the left to open its terminal. Open more to tile them (up to 4).",
    "ag.none.scope": "No agents in {scope} yet",
    "ag.detach": "Close pane",
    "ag.to": "To {name} · {ws}",
    "ag.toName": "To {name}",
    "ag.detachName": "Close {id}'s pane (it keeps running)",
    "ag.detached": "Closed {id}'s pane: it keeps running",
    "ag.open": "Open",
    "ag.openName": "Open {id} in Agents",
    "ws.openAgents": "Open in Agents →",
    "ag.signin": "Sign in to open terminals: run {cli} web login",
    "ag.revoked": "token revoked",
    "ag.revokedTip":
      "Its token was revoked (web logout --all): stop and resume it, or start it again, to give it a new one",
    "ag.ended":
      "This terminal has ended. Its record stays until it is resumed or removed.",
    "ag.switched": "Switched to {p}",
    "ag.exitedLine": "[the terminal exited{code}]",
    "ag.refusedUnknown": "the server refused the terminal",
    "ag.refusedStatus": "the server refused the terminal ({status})",
    "ag.goWs": "Open {ws} on Projects",
    "ag.lost": "[disconnected: {why}]",
    "ag.reconnect": "Reconnect",
    "ag.reconnecting": "Reconnecting…",
    "ag.reconnectGaveUp": "Couldn't reconnect: {n} tries in {min} minutes",
    "ag.notAnswering": "__DEN_TITLE__ isn't answering",
    // AG-DROP: a file dropped, pasted or attached onto an agent's terminal.
    "ag.path.download": "Download",
    "ag.path.open": "Open in {ed}",
    "ag.path.copy": "Copy path",
    "ag.path.downloading": "Downloading {name}",
    "ag.path.noFile":
      "{name} can't be downloaded: it isn't a file in the agent's project or uploads",
    "ag.up.drop": "Drop to attach to {name}",
    "ag.up.cant": "Can't attach: {name} isn't running",
    "ag.up.cantConn":
      "Can't attach: {name} isn't connected yet. Try again in a moment.",
    "ag.up.miss": "Drop the file on an agent's pane to attach it.",
    "ag.up.sending": "sending…",
    "ag.up.pct": "{n}%",
    "ag.up.done": "attached",
    "ag.up.attach": "Attach",
    "ag.up.attachName": "Attach a file to {id}",
    "ag.up.attachTip":
      "Attach a file: it goes to the agent's machine and its path is typed here",
    "ag.size.follow": "Sized by another view ({cols}×{rows})",
    "ag.size.take": "Take over",
    "ag.noBackend":
      "Terminals need the optional PTY module (den-pty is unavailable): {cli} doctor says why",
    "ag.hostDown":
      "Den couldn't reach the terminal host in time, so this list may be out of date. Trying again every few seconds.",
    "ag.noHost": "No session host is running: nothing has started yet",
    "ag.ws": "Project",
    "ag.pal": "Agents › {ws} / {name}",
    "tm.pal": "Terminals › {ws} / {name}",
    "ag.palStart": "Start agent…",
    // ON-6: the __DEN_TITLE__ agent (server-agent-page.js, the rail, ⌘K).
    "n.serverAgent": "__DEN_TITLE__ agent",
    "ag.server": "Server",
    "pal.askServer": "Ask the __DEN_TITLE__ agent",
    "sa.sub.fresh":
      "Let's set up __DEN_TITLE__. It reads only until you allow a write.",
    "sa.sub":
      "For anything about this server: add a repo, fix a failing service, change a setting, or explain what's running.",
    "sa.login":
      "If Claude asks you to log in, log in here. Then {name} starts.",
    "sa.trust": "The agent asks whether to trust its folder, {folder}.",
    "sa.trust.yes": "Trust",
    "sa.trust.no": "Not now",
    "sa.trust.wait":
      "The agent waits until you answer, here or in its terminal.",
    "sa.model": "Model",
    "sa.readsOnly":
      "It changes __DEN_TITLE__ through its own tools, and commits only the distribution's own files. Each change asks you first, in this browser.",
    "sa.starting": "Starting the agent…",
    "sa.idle": "{name} isn't running.",
    "sa.start": "Start",
    "sa.fresh": "Start fresh",
    "sa.fresh.h": "Start fresh?",
    "sa.fresh.q": "This ends the {name}'s conversation. Start a new one?",
    "sa.fresh.cancel": "Cancel",
    "sa.fresh.go": "Start fresh",
    "sa.fresh.w": "Starting a new {name}…",
    "sa.fresh.done": "Done: a new {name} is running.",
    "sa.fresh.fail": "Couldn't start a new {name}.",
    "sa.failed": "It didn't start: {why}. {cli} agents doctor says more.",
    "sa.unread": "Couldn't read the agent's status. Is the web server running?",
    "sa.none.h": "No runtime can run the agent yet",
    "sa.none":
      "The agent runs on an agent CLI from the runtime catalog. Install one, log in to it once, then reload this page.",
    "sa.noTools": "can't use __DEN_TITLE__'s tools yet",
    "sa.manual.h": "Or set it up yourself",
    "sa.manual": "Every step the agent takes is also a command. In a terminal:",
    "sa.runsOn": "Runs on",
    "sa.openAgents": "Open in Agents",
    "sa.saved": "Saved. The agent uses it from its next start.",
    // Issue 52: the Coach tab (mock v2).
    "co.tabs": "Agent views",
    "co.tab.terminal": "Terminal",
    "co.tab.coach": "Coach",
    "co.run": "Run now",
    "co.runAgain": "Run again",
    "co.running": "Running…",
    "co.running.sub": "Reading transcripts: {done} of {total} agents.",
    "co.running.start": "Starting the run.",
    "co.running.h": "Reading this __DEN_TITLE__'s agents",
    "co.running.p":
      "The tab fills in when the run ends. You can leave this page.",
    "co.failed": "Last run failed: {when}",
    "co.failed.before": "Nothing was saved. Showing the run before: {when}.",
    "co.failed.none": "Nothing was saved.",
    "co.failed.table": "The table below is the {when} report, unchanged.",
    "co.none.h": "Not run yet",
    "co.none.sub":
      "Run it by hand. It reads this __DEN_TITLE__'s agents and changes nothing.",
    "co.empty.h": "No report yet",
    "co.empty.p": "Press Run now. A run takes a minute or two.",
    "co.last": "Last run: {when}",
    "co.cost": "It cost {tokens} tokens on {model}. It read {n} agents.",
    "co.cost.one": "It cost {tokens} tokens on {model}. It read {n} agent.",
    "co.costNone": "It used no model. It read {n} agents.",
    "co.costNone.one": "It used no model. It read {n} agent.",
    "co.off.h": "Coach is off",
    "co.off.sub": "Turn Coach on to run it.",
    "co.off.p":
      "Coach reads how this __DEN_TITLE__'s agents use tokens and writes a report. It reads only this __DEN_TITLE__'s own agents, sends nothing off this machine and changes nothing.",
    "co.off.how":
      "To turn it on: Settings → Agents → Coach → turn on. Or set agents.coach.enabled: true.",
    "co.openSettings": "Open Settings",
    "co.tile.window": "Window",
    "co.days": "{n} days",
    "co.days.one": "{n} day",
    "co.perDayShort": "{v} / day",
    "co.range": "Window: {from} – {to}, {days} days",
    "co.showAs": "Show counts as",
    "co.total": "Total",
    "co.perDay": "Per day",
    "co.col.agent": "Agent",
    "co.col.calls": "Calls",
    "co.col.output_M": "Output tokens",
    "co.col.cache_read_B": "Cache reads",
    "co.col.avg_context_k_main": "Avg context / call",
    "co.col.compactions": "Compactions",
    "co.col.rotations": "Rotations",
    "co.col.conversations": "Conversations",
    "co.col.polls": "Polls",
    "co.col.denials": "Denials",
    "co.col.tool_error_pct": "Tool errors",
    "co.col.correction_pct": "Corrections",
    "co.card.calls": "Calls",
    "co.card.output": "Output",
    "co.noNumbers": "no numbers in this window",
    "co.foot": "Only agents this __DEN_TITLE__ started or brought in.",
    "co.detail.sub": "{range} · {n} conversations",
    "co.detail.sub.one": "{range} · {n} conversation",
    "co.close": "Close",
    "co.conv.h": "Conversations (newest first)",
    "co.noConv": "No conversation in this window.",
    "co.kind.start": "start",
    "co.kind.fresh": "fresh",
    "co.kind.rotation": "rotation",
    "co.kind.bring-in": "bring-in",
    "co.why.start": "its first launch",
    "co.why.fresh": "a new conversation: Start fresh or a relaunch",
    "co.why.rotation": "relaunched from its handoff",
    "co.why.bring-in": "brought in from outside __DEN_TITLE__",
    "co.approx": "(time approximate)",
    "co.mix.h": "Model mix, by calls",
    "co.mix.main": "Main calls",
    "co.mix.sub": "Subagent calls",
    "co.mix.none": "No calls",
    "co.mix.opus": "Opus",
    "co.mix.sonnet": "Sonnet",
    "co.mix.haiku": "Haiku",
    "co.mix.other": "Other",
    "co.mix.part": "{model} {pct}",
    "co.mix.flagged": "{pct} on Opus; the Coach flags this below",
    "co.perDayH": "Per day",
    "co.perDayLine":
      "Calls {calls}/day · output {output}/day · {compactions} compactions/day · {rotations} rotations/day",
    "co.run.w": "Running the Coach…",
    "co.run.done": "Done: the Coach's report is ready.",
    "co.run.fail": "The Coach run failed.",
    "co.dis.w": "Dismissing…",
    "co.dis.done": "Dismissed.",
    "co.dis.fail": "Couldn't dismiss it.",
    "co.ap.busy.w": "Asking for Allow…",
    "co.ap.busy.done": "Sent to the bell for Allow.",
    "co.ap.busy.fail": "Couldn't ask for Allow.",
    "co.undo.w": "Taking it back…",
    "co.undo.done": "Back in the list.",
    "co.undo.fail": "Couldn't take the dismissal back.",
    "co.counts.w": "Saving…",
    "co.counts.done": "Saved.",
    "co.counts.fail": "Couldn't save how counts show.",
    "co.off.status": "Off",
    "co.f.h": "Findings",
    "co.f.count":
      "{n} from this run. Coach only reads and reports: it changes nothing.",
    "co.f.count.one":
      "{n} from this run. Coach only reads and reports: it changes nothing.",
    "co.f.col.finding": "Finding",
    "co.f.col.agent": "Agent",
    "co.f.col.why": "Why Coach says so",
    "co.ap.apply": "Apply",
    "co.ap.proposed": "Proposed change: {change}",
    "co.ap.change.subagent_opus": "Set {persona}’s subagent model to Sonnet.",
    "co.ap.rev.subagent_opus": "Yes: set it back in {persona}’s persona.",
    "co.ap.now.subagent_opus": "{persona}’s subagent model is now Sonnet.",
    "co.ap.none": "Coach has no change to propose for this one.",
    "co.ap.waiting": "Waiting for Allow",
    "co.ap.waiting.line":
      "Nothing has changed yet. A person must allow this in the bell.",
    "co.ap.openBell": "Open the bell",
    "co.ap.applied": "Applied",
    "co.ap.applied.by":
      "Allowed by {by}, {when}. {now} Coach will check it in the next run.",
    "co.ap.applied.at":
      "Allowed {when}. {now} Coach will check it in the next run.",
    "co.ap.denied": "Denied",
    "co.ap.denied.by":
      "Denied by {by}, {when}. Nothing was changed. The finding stays.",
    "co.ap.denied.at": "Denied {when}. Nothing was changed. The finding stays.",
    "co.ap.failed": "Failed",
    "co.ap.failed.line": "Could not apply: {reason}. Nothing was changed.",
    "co.ap.failed.none": "Could not apply. Nothing was changed.",
    "co.ap.again": "Apply again",
    "co.ap.retry": "Try again",
    "co.ap.fail": "Could not ask to apply “{title}”. Try again.",
    "co.ap.live.waiting": "“{title}”: waiting for Allow.",
    "co.ap.live.applied": "“{title}”: applied.",
    "co.ap.live.denied": "“{title}”: denied. Nothing was changed.",
    "co.ap.live.failed": "“{title}”: failed. Nothing was changed.",
    "bell.coach.asks": "The __DEN_TITLE__ agent asks to change {persona}",
    "bell.coach.from": "From the Coach finding “{title}”.",
    "bell.coach.change": "Change",
    "bell.coach.why": "Why",
    "bell.coach.rev": "Reversible",
    "co.f.dismiss": "Dismiss",
    "co.f.undo": "Undo",
    "co.f.toast": "Dismissed “{title}”.",
    "co.f.fail": "Could not dismiss “{title}”. Try again.",
    "co.f.none": "Nothing stood out this week. No agent is past a line.",
    "co.f.dismissedN": "{n} dismissed",
    "co.f.dismissedN.one": "{n} dismissed",
    "co.f.show": "Show",
    "co.f.hide": "Hide",
    "co.f.dismissedAt": "Dismissed {when}",
    "co.f.subagent_opus.t": "{agent} runs its subagents on Opus",
    "co.f.subagent_opus.why":
      "{n}% of {calls} subagent calls ran on Opus, past the line of {line}%. Setting its persona's subagent model to Sonnet runs exploring and checking on the cheaper model.",
    "co.f.polling.t": "{agent} polls a lot",
    "co.f.polling.why":
      "{n} polls a day, past the line of {line}. Waiting on a long run by polling costs a call each time; running it in the background and waiting to be told costs none.",
    "co.f.no_rotation.t": "{agent} hasn't rotated",
    "co.f.no_rotation.why":
      "{n} compactions in this conversation, past its limit of {line}. Each one drops context the agent then reads again. Relaunching it from its handoff starts it smaller.",
    "co.f.denials.t": "{agent} is refused often",
    "co.f.denials.why":
      "{n} refusals a day, past the line of {line}. Check what it keeps asking for: an allow rule for you to approve, or a change to how it works.",
    "co.f.transcript_size.t": "{agent} has large transcripts",
    "co.f.transcript_size.why":
      "{n} MB of transcripts in this window, past the line of {line} MB. Rotating it, or saving screenshots to files, keeps them smaller.",
    "co.f.ask_r12.t": "{agent} asks you unclear questions",
    "co.f.ask_r12.why":
      "{pct}% of its {n} asks to you were plain, under the line of {line}%. Short sentences, every ID explained and each decision a numbered yes/no question make them plain.",
    "co.f.ask_wait.t": "{agent}'s asks wait long",
    "co.f.ask_wait.why":
      "Its asks waited {n} minutes for an answer, at the median, past the line of {line}. Another agent may own these answers, or the asks could be batched.",
    "co.f.msg_repeat.t": "{agent} sends the same message again",
    "co.f.msg_repeat.why":
      "It sent other agents the same text again {n} times, at or past the line of {line}. A missed reply or a loop: saying it once and waiting to be told is enough.",
    "co.f.msg_no_reply.t": "{agent}'s messages get no reply",
    "co.f.msg_no_reply.why":
      "{pct}% of its {n} messages to other agents got no reply, past the line of {line}%. Check it sends to the agent that owns the answer, and that the other agent reads its messages.",
    "co.f.repeat_ask.t": "{agent} left you asking again",
    "co.f.repeat_ask.why":
      "{n} of your prompts asked again for something asked before, as the cheap model judged them. Something you asked for may not have been done.",
    "co.f.trivial_ask.t": "{agent} asks what it could decide",
    "co.f.trivial_ask.why":
      "{n} of its asks to you were ones it could have decided itself, as the cheap model judged them.",
    "co.f.relay.t": "{agent} passes your requests on as its own",
    "co.f.relay.why":
      "{n} of its messages passed a request of yours to another agent as its own, as the cheap model judged them.",
    "ag.cap": "Up to 4 panes: {id}'s closed to make room (it keeps running)",
    // AG-4b: the Agents tab's layouts and named tabs.
    "ag.layout": "Layout",
    "ag.l.focus": "Focus",
    "ag.l.tabs": "Tabs",
    "ag.l.tile": "Tile",
    "ag.l.tip": "{name} ({key})",
    "ag.hint.keys":
      "⌃⇧1 / ⌃⇧2 / ⌃⇧3 switch layout. ⌘-click (Ctrl-click) opens a link or path. Alt+↑ / Alt+↓ move an agent in its project.",
    "ag.pal.layout": "Layout: {name}",
    "ag.copied": "Copied",
    "ag.linkHint": "{key}-click to open",
    "ag.subagents": "subagents: {model}",
    "ag.subagents.inherit": "the runtime's",
    "ag.subagents.inheritFrom.persona":
      "Den sets no model for its subagents: its persona's subagent_model is inherit. Claude Code decides, so Explore may run on the agent's own model.",
    "ag.subagents.inheritFrom.org":
      "Den sets no model for its subagents: agents.subagents.model is inherit. Claude Code decides, so Explore may run on the agent's own model.",
    "ag.subagents.from.persona":
      "Its subagents (Explore too) run on {model}: its persona's subagent_model.",
    "ag.subagents.from.org":
      "Its subagents (Explore too) run on {model}: agents.subagents.model.",
    "ag.subagents.from.default":
      "Its subagents (Explore too) run on {model}: Den's default. agents.subagents.model or a persona's subagent_model changes it.",
    "ag.signIn": "on {label}",
    "ag.signIn.tip":
      "It signs in with {label}, whose token is in this install's secrets store, so it keeps running after logout.",
    "ag.hub.bound": "Verified on Hub",
    "ag.hub.bound.tip":
      "It calls Hub with its own token, so Hub counts its work and approvals as its own.",
    "ag.hub.unbound": "Not verified on Hub",
    "ag.hub.unbound.tip":
      "It calls Hub with this install's token for now, so Hub can't tell its approvals from the install's. Den asks Hub for its own token when it next calls Hub.",
    "ag.tabs": "Open terminals",
    "ag.hint.focus":
      "Click shows one terminal. Shift- or ⌘-click adds it alongside.",
    "ag.hint.tabs":
      "Click opens a terminal as a tab. Double-click a tab to rename it.",
    "ag.hint.tile": "Click adds a terminal as a tile, up to 4.",
    "ag.renameTip": "Double-click to rename",
    "ag.renameName": "Rename {id}",
    "ag.rn.item": "Rename…",
    "ag.rn.title": "Rename {id}",
    "ag.rn.name": "Name",
    "ag.rn.help":
      "Its tab, row and pane header show it; the id {id} never changes. Other agents see it as {peer} from its next start or resume. Empty: back to {id}.",
    "ag.rn.go": "Rename",
    "ag.rn.cancel": "Cancel",
    "ag.job.h": "A background job is still running",
    "ag.job.q":
      "{id}: a background job it started is still running ({min} min), such as a test run. Restart anyway? That ends the job.",
    "ag.job.go": "Restart anyway",
    "ag.job.held":
      "{id}: a background job it started is still running: not restarted yet",
    "ag.mv.item": "Move to project…",
    "ag.ord.up": "Move up",
    "ag.ord.down": "Move down",
    "ag.ord.top": "Move to top",
    "ag.ord.upOne": "Move {id} up",
    "ag.ord.downOne": "Move {id} down",
    "ag.ord.reorder": "Reorder",
    "ag.ord.reorderBand": "Reorder the {band} agents",
    "ag.ord.reorderStopped": "Reorder the stopped agents",
    "ag.ord.done": "Done",
    "ag.ord.grip": "Drag to move it in its project's order",
    "ag.ord.gripOne": "Drag to move {id}",
    "ag.ord.moved": "{name} moved to position {n} of {of}",
    "busy.ordW": "Moving {id}…",
    "busy.ordS": "Done: {id} moved.",
    "busy.ordF": "Couldn't move {id}.",
    "busy.pcW": "Saving the project's colour…",
    "busy.pcS": "Done: the project's colour is saved.",
    "busy.pcF": "Couldn't save the project's colour.",
    // Issue 133: Delete project and Remove service, on the working pop-up.
    "busy.delProjW": "Deleting {name}…",
    "busy.delProjS": "Deleted {name}.",
    "busy.delProjF": "Couldn't delete {name}.",
    // Issue 144: the Agents page's gate chip (heavy test runs take turns).
    "gate.chip": "Gate: {kind} · {who} · until {at}",
    "gate.chipWaiting": " · {n} waiting",
    "gate.kind.browser": "browser tests",
    "gate.kind.cpu": "unit tests",
    "gate.popH": "Test runs on this machine",
    "gate.holds": "Runs {kind}, until about {at}",
    "gate.waits": "Waits to run {kind}, from about {at}",
    "gate.padded": "estimate {est} min; this usually takes {usual}",
    "gate.over": "past its estimate",
    "gate.none": "No test runs hold or wait.",
    "gate.end": "End early",
    "gate.endT": "End this slot early?",
    "gate.endQ":
      "End the slot for {label}? Its run is not stopped; the next one may start.",
    "gate.endGo": "End slot",
    "gate.rowHolds": "gate: {kind}",
    "gate.rowWaits": "waits for gate: {kind}",
    // Issue 715: a release run a person waits on, and why.
    "gate.priority": "release priority: {reason}",
    "gate.priorityWaits": "release priority, after the one ahead: {reason}",
    // Issue 625: test boxes, browser slots on other machines.
    "gate.onBox": "on box {box}",
    "gate.anyBox": "here or on a test box",
    "gate.boxesH": "Test boxes",
    "gate.swapHold":
      "waiting: this machine has {used} GB of swap in use, over {limit} GB, while another run here is going; it starts once swap drops or that run ends",
    "gate.swapUsed": "Swap in use: {used} GB",
    "gate.memoryHold":
      "waiting: this machine has {free}% of its memory free, under {limit}%, while another run here is going; it starts once memory frees or that run ends",
    "gate.memoryUnavailableHold":
      "waiting: memory reading unavailable, while another run here is going; it starts once a reading comes back or that run ends",
    "gate.memoryUnavailable": "This machine: memory reading unavailable",
    "gate.memoryNotMeasured":
      "This machine: memory isn't measured on this platform: memory holds don't apply",
    "gate.freeMemory": "This machine: {free}% of memory free",
    "gate.vms": "VMs here promise {promised} GB of {limit} GB allowed",
    "gate.vmsOver":
      "VMs here promise {promised} GB, over the {limit} GB allowed: the machine can run out of memory",
    "gate.vmsNotCounted": "{runtime}: not counted (couldn't read it)",
    "gate.boxSlots": "{box}: {held} of {n} browser slots in use",
    "gate.boxHeld": "{box}: skipped, held ({reason})",
    "gate.boxDown": "{box}: skipped, doesn't answer ({reason})",
    "gate.boxLow": "{box}: skipped, low on memory ({reason})",
    "gate.boxMemUnknown":
      "{box}: skipped, its free memory can't be read ({reason})",
    "gate.boxSkip": "can't use {box}: {reason}",
    "gate.boxOff": "{box}: skipped, turned off",
    "gate.boxClosed": "{box}: skipped, outside its window (opens {time})",
    "gate.yielded": "Let {to} go ahead",
    "gate.class": "Class: {name}",
    "gate.window": "waits for its {window} window",
    "gate.loadHoldCores":
      "waiting: this machine's load is {load}, over {perCore} × {cores} cores ({limit}), while another unit test run is going; it starts once the load drops or that run ends",
    "gate.loadHold":
      "waiting: load {load} ≥ {limit} while a release run holds the browser slot",
    "gate.startHold":
      "holds its slot; waiting for the load ({load}) to drop under {limit} before it starts",
    "gate.leftoversH": "Stopped after their run ended",
    "gate.leftovers": "{n} leftover processes of {label} ({cmd})",
    "gate.leftovers.one": "{n} leftover process of {label} ({cmd})",
    "gate.removedH": "Throwaway containers removed after their run",
    "gate.removed": "{n} containers of {label} ({images})",
    "gate.removed.one": "{n} container of {label} ({images})",
    "gate.removedBare": "{n} containers of {label}",
    "gate.removedBare.one": "{n} container of {label}",
    "busy.setUndoW": "Putting the setting back…",
    "busy.setUndoS": "The setting is back as it was.",
    "busy.setUndoF": "Couldn't put the setting back.",
    "busy.gateEndW": "Ending the slot for {name}…",
    "busy.gateEndS": "The slot for {name} ended.",
    "busy.gateEndF": "Couldn't end the slot for {name}.",
    "busy.allowW": "Allowing…",
    "busy.allowS": "Allowed.",
    "busy.allowF": "Couldn't allow it.",
    "busy.denyW": "Denying…",
    "busy.denyS": "Denied.",
    "busy.denyF": "Couldn't deny it.",
    "busy.rmSvcW": "Removing {name}…",
    "busy.rmSvcS": "Removed {name}.",
    "busy.rmSvcF": "Couldn't remove {name}.",
    "busy.addSvcW": "Adding {name}…",
    "busy.addSvcS": "Added {name}.",
    "busy.addSvcF": "Couldn't add {name}.",
    "ag.orphan.one":
      "{names} has no project: its project was deleted. Give it one with ⋯ › Move to project….",
    "ag.orphan.many":
      "{n} agents have no project ({names}): their project was deleted. Give each one with ⋯ › Move to project….",
    "ag.mv.title": "Move {id}",
    "ag.mv.to": "To project",
    "ag.mv.helpStopped":
      "It keeps its conversation, folder, name and services. Its next resume is in the new project.",
    "ag.mv.helpRunning":
      "It keeps its conversation, folder, name and services. Den waits for its turn to end, then resumes it there with that project's tools.",
    "ag.mv.now": "Move now, even mid-turn",
    "ag.mv.go": "Move",
    "ag.mv.none": "There is no other project to move it to.",
    "ag.mv.pending": "{id} moves to {ws} when its turn ends.",
    "ag.mv.done": "{id} moved to {ws}.",
    "ag.where.logout": "Stops at logout",
    "ag.where.logoutTip":
      "It runs in the desktop login, so logging out ends it. To keep agents running: Settings › Keep agents running after logout, or {cli} service install --mode always (agents sign in there with a long-lived token: {cli} agents token set)",
    "ag.where.bg": "No GUI",
    "ag.where.bgTip":
      "It keeps running after logout, outside the desktop session: no login keychain and no GUI apps. 1Password uses the service-account token, browsers run headless, and protected folders need Full Disk Access ({cli} doctor).",
    "ag.rt.ready": "Starts {name} {version} from",
    "ag.rt.readyNoVer": "Starts {name} from",
    "ag.rt.notFound": "{name} not found.",
    "ag.rt.searched": "Searched:",
    "ag.rt.more": "and {n} more",
    "ag.rt.nowhere": "no directories",
    "ag.rt.refused": "{name} can't start: {why}.",
    "ag.rt.fix":
      "Install it, or set {key} to its path in {file}, or run {cmd}.",
    "ag.rt.unknown": "No runtime {id} here.",
    "ag.rt.denTools": "Den tools: coming",
    "ag.rt.ownCli":
      "It runs as its own CLI in the project: Den's tools and permission modes are coming for it.",
    "ag.rt.notInstalled": "not installed",
    "ag.rt.needsArgv": "the persona has no argv template",
    // issue 479: a quarantined runtime copy is never started.
    "ag.rt.quarantined":
      "{name} can't start: macOS has quarantined this copy, so Den did not run it and macOS showed no warning:",
    "ag.rt.useOther": "Use another copy found:",
    "ag.rt.clearSelf":
      "Or clear it yourself on the Den machine: run it once from a terminal there and allow it when macOS asks. Den never removes the quarantine.",
    "ag.rt.copyPath": "Copy path",
    "ag.rt.openTerminal": "Open a terminal there",
    "ag.rt.copied": "Copied",
    "ag.rt.copyByHand": "Selected: copy it with ⌘C or Ctrl+C",
    "ag.rt.openRuntimes": "Open Settings › Runtimes",
    "ag.rt.checkAgain": "Check again",
    "ag.rt.notDone": "That didn't work",
    // issue 171: the Edge page.
    "edge.reading": "Reading the edge…",
    "edge.tls.implicit":
      "implicit: edge.tls is not set (mkcert with a local CA, deprecated)",
    "edge.tls.legacy": "from the legacy keys (caroot / issue_cert), mapped",
    "edge.tls.set": "set in edge.tls",
    "edge.cert.files": "Names the included certs should cover",
    "edge.cert.names": "Certificate names",
    "edge.cert.planned": "Certificate names (planned)",
    "edge.none": "No edge configured.",
    "edge.ports.httpOnly": ":{http} (http only)",
    "edge.ports.none": "not published",
    "edge.trust.fronted": "not needed: fronted",
    "edge.trust.unknown": "unknown",
    "edge.trust.yes": "trusted",
    "edge.trust.no": "not trusted",
    "edge.k.container": "Container",
    "edge.k.ports": "Ports",
    "edge.k.trust": "CA trust",
    "edge.k.cert": "Certificate",
    "edge.up": "up",
    "edge.down": "down",
    "edge.network": "network",
    "edge.trust.httpOnly": "http only: no CA",
    "edge.trust.proxy": "a proxy in front owns browser trust",
    "edge.trust.noCa": "no CA set",
    "edge.cert.issued": "issued",
    "edge.cert.notIssued": "not issued",
    "edge.cert.httpOnly": "http only: no cert",
    "edge.cert.fromFiles": "from the included config",
    "edge.cert.n": "{n} names",
    "edge.cert.n.one": "{n} name",
    "edge.src.included": "included dynamic file",
    "edge.src.stack": "written by stack up",
    "edge.routes": "Routes",
    "edge.col.name": "Name",
    "edge.col.upstream": "Upstream",
    "edge.col.source": "Source",
    "edge.routes.none": "No routes.",
    "edge.notRead": "not read ({error})",
    "edge.routes.note":
      "Den's own routes, then the routers in the included dynamic files (edge include), each with its source file, then the routers the stacks wrote (stack).",
    "edge.domains": "Domains",
    "edge.cert.none": "None: the included config holds the certs.",
    "edge.notConfigured": "Not configured",
    "edge.unreachable": "unreachable",
    // Issue 455: Den's address when another server holds its port.
    "edgeAddr.busy.checkW": "Checking __DEN_TITLE__'s address…",
    "edgeAddr.busy.checkS": "Checked",
    "edgeAddr.busy.checkF": "The check didn't finish.",
    "edgeAddr.busy.takeW": "Taking the port over for __DEN_TITLE__'s proxy…",
    "edgeAddr.busy.takeS": "__DEN_TITLE__'s proxy started",
    "edgeAddr.busy.takeF": "__DEN_TITLE__'s proxy didn't start.",
    "edgeAddr.banner.title": "__DEN_TITLE__ is at {address} for now.",
    "edgeAddr.banner.held":
      "Port {port} is held by {owner} ({name}), so {host} goes to {owner} instead.",
    "edgeAddr.banner.heldBare":
      "Port {port} is held by {owner}, so {host} goes to {owner} instead.",
    "edgeAddr.banner.unknown":
      "Port {port} is in use by something __DEN_TITLE__ cannot name, so {host} goes there instead.",
    "edgeAddr.banner.none": "Not reachable yet: nothing answers at {host}.",
    "edgeAddr.banner.fix": "Fix it in Edge",
    "edgeAddr.banner.dismiss": "Dismiss",
    "edgeAddr.card.title":
      "__DEN_TITLE__'s proxy is not running: port {port} is in use",
    "edgeAddr.card.titleNone": "__DEN_TITLE__'s address doesn't answer yet",
    "edgeAddr.card.held":
      "Held by {owner}, {kind} {name} (not __DEN_TITLE__). __DEN_TITLE__ is serving at {address} instead. Checked {time}.",
    "edgeAddr.card.heldBare":
      "Held by {owner} (not __DEN_TITLE__). __DEN_TITLE__ is serving at {address} instead. Checked {time}.",
    "edgeAddr.card.unknown":
      "Held by something __DEN_TITLE__ cannot name. __DEN_TITLE__ is serving at {address} instead. Checked {time}.",
    "edgeAddr.card.none":
      "Not reachable yet: nothing answers at {wanted}. __DEN_TITLE__ is serving at {address} instead. Checked {time}.",
    "edgeAddr.sub.held": "not running: port {port} is in use",
    "edgeAddr.sub.none": "not reachable yet",
    "edgeAddr.kind.container": "Docker container",
    "edgeAddr.kind.process": "process",
    "edgeAddr.what": "What would you like to do?",
    "edgeAddr.opt.proxy": "Add __DEN_TITLE__ to that proxy",
    "edgeAddr.opt.free": "Free port {port}",
    "edgeAddr.opt.takeOver": "Take over",
    "edgeAddr.proxy.body":
      "Your proxy stays in charge of port {port} and sends {host} to __DEN_TITLE__. __DEN_TITLE__ changes nothing in your other project; you paste this where your proxy's config lives.",
    "edgeAddr.proxy.kinds": "Proxy",
    "edgeAddr.copy": "Copy",
    "edgeAddr.copied": "Copied",
    "edgeAddr.proxy.after":
      "After you reload that proxy, __DEN_TITLE__ checks {wanted} reaches __DEN_TITLE__ and switches its links to it. __DEN_TITLE__'s own proxy stays off (edge.publish: false, set for you).",
    "edgeAddr.check": "Check again",
    "edgeAddr.checking": "Checking…",
    "edgeAddr.check.still": "Not there yet: still answers as {owner}.",
    "edgeAddr.check.stillUnknown":
      "Not there yet: it still isn't __DEN_TITLE__.",
    "edgeAddr.check.done": "Done. __DEN_TITLE__ is now at {wanted}.",
    "edgeAddr.check.failed": "The check didn't finish: {error}",
    "edgeAddr.free.container":
      "Stop the container {name} in Docker, or move it off port {port}. Then press Check again; __DEN_TITLE__ starts its own proxy.",
    "edgeAddr.free.process":
      "Stop {owner} (process {name}), or move it off port {port}. Then press Check again; __DEN_TITLE__ starts its own proxy.",
    "edgeAddr.free.unknown":
      "Stop what uses port {port}, or move it off that port. Then press Check again; __DEN_TITLE__ starts its own proxy.",
    "edgeAddr.free.takeOver":
      "It is an old __DEN_TITLE__ proxy ({name}). Take over stops it and starts __DEN_TITLE__'s own.",
    "edgeAddr.now": "Now",
    "edgeAddr.k.container": "Container",
    "edgeAddr.k.ports": "Ports",
    "edgeAddr.k.address": "__DEN_TITLE__'s address",
    "edgeAddr.k.wanted": "Wanted address",
    "edgeAddr.container.notCreated": "not created",
    "edgeAddr.port.heldBy": "{port} held by {owner}",
    "edgeAddr.port.held": "{port} in use",
    "edgeAddr.port.free": "{port} free",
    "edgeAddr.checked.den": "checked: this __DEN_TITLE__",
    "edgeAddr.checked.notDen": "not __DEN_TITLE__",
    "edgeAddr.answers.as": "answers as {owner}",
    "edgeAddr.answers.notDen": "isn't __DEN_TITLE__",
    "edgeAddr.answers.nothing": "nothing answers",
    // issue 171: values the pages show (value-words.js, log-history.ts).
    "val.docker.created": "created",
    "val.docker.running": "running",
    "val.docker.paused": "paused",
    "val.docker.restarting": "restarting",
    "val.docker.removing": "removing",
    "val.docker.exited": "stopped",
    "val.docker.dead": "dead (can't restart)",
    "val.docker.absent": "not found",
    "val.tls.none": "none",
    "val.tls.files": "files",
    "val.gh.success": "succeeded",
    "val.gh.failure": "failed",
    "val.gh.error": "error",
    "val.gh.cancelled": "cancelled",
    "val.gh.timed_out": "timed out",
    "val.gh.inactive": "inactive",
    "val.gh.in_progress": "in progress",
    "val.gh.queued": "queued",
    "val.gh.pending": "pending",
    "val.gh.waiting": "waiting",
    "val.gh.requested": "requested",
    "val.gh.skipped": "skipped",
    "val.gh.action_required": "action required",
    "val.gh.neutral": "neutral",
    "val.gh.stale": "stale",
    "val.gh.startup_failure": "failed to start",
    "val.perf.httpReqs": "HTTP requests",
    "val.perf.iterations": "Iterations",
    "val.perf.vus": "Virtual clients (VUs)",
    "val.perf.httpAvg": "HTTP avg",
    "val.perf.httpP50": "HTTP p50",
    "val.perf.httpP95": "HTTP p95",
    "val.perf.httpP99": "HTTP p99",
    "val.perf.httpMax": "HTTP max",
    "val.perf.reqRate": "Requests / sec",
    "val.perf.iterRate": "Iterations / sec",
    "val.perf.failRate": "Failure rate",
    "val.h.twice": "{why}, twice in a row",
    "val.h.timeout": "timed out",
    "val.h.noAnswer": "no answer in {s} s",
    "val.h.dns": "name not found (DNS)",
    "val.h.noRoute": "no route for it (404)",
    "val.h.fallback": "not this service (localhost answered with an error)",
    "val.h.killed": "stopped by {signal}",
    "val.h.exit": "check failed (exit code {code})",
    "val.h.refused": "connection refused",
    "val.h.reset": "connection dropped",
    "val.h.unreachable": "no answer",
    "val.h.tls": "certificate not accepted",
    "val.h.dockerUnknown": "Docker didn't answer",
    "val.h.noContainer": "no container {name}",
    "val.h.unhealthy": "{name}: failing its health check",
    "val.h.starting": "{name}: starting",
    "val.h.healthy": "{name}: healthy",
    "val.h.container": "{name}: {state}",
    "lg.why.badName": "not a valid repo or service name",
    "lg.why.notLocal": "only on local for now, not on {env}",
    "lg.why.noProject": "can't tell which project {name} is in",
    "lg.why.noSource": "{name} has no running container or log file",
    "lg.why.noSnapshot": "couldn't copy the container's log",
    // issue 171: the Environments page.
    "env.recheck": "Re-check",
    "env.checking": "checking…",
    "env.note.a": "Each repo's",
    "env.note.b":
      "health checks, run against every environment. ↗ opens the service in a new tab. beta and prod are check-only.",
    "env.loading": "Loading…",
    "env.open.title": "Open {what} in a new tab: {url}",
    "env.open": "Open {what} in a new tab",
    "env.run.title": "The deploy run on GitHub",
    "env.run": "run",
    "env.timedOut": "timed out after {s} s",
    "env.fetchFailed": "No answer: is it running?",
    "env.fetchFailedWhy":
      "{url} didn't answer. Check that it is running and that this computer can reach it.",
    "env.up": "up",
    "env.down": "down",
    "env.service": "Service",
    "env.none": "No services in view have a __DEN_MANIFEST_YML__ yet.",
    "env.noCompany": "no company",
    "env.repoOn": "{repo} on {env}",
    "env.checkingN": "checking {n} environments…",
    "env.checkingN.one": "checking {n} environment…",
    "env.failingSoFar": "{n} failing so far",
    "env.checked": "checked {time}",
    "env.failing": "{n} failing",
    "env.nothingFailing": "nothing failing",
    // issue 171: the Logs page.
    "lg.streams": "streams",
    "lg.cols.title": "Side by side",
    "lg.cols": "cols",
    "lg.rows.title": "Stacked",
    "lg.rows": "rows",
    "lg.search.ph": "Search across all logs…",
    "lg.search.title":
      "Search the FULL log history of every running service (back to container startup)",
    "lg.search": "search",
    "lg.empty":
      "No active log streams. Open a log from a service card or the toolbar above.",
    "lg.ownLog": "__DEN_TITLE__'s own log (lifecycle + requests)",
    "lg.earlier": "⟰ earlier",
    "lg.earlier.title": "Load earlier log history (back to container startup)",
    "lg.filter": "filter…",
    "lg.filter.clear": "Clear filter",
    "lg.close": "✕ Close",
    "lg.paused":
      "live lines paused in this view (window full while browsing history)",
    "lg.loading": "… loading",
    "lg.hist.unavailable": "history unavailable: {reason}",
    "lg.hist.start": "container start",
    "lg.hist.full":
      "history window full ({n} lines) — raise log_window_lines or use search",
    "lg.hist.full.one":
      "history window full ({n} line) — raise log_window_lines or use search",
    "lg.hist.failed": "history fetch failed: {error}",
    "lg.empty.click":
      "No active log streams. Click a service name above to open one.",
    "lg.search.pane": 'search: "{q}"',
    "lg.search.matches": "{n} matches (click to open stream)",
    "lg.search.matches.one": "{n} match (click to open stream)",
    "lg.search.matchesMore": "{n}+ matches (click to open stream)",
    "lg.search.matchesMore.one": "{n}+ match (click to open stream)",
    "lg.search.none": 'no matches for "{q}" in any service\'s history',
    "lg.aws.expired": "AWS sign-in expired",
    "lg.aws.reauth": "Re-authenticate",
    "lg.aws.retry": "Retry",
    "lg.aws.failed": "login failed",
    "lg.aws.connErr": "connection error",
    // issue 171: the Services page.
    "svc.loading": "Loading services…",
    "svc.ws.none": "No services yet.",
    "svc.ws.devManaged": "dev-managed · {path}",
    "svc.ws.managed": "managed · {branch}",
    "svc.ws.remove": "Remove",
    "svc.ws.selectRepo": "Select repo…",
    "svc.ws.added": "(added)",
    "svc.ws.nameRequired": "Name required",
    "svc.ws.created": '✓ Created "{name}"',
    "svc.ws.keepDefault": "Cannot delete default",
    "svc.ws.deleted": '✓ Deleted "{name}"',
    "svc.ws.pickRepo": "Select a repo",
    "svc.ws.addedRepo": "✓ Added {repo}",
    "svc.loadingShort": "Loading…",
    "svc.loadFailed": "Failed to load services",
    "svc.none": "No services registered.",
    "svc.none.how": "{cmd} to add a repo.",
    "svc.pin": "Pin {id}",
    "svc.unpin": "Unpin {id}",
    "svc.logs": "logs",
    "svc.notCloned.note": "not cloned yet — run Sync in Projects",
    "svc.sub.note": "managed by its system",
    "svc.noCmds": "no commands for this env",
    "svc.noRuntime": "no runtime",
    "svc.runsNothing.note":
      "runs nothing: nothing to start or health-check; agents can work in it",
    "svc.runsNothing.title":
      "This repo runs nothing (config, docs, rulesets or shared CI). It has no services, so nothing starts and nothing is health-checked.",
    "svc.notCloned.title": "Not cloned yet",
    "svc.notCloned": "not cloned",
    "svc.layers.title": "Manifest layers applied",
    "svc.layers": "manifest: {layers}",
    "svc.shared":
      "Shared: listed once for every project in view that defines it",
    "svc.app.single": "Single-repo applications",
    "svc.app.single.d": "Each repo is its own application.",
    "svc.app.none": "Not in an application",
    "svc.app.none.d": "In view, but in no application.",
    "svc.owner": "Owner",
    "svc.done": "✓ Done in {time}",
    "svc.failed": "✗ Failed in {time}",
    "svc.closed": "Connection closed",
    "svc.openTab": "Open {url} in a new tab",
    // issue 171: the Tests page's report pane.
    "perf.noMetrics": "No metrics captured.",
    "perf.noValues": "No metric values captured",
    "perf.noData": "No data captured.",
    "perf.pane.journeys": "Journeys Output",
    "perf.pane.journeys.empty":
      "Run journeys to see run output; per-run reports land under reports/journeys/",
    "perf.pane.security": "Security Scan Output",
    "perf.pane.security.empty":
      "Run security scans to see run output; ZAP reports land under reports/security/",
    "perf.pane.suites": "Suite Output",
    "perf.pane.suites.empty": "Run the repo suites to see their output",
    "perf.pane.playwright": "Playwright Report",
    "perf.pane.playwright.empty": "Run tests to see the Playwright report",
    "perf.pane.perf": "Performance Report",
    "perf.pane.perf.empty": "Run performance tests to see the rendered report",
    "perf.col.metric": "Metric",
    "perf.col.expression": "Expression",
    "perf.col.actual": "Actual",
    "perf.col.status": "Status",
    "perf.passed": "passed",
    "perf.failed": "failed",
    "perf.noThresholds": "No thresholds configured.",
    "perf.col.check": "Check",
    "perf.col.passes": "Passes",
    "perf.col.fails": "Fails",
    "perf.col.passRate": "Pass rate",
    "perf.noChecks": "No checks captured.",
    "perf.col.scenario": "Scenario",
    "perf.col.executor": "Executor",
    "perf.col.details": "Details",
    "perf.noScenarios": "No scenarios captured.",
    "perf.col.values": "Values",
    "perf.pass": "pass",
    "perf.fail": "fail",
    "perf.noCustom": "No custom metrics captured.",
    "perf.summary": "Summary",
    "perf.latency": "Latency",
    "perf.throughput": "Throughput & Errors",
    "perf.thresholds": "Thresholds",
    "perf.scenarios": "Scenarios",
    "perf.checks": "Checks",
    "perf.custom": "Custom Metrics",
    "perf.modules": "Modules: {n}",
    "perf.started": "Started: {at}",
    "perf.finished": "Finished: {at}",
    // issue 171: the Tests page.
    "tst.openApp": "Open app",
    "tst.openApp.link": "open app",
    "tst.idle": "idle",
    "tst.layout.top.title": "Controls on top",
    "tst.layout.top": "top",
    "tst.layout.side.title": "Controls on left",
    "tst.layout.side": "side",
    "tst.run": "Run",
    "tst.p.browser": "browser",
    "tst.p.api": "api",
    "tst.p.smoke": "smoke",
    "tst.p.perf": "perf",
    "tst.p.journeys": "journeys",
    "tst.p.security": "security",
    "tst.p.suites": "suites",
    "tst.allModules": "All modules",
    "tst.modules": "{n} modules",
    "tst.modules.one": "{n} module",
    "tst.apiUrl": "api url",
    "tst.apiUrl.ph": "Optional override; blank uses repo/env default",
    "tst.localCheckout": "use local checkout",
    "tst.scan": "scan",
    "tst.scan.baseline": "baseline: passive, local + beta",
    "tst.scan.api": "api: OpenAPI, active, local only",
    "tst.scan.full": "full: active attacks, local only",
    "tst.view.rendered": "Rendered Report",
    "tst.view.raw": "Raw Output",
    "tst.openTab": "Open in new tab",
    "tst.noSource":
      "No source repo detected for this pillar — add one to your project or register-repos.",
    "tst.source": "source:",
    "tst.unknown": "(unknown)",
    "tst.noBranch": "(no branch)",
    "tst.running": "running…",
    "tst.passedIn": "✓ Passed in {d}",
    "tst.failedIn": "✗ Failed in {d}",
    "tst.passed": "passed ({d})",
    "tst.failed": "failed ({d})",
    "tst.perfUnavailable":
      "Structured perf report unavailable. Showing raw output instead.",
    "tst.error": "error",
    "tst.rawEmpty": "Raw performance output will appear here.",
    "tst.risk.high": "High",
    "tst.risk.medium": "Medium",
    "tst.risk.low": "Low",
    "tst.risk.info": "Info",
    "tst.sec.head": "{mode} scan · {env} · {at}",
    "tst.sec.new": "New",
    "tst.sec.failed": "scan failed: {error}",
    "tst.sec.report": "report",
    "tst.sec.newOne": "new",
    "tst.perfLoadFailed": "Failed to load perf report ({status})",
    "tst.svc.none": "No services registered for {env}.",
    "tst.svc.how": "Add a {block} block to {file}.",
    "tst.svc.noCaps": "no capabilities for this env",
    "tst.detach": "Detach",
    "tst.stop": "Stop",
    "tst.detached": "Detached",
    "tst.stopped": "Stopped",
    "tst.runningCmd": "running {what}…",
    // issue 171: the Release page.
    "rel.deployTo": "deploy to:",
    "rel.target": "Deploy target",
    "rel.refresh.title": "Re-check deployed state",
    "rel.refresh": "Refresh",
    "rel.idle": "idle",
    "rel.waves.title": "Edit wave assignment",
    "rel.waves": "Waves…",
    "rel.deployAll": "Deploy all →",
    "rel.readOnly.title":
      "Deploys are off. Set release.deploy: true in __DEN_CONFIG_FILE__ to enable them.",
    "rel.readOnly": "read-only",
    "rel.loading": "Loading deployed state",
    "rel.loading.sub":
      "Checking every repo against GitHub — this can take a minute.",
    "rel.close": "Close",
    "rel.col.repo": "Repo",
    "rel.col.deployedAt": "Deployed At",
    "rel.col.deployer": "Deployer",
    "rel.col.source": "Source",
    "rel.col.deployed": "Deployed",
    "rel.col.branch": "Branch",
    "rel.col.status": "Status",
    "rel.col.deploy": "Deploy",
    "rel.col.run": "Deploy run",
    "rel.noEnv": "no deploy environment configured",
    "rel.refreshing": "refreshing…",
    "rel.checking": "checking deployed state…",
    "rel.error": "error: {error}",
    "rel.updated": "{n} repos · updated {time}",
    "rel.updated.one": "{n} repo · updated {time}",
    "rel.loadFailed": "failed to load status",
    "rel.rechecking": "Re-checking {env}",
    "rel.checkingEnv": "Checking {env}",
    "rel.comparing":
      "Comparing every repo against GitHub — this may take a minute.",
    "rel.none":
      "No repos to check. Give a repo's {file} a {block} block saying where each environment's deployed commit is read.",
    "rel.via": "via {source}",
    "rel.srcBranch": "branch this environment ships from",
    "rel.ghEnv": "GitHub Environment",
    "rel.automated": "automated",
    "rel.viewOnGh": "View {who} on GitHub",
    "rel.openWorkflow": "Open {workflow} for {repo} on GitHub",
    "rel.wave": "wave",
    "rel.deploy": "Deploy →",
    "rel.run.success": "success",
    "rel.run.failed": "failed",
    "rel.run.skipped": "skipped",
    "rel.run.dispatching": "dispatching…",
    "rel.run.queued": "queued",
    "rel.run.running": "running",
    "rel.noDate": "the service reports its commit, not when it shipped",
    "rel.never": "never",
    "rel.dep.title": "Deploy {repo} → {env}",
    "rel.dep.ref": "Branch / ref",
    "rel.cancel": "Cancel",
    "rel.dep.go": "Deploy",
    "rel.hot.drift": "(deployed is {status})",
    "rel.hot":
      "{hotfix}: deploying non-main branch {branch} to {prod}{drift}. This bypasses the main-only prod policy — proceed only for an urgent fix.",
    "rel.hot.word": "HOTFIX",
    "rel.prodWord": "PRODUCTION",
    "rel.prodDeploy": "A production deploy.",
    "rel.typeProd": "Type {word} to confirm",
    "rel.typeBranch": "Type the branch name {branch} to confirm the hotfix",
    "rel.deployHotfix": "Deploy hotfix →",
    "rel.plan.wave": "Wave {wave} · {n} repos",
    "rel.plan.wave.one": "Wave {wave} · {n} repo",
    "rel.all.mainOnly":
      "Deploy all to prod takes main only. These are set to another branch: {repos}. Fix the config, or use a hotfix on one repo.",
    "rel.all.prod":
      "Deploying main of {n} repos to PRODUCTION in {waves} waves. Each wave must succeed before the next.",
    "rel.all.prod.one":
      "Deploying main of {n} repo to PRODUCTION in {waves} waves. Each wave must succeed before the next.",
    "rel.all.title": "Deploy all → {env}",
    "rel.all.none": "No repos enabled.",
    "rel.all.hint":
      "Backends (lower waves) deploy first; the next wave only starts once the previous one succeeds (20 s between dispatches).",
    "rel.wave.on": "on",
    "rel.wave.title": "Wave assignment",
    "rel.wave.col": "Wave",
    "rel.wave.workflow": "Workflow",
    "rel.wave.enabled": "Enabled",
    "rel.wave.hint":
      "Saved to your own {mine} (not committed); the shared default in {shared} is unchanged. Lower wave numbers deploy first.",
    "rel.wave.save": "Save (just mine)",
    "rel.wave.saveFailed": "Save failed: {error}",
    "rel.all.label": "all → {env}",
    "rel.tab": "deploy {label}",
    "rel.requesting": "requesting deploy {label}",
    "rel.starting": "starting {label}…",
    "rel.requestId": "(request id {id})",
    "rel.notStarted": "deploy not started",
    "rel.startFailed": "Failed to start deploy: {error}",
    "rel.attaching": "attaching to deploy…",
    "rel.finished": "deploy finished",
    "rel.disconnected": "stream disconnected — reopen Releases to reattach",
    "rel.finishedRechecking": "deploy finished — re-checking…",
    "rel.busy.any": "A CD run is in flight — wait for it to finish",
    "rel.busy.this": "Already deploying this repo",
    "rel.busy.ext": "A CD run for {repo} → {env} is already in flight",
    "rel.busy.extUnknown":
      "A CD run for {repo} is in flight; its target environment is unknown, so a new deploy is blocked",
    // issue 171: a release status line (release-service.ts).
    "rel.st.noBranch": "could not read {branch} branch",
    "rel.st.noSource": "? no release source for {env} in {file}",
    "rel.st.versionErr": "✗ version endpoint: {error}",
    "rel.st.noRun": "? no successful deploy run on {branch}",
    "rel.st.deploymentsErr": "✗ deployments API error",
    "rel.st.noDeploy": "? no successful {workflow} deployment to {env}",
    "rel.st.lastFailed": "? last CD deploy {state} (none succeeded)",
    "rel.st.runConcl": "✗ deploy run {state} — NOT rolled out",
    "rel.st.newer": "⚠ newer deploy {state} @ {at}",
    "rel.st.upToDate": "✓ up-to-date",
    "rel.st.compareErr": "✗ drift (compare API error)",
    "rel.st.behind": "✗ behind {branch} by {n} commits",
    "rel.st.behind.one": "✗ behind {branch} by {n} commit",
    "rel.st.off": "⚠ off-{branch} ({branch} +{ahead}/-{behind})",
    "rel.st.ahead": "⚠ ahead of {branch} by {n} commits",
    "rel.st.ahead.one": "⚠ ahead of {branch} by {n} commit",
    "rel.st.drift": "✗ drift (status={status})",
    "rel.src.version": "version endpoint",
    "rel.src.run": "workflow run",
    "rel.src.deployment": "GitHub deployment",
    // issue 171: the View note (view-scope.js, Environments and Release).
    "view.all": "all active projects",
    "view.one": "project {name}",
    "view.note": "Shows {what}, as the top bar's View. Change it there.",
  };
  // The languages the UI has a catalog for, each named in itself (a name is
  // never translated). The server's list is ui-language.ts's UI_LANGUAGES.
  var LANGUAGES = [
    { id: "en", name: "English" },
    { id: "ja", name: "日本語" },
    { id: "es", name: "Español" },
  ];
  // The page's language: <html lang>, when a catalog for it is loaded.
  var lang = (function () {
    var l = (document.documentElement && document.documentElement.lang) || "en";
    return MESSAGES[l] ? l : "en";
  })();
  function has(table, key) {
    return !!table && Object.prototype.hasOwnProperty.call(table, key);
  }
  var pluralRules = null;
  function pluralOf(n) {
    try {
      pluralRules = pluralRules || new Intl.PluralRules(lang);
      return pluralRules.select(n);
    } catch (e) {
      return n === 1 ? "one" : "other";
    }
  }
  /** A number in the page's language (Intl.NumberFormat, its options). */
  function num(n, opts) {
    try {
      return new Intl.NumberFormat(lang, opts).format(n);
    } catch (e) {
      return String(n);
    }
  }
  /** The catalog's text for key (its plural form for vars.n), or null. */
  function lookup(table, key, vars) {
    if (!has(table, key)) return null;
    if (vars && typeof vars.n === "number") {
      var form = key + "." + pluralOf(vars.n);
      if (has(table, form)) return table[form];
    }
    return table[key];
  }
  function t(key, vars) {
    var s = lookup(MESSAGES[lang], key, vars);
    if (s == null && lang !== "en") s = lookup(MESSAGES.en, key, vars);
    if (s == null) s = key;
    return String(s).replace(/\{(\w+)\}/g, function (m, k) {
      if (!vars || vars[k] == null) return m;
      return typeof vars[k] === "number" ? num(vars[k]) : String(vars[k]);
    });
  }

  /**
   * A held write's details lines as its Allow card shows them: a line with
   * a key in the page's language, else as sent. The approval dialog and the
   * bell's Allow row (its Review) both show these, so they can't differ.
   */
  function apDetailLines(a) {
    var dk = (a && a.detailKeys) || [];
    return ((a && a.details) || []).map(function (l, i) {
      var k = dk[i];
      return k && k.key ? t(k.key, k.vars || {}) : String(l);
    });
  }
  window.denApDetailLines = apDetailLines;

  /**
   * A built-in text's words in this page's language (0.4.45): `en` is the
   * registry's English. A built-in key whose en is word for word `en` reads
   * the catalog; otherwise `own` (a row a distribution or plugin adds:
   * { es: { key: text }, ja: … }, the catalogs' shape) has it, else `en`.
   */
  function tr(key, en, own) {
    if (en == null || en === "") return en;
    if (has(MESSAGES.en, key) && MESSAGES.en[key] === en) return t(key);
    var mine = own && own[lang];
    if (mine && typeof mine[key] === "string" && mine[key]) return mine[key];
    return en;
  }

  /**
   * A page's own static words (0.4.45): an element with data-t="key" shows
   * t(key); data-t-attr="placeholder:key title:key" sets those attributes.
   * The English in the HTML is the fallback (and en's words, held equal by
   * tests/unit/server/i18n.test.ts). Runs once the page is parsed, and on
   * any root a page passes (denShell.localize(root)).
   */
  function localize(root) {
    var scope = root || document;
    if (!scope.querySelectorAll) return;
    var els = scope.querySelectorAll("[data-t], [data-t-attr]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var k = el.getAttribute("data-t");
      if (k && has(MESSAGES.en, k)) el.textContent = t(k);
      var pairs = (el.getAttribute("data-t-attr") || "").split(/\s+/);
      for (var j = 0; j < pairs.length; j++) {
        var m = /^([\w-]+):([\w.-]+)$/.exec(pairs[j]);
        if (m && has(MESSAGES.en, m[2])) el.setAttribute(m[1], t(m[2]));
      }
    }
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", function () {
      localize(document);
    });
  else localize(document);

  var host = document.getElementById("den-shell");
  if (!host || host.dataset.mounted) return;
  host.dataset.mounted = "1";
  var page = host.dataset.page || "";
  // 0.4.45: the rail item lit; a page may light another of its own.
  // Issue 482: the Terminals page's id is its rail item's ("terminal").
  var railLit = page;
  // The page id on the body (den-page-<id>), for CSS from first paint: the
  // Graph page is the Workspaces page's file at /graph (R22, 0.3.0-dev.32).
  if (/^[a-z0-9-]+$/.test(page) && document.body)
    document.body.classList.add("den-page-" + page);

  function esc(v) {
    return String(v == null ? "" : v).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  // ── the kit (den-ui): the shell's markup and its hydration ───────────
  // /den-ui-shell.js, loaded just before this script, is the kit's
  // shell-html.js and shell-client.js as one classic script
  // (window.DenUIShell): the top bar, the rail, the version chip and the
  // Report button are drawn by it, from Den's registries as data.
  var DUI = window.DenUIShell;
  /** An icon's <svg> (the kit's line drawings; a product's own markup). */
  function icon(name) {
    return DUI.icon(name);
  }

  // ── registries ─────────────────────────────────────────────────────────
  var GROUPS = [];
  var NAV = [];
  function upsert(list, item) {
    for (var i = 0; i < list.length; i++)
      if (list[i].id === item.id) {
        list[i] = item;
        return;
      }
    list.push(item);
  }
  function byOrder(a, b) {
    return (a.order || 0) - (b.order || 0) || (a.id < b.id ? -1 : 1);
  }
  var ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
  /** A registration's `order`: a finite number, else 100 with a warning. */
  function orderOf(kind, x) {
    if (x.order === undefined) return 100;
    if (typeof x.order === "number" && isFinite(x.order)) return x.order;
    warn(
      kind +
        ' "' +
        x.id +
        '": order must be a number (got ' +
        JSON.stringify(x.order) +
        "); using 100",
    );
    return 100;
  }
  function warn(msg) {
    if (typeof console !== "undefined" && console.warn)
      console.warn("denShell: " + msg);
  }
  function hasGroup(id) {
    for (var i = 0; i < GROUPS.length; i++)
      if (GROUPS[i].id === id) return true;
    return false;
  }
  function registerGroup(g) {
    if (!g || !ID.test(g.id || "")) throw new Error("group needs an id");
    upsert(GROUPS, {
      id: g.id,
      label: g.label || g.id,
      order: orderOf("group", g),
      from: g.from || null,
    });
    renderRail();
  }
  function registerNav(n) {
    if (!n || !ID.test(n.id || "") || !n.href || !n.group)
      throw new Error("a page needs an id, an href and a group");
    // A page whose group isn't registered yet is kept, and shows when the
    // group arrives (registerGroup re-renders). Registering a page before
    // its group is a legitimate order (a queue, two scripts), so the
    // warning waits until the queue has drained and a tick has passed.
    upsert(NAV, {
      id: n.id,
      label: n.label || n.id,
      // D73: the rail's tooltip, when it says more than the label.
      tip: typeof n.tip === "string" ? n.tip : "",
      icon: n.icon || "page",
      group: n.group,
      order: orderOf("nav", n),
      href: n.href,
      badge: typeof n.badge === "function" ? n.badge : null,
      when: typeof n.when === "function" ? n.when : null,
      // Other names the palette finds it by (R24a: "Local Dev").
      keywords: Array.isArray(n.keywords) ? n.keywords.map(String) : [],
      from: n.from || null,
    });
    checkOrphansSoon();
    renderRail();
  }

  // ── orphans: a page or setting whose group or category never came ────
  var settled = false;
  var orphanTimer = null;
  var warnedOrphan = {};
  function checkOrphansSoon() {
    if (!settled || orphanTimer) return;
    orphanTimer = setTimeout(function () {
      orphanTimer = null;
      checkOrphans();
    }, 0);
  }
  function checkOrphans() {
    NAV.forEach(function (n) {
      var key = "nav:" + n.id + ":" + n.group;
      if (hasGroup(n.group) || warnedOrphan[key]) return;
      warnedOrphan[key] = true;
      warn(
        'nav "' +
          n.id +
          '": group "' +
          n.group +
          '" is not registered; the page shows once it is',
      );
    });
    SETTING_ROWS.forEach(function (r) {
      var key = "setting:" + r.id + ":" + r.category;
      if (hasCategory(r.category) || warnedOrphan[key]) return;
      warnedOrphan[key] = true;
      warn(
        'setting "' +
          r.id +
          '": category "' +
          r.category +
          '" is not registered; the row shows once it is',
      );
    });
  }

  // ── SETTINGS (R21): what the Settings page draws, row by row ──────────
  // A category: { id, label, order, description?, from? }. A row: { id,
  // category, label, description, keywords, scope: user|workspace|
  // distribution, control: { type, … }, read(ctx), write?(value, ctx),
  // keys? } (keys: the /api/settings keys it stores, for the inventory).
  var SETTING_CATS = [];
  var SETTING_ROWS = [];
  var SETTING_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  var SCOPES = ["user", "workspace", "distribution"];
  function hasCategory(id) {
    for (var i = 0; i < SETTING_CATS.length; i++)
      if (SETTING_CATS[i].id === id) return true;
    return false;
  }
  function settingsChanged() {
    try {
      window.dispatchEvent(new CustomEvent("den:settings"));
    } catch (e) {
      /* no CustomEvent: the page re-reads on its own */
    }
  }
  function registerSettingsCategory(c) {
    if (!c || !ID.test(c.id || ""))
      throw new Error("a settings category needs an id");
    upsert(SETTING_CATS, {
      id: c.id,
      label: c.label || c.id,
      order: orderOf("settings category", c),
      description: c.description || "",
      from: c.from || null,
    });
    settingsChanged();
  }
  function registerSetting(r) {
    if (!r || !SETTING_ID.test(r.id || "") || !r.category || !r.label)
      throw new Error(
        'setting "' +
          (r && r.id) +
          '": a setting needs an id ([A-Za-z0-9._-]), a category and a label',
      );
    var scope = r.scope || "user";
    if (SCOPES.indexOf(scope) < 0)
      throw new Error(
        'setting "' + r.id + '": scope must be user, workspace or distribution',
      );
    if (typeof r.read !== "function")
      throw new Error('setting "' + r.id + '" needs read(ctx)');
    // The distribution's own config is tracked: shown, never written.
    if (scope === "distribution" && r.write)
      throw new Error(
        'setting "' +
          r.id +
          '": a distribution setting is read-only (no write)',
      );
    upsert(SETTING_ROWS, {
      id: r.id,
      category: r.category,
      label: r.label,
      description: r.description || "",
      keywords: Array.isArray(r.keywords) ? r.keywords.slice() : [],
      scope: scope,
      control: r.control || { type: "readonly" },
      read: r.read,
      write: typeof r.write === "function" ? r.write : null,
      keys: Array.isArray(r.keys) ? r.keys.slice() : [],
      order: orderOf("setting", r),
      from: r.from || null,
      helpInControl: r.helpInControl === true,
    });
    settingCommand(r);
    checkOrphansSoon();
    settingsChanged();
  }

  // ── the ⌘K palette's commands (R17, dev.20) ────────────────────────────
  // Pages, services and apps are the palette's own (topbar.js); this holds
  // what a page, a distribution or a plugin adds: actions, and the
  // Settings registry's rows (kind "setting", dev.19).
  var COMMANDS = [];
  function registerCommand(c) {
    if (!c || typeof c.id !== "string" || !c.id || typeof c.run !== "function")
      throw new Error("a command needs an id and a run()");
    if (c.label == null)
      throw new Error('command "' + c.id + '" needs a label');
    upsert(COMMANDS, {
      id: c.id,
      label: c.label,
      keywords: Array.isArray(c.keywords)
        ? c.keywords.slice()
        : c.keywords
          ? [String(c.keywords)]
          : [],
      kind: typeof c.kind === "string" && c.kind ? c.kind : "action",
      run: c.run,
      href: typeof c.href === "string" && c.href ? c.href : undefined,
      from: c.from || null,
    });
  }
  function unregisterCommand(id) {
    for (var i = COMMANDS.length - 1; i >= 0; i--)
      if (COMMANDS[i].id === id) COMMANDS.splice(i, 1);
  }
  /**
   * Every SETTINGS row is a palette row too (kind "setting"): Enter opens
   * the Settings page searched for it, at its category
   * (/settings?q=<label>#<category>).
   */
  function settingCommand(r) {
    var cat = r.category;
    // A built-in row's palette label is in the catalogs (set.<id>); a row
    // a distribution or a plugin adds shows its own label. The Settings
    // search (?q=) keeps the row's own label, which that page shows.
    var key = "set." + r.id;
    var href =
      "/settings?q=" +
      encodeURIComponent(r.label) +
      "#" +
      encodeURIComponent(cat);
    registerCommand({
      id: "setting:" + r.id,
      label:
        has(MESSAGES.en, key) && MESSAGES.en[key] === r.label
          ? function () {
              return t(key);
            }
          : r.label,
      keywords: (Array.isArray(r.keywords) ? r.keywords : []).concat([
        cat,
        "settings",
      ]),
      kind: "setting",
      href: href,
      run: function () {
        location.assign(href);
      },
      from: r.from || null,
    });
  }
  /** The registered commands, labels resolved (a label may be a function). */
  function commands() {
    return COMMANDS.map(function (c) {
      var label = c.label;
      if (typeof label === "function") {
        try {
          label = label();
        } catch (e) {
          label = c.id;
        }
      }
      return {
        id: c.id,
        label: String(label),
        keywords: c.keywords.slice(),
        kind: c.kind,
        run: c.run,
        href: c.href,
        from: c.from,
      };
    });
  }

  // ── state: what badges, when() and the pinned dots read ───────────────
  var LS = "__DEN_CLI__-shell";
  var state = {
    health: {},
    down: 0,
    openLogs: 0,
    helpersRunning: 0,
    agentsNeedYou: 0,
    // The rail's Hub link: GET /api/hub?rail=1, or null (not connected).
    hub: null,
    pins: [],
    collapsed: false,
    hidden: [],
    order: [],
    // Issue 1444: the rail sections this person folded (group ids).
    folded: [],
    // The runs dock (R16a): open or collapsed to its bar, and its height
    // (0: the prototype's 170px). User prefs, like the pins.
    dock: false,
    dockHeight: 0,
    // Whether the edge is configured (the Edge page's when): null until
    // known, the last answer cached so the rail doesn't jump.
    edge: null,
    // SEC-2a: who this browser is (GET /api/session `identity`): local,
    // a signed-in device, or a GitHub login. Null until known.
    identity: null,
    // 0.4.18: each pin's URL (svc-panel.js, from the health feed) for its
    // Visit ↗, whether that Visit is off (down or starting: the panel's own
    // live state), and the pin whose service panel is open.
    pinUrls: {},
    pinOff: {},
    svpOpen: null,
    // Issue 402 (the model set on 11-18): a pin is (company, project or
    // none, person, item). pinList is this person's pins in this install
    // ({ item, project }, project null: none), in pin order; pinProject the
    // project picked (the Workspace menu's model, header.js), null under
    // All. `pins` is derived: the items in view, each once: the pins made
    // for the project picked, or every pin under All. pinsLoaded: the
    // server's copy has arrived.
    pinList: [],
    pinProject: null,
    // Issue 402: pinProject is only the one active project, never picked
    // by the person: no project selected, so pins of none show too.
    pinImplicit: false,
    pinsLoaded: false,
    // Whether the Workspace menu's model has said which project is picked.
    pinViewKnown: false,
  };
  // Pins made before the page knew the project picked: they take it when
  // the menu's model arrives (issue 402, clause 2).
  var unplacedPins = [];
  try {
    var cached = JSON.parse(localStorage.getItem(LS) || "{}");
    if (typeof cached.edge === "boolean") state.edge = cached.edge;
    if (Array.isArray(cached.pins)) state.pinList = pinTuples(cached.pins);
    state.collapsed = cached.collapsed === true;
    if (Array.isArray(cached.hidden)) state.hidden = cached.hidden;
    if (Array.isArray(cached.order)) state.order = cached.order;
    if (Array.isArray(cached.folded)) state.folded = cached.folded;
    state.dock = cached.dock === true;
    if (typeof cached.dockHeight === "number")
      state.dockHeight = cached.dockHeight;
  } catch (e) {
    /* no storage: the server's copy arrives below */
  }
  function remember() {
    try {
      localStorage.setItem(
        LS,
        JSON.stringify({
          pins: state.pinList,
          collapsed: state.collapsed,
          hidden: state.hidden,
          order: state.order,
          folded: state.folded,
          dock: state.dock,
          dockHeight: state.dockHeight,
          edge: state.edge,
        }),
      );
    } catch (e) {
      /* a convenience only */
    }
  }
  function setState(partial) {
    var before = JSON.stringify([
      state.pins,
      state.pinProject,
      state.pinImplicit,
    ]);
    for (var k in partial)
      if (Object.prototype.hasOwnProperty.call(partial, k))
        state[k] = partial[k];
    // Issue 402: a list of bare ids (an older caller) is pins for the
    // project in view; the items in view follow the list and the project.
    if (partial && partial.pins !== undefined && partial.pinList === undefined)
      state.pinList = pinsForView(ids(partial.pins));
    state.pins = pinsInView();
    applyState();
    renderRail();
    if (
      JSON.stringify([state.pins, state.pinProject, state.pinImplicit]) !==
      before
    )
      pinsChanged();
  }
  /**
   * Any pin change (the rail's ×, Delete, a page's toggle, the server's
   * prefs arriving) is one event, `den:pins` on window, and every pin
   * toggle on the page ([data-pin-toggle]) repaints from it.
   */
  function pinsChanged() {
    if (typeof window.dispatchEvent !== "function") return;
    var detail = { pins: state.pins.slice() };
    var ev;
    try {
      ev = new CustomEvent("den:pins", { detail: detail });
    } catch (e) {
      return;
    }
    window.dispatchEvent(ev);
  }
  if (typeof window.addEventListener === "function")
    window.addEventListener("den:pins", function () {
      pinToggles(document);
    });
  /** Every pin toggle in root: the kit's ★ "Unpin x" / ☆ "Pin x". */
  function pinToggles(root) {
    DUI.syncPinToggles(root, isPinned, lang);
  }
  function saveShell(patch) {
    remember();
    if (typeof fetch !== "function") return Promise.resolve();
    // busy-ok: pins and the rail's fold save in the background; the page shows them at once
    return fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ shell: patch }),
    })
      .then(function (r) {
        return r && r.ok !== false;
      })
      .catch(function () {
        return false;
      });
  }
  /**
   * Issue 402: pins as the server and older copies hold them: { item,
   * project } (project null: none); a bare id (this browser's copy from
   * before the tuple) is none until the server's migrated copy arrives.
   */
  function pinTuples(list) {
    var out = [];
    (Array.isArray(list) ? list : []).forEach(function (p) {
      var pin =
        typeof p === "string"
          ? { item: p, project: null }
          : p && typeof p.item === "string"
            ? {
                item: p.item,
                project: typeof p.project === "string" ? p.project : null,
              }
            : null;
      if (!pin) return;
      for (var i = 0; i < out.length; i++)
        if (out[i].item === pin.item && out[i].project === pin.project) return;
      out.push(pin);
    });
    return out;
  }
  /** Whether pin `p` is one of the view's: the project picked's, or any under All. */
  function inView(p) {
    return (
      state.pinProject === null ||
      p.project === state.pinProject ||
      (state.pinImplicit && p.project === null)
    );
  }
  /** The project a pin made now is for: none unless the person picked one. */
  function pinFor() {
    return state.pinImplicit ? null : state.pinProject;
  }
  /** The items in view, each once, in pin order (issue 402, clauses 3 and 4). */
  function pinsInView() {
    var out = [];
    state.pinList.forEach(function (p) {
      if (inView(p) && out.indexOf(p.item) < 0) out.push(p.item);
    });
    return out;
  }
  /**
   * The pins once the view's items are `items`, in that order (the
   * Settings page's Pinned row): the view's pins of an item no longer
   * listed go (under All, every pin of it), a new item is pinned for the
   * project in view (none under All), and the other projects' pins stay
   * where they were.
   */
  function pinsForView(items) {
    var view = [];
    items.forEach(function (item) {
      var mine = state.pinList.filter(function (p) {
        return inView(p) && p.item === item;
      });
      view = view.concat(
        mine.length ? mine : [{ item: item, project: pinFor() }],
      );
    });
    var out = [];
    state.pinList.forEach(function (p) {
      if (!inView(p)) out.push(p);
      else if (view.length) out.push(view.shift());
    });
    return pinTuples(out.concat(view));
  }
  function isPinned(id) {
    return state.pins.indexOf(id) >= 0;
  }
  /** Pins made before the project picked was known take it now. */
  function placePins() {
    var made = unplacedPins;
    unplacedPins = [];
    if (pinFor() === null || !made.length) return;
    var moved = false;
    var list = state.pinList.map(function (p) {
      var mine = made.some(function (m) {
        return m.item === p.item && p.project === null;
      });
      if (!mine) return p;
      moved = true;
      return { item: p.item, project: pinFor() };
    });
    if (!moved) return;
    setState({ pinList: pinTuples(list) });
    savePins();
  }
  function savePins() {
    return saveShell({ pins: state.pinList });
  }
  /** Issue 402, clause 2: a pin made now is for the project in view, none under All. */
  function pin(id) {
    if (isPinned(id)) return;
    var made = { item: id, project: pinFor() };
    if (!state.pinViewKnown) unplacedPins.push(made);
    setState({ pinList: state.pinList.concat([made]) });
    savePins();
    toast(t("toast.pinned", { s: id }));
  }
  /**
   * Issue 402, clause 5: under a project, unpinning removes that project's
   * pin only. Under All (★ is "pinned anywhere"), it removes every pin of
   * the item, so the toggle reads ☆, and the toast's Undo puts back
   * exactly the pins removed.
   */
  function unpin(id) {
    if (!isPinned(id)) return;
    var was = state.pinList.slice();
    var removed = was.filter(function (p) {
      return p.item === id && inView(p);
    });
    setState({
      pinList: was.filter(function (p) {
        return removed.indexOf(p) < 0;
      }),
    });
    savePins();
    if (pinFor() !== null) {
      toast(t("toast.unpinned", { s: id }));
      return;
    }
    toastAction(
      t("toast.unpinnedAll", { s: id }),
      t("toast.undo"),
      function () {
        // Each removed pin back where it was, unless it is pinned again.
        var list = state.pinList.slice();
        removed.forEach(function (p) {
          var there = list.some(function (q) {
            return q.item === p.item && q.project === p.project;
          });
          if (!there) list.splice(Math.min(was.indexOf(p), list.length), 0, p);
        });
        setState({ pinList: pinTuples(list) });
        savePins();
      },
    );
  }
  function ids(list) {
    return (Array.isArray(list) ? list : []).filter(function (x, i, all) {
      return typeof x === "string" && all.indexOf(x) === i;
    });
  }
  /** Navigation (R21): the pages the rail hides and their order. */
  function setNavPrefs(prefs) {
    var patch = {};
    if (prefs && prefs.hidden !== undefined) patch.hidden = ids(prefs.hidden);
    if (prefs && prefs.order !== undefined) patch.order = ids(prefs.order);
    setState(patch);
    return saveShell(patch);
  }
  /**
   * The pins in view, in this order (the Settings page's Pinned row): the
   * view's pins follow the list (issue 402), the other projects' stay.
   */
  function setPins(list) {
    setState({ pinList: pinsForView(ids(list)) });
    return savePins();
  }
  function setCollapsed(on) {
    setState({ collapsed: !!on });
    return saveShell({ collapsed: state.collapsed });
  }
  /** The runs dock open or collapsed to its bar (R16a), remembered. */
  function setDock(on) {
    dockOpen = !!on;
    renderDock();
    return rememberDock();
  }
  /** NAV pages in the rail's order: groups by order, then yours, then theirs. */
  function orderedNav() {
    var rank = function (id) {
      var i = state.order.indexOf(id);
      return i < 0 ? Infinity : i;
    };
    var gs = GROUPS.slice().sort(byOrder);
    var out = [];
    gs.forEach(function (g) {
      NAV.filter(function (n) {
        return n.group === g.id;
      })
        .sort(function (a, b) {
          return rank(a.id) - rank(b.id) || byOrder(a, b);
        })
        .forEach(function (n) {
          out.push(n);
        });
    });
    return out;
  }
  var toastTimer = null;
  /**
   * 0.4.45: a toast never covers a line a page marks data-toast-clear
   * (the terminal's "To" line: who the keyboard types to). It moves up
   * until it sits above every such line it would cover. A page may draw
   * that line after the toast shows (issue 448: a toast up before a
   * terminal's pane opens), so it looks again every 250 ms while it shows.
   */
  function clearOfMarked(el, again) {
    if (!el || !el.getBoundingClientRect || !document.querySelectorAll) return;
    if (!again) {
      var look = function () {
        if (!el.isConnected) return;
        clearOfMarked(el, true);
        setTimeout(look, 250);
      };
      setTimeout(look, 120);
    }
    var marks = document.querySelectorAll("[data-toast-clear]");
    for (var pass = 0; pass < 4; pass++) {
      var r = el.getBoundingClientRect();
      var moved = false;
      for (var i = 0; i < marks.length; i++) {
        var m = marks[i].getBoundingClientRect();
        if (!m.width || !m.height) continue;
        var hit =
          r.left < m.right &&
          r.right > m.left &&
          r.top < m.bottom &&
          r.bottom > m.top;
        if (hit) {
          el.style.bottom = Math.ceil(window.innerHeight - m.top + 8) + "px";
          moved = true;
        }
      }
      if (!moved) return;
    }
  }
  function toast(msg) {
    if (!document.body || !document.createElement) return;
    var old = document.querySelector && document.querySelector(".den-toast");
    if (old && old.remove) old.remove();
    var el = document.createElement("div");
    el.className = "den-toast";
    if (el.setAttribute) el.setAttribute("role", "status");
    el.textContent = msg;
    if (document.body.appendChild) document.body.appendChild(el);
    clearOfMarked(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      if (el.remove) el.remove();
    }, 2200);
  }
  /**
   * A toast with one action (AG-14.1b: Remove's Undo): the message and a
   * small button, for `ms` (default 10 s). The action runs once, and the
   * toast goes.
   */
  // Bell v6: `link` ({href, label}) adds a link after the button.
  function toastAction(msg, label, onAction, ms, link) {
    if (!document.body || !document.createElement) return null;
    var old = document.querySelector && document.querySelector(".den-toast");
    if (old && old.remove) old.remove();
    var el = document.createElement("div");
    el.className = "den-toast den-toast-act";
    el.setAttribute("role", "status");
    // Hooks for tests (issue 839: never a styling class).
    el.setAttribute("data-toast", "action");
    var text = document.createElement("span");
    text.className = "den-tmsg";
    text.setAttribute("data-toast-msg", "");
    text.textContent = msg;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "den-tbtn";
    b.setAttribute("data-toast-btn", "");
    b.textContent = label;
    var done = false;
    b.addEventListener("click", function () {
      if (done) return;
      done = true;
      clearTimeout(toastTimer);
      el.remove();
      onAction();
    });
    // The actions in one row: beside the words when wide, under them at
    // 480 px and below.
    var acts = document.createElement("span");
    acts.className = "den-tacts";
    acts.appendChild(b);
    if (link && link.href) {
      var a = document.createElement("a");
      a.className = "den-tlink";
      a.href = link.href;
      a.textContent = link.label;
      acts.appendChild(a);
    }
    el.appendChild(text);
    el.appendChild(acts);
    document.body.appendChild(el);
    clearOfMarked(el);
    // Issue 52: it stays while the pointer or focus is on it, then runs
    // out what was left, so an Undo is never pulled from under a hand.
    var left = ms || 10000;
    var since = Date.now();
    var held = 0;
    var go = function () {
      clearTimeout(toastTimer);
      since = Date.now();
      toastTimer = setTimeout(function () {
        done = true;
        if (el.remove) el.remove();
      }, left);
    };
    var hold = function () {
      if (held++ === 0) {
        clearTimeout(toastTimer);
        left = Math.max(1000, left - (Date.now() - since));
      }
    };
    var letGo = function () {
      if (held > 0 && --held === 0 && !done) go();
    };
    if (el.addEventListener) {
      el.addEventListener("mouseenter", hold);
      el.addEventListener("mouseleave", letGo);
      el.addEventListener("focusin", hold);
      el.addEventListener("focusout", letGo);
    }
    go();
    return el;
  }

  // ── the top layer (0.4.17): one placement for every menu ─────────────
  // A menu shown with topShow is in the browser's top layer (a manual
  // popover), placed by its anchor: below it, above when there's more room
  // there, kept inside the window. No overflow or stacking ancestor can
  // clip or cover it, and it stays where it is in the page, so the page's
  // own click handlers still reach it. It closes when the page hides it
  // (display: none), its anchor goes, or topHide.
  var topOpen = [];
  var TOP_MARGIN = 8;
  function topSupported(el) {
    return typeof el.showPopover === "function";
  }
  // Without the top layer (no popover: an older iPad), a menu inside a
  // modal dialog is fixed to the dialog, not the window: the dialog's
  // transform (it is centred by translateY, issue 231) makes it the
  // containing block. So after placing it, measure where it landed and
  // take the difference off.
  function topPlace(el, anchor, opts) {
    topPlaceAt(el, anchor, opts);
    if (opts.sheet) return;
    try {
      if (el.matches(":popover-open")) return;
    } catch (e) {
      /* no popover: measure */
    }
    var want = {
      top: parseFloat(el.style.getPropertyValue("top")),
      left: parseFloat(el.style.getPropertyValue("left")),
    };
    if (isNaN(want.top) || isNaN(want.left)) return;
    var got = el.getBoundingClientRect();
    var dy = got.top - want.top;
    var dx = got.left - want.left;
    if (Math.abs(dy) < 0.5 && Math.abs(dx) < 0.5) return;
    el.style.setProperty("top", want.top - dy + "px", "important");
    el.style.setProperty("left", want.left - dx + "px", "important");
  }
  function topPlaceAt(el, anchor, opts) {
    var r = anchor.getBoundingClientRect();
    var gap = opts.gap != null ? opts.gap : 4;
    el.style.maxHeight = "";
    // 0.4.18: a bottom sheet is placed by its CSS (bottom: 0), not here.
    if (opts.sheet) {
      el.style.removeProperty("top");
      el.style.removeProperty("left");
      return;
    }
    // 0.4.18: beside the anchor (the rail), level with a row in it.
    if (opts.side === "right") {
      var row = typeof opts.row === "function" ? opts.row() : null;
      var rr = row ? row.getBoundingClientRect() : r;
      var bw = el.offsetWidth;
      var bh = el.offsetHeight;
      var bl = Math.min(r.right + gap, window.innerWidth - bw - TOP_MARGIN);
      var bt = Math.min(
        rr.top + (opts.dy || 0),
        window.innerHeight - bh - TOP_MARGIN,
      );
      el.style.setProperty("top", Math.max(TOP_MARGIN, bt) + "px", "important");
      el.style.setProperty(
        "left",
        Math.max(TOP_MARGIN, bl) + "px",
        "important",
      );
      return;
    }
    var w = el.offsetWidth;
    var h = el.offsetHeight;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var below = vh - r.bottom - gap - TOP_MARGIN;
    var above = r.top - gap - TOP_MARGIN;
    var up = h > below && above > below;
    var room = Math.max(80, up ? above : below);
    if (h > room) {
      el.style.maxHeight = room + "px";
      h = room;
    }
    var top = up ? r.top - gap - h : r.bottom + gap;
    var left = opts.align === "right" ? r.right - w : r.left;
    left = Math.max(TOP_MARGIN, Math.min(left, vw - w - TOP_MARGIN));
    // Important, so no page or UA rule (a popover's inset) moves it.
    el.style.setProperty("top", Math.max(TOP_MARGIN, top) + "px", "important");
    el.style.setProperty("left", left + "px", "important");
  }
  function topIndex(el) {
    for (var i = 0; i < topOpen.length; i++) if (topOpen[i].el === el) return i;
    return -1;
  }
  function topShow(el, anchor, opts) {
    if (!el || !anchor) return;
    opts = opts || {};
    var i = topIndex(el);
    if (i >= 0) {
      topOpen[i].anchor = anchor;
      topOpen[i].opts = opts;
    } else {
      if (topSupported(el)) {
        if (!el.hasAttribute("popover")) {
          el.setAttribute("popover", "manual");
          el.setAttribute("data-den-top-added", "");
        }
        try {
          if (!el.matches(":popover-open")) el.showPopover();
        } catch (e) {
          /* not in the document yet: placed as fixed */
        }
      }
      var o = { el: el, anchor: anchor, opts: opts, mo: null };
      if (typeof MutationObserver === "function") {
        o.mo = new MutationObserver(function () {
          topCheck(o);
        });
        o.mo.observe(el, {
          attributes: true,
          attributeFilter: ["style", "class", "hidden"],
        });
      }
      topOpen.push(o);
    }
    el.classList.add("den-toplayer");
    topPlace(el, anchor, opts);
  }
  function topHide(el) {
    var i = topIndex(el);
    if (i < 0) return;
    var o = topOpen.splice(i, 1)[0];
    if (o.mo) o.mo.disconnect();
    try {
      if (el.matches && el.matches(":popover-open")) el.hidePopover();
    } catch (e) {
      /* already gone */
    }
    if (el.hasAttribute("data-den-top-added")) {
      el.removeAttribute("popover");
      el.removeAttribute("data-den-top-added");
    }
    el.classList.remove("den-toplayer");
    el.style.removeProperty("top");
    el.style.removeProperty("left");
  }
  /** The page hid it, or its anchor went: it's closed. */
  function topCheck(o) {
    if (
      !o.el.isConnected ||
      !o.anchor.isConnected ||
      o.el.hidden ||
      getComputedStyle(o.el).display === "none"
    )
      topHide(o.el);
  }
  function topReplace() {
    topOpen.slice().forEach(function (o) {
      topCheck(o);
      if (topIndex(o.el) >= 0) topPlace(o.el, o.anchor, o.opts);
    });
  }
  window.addEventListener("resize", topReplace);
  document.addEventListener("scroll", topReplace, true);

  // ── menus (.pop, R18): the scope parts' popovers ─────────────────────
  // A menu is { label, items: [{ heading } | { hr: true } | { label, tag?,
  // checked?, href?, onSelect? }] }. Rows with `checked` are radios (✓ when
  // checked). Keyboard: ↑/↓ (wrapping), Home and End move; Enter or Space
  // picks; Escape and Tab close and give focus back to the button; a click
  // outside closes.
  var openPop = null;
  function closeMenu(refocus) {
    if (!openPop) return;
    var o = openPop;
    openPop = null;
    topHide(o.el);
    if (o.el.remove) o.el.remove();
    o.anchor.setAttribute("aria-expanded", "false");
    // aria-controls names the menu only while it exists.
    o.anchor.removeAttribute("aria-controls");
    if (refocus && o.anchor.focus) o.anchor.focus();
  }
  function menuRows(pop) {
    // An entry the kit's filter hid is not a stop.
    return Array.prototype.slice
      .call(pop.querySelectorAll(".den-mi"))
      .filter(function (r) {
        return !r.hidden;
      });
  }
  function openMenu(anchor, menu) {
    var again = openPop && openPop.anchor === anchor;
    closeMenu(false);
    if (again || !menu) return;
    var pop = document.createElement("div");
    pop.className = "den-pop";
    pop.tabIndex = -1;
    pop.id = "den-pop-" + (anchor.dataset.scope || "menu");
    pop.setAttribute("role", "menu");
    pop.setAttribute("aria-label", menu.label);
    var html = "";
    var acts = [];
    (menu.items || []).forEach(function (it) {
      if (it.heading != null)
        html +=
          '<div class="den-ml" aria-hidden="true">' +
          esc(it.heading) +
          "</div>";
      else if (it.hr) html += '<div class="den-hr" role="separator"></div>';
      // A line of text (a notice), and an empty slot a later build fills
      // (the user menu's Language, dev.23).
      else if (it.note != null)
        html += '<p class="den-mnote" role="status">' + esc(it.note) + "</p>";
      else if (it.slot != null)
        html +=
          '<div class="den-mslot" data-slot="' +
          esc(it.slot) +
          '"' +
          (it.hidden ? " hidden" : "") +
          "></div>";
      else {
        var radio = it.checked != null;
        var tag = it.href ? "a" : "button";
        html +=
          "<" +
          tag +
          ' class="den-mi" tabindex="-1" data-i="' +
          acts.length +
          '" role="' +
          (radio ? "menuitemradio" : "menuitem") +
          '"' +
          (radio
            ? ' aria-checked="' + (it.checked ? "true" : "false") + '"'
            : "") +
          (it.href ? ' href="' + esc(it.href) + '"' : ' type="button"') +
          (it.title ? ' title="' + esc(it.title) + '"' : "") +
          // With a tag, the name is "default, focus" (the tag's text would
          // run into the label: "defaultfocus").
          (it.tag
            ? ' aria-label="' + esc(it.label + ", " + it.tag) + '"'
            : "") +
          '><span class="den-mi-l">' +
          esc(it.label) +
          "</span>" +
          (it.tag
            ? '<span class="den-mtag" aria-hidden="true">' +
              esc(it.tag) +
              "</span>"
            : "") +
          "</" +
          tag +
          ">";
        acts.push(it);
      }
    });
    pop.innerHTML = html;
    // A crumb's long menu (an org's or a project's list) gets the kit's
    // type-to-filter field (den-ui 0.7.0): Esc clears it, then closes.
    var filterField =
      anchor.dataset && anchor.dataset.scope
        ? DUI.attachMenuFilter(pop, {
            label: menu.label,
            lang: lang,
            onClose: function (refocus) {
              closeMenu(refocus);
            },
          })
        : null;
    // Inside a modal, in it: anything outside a modal is inert.
    var host =
      (anchor.closest && anchor.closest("dialog[open]")) || document.body;
    host.appendChild(pop);
    openPop = { el: pop, anchor: anchor };
    anchor.setAttribute("aria-expanded", "true");
    anchor.setAttribute("aria-controls", pop.id);
    topShow(pop, anchor, { gap: 6 });
    pop.addEventListener("click", function (e) {
      var row = e.target.closest ? e.target.closest(".den-mi") : null;
      if (!row) return;
      var it = acts[+row.getAttribute("data-i")];
      if (!it.href) e.preventDefault();
      closeMenu(true);
      if (it.onSelect) it.onSelect(it);
    });
    pop.addEventListener("keydown", function (e) {
      var rows = menuRows(pop);
      var i = rows.indexOf(document.activeElement);
      var next =
        e.key === "ArrowDown"
          ? (i + 1) % rows.length
          : e.key === "ArrowUp"
            ? (i - 1 + rows.length) % rows.length
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? rows.length - 1
                : -1;
      if (next >= 0 && rows.length) {
        e.preventDefault();
        rows[next].focus();
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeMenu(true);
      } else if (e.key === "Tab") closeMenu(true);
      else if (e.key === " " && rows[i] && rows[i].tagName === "A") {
        e.preventDefault();
        rows[i].click();
      }
    });
    var rows = menuRows(pop);
    var first = pop.querySelector('.den-mi[aria-checked="true"]') || rows[0];
    if (filterField) filterField.focus();
    else if (first) first.focus();
    else pop.focus();
  }
  document.addEventListener("mousedown", function (e) {
    if (!openPop) return;
    var tg = e.target;
    if (openPop.el.contains(tg) || openPop.anchor.contains(tg)) return;
    closeMenu(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && openPop) closeMenu(true);
  });
  window.addEventListener("resize", function () {
    closeMenu(false);
  });

  /** A page's href from the NAV registry (Workspaces manages them). */
  function navHref(id) {
    for (var i = 0; i < NAV.length; i++)
      if (NAV[i].id === id) return NAV[i].href;
    return "/";
  }
  /**
   * The org crumb, drawn by the kit (den-ui 0.7.0): a plain label while
   * there is one org (C4), a ▾ button with Den's own menu for two or more.
   */
  function orgCrumb(word, value, menu, hidden) {
    return {
      id: "org-crumb",
      key: "org",
      label: word,
      value: value,
      menu: menu ? true : null,
      hidden: !!hidden,
      cls: "den-org",
      optional: true,
      valueCls: "den-org-name",
    };
  }

  // ── Den's own groups and pages ─────────────────────────────────────────
  [
    { id: "develop", label: "g.develop", order: 10 },
    { id: "verify", label: "g.verify", order: 20 },
    { id: "ship", label: "g.ship", order: 30 },
  ].forEach(function (g) {
    GROUPS.push({ id: g.id, label: g.label, order: g.order, from: null });
  });
  [
    // Workspaces (R24a, 0.3.0-dev.35; was Local Dev): run your workspaces.
    // Its id and route stay (prefs and links keep working); the palette
    // still finds it as "Local Dev".
    {
      id: "local-dev",
      label: "n.workspaces",
      icon: "overview",
      group: "develop",
      order: 10,
      href: "/local-dev",
      keywords: ["Local Dev", "workspaces"],
    },
    // The Graph page (R22, 0.3.0-dev.32, Ward 2026-11-05): the graph alone,
    // full width, after Workspaces as the prototype orders them.
    {
      id: "graph",
      label: "n.graph",
      icon: "graph",
      group: "develop",
      order: 15,
      href: "/graph",
    },
    // The Agents tab (AG-4a-term, AG spec §5d): sessions and terminal
    // panes, after Graph as the prototype orders them.
    {
      id: "agents",
      label: "n.agents",
      icon: "agents",
      group: "develop",
      order: 17,
      href: "/agents",
      keywords: ["sessions", "terminal"],
      badge: function (s) {
        if (s.agentsNeedYou > 0)
          return { n: s.agentsNeedYou, what: "waiting", warn: true };
        return s.helpersRunning > 0
          ? { n: s.helpersRunning, what: "running" }
          : null;
      },
    },
    // D73: a plain shell in the project's folder, the same terminal pane
    // agents use with no agent in it: a person's, signed in like the page.
    // Issue 482: Terminals, a page of their own (/terminals), never rows
    // in the Agents list. A click opens the one used last in the project
    // in view, or starts one (terminalHref).
    {
      id: "terminal",
      label: "n.terminal",
      tip: "n.terminalTip",
      icon: "terminal",
      group: "develop",
      // 0.4.45: right under Agents.
      order: 17.5,
      href: "/terminals",
      keywords: ["terminal", "shell", "console", "command line"],
    },
    // 0.4.45: the __DEN_TITLE__ agent is off the rail: one door, the SERVER row
    // pinned at the top of Agents, and ⌘K "Ask the <name> agent".
    {
      id: "services",
      label: "n.services",
      icon: "services",
      group: "develop",
      order: 20,
      href: "/services",
      // R13: down services, from the health row's rollup, live.
      badge: function (s) {
        return s.down > 0 ? { n: s.down, bad: true, what: "down" } : null;
      },
    },
    {
      id: "logs",
      label: "n.logs",
      icon: "logs",
      group: "develop",
      order: 30,
      href: "/logs",
      badge: function (s) {
        // Open log streams (Den keeps no new-lines count yet).
        return s.openLogs > 0 ? { n: s.openLogs, what: "open" } : null;
      },
    },
    // Issue 209: Verify's page ("Checks"), and the older test kinds'
    // page while they retire.
    {
      id: "verify",
      label: "n.verify",
      icon: "tests",
      group: "verify",
      order: 10,
      href: "/verify",
    },
    {
      id: "tests",
      label: "n.tests",
      icon: "tests",
      group: "verify",
      order: 20,
      href: "/test-runs",
    },
    {
      id: "environments",
      label: "n.environments",
      icon: "envs",
      group: "ship",
      order: 10,
      href: "/environments",
    },
    {
      id: "release",
      label: "n.releases",
      icon: "releases",
      group: "ship",
      order: 20,
      href: "/release",
    },
    // The Edge page (PL-SPEC §10): only once /api/edge says the edge is
    // configured (state.edge, from /api/edge?probe=1 below).
    {
      id: "edge",
      label: "n.edge",
      icon: "edge",
      group: "ship",
      order: 30,
      href: "/edge",
      when: function (s) {
        return s.edge === true;
      },
    },
  ].forEach(function (n) {
    NAV.push({
      id: n.id,
      label: n.label,
      tip: n.tip || "",
      icon: n.icon,
      group: n.group,
      order: n.order,
      href: n.href,
      badge: n.badge || null,
      when: n.when || null,
      keywords: n.keywords || [],
      from: null,
    });
  });
  // The Settings page (R21): every setting, from the SETTINGS registry.
  var SETTINGS = {
    id: "settings",
    label: "n.settings",
    icon: "settings",
    href: "/settings",
  };

  // ── the frame ──────────────────────────────────────────────────────────
  // The top bar after the scope, in the prototype's order (dev.20): the ⌘K
  // search field (R5), then .chips: status (R6), Runs (R7), the sudo ask (R8),
  // What's new (R9) and ◐ ▾ (R10, appearance.js fills #den-user). The
  // chips start neutral ("Checking…", "Runs"; the sudo chip hidden) and topbar.js
  // paints them: a cold load never shows a partial red.
  // Den's own parts of the bar, in the kit's slots: the scope breadcrumb
  // and the ⌘K search field (start), the status, Runs and sudo chips (the
  // right group's start), the bell and ◐ ▾ (after Report). The chips start
  // neutral ("Checking…", "Runs"; the sudo chip hidden) and topbar.js
  // paints them: a cold load never shows a partial red.
  var slotStart =
    // The prototype's scope breadcrumb (R4): / COMPANY <org> / PROJECT
    // <ws> ▾ / ENV <env> ▾, drawn by the kit (den-ui 0.7.0); each ▾ opens
    // Den's own menu (openMenu). The org is a static label while there is
    // one org (ORG-SPEC C4) and hidden until header.js knows it; the
    // project part is hidden until header.js knows the projects. #env-sel
    // stays as the env's value (pages read it and listen for its change):
    // the Env menu drives it.
    DUI.scopeHtml({
      label: t("scope"),
      crumbs: [
        orgCrumb(t("k.org"), "", false, true),
        {
          id: "ws-pill",
          key: "ws",
          label: t("k.ws"),
          value: "",
          menu: true,
          hidden: true,
        },
        {
          id: "env-btn",
          key: "env",
          label: t("k.env"),
          value: "local",
          menu: true,
        },
      ],
      after:
        '<select id="env-sel" hidden aria-hidden="true" tabindex="-1"><option value="local">local</option></select>',
    }) +
    // The ⌘K search field (R5), the kit's; ⌘K opens the palette (topbar.js).
    DUI.searchHtml({ lang: lang });
  var slotEnd =
    '<button type="button" class="den-chip" id="den-status" aria-haspopup="dialog" aria-expanded="false" aria-busy="true">' +
    '<span class="den-dot off" aria-hidden="true"></span><span class="den-n">' +
    esc(t("status.checking")) +
    "</span></button>" +
    '<button type="button" class="den-chip" id="den-runs">' +
    '<span class="den-dot off" aria-hidden="true"></span><span class="den-n den-lbl-l">' +
    esc(t("runs.title")) +
    "</span></button>" +
    // LK-0: shown only while a run waits for the admin password (topbar.js).
    '<button type="button" class="den-chip" id="den-lock" aria-haspopup="dialog" aria-expanded="false" hidden>' +
    '<span class="den-lock-ic" aria-hidden="true">🔑</span><span class="den-lbl-l">' +
    esc(t("lock.waiting")) +
    "</span></button>";
  // NT-3: the bell, the kit's (bell.js paints its count and fills its
  // panel).
  var slotBell = DUI.bellButtonHtml({ label: t("bell.title") });
  host.className = "den-shell";
  // The kit draws the frame: skip link, top bar (☰, brand, Den's slots,
  // Report · bell · version · ◐ ▾ in that order, UK-3), and the rail, its
  // entries drawn from the registries (railModel) once the page is up.
  host.innerHTML = DUI.shellHtml({
    product: { name: "__DEN_CLI__", title: "__DEN_TITLE__" },
    lang: lang,
    report: !state.reportOff,
    slots: {
      start: slotStart,
      end: slotEnd,
      bell: slotBell,
      // ◐ ▾, the kit's (appearance.js gives its menu and takes the pick).
      account:
        '<span class="den-user" id="den-user">' +
        DUI.appearanceButtonHtml({
          label: t("um.label"),
          title: t("um.title"),
        }) +
        "</span>",
    },
  });
  // The rail is drawn by renderRail from the registries (below).
  var nav = host.querySelector(".den-rail");
  nav.innerHTML = "";

  // ── the scope parts (R4) ───────────────────────────────────────────────
  // Each part's menu comes from its model, set by header.js: setOrgs (the
  // org menu, only with two or more orgs), setWorkspaces (the view scope),
  // and the env from #env-sel's options. Choosing never starts, stops or
  // routes anything: the callbacks only store a preference.
  var scopeMenus = {
    org: null,
    ws: null,
    env: function () {
      var sel = document.getElementById("env-sel");
      if (!sel) return null;
      var items = [{ heading: t("k.env") }];
      Array.prototype.forEach.call(sel.options, function (o) {
        items.push({
          label: o.textContent,
          checked: o.value === sel.value,
          onSelect: function () {
            if (sel.value === o.value) return;
            sel.value = o.value;
            syncEnv();
            sel.dispatchEvent(new Event("change", { bubbles: true }));
          },
        });
      });
      return { label: t("k.env"), items: items };
    },
  };
  function scopeMenu(kind) {
    var m = scopeMenus[kind];
    return typeof m === "function" ? m() : m;
  }
  // The kit's crumbs (den-ui 0.7.0): a ▾ opens Den's own menu.
  DUI.hydrateScope(host, {
    onOpen: function (key, b) {
      openMenu(b, scopeMenu(key));
    },
  });
  host.addEventListener("keydown", function (e) {
    var b = e.target.closest ? e.target.closest("[data-scope]") : null;
    if (!b || b.tagName !== "BUTTON") return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!openPop || openPop.anchor !== b)
        openMenu(b, scopeMenu(b.dataset.scope));
      if (e.key === "ArrowUp" && openPop) {
        var rows = menuRows(openPop.el);
        if (rows.length) rows[rows.length - 1].focus();
      }
    }
  });
  function setValue(btn, value, title) {
    if (!btn) return;
    btn.querySelector(".den-vn").textContent = value;
    if (title != null) btn.title = title;
  }
  /** The Env part's value: what #env-sel holds now. */
  function syncEnv() {
    var sel = document.getElementById("env-sel");
    if (sel) setValue(document.getElementById("env-btn"), sel.value);
  }
  var envSel = document.getElementById("env-sel");
  if (envSel) envSel.addEventListener("change", syncEnv);

  /** One org: "/ ORG <title>" as a static label, no ▾ (C4). */
  // 0.4.45: the crumb's word. Company for an org of Den's own config;
  // "Repo owner" when none is configured and the orgs are only the repos'
  // GitHub owners (a GitHub org isn't a company).
  var orgWord = "k.org";
  function paintOrgWord(el) {
    var k = el && el.querySelector && el.querySelector(".den-k");
    if (k) k.textContent = t(orgWord);
  }
  function setOrg(org) {
    var el = document.getElementById("org-crumb");
    if (!el || !org || !org.title) return false;
    if (el.tagName === "BUTTON") {
      var tmp = document.createElement("span");
      tmp.innerHTML = DUI.scopeCrumbHtml(orgCrumb(t(orgWord), "", false));
      var span = tmp.firstChild;
      el.replaceWith(span);
      el = span;
    }
    scopeMenus.org = null;
    paintOrgWord(el);
    el.querySelector(".den-org-name").textContent = org.title;
    el.title = t(org.id ? "org.titleId" : "org.title", {
      title: org.title,
      id: org.id,
    });
    el.hidden = false;
    var sep = el.nextElementSibling;
    if (sep && sep.classList.contains("den-org-sep")) sep.hidden = false;
    return true;
  }
  /**
   * The orgs that own workspaces (ORG-1b plugs /api/orgs in here). Fewer
   * than two: the static label (C4). Two or more: an Org ▾ menu; picking
   * one calls onSelect(id) and fires `den:org` on window. No backend.
   */
  function setOrgs(orgs, current, onSelect) {
    var list = (Array.isArray(orgs) ? orgs : []).filter(function (o) {
      return o && o.id;
    });
    orgWord =
      list.length &&
      list.every(function (o) {
        return o.configured === false;
      })
        ? "k.repoOwner"
        : "k.org";
    var cur = null;
    for (var i = 0; i < list.length; i++)
      if (list[i].id === current) cur = list[i];
    cur = cur || list[0];
    var title = function (o) {
      return o.title || o.label || o.id;
    };
    if (list.length < 2)
      return cur ? setOrg({ id: cur.id, title: title(cur) }) : false;
    var el = document.getElementById("org-crumb");
    if (!el) return false;
    if (el.tagName !== "BUTTON") {
      var tmp = document.createElement("span");
      tmp.innerHTML = DUI.scopeCrumbHtml(orgCrumb(t(orgWord), "", true));
      var btn = tmp.firstChild;
      el.replaceWith(btn);
      el = btn;
    }
    el.hidden = false;
    paintOrgWord(el);
    setValue(
      el,
      title(cur),
      t("org.titleId", { title: title(cur), id: cur.id }),
    );
    var sep = el.nextElementSibling;
    if (sep && sep.classList.contains("den-org-sep")) sep.hidden = false;
    scopeMenus.org = {
      label: t(orgWord),
      items: [{ heading: t(orgWord) }].concat(
        list.map(function (o) {
          return {
            label: title(o),
            checked: o.id === cur.id,
            tag:
              typeof o.workspaces === "number"
                ? t("org.n", { n: o.workspaces })
                : null,
            onSelect: function () {
              if (o.id === cur.id) return;
              setOrgs(list, o.id, onSelect);
              if (typeof onSelect === "function") onSelect(o.id);
              try {
                window.dispatchEvent(
                  new CustomEvent("den:org", { detail: { id: o.id } }),
                );
              } catch (e) {
                /* no CustomEvent: the callback has it */
              }
            },
          };
        }),
      ),
    };
    return true;
  }
  /**
   * The Workspace part: { label, title, items: [{ value, label, checked,
   * focused, title? }], onSelect(value) }. "All active" and the active
   * workspaces, the focused one (model.focus, the CLI default) marked; then
   * a link to manage them. onSelect(value, focus): choosing a workspace
   * also makes it the CLI default (header.js).
   */
  // Every workspace's name, from the Workspace menu's model (header.js).
  var workspaceNameList = [];
  function workspaceNames() {
    return workspaceNameList.slice();
  }
  /**
   * Issue 168: the top bar's project chip carries the project's colour, a
   * dot beside its name (never colour alone); none under All active.
   */
  function paintProjectColour(btn, colour) {
    var vn = btn.querySelector(".den-vn");
    var dot = btn.querySelector(".den-pc");
    if (!colour || !vn) {
      if (dot) dot.parentNode.removeChild(dot);
      return;
    }
    if (!dot) {
      dot = document.createElement("span");
      dot.className = "den-pc";
      dot.setAttribute("aria-hidden", "true");
      vn.parentNode.insertBefore(dot, vn);
    }
    dot.setAttribute("data-pc", colour);
  }
  /** Issue 168: every project's colour, from the last setWorkspaces. */
  var projectColourMap = {};
  function setWorkspaces(model) {
    var coloursWere = JSON.stringify(projectColourMap);
    projectColourMap =
      model && model.colours && typeof model.colours === "object"
        ? model.colours
        : {};
    // Issue 168: what wears a project's colour repaints (the bell's
    // headings, the Agents page).
    if (JSON.stringify(projectColourMap) !== coloursWere)
      try {
        window.dispatchEvent(new CustomEvent("den:project-colours-shown"));
      } catch (e) {
        /* no CustomEvent */
      }
    workspaceNameList =
      model && Array.isArray(model.names) ? model.names.slice() : [];
    // Issue 402: the project picked (null under All): the rail and every
    // ☆/★ read its pins, and a pin made now is for it (a repaint only).
    var pinProject =
      model && typeof model.pinProject === "string" ? model.pinProject : null;
    var pinImplicit = !!(model && model.pinImplicit === true && pinProject);
    var first = model && !state.pinViewKnown;
    if (
      first ||
      pinProject !== state.pinProject ||
      pinImplicit !== state.pinImplicit
    )
      setState({
        pinProject: pinProject,
        pinImplicit: pinImplicit,
        pinViewKnown: !!model || state.pinViewKnown,
      });
    if (first) placePins();
    var btn = document.getElementById("ws-pill");
    if (!btn) return;
    var sep = btn.nextElementSibling;
    if (!model) {
      btn.hidden = true;
      if (sep) sep.hidden = true;
      scopeMenus.ws = null;
      return;
    }
    setValue(btn, model.label, model.title || null);
    paintProjectColour(btn, model.colour);
    btn.hidden = false;
    if (sep) sep.hidden = false;
    var items = [{ heading: t("k.ws") }];
    if (!model.items || !model.items.length)
      items.push({ label: t("ws.none"), href: navHref("local-dev") });
    (model.items || []).forEach(function (it) {
      items.push({
        label: it.label,
        checked: !!it.checked,
        // Issue 897: no "CLI default" tag: picking a project sets it.
        title: it.title || null,
        onSelect: function () {
          if (typeof model.onSelect !== "function") return;
          // The workspace in view still becomes the CLI default when it
          // isn't one; picking what is both already does nothing.
          if (it.checked && (it.value === "all" || it.value === model.focus))
            return;
          model.onSelect(it.value, model.focus || null, !!it.checked);
        },
      });
    });
    items.push({ hr: true });
    items.push({ label: t("ws.manage"), href: navHref("local-dev") });
    scopeMenus.ws = { label: t("k.ws"), items: items };
  }

  function healthDot(id) {
    var s = state.health[id];
    var cls =
      s === "down"
        ? " bad"
        : s === "degraded"
          ? " warn"
          : s === "ok"
            ? ""
            : " off";
    return '<span class="den-dot' + cls + '" aria-hidden="true"></span>';
  }
  /**
   * 0.4.18: a pin's Visit ↗: none without a URL, greyed out while it is
   * down. Down is the service panel's live state (pinOff), the same as its
   * dot, so it holds for a pin outside the View too; the rail's rollup
   * only without it.
   */
  function pinVisit(id) {
    var url = state.pinUrls && state.pinUrls[id];
    if (!url) return "";
    var off = state.pinOff || {};
    var down = Object.prototype.hasOwnProperty.call(off, id)
      ? !!off[id]
      : state.health[id] === "down";
    // D27: a real link (never popup-blocked, as window.open was in Safari).
    var live = !down && /^https?:\/\//i.test(url);
    return (
      '<a class="den-pvisit" tabindex="-1" data-visit="' +
      esc(id) +
      '" data-url="' +
      esc(url) +
      '"' +
      (live
        ? ' href="' + esc(url) + '" target="_blank" rel="noopener noreferrer"'
        : ' role="link" aria-disabled="true"') +
      ' aria-label="' +
      esc(t("act.visitX", { s: id })) +
      '" title="' +
      esc(down ? t("svp.notRunning") : url) +
      '"><span aria-hidden="true">↗</span></a>'
    );
  }
  /** A pin's Visit ↗ clicked: true when the link opens by itself. */
  function visitPin(b) {
    if (b.getAttribute("aria-disabled") === "true" || !b.hasAttribute("href")) {
      toast(t("svp.notRunning"));
      return false;
    }
    return true;
  }
  // 0.4.18: the service panel (svc-panel.js registers it).
  var servicePanel = null;
  function setServicePanel(p) {
    servicePanel = p && typeof p.open === "function" ? p : null;
  }
  function pinHref(id) {
    var repo = id.split("/")[0];
    return "/services#repo-" + encodeURIComponent(repo);
  }
  /**
   * D73: the rail's Terminals, in the project in view when there is one.
   * Issue 482: on the Terminals page itself (/terminals?terminal=1).
   */
  function terminalHref() {
    var ws = "";
    try {
      var q = new URLSearchParams(location.search);
      ws = q.get("project") || q.get("ws") || "";
    } catch (_) {
      ws = "";
    }
    return (
      "/terminals?terminal=1" + (ws ? "&project=" + encodeURIComponent(ws) : "")
    );
  }
  /**
   * The rail as the kit's data (shellHtml's nav, groups and foot): the
   * pins, then the NAV registry by GROUPS, then Hub, Settings and who
   * this browser is. The kit draws it (railHtml) with its collapse toggle.
   */
  function railModel() {
    var groups = [];
    var entries = [];
    var shown = state.pins;
    if (shown.length) {
      groups.push({ id: "pinned", label: t("g.pinned") });
      shown.forEach(function (p) {
        // 0.4.18: the row (named by the id alone) opens the service's
        // panel in place (svc-panel.js); it is still the link to
        // Services, so ⌘-click and middle-click open that in a new
        // tab. Delete unpins it. Visit ↗ beside it opens the service's
        // URL, out of the tab order: the panel's first button is the
        // keyboard's Visit. Unpin is in the panel's footer.
        entries.push({
          id: "pin-" + p,
          group: "pinned",
          href: pinHref(p),
          label: p,
          lead: healthDot(p),
          mono: true,
          pin: p,
          // Issue 307: the kit's SERVICE tag at the row's end.
          kind: "service",
          after: pinVisit(p),
          attrs: {
            "data-pin": p,
            "data-svpanel": p,
            "aria-haspopup": "dialog",
            "aria-expanded": state.svpOpen === p ? "true" : "false",
          },
        });
      });
    }
    var ordered = orderedNav();
    GROUPS.slice()
      .sort(byOrder)
      .forEach(function (g) {
        var items = ordered.filter(function (n) {
          return (
            n.group === g.id &&
            state.hidden.indexOf(n.id) < 0 &&
            (!n.when || n.when(state))
          );
        });
        if (!items.length) return;
        groups.push({ id: g.id, label: t(g.label), from: g.from });
        items.forEach(function (n) {
          var b = n.badge ? n.badge(state) : null;
          entries.push({
            id: n.id,
            group: g.id,
            href: n.href,
            label: t(n.label),
            icon: n.icon,
            tip: n.tip ? t(n.tip) : "",
            current: n.id === railLit,
            badge: b,
          });
        });
      });
    var foot = [];
    var hub = hubEntry();
    if (hub) foot.push(hub);
    return {
      nav: entries,
      groups: groups,
      foot: foot,
      // Settings, then the account entry: the kit's (den-ui 0.7.0).
      settings: {
        href: SETTINGS.href,
        label: t(SETTINGS.label),
        current: page === SETTINGS.id,
      },
      account: accountModel(),
      lang: lang,
      collapsed: state.collapsed,
      folded: state.folded,
    };
  }

  /**
   * The rail's Hub link, above Settings. It opens the company's page on
   * Hub in this tab (D51: a plain link, so ⌘-, Ctrl- and middle-click
   * still give a new one), with a count of what waits on the person
   * (whoami's unread). A token Hub
   * rejects, or a role it forbids, greys it, and it goes to Settings ›
   * Hub, which says what to do.
   */
  function hubTarget(u) {
    try {
      var x = new URL(u);
      return x.protocol === "https:" ||
        (x.protocol === "http:" &&
          (x.hostname === "localhost" ||
            x.hostname === "127.0.0.1" ||
            /\.localhost$/.test(x.hostname)))
        ? x.href
        : "";
    } catch (e) {
      return "";
    }
  }
  /**
   * Where Hub is, for the rail and ⌘K (D51): null when no Hub is set up;
   * else `href` (Hub, opened in this tab) or, when it can't be opened,
   * `why` (D49's reason, for ⌘K) and `off` (the rail's, as den-ui data);
   * the item is greyed and goes to Settings › Hub.
   */
  function hubLink() {
    var h = state.hub;
    if (!h || !h.configured) return null;
    // Configured: always there. Connected, it opens Hub; otherwise it is
    // greyed, goes to Settings › Hub and says why (D49: a Hub that
    // vanished from the rail left no way across).
    var href =
      h.state === "connected"
        ? hubTarget(h.teamUrl || "") || hubTarget(h.url || "")
        : "";
    if (href) return { href: href, team: h.team || "" };
    var key =
      {
        rejected: "hub.railRejected",
        forbidden: "hub.railForbidden",
        no_token: "hub.railNoToken",
        unreachable: "hub.railUnreachable",
        bad_config: "hub.railBadConfig",
      }[h.state] ||
      (h.state === "connected" ? "hub.railBadUrl" : "hub.railUnreachable");
    // Issue 326: the rail's reason as data (den-ui's `off`): the kit
    // words it. `why` is ⌘K's longer sentence.
    var off =
      {
        rejected: "reconnect",
        forbidden: "forbidden",
        no_token: "connect",
        unreachable: "unreachable",
        bad_config: "config",
      }[h.state] || (h.state === "connected" ? "config" : "unreachable");
    return { href: "", why: t(key), off: off };
  }
  function hubEntry() {
    var h = state.hub;
    var link = hubLink();
    if (!link) return null;
    // Issue 307: data only. The label is the company it opens (else
    // Hub's name) and the kind is "hub": the kit words the tooltip and
    // the name ("Acme Co · Hub", a count "3 waiting" after it).
    var label = h.team || t("hub.rail");
    // Off: greyed by the kit, which says why from `off` (issue 326).
    if (!link.href)
      return {
        id: "hub",
        cls: "den-hub",
        href: "/settings#agents.hub",
        label: label,
        icon: "hub",
        kind: "hub",
        off: link.off,
        attrs: { "data-hub": h.state || "unknown" },
      };
    var n = typeof h.unread === "number" && h.unread > 0 ? h.unread : 0;
    return {
      id: "hub",
      cls: "den-hub",
      href: link.href,
      label: label,
      icon: "hub",
      kind: "hub",
      badge: n ? { n: n > 99 ? "99+" : n, what: "waiting" } : null,
      attrs: { "data-hub": "connected" },
    };
  }

  /**
   * SEC-2a: the rail foot's account entry (the kit's, den-ui 0.7.1), last
   * in the rail's foot, opening Settings › Access. Who is signed in, as
   * data: this browser's GitHub sign-in ({ name, login }), else, on a
   * local browser on this machine only, the install owner's GitHub
   * identity (/api/session's identity.owner) with its role. A browser
   * signed in with a link or a code is never shown as the owner. The kit draws the name over @login, and @login alone when the name is
   * just the login (issue 656; a role only in an
   * account menu's header). With no GitHub identity at all, the kit's own
   * word for this computer. Never device words.
   */
  function accountModel() {
    var id = state.identity;
    if (!id) return null;
    var gh =
      id.kind === "github" && id.login
        ? id
        : id.kind === "local" && id.owner && id.owner.login
          ? id.owner
          : null;
    // Issue 406: GitHub has no name: Hub's, when Hub's login is the same one.
    // Issue 1210: never for the fixture person (via "fixture"): its login is
    // invented, and a match would show a real person's name on a test
    // install. kind "github" with via "fixture" is display only: no
    // decision anywhere reads this identity as a GitHub sign-in.
    var h = state.hub;
    var hubName =
      gh &&
      id.via !== "fixture" &&
      h &&
      h.state === "connected" &&
      typeof h.name === "string" &&
      h.name &&
      typeof h.login === "string" &&
      h.login.toLowerCase() === String(gh.login).toLowerCase()
        ? h.name
        : undefined;
    // Issue 656: a name that is just the login is no name (the kit's
    // rule): the entry is @login alone, never the login twice.
    var realName = function (n) {
      return n && !DUI.sameAsLogin(n, gh.login) ? n : undefined;
    };
    var who = gh
      ? {
          login: gh.login,
          name: realName(gh.name) || realName(hubName),
          role:
            gh.role === "owner" ? t("acct.roleOwner") : gh.role || undefined,
        }
      : { local: true, lang: lang };
    return Object.assign(who, {
      navId: "identity",
      href: "/settings#access",
      id: "den-ident",
      attrs: { "data-ident": id.kind },
    });
  }
  /** What GET /api/session said about this browser: the chip, and a toast once after a sign-in. */
  function applyIdentity(b) {
    if (!b || !b.identity) return;
    var was = state.identity;
    if (!was || was.kind !== b.identity.kind || was.login !== b.identity.login)
      setState({ identity: b.identity });
    if (b.justSignedIn)
      toast(
        t("ident.toast", {
          name: b.product || "__DEN_TITLE__",
          host: b.machine || "",
        }),
      );
  }

  // The kit's hydration of the rail and the ☰ drawer (shell-client.js):
  // one tab stop (the current page); ↑/↓, Home and End move within the
  // rail; Delete unpins a pinned row; the collapse toggle; below 720px
  // the rail is a modal drawer behind ☰ (the top bar, the page and the
  // runs dock inert behind it; Escape, the scrim or ☰ close it).
  var shellUi = DUI.hydrateShell(host, {
    lang: lang,
    onCollapse: function (next) {
      setState({ collapsed: next });
      saveShell({ collapsed: state.collapsed });
    },
    onUnpin: function (id) {
      unpin(id);
    },
    // Issue 1444: the folded sections are this person's shell setting.
    folds: {
      get: function () {
        return state.folded;
      },
      set: function (ids) {
        state.folded = ids;
        saveShell({ folded: ids });
      },
    },
    inert: function () {
      return [
        host.querySelector(".den-top"),
        document.getElementById("den-content"),
        document.getElementById("den-dock"),
      ];
    },
    menuOpen: function () {
      return !!openPop;
    },
  });
  /** The rail from the registries and the state, drawn by the kit. */
  function renderRail(force) {
    if (!nav || !shellUi) return;
    shellUi.paint(DUI.railHtml(railModel()), force);
  }
  // Den's own clicks in the rail (the kit handles the collapse toggle).
  nav.addEventListener("click", function (e) {
    var tgt = e.target;
    // D73: the rail's Terminal opens in the project in view (?ws=).
    var term = tgt && tgt.closest ? tgt.closest('[data-nav="terminal"]') : null;
    if (term) term.setAttribute("href", terminalHref());
    var v = tgt && tgt.closest ? tgt.closest("[data-visit]") : null;
    if (v) {
      if (!visitPin(v)) e.preventDefault();
      return;
    }
    // 0.4.18: a plain click (or Enter) on a pinned row opens its panel;
    // ⌘/Ctrl-, Shift- and middle-click keep the link (Services).
    var sp = tgt && tgt.closest ? tgt.closest("[data-svpanel]") : null;
    if (
      sp &&
      servicePanel &&
      e.button === 0 &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.shiftKey &&
      !e.altKey
    ) {
      e.preventDefault();
      servicePanel.open(sp.getAttribute("data-svpanel"), sp, {
        fromRail: true,
      });
    }
  });

  /** The body's classes from the state: collapsed, reports off. */
  function applyState() {
    // FB (den#81): reports off hides every Report button, the injected too.
    document.documentElement.classList.toggle(
      "den-report-off",
      !!state.reportOff,
    );
    if (shellUi) shellUi.setCollapsed(!!state.collapsed);
    else if (document.body && document.body.classList)
      document.body.classList.toggle("den-rail-collapsed", !!state.collapsed);
  }

  // FB (den#81): ⌘⇧F (Ctrl+Shift+F) opens Report an issue from anywhere,
  // over an open dialog too.
  document.addEventListener(
    "keydown",
    function (e) {
      if (
        (e.metaKey || e.ctrlKey) &&
        e.shiftKey &&
        !e.altKey &&
        (e.key === "F" || e.key === "f" || e.code === "KeyF") &&
        !state.reportOff
      ) {
        e.preventDefault();
        openReport();
      }
    },
    true,
  );
  // The version chip (the kit's) opens What's new (header.js).
  var chip = document.getElementById("version-pill");
  if (chip)
    chip.addEventListener("click", function () {
      if (typeof window.openChangelog === "function") window.openChangelog();
    });

  // ── the page header (R20, 0.3.0-dev.32) ──────────────────────────────
  // One h1 per page, the page's own (the brand is not a heading). A page
  // whose content has none gets the prototype's page header (.ph): the h1,
  // named from its rail entry or its <title> ("__DEN_TITLE__ · Services" →
  // Services), and a 13px muted sub line with the scope ("org / ws / env",
  // kept in step with the top bar's scope). A page adds its primary action
  // with denShell.pageHeader().act and its tabs below it with .tabs (both
  // empty until a page fills them). Settings and Edge draw their own.
  var ph = null;
  function scopeText() {
    var parts = [];
    var org = document.getElementById("org-crumb");
    if (org && !org.hidden) {
      var on =
        org.querySelector(".den-org-name") || org.querySelector(".den-vn");
      if (on && on.textContent) parts.push(on.textContent);
    }
    var over = (ph && ph.over) || {};
    [
      ["ws-pill", over.ws],
      ["env-btn", over.env],
    ].forEach(function (p) {
      if (p[1]) return parts.push(p[1]);
      var b = document.getElementById(p[0]);
      var v = b && !b.hidden ? b.querySelector(".den-vn") : null;
      if (v && v.textContent) parts.push(v.textContent);
    });
    return parts.join(" / ");
  }
  function paintPageSub() {
    if (!ph || ph.subFixed) return;
    var text = scopeText();
    if (ph.sub.textContent !== text) ph.sub.textContent = text;
  }
  function ensurePageHeader() {
    var main = document.getElementById("den-content");
    if (!main || main.querySelector("h1")) return;
    var label = "";
    NAV.forEach(function (n) {
      if (n.id === page) label = t(n.label);
    });
    if (!label) {
      var title = String(document.title || "");
      label = title.indexOf(" · ") >= 0 ? title.split(" · ").pop() : "";
    }
    if (!label) return;
    var el = document.createElement("div");
    el.className = "ph den-ph";
    el.innerHTML =
      '<div class="den-ph-h"><h1></h1><div class="sub"></div></div>' +
      '<div class="act" hidden></div>';
    el.querySelector("h1").textContent = label;
    main.insertBefore(el, main.firstChild);
    ph = {
      el: el,
      h1: el.querySelector("h1"),
      sub: el.querySelector(".sub"),
      act: el.querySelector(".act"),
      tabs: null,
      subFixed: false,
      over: null,
    };
    paintPageSub();
    var scope = host.querySelector(".den-scope");
    if (scope && typeof MutationObserver === "function")
      new MutationObserver(paintPageSub).observe(scope, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ["hidden"],
      });
  }
  // ── tabs: the WAI-ARIA tabs pattern, one helper (0.3.0-dev.33) ────────
  // Every page tablist (a page header's tabs) is wired here: one tab stop (the selected tab is tabindex 0, the rest
  // -1); ←/→ move and wrap, Home and End go to the ends, and each selects
  // as it moves (automatic activation); a click selects. Each tab has
  // aria-controls naming its role=tabpanel, which has aria-labelledby back
  // to the tab, and only the selected tab's panel shows.
  var tabSeq = 0;
  function tabIdOf(el, stem) {
    if (!el.id) el.id = "den-" + stem + "-" + ++tabSeq;
    return el.id;
  }
  /**
   * Wire `list` (an element with role=tablist) as tabs. opts:
   *   panelOf(tab)    its panel (default: the element its aria-controls
   *                   names)
   *   onSelect(tab)   after a tab is selected (by click or key)
   *   selected        the tab (or its index) to select first (default:
   *                   the one with aria-selected="true", else the first)
   * Returns { select(tabOrIndex, focus?), selected(), tabs() }. Wiring the
   * same list again replaces the old wiring.
   */
  function wireTabs(list, opts) {
    opts = opts || {};
    if (!list) return null;
    if (list._denTabs) list._denTabs.off();
    list.setAttribute("role", "tablist");
    function tabs() {
      return Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    }
    function panelOf(tab) {
      if (typeof opts.panelOf === "function") return opts.panelOf(tab);
      var id = tab.getAttribute("aria-controls");
      return id ? document.getElementById(id) : null;
    }
    tabs().forEach(function (tab) {
      var panel = panelOf(tab);
      tabIdOf(tab, "tab");
      if (!panel) return;
      tab.setAttribute("aria-controls", tabIdOf(panel, "tabpanel"));
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", tab.id);
    });
    function indexOf(t) {
      return typeof t === "number" ? t : tabs().indexOf(t);
    }
    function paint(i) {
      tabs().forEach(function (tab, j) {
        var on = j === i;
        tab.setAttribute("aria-selected", on ? "true" : "false");
        tab.setAttribute("tabindex", on ? "0" : "-1");
        tab.classList.toggle("active", on);
        var panel = panelOf(tab);
        if (panel) {
          panel.hidden = !on;
          panel.classList.toggle("active", on);
        }
      });
    }
    function select(t, focus) {
      var all = tabs();
      var i = indexOf(t);
      if (i < 0 || !all[i]) return;
      paint(i);
      if (focus) all[i].focus();
      if (typeof opts.onSelect === "function") opts.onSelect(all[i]);
    }
    function current() {
      var all = tabs();
      for (var i = 0; i < all.length; i++)
        if (all[i].getAttribute("aria-selected") === "true") return all[i];
      return all[0] || null;
    }
    function onClick(e) {
      var tab = e.target.closest && e.target.closest('[role="tab"]');
      if (!tab || !list.contains(tab)) return;
      e.preventDefault();
      select(tab, false);
    }
    function onKey(e) {
      var tab = e.target.closest && e.target.closest('[role="tab"]');
      if (!tab || !list.contains(tab)) return;
      var all = tabs();
      var i = all.indexOf(tab);
      var n = all.length;
      var next =
        e.key === "ArrowRight"
          ? (i + 1) % n
          : e.key === "ArrowLeft"
            ? (i - 1 + n) % n
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? n - 1
                : -1;
      if (next < 0) return;
      e.preventDefault();
      select(next, true);
    }
    list.addEventListener("click", onClick);
    list.addEventListener("keydown", onKey);
    var first =
      opts.selected != null ? indexOf(opts.selected) : indexOf(current());
    paint(first < 0 ? 0 : first);
    var api = {
      select: select,
      selected: current,
      tabs: tabs,
      off: function () {
        list.removeEventListener("click", onClick);
        list.removeEventListener("keydown", onKey);
        list._denTabs = null;
      },
    };
    list._denTabs = api;
    return api;
  }
  /**
   * The page header's tabs, made only when a page asks (no empty stub):
   * spec { label, tabs: [{ id, label, panel }], selected?, onSelect? }.
   * A .ptabs tablist below the header, wired by wireTabs; each panel is
   * the page's own element. Asked again, the old tablist is replaced.
   */
  function pageTabs(spec) {
    if (!ph || !spec || !Array.isArray(spec.tabs)) return null;
    if (ph.tabs) ph.tabs.remove();
    var list = document.createElement("div");
    list.className = "ptabs den-ptabs";
    list.setAttribute("role", "tablist");
    if (spec.label) list.setAttribute("aria-label", String(spec.label));
    var panels = [];
    var sel = 0;
    spec.tabs.forEach(function (d, i) {
      var b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "tab");
      if (d.id) b.setAttribute("data-tab", String(d.id));
      b.textContent = String(d.label || d.id || "");
      list.appendChild(b);
      panels.push(d.panel || null);
      if (spec.selected != null && d.id === spec.selected) sel = i;
    });
    ph.el.parentNode.insertBefore(list, ph.el.nextSibling);
    ph.tabs = list;
    var all = Array.prototype.slice.call(list.querySelectorAll('[role="tab"]'));
    return wireTabs(list, {
      panelOf: function (tab) {
        return panels[all.indexOf(tab)] || null;
      },
      selected: sel,
      onSelect: function (tab) {
        if (typeof spec.onSelect === "function")
          spec.onSelect(tab.getAttribute("data-tab"), tab);
      },
    });
  }
  /**
   * The page header (R20): { el, h1, sub, act, tabs }, or null on a page
   * that draws its own. setSub(text) fixes the sub line (null: the scope
   * again); setScope({ ws?, env? }) keeps the scope line but names the
   * workspace or env the page shows (Workspaces and Graph show one
   * workspace, locally); a page shows .act by filling it and unhiding it,
   * and tabs with tabs(spec) (pageTabs: made only then).
   */
  function pageHeader() {
    if (!ph) return null;
    return {
      el: ph.el,
      h1: ph.h1,
      sub: ph.sub,
      act: ph.act,
      tabs: pageTabs,
      setSub: function (text) {
        ph.subFixed = text != null;
        if (text != null) ph.sub.textContent = String(text);
        else paintPageSub();
      },
      setScope: function (over) {
        ph.over = over || null;
        paintPageSub();
      },
    };
  }
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", ensurePageHeader);
  else ensurePageHeader();

  // Skip to content: the page's <main id="den-content">, its one main
  // landmark (each page wraps its content in it).
  var skip = host.querySelector(".den-skip");
  if (skip)
    skip.addEventListener("click", function (e) {
      var el = document.getElementById("den-content");
      if (!el) return;
      e.preventDefault();
      if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
      el.focus();
    });

  // The browser-tab icon is the active theme's (dev.22), set here. A page
  // comes with the kit's icons (issue 644's head snippet: Den's default
  // theme's own), which this replaces. Until appearance.js knows the theme
  // (it calls setFavicon with the versioned URL for the mode it draws in,
  // again on every theme or mode change), the bare route serves the
  // active theme's, never cached.
  function setFavicon(href) {
    var links = document.querySelectorAll('link[rel~="icon"]');
    var link = document.getElementById("den-favicon");
    for (var i = 0; i < links.length; i++)
      if (links[i] !== link) links[i].remove();
    if (!link) {
      link = document.createElement("link");
      link.id = "den-favicon";
      link.rel = "icon";
      document.head.appendChild(link);
    }
    if (link.getAttribute("href") !== href) link.setAttribute("href", href);
  }
  setFavicon(
    "/theme-favicon?mode=" +
      (document.documentElement.dataset.mode === "light" ? "light" : "dark"),
  );

  document.body.classList.add("den-has-shell");
  applyState();
  renderRail();

  // ── the runs dock (R16, 0.3.0-dev.30) ──────────────────────────────────
  // One output dock for every page, at the foot of the content column
  // (the prototype's grid area `dock`). A bar: "Runs", the run tabs (mono
  // 12, a dot that pulses while running) and Show/Hide runs; open, a 170px
  // <pre> with the selected run's output. It replaces the pages' own output
  // panes: every run a page starts is a tab here, through denShell.runs.
  //
  //   runs.add(id, label, opts)     a tab (no change to its state if it
  //                                 exists, beyond what opts set)
  //   runs.start(id, label, opts)   add + running + selected; the dock
  //                                 stays as it is unless opts.open: true
  //                                 (R16a); opts.select: false keeps the
  //                                 selection
  //   runs.append(id, text, cls?, { key }?)  one line (cls: cmd, err, warn,
  //                                 done-ok, done-fail, ok, phase); a `key`
  //                                 replaces that line in place (progress)
  //   runs.finish(id, { ok })       stops the pulse; ok false is an error.
  //                                 A run with opts.doneLine (the default
  //                                 for new callers) gets "✓ done in {s}s"
  //   runs.set(id, { label, running, error, actions })
  //   runs.select(id, { open }) (opens only with open: true),
  //   runs.clear(id), runs.remove(id)
  //   runs.show(), hide(), toggle(), isOpen(), has(id), list(), selected(),
  //   runs.text(id), running(), onChange(fn)
  //   runs.scope({ ws } | null)     only that workspace's runs show, with
  //                                 an "All runs" toggle in the bar (R24e)
  //
  // opts: closable (default true: a × on the tab), onClose(id) (the page
  // decides; else the tab goes), onSelect(id), onClear(id), max (lines
  // kept, 0 = all), actions [{ id, label, title?, run(id) }] (buttons in
  // the bar for the selected run, e.g. Stop), doneLine, ws (the workspace
  // or workspaces it ran in, added to the ones it has).
  //
  // The bar carries Copy and Clear for the selected run (the panes had
  // them). R16a (Ward QA 2026-11-05): the dock starts collapsed to its bar.
  // Open/closed and its height are user prefs (/api/settings `shell.dock`,
  // `shell.dockHeight`, mirrored with the rest of the shell's prefs for the
  // first paint), so they survive navigation and reloads, per user. A run
  // starting never opens it: its tab appears and the Runs chip pulses. Only
  // the engineer opens it: Show runs, the Runs chip, a tab click, or a page
  // action whose whole point is output (runs.start/select with open: true).
  // Drag the dock's top edge to resize it, 60px to half the window.
  var SS_LAST_RUN = "__DEN_CLI__-last-run";
  var RUNS = [];
  var runSel = null;
  var DOCK_H = 170;
  var dockOpen = state.dock === true;
  var dockH = state.dockHeight >= 60 ? state.dockHeight : DOCK_H;
  var runSeqId = 0;
  var runListeners = [];
  /** At most half the window (R16a); at least 60px. */
  function dockCap(h) {
    var max = Math.max(60, Math.floor((window.innerHeight || 800) * 0.5));
    return Math.round(Math.max(60, Math.min(h, max)));
  }
  var dock = document.createElement("div");
  dock.className = "den-dock";
  dock.id = "den-dock";
  if (dock.setAttribute) {
    dock.setAttribute("role", "region");
    dock.setAttribute("aria-label", t("runs.title"));
  }
  function placeDock() {
    if (document.body && document.body.appendChild)
      document.body.appendChild(dock);
  }
  placeDock();
  // After the page's content (the foot of the column), once it's parsed.
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", placeDock);

  function runById(id) {
    for (var i = 0; i < RUNS.length; i++) if (RUNS[i].id === id) return RUNS[i];
    return null;
  }
  // R24e (0.3.0-dev.35): a page showing one workspace scopes the dock to
  // it (runs.scope({ ws })): only runs started in that workspace show, and
  // "All runs" (aria-pressed) shows every one. A run's workspaces are what
  // its page tagged it with (opts.ws); a run with none always shows.
  var runScope = null;
  var runAll = false;
  function inScope(r) {
    return (
      !runScope || runAll || !r.ws.length || r.ws.indexOf(runScope.ws) >= 0
    );
  }
  function visibleRuns() {
    return RUNS.filter(inScope);
  }
  function selectedRun() {
    var shown = visibleRuns();
    var r = runById(runSel);
    return (r && inScope(r) ? r : null) || shown[shown.length - 1] || null;
  }
  function runsChanged() {
    runListeners.forEach(function (fn) {
      try {
        fn();
      } catch (e) {
        /* a listener's problem */
      }
    });
    try {
      window.dispatchEvent(new CustomEvent("den:runs"));
    } catch (e) {
      /* no CustomEvent */
    }
  }
  /** Open/closed changed by the engineer: the pref follows. */
  function rememberDock() {
    if (state.dock === dockOpen) return Promise.resolve(true);
    state.dock = dockOpen;
    return saveShell({ dock: dockOpen });
  }
  /** The server's prefs arrived: the dock follows them. */
  function dockFromPrefs() {
    var h = state.dockHeight >= 60 ? state.dockHeight : DOCK_H;
    if (dockOpen === (state.dock === true) && h === dockH) return;
    dockOpen = state.dock === true;
    dockH = h;
    var out = outEl();
    if (out) out.style.height = dockCap(dockH) + "px";
    renderDock();
  }
  function secs(ms) {
    return num(Math.max(0, ms) / 1000, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  }
  function dotClass(r) {
    if (r.running) return "run";
    if (r.error) return "bad";
    if (r.done) return "";
    return "off";
  }
  function runTitle(r) {
    if (r.running) return r.label;
    if (r.done && r.endedAt)
      return (
        r.label +
        " · " +
        t(r.error ? "dock.failed" : "dock.done", {
          s: secs(r.endedAt - r.startedAt),
        })
      );
    return r.label;
  }
  function lastRunHere() {
    try {
      var l = JSON.parse(sessionStorage.getItem(SS_LAST_RUN) || "null");
      var here = location.pathname + location.search;
      return l && l.page && l.page !== here ? l : null;
    } catch (e) {
      return null;
    }
  }

  // The bar: redrawn on any run's state change (not on every line).
  function barHtml() {
    var sel = selectedRun();
    var shown = visibleRuns();
    var tabs = shown.length
      ? shown
          .map(function (r) {
            var on = sel && sel.id === r.id;
            return (
              '<span class="den-rtab-w">' +
              '<button type="button" class="den-rtab' +
              (r.closable ? " den-x" : "") +
              '" role="tab" id="den-rtab-' +
              r.n +
              '" data-rsel="' +
              r.n +
              '" aria-selected="' +
              (on ? "true" : "false") +
              '" aria-controls="den-dock-out" tabindex="' +
              (on ? "0" : "-1") +
              '" title="' +
              esc(runTitle(r)) +
              '"' +
              (r.closable ? ' aria-keyshortcuts="Delete"' : "") +
              '><span class="den-dot ' +
              dotClass(r) +
              '" aria-hidden="true"></span>' +
              esc(r.label) +
              (r.running
                ? '<span class="den-sr">, ' +
                  esc(t("runs.n", { n: 1 })) +
                  "</span>"
                : r.error
                  ? '<span class="den-sr">, ' + esc(t("dock.err")) + "</span>"
                  : "") +
              "</button>" +
              (r.closable
                ? '<button type="button" class="den-rtab-x" tabindex="-1" data-rclose="' +
                  r.n +
                  '" aria-label="' +
                  esc(t("dock.closeRun", { s: r.label })) +
                  '" title="' +
                  esc(t("dock.closeRun", { s: r.label })) +
                  '"><span aria-hidden="true">×</span></button>'
                : "") +
              "</span>"
            );
          })
          .join("")
      : "<span>" + esc(t("runs.none")) + "</span>";
    var acts = "";
    if (dockOpen && sel) {
      (sel.actions || []).forEach(function (a, i) {
        acts +=
          '<button type="button" class="den-ib" data-ract="' +
          i +
          '"' +
          (a.title ? ' title="' + esc(a.title) + '"' : "") +
          ">" +
          esc(a.label) +
          "</button>";
      });
      acts +=
        '<button type="button" class="den-ib" data-dock="copy">' +
        esc(t("dock.copy")) +
        "</button>" +
        '<button type="button" class="den-ib" data-dock="clear">' +
        esc(t("dock.clear")) +
        "</button>";
    }
    return (
      "<b>" +
      esc(t("runs.title")) +
      "</b>" +
      // A tablist only while it holds tabs: an empty one ("No runs") is
      // a tablist with no tab, which screen readers announce as broken
      // (0.3.0-dev.34, a consumer's finding). The bar redraws on any run's
      // state change, so the first tab brings the role back.
      '<div class="den-runs-l"' +
      (shown.length
        ? ' role="tablist" aria-label="' + esc(t("runs.title")) + '"'
        : "") +
      ">" +
      tabs +
      "</div>" +
      (acts ? '<span class="den-dock-acts">' + acts + "</span>" : "") +
      // (No runs at all: nothing to filter, no toggle.)
      (runScope && RUNS.length
        ? '<button type="button" class="den-ib" data-dock="all" aria-pressed="' +
          (runAll ? "true" : "false") +
          '" title="' +
          esc(t(runAll ? "runs.allOn" : "runs.allTip", { ws: runScope.ws })) +
          '">' +
          esc(t("runs.all")) +
          "</button>"
        : "") +
      '<button type="button" class="den-ib" data-act="dock" aria-expanded="' +
      (dockOpen ? "true" : "false") +
      '" aria-controls="den-dock-out">' +
      esc(dockOpen ? t("dock.close") + " ▾" : t("dock.show") + " ▴") +
      "</button>"
    );
  }
  var shownRun = null;
  var pending = [];
  var rafId = null;
  function lineSpan(l) {
    var span = document.createElement("span");
    if (l.cls) span.className = l.cls;
    span.textContent = l.text + "\n";
    l.el = span;
    return span;
  }
  function outEl() {
    return dock.querySelector ? dock.querySelector("#den-dock-out") : null;
  }
  function fillOut() {
    var out = outEl();
    if (!out) return;
    pending = [];
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    var sel = selectedRun();
    shownRun = sel;
    out.innerHTML = "";
    if (sel) out.setAttribute("aria-labelledby", "den-rtab-" + sel.n);
    else out.removeAttribute("aria-labelledby");
    if (!sel) {
      out.textContent = t("runs.empty");
      var last = lastRunHere();
      if (last) {
        out.appendChild(document.createTextNode(" "));
        var a = document.createElement("a");
        a.href = last.page;
        a.textContent = t("dock.last", { s: last.label });
        out.appendChild(a);
      }
      return;
    }
    var frag = document.createDocumentFragment();
    sel.lines.forEach(function (l) {
      frag.appendChild(lineSpan(l));
    });
    out.appendChild(frag);
    if (sel.autoScroll) out.scrollTop = out.scrollHeight;
  }
  function flush() {
    rafId = null;
    var out = outEl();
    var batch = pending;
    pending = [];
    if (!out || !shownRun || !batch.length) return;
    var frag = document.createDocumentFragment();
    batch.forEach(function (l) {
      if (shownRun.lines.indexOf(l) >= 0) frag.appendChild(lineSpan(l));
    });
    out.appendChild(frag);
    if (shownRun.max)
      while (out.childElementCount > shownRun.max)
        out.removeChild(out.firstChild);
    if (shownRun.autoScroll) out.scrollTop = out.scrollHeight;
  }
  function renderDock() {
    if (!dock.querySelector) return;
    var bar = dock.querySelector(".den-bar");
    if (!bar) {
      dock.innerHTML =
        '<div class="den-dock-grip" aria-hidden="true" title="' +
        esc(t("dock.resize")) +
        '"></div><div class="den-bar"></div>';
      bar = dock.querySelector(".den-bar");
    }
    var focusSel =
      document.activeElement && dock.contains(document.activeElement)
        ? document.activeElement.getAttribute("data-rsel") ||
          document.activeElement.getAttribute("data-act") ||
          document.activeElement.getAttribute("data-dock")
        : null;
    bar.innerHTML = barHtml();
    dock.classList.toggle("open", dockOpen);
    var out = outEl();
    if (dockOpen && !out) {
      out = document.createElement("pre");
      out.id = "den-dock-out";
      out.setAttribute("role", "tabpanel");
      out.tabIndex = 0;
      out.style.height = dockCap(dockH) + "px";
      out.addEventListener("scroll", function () {
        if (!shownRun) return;
        shownRun.autoScroll =
          out.scrollHeight - out.scrollTop <= out.clientHeight + 20;
      });
      dock.appendChild(out);
      fillOut();
    } else if (!dockOpen && out) {
      out.remove();
      shownRun = null;
    } else if (out && selectedRun() !== shownRun) fillOut();
    // Keep focus on what had it (a redraw replaces the bar's buttons).
    if (focusSel) {
      var back =
        bar.querySelector('[data-rsel="' + focusSel + '"]') ||
        bar.querySelector('[data-act="' + focusSel + '"]') ||
        bar.querySelector('[data-dock="' + focusSel + '"]');
      if (back) back.focus();
    }
    var on = bar.querySelector('.den-rtab[aria-selected="true"]');
    if (on && on.scrollIntoView)
      on.scrollIntoView({ block: "nearest", inline: "nearest" });
    var chip = document.getElementById("den-runs");
    if (chip) {
      chip.setAttribute("aria-expanded", dockOpen ? "true" : "false");
      chip.setAttribute("aria-controls", "den-dock");
    }
  }

  function addRun(id, label, opts) {
    id = String(id);
    opts = opts || {};
    var r = runById(id);
    if (!r) {
      r = {
        id: id,
        n: ++runSeqId,
        label: String(label == null ? id : label),
        lines: [],
        running: false,
        done: false,
        error: false,
        startedAt: Date.now(),
        endedAt: null,
        autoScroll: true,
        closable: true,
        doneLine: true,
        max: 0,
        actions: [],
        keyed: {},
        ws: [],
        ranAt: null,
      };
      RUNS.push(r);
    } else if (label != null) r.label = String(label);
    // The workspaces it ran in (R24e): every one a page tagged it with.
    [].concat(opts.ws == null ? [] : opts.ws).forEach(function (w) {
      if (w && r.ws.indexOf(String(w)) < 0) r.ws.push(String(w));
    });
    [
      "closable",
      "doneLine",
      "max",
      "onClose",
      "onSelect",
      "onClear",
      "actions",
    ].forEach(function (k) {
      if (opts[k] !== undefined) r[k] = opts[k];
    });
    if (opts.running !== undefined) markRunning(r, !!opts.running);
    if (opts.error !== undefined) r.error = !!opts.error;
    return r;
  }
  /** Running on or off; when it last ran and ended (a page's last-run column). */
  function markRunning(r, on) {
    if (on && !r.running) {
      r.ranAt = Date.now();
      r.endedAt = null;
    } else if (!on && r.running) r.endedAt = Date.now();
    r.running = on;
  }
  var runsApi = {
    add: function (id, label, opts) {
      var r = addRun(id, label, opts);
      if (opts && opts.select) runSel = r.id;
      if (opts && opts.open === true) {
        dockOpen = true;
        rememberDock();
      }
      renderDock();
      runsChanged();
      return r.id;
    },
    start: function (id, label, opts) {
      opts = opts || {};
      var r = addRun(id, label, opts);
      r.running = opts.running !== false;
      r.done = false;
      r.error = false;
      r.startedAt = Date.now();
      r.ranAt = r.startedAt;
      r.endedAt = null;
      if (opts.clear) {
        r.lines = [];
        r.keyed = {};
        if (shownRun === r) shownRun = null;
      }
      if (opts.select !== false) runSel = r.id;
      // R16a: a run starting never opens the dock; open: true is for an
      // action whose whole point is output (e.g. a service's Logs).
      if (opts.open === true) {
        dockOpen = true;
        rememberDock();
      }
      renderDock();
      runsChanged();
      return r.id;
    },
    append: function (id, text, cls, o) {
      var r = runById(String(id));
      if (!r) return;
      var key = o && o.key;
      if (key != null && r.keyed[key] && r.lines.indexOf(r.keyed[key]) >= 0) {
        var l0 = r.keyed[key];
        l0.text = String(text);
        if (l0.el && shownRun === r) l0.el.textContent = l0.text + "\n";
        if (shownRun === r && r.autoScroll) {
          var o0 = outEl();
          if (o0) o0.scrollTop = o0.scrollHeight;
        }
        return;
      }
      var l = { text: String(text), cls: cls || "" };
      if (key != null) r.keyed[key] = l;
      r.lines.push(l);
      if (r.max && r.lines.length > r.max)
        r.lines.splice(0, r.lines.length - r.max);
      if (shownRun === r) {
        pending.push(l);
        if (rafId === null) rafId = requestAnimationFrame(flush);
      }
    },
    finish: function (id, o) {
      var r = runById(String(id));
      if (!r) return;
      var ok = !(o && o.ok === false);
      r.running = false;
      r.done = true;
      r.error = !ok;
      r.endedAt = Date.now();
      if (r.doneLine)
        runsApi.append(
          r.id,
          (ok ? "✓ " : "✗ ") +
            t(ok ? "dock.done" : "dock.failed", {
              s: secs(r.endedAt - r.startedAt),
            }),
          ok ? "done-ok" : "done-fail",
        );
      renderDock();
      runsChanged();
    },
    set: function (id, o) {
      var r = runById(String(id));
      if (!r || !o) return;
      if (o.label != null) r.label = String(o.label);
      if (o.running !== undefined) markRunning(r, !!o.running);
      if (o.error !== undefined) r.error = !!o.error;
      if (o.actions !== undefined) r.actions = o.actions || [];
      renderDock();
      runsChanged();
    },
    select: function (id, o) {
      var r = runById(String(id));
      if (!r) return;
      runSel = r.id;
      if (o && o.open === true) {
        dockOpen = true;
        rememberDock();
      }
      renderDock();
    },
    clear: function (id) {
      var r = runById(String(id == null ? runSel : id));
      if (!r) return;
      r.lines = [];
      r.keyed = {};
      if (shownRun === r) fillOut();
    },
    remove: function (id) {
      var r = runById(String(id));
      if (!r) return;
      RUNS.splice(RUNS.indexOf(r), 1);
      if (runSel === r.id) {
        var last = RUNS[RUNS.length - 1];
        runSel = last ? last.id : null;
      }
      if (shownRun === r) shownRun = null;
      renderDock();
      runsChanged();
    },
    show: function () {
      dockOpen = true;
      rememberDock();
      renderDock();
    },
    hide: function () {
      dockOpen = false;
      rememberDock();
      renderDock();
    },
    toggle: function () {
      dockOpen = !dockOpen;
      rememberDock();
      renderDock();
      return dockOpen;
    },
    isOpen: function () {
      return dockOpen;
    },
    has: function (id) {
      return !!runById(String(id));
    },
    list: function () {
      return RUNS.map(function (r) {
        return {
          id: r.id,
          label: r.label,
          running: r.running,
          done: r.done,
          error: r.error,
          lines: r.lines.length,
          ws: r.ws.slice(),
          ranAt: r.ranAt,
          endedAt: r.endedAt,
          shown: inScope(r),
        };
      });
    },
    /**
     * Scope the dock to one workspace's runs (R24e), or null for every
     * run. "All runs" in the bar lifts it until the scope changes.
     */
    scope: function (o) {
      var ws = o && o.ws ? String(o.ws) : null;
      if ((runScope && runScope.ws) === ws) return;
      runScope = ws ? { ws: ws } : null;
      runAll = false;
      renderDock();
      runsChanged();
    },
    selected: function () {
      var r = selectedRun();
      return r ? r.id : null;
    },
    text: function (id) {
      var r = runById(String(id == null ? runSel : id)) || selectedRun();
      return r
        ? r.lines
            .map(function (l) {
              return l.text + "\n";
            })
            .join("")
        : "";
    },
    running: function () {
      return RUNS.filter(function (r) {
        return r.running;
      }).length;
    },
    onChange: function (fn) {
      if (typeof fn === "function") runListeners.push(fn);
    },
  };

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText)
      return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e) {
        ok = false;
      }
      ta.remove();
      if (ok) resolve();
      else reject(new Error("copy failed"));
    });
  }
  function runOfEl(el, attr) {
    var n = Number(el.getAttribute(attr));
    for (var i = 0; i < RUNS.length; i++) if (RUNS[i].n === n) return RUNS[i];
    return null;
  }
  function closeRun(r) {
    if (typeof r.onClose === "function") r.onClose(r.id);
    else runsApi.remove(r.id);
  }
  if (dock.addEventListener) {
    dock.addEventListener("click", function (e) {
      var tgt = e.target && e.target.closest ? e.target : null;
      if (!tgt) return;
      var x = tgt.closest("[data-rclose]");
      if (x) {
        var rx = runOfEl(x, "data-rclose");
        if (rx) closeRun(rx);
        return;
      }
      var tab = tgt.closest("[data-rsel]");
      if (tab) {
        var rt = runOfEl(tab, "data-rsel");
        if (!rt) return;
        runsApi.select(rt.id, { open: true });
        if (typeof rt.onSelect === "function") rt.onSelect(rt.id);
        return;
      }
      if (tgt.closest('[data-act="dock"]')) {
        runsApi.toggle();
        return;
      }
      var act = tgt.closest("[data-ract]");
      var sel = selectedRun();
      if (act && sel) {
        var a = (sel.actions || [])[Number(act.getAttribute("data-ract"))];
        if (a && typeof a.run === "function") a.run(sel.id);
        return;
      }
      var d = tgt.closest("[data-dock]");
      if (d && d.getAttribute("data-dock") === "all") {
        runAll = !runAll;
        renderDock();
        runsChanged();
        return;
      }
      if (!d || !sel) return;
      if (d.getAttribute("data-dock") === "clear") {
        runsApi.clear(sel.id);
        if (typeof sel.onClear === "function") sel.onClear(sel.id);
      } else {
        var btn = d;
        copyText(runsApi.text(sel.id))
          .then(function () {
            btn.textContent = t("dock.copied");
            setTimeout(function () {
              btn.textContent = t("dock.copy");
            }, 1500);
          })
          .catch(function () {});
      }
    });
    // The run tabs: one tab stop; ←/→, Home and End move (and select);
    // Delete closes a closable run.
    dock.addEventListener("keydown", function (e) {
      var tab = e.target && e.target.closest && e.target.closest("[data-rsel]");
      if (!tab) return;
      var r = runOfEl(tab, "data-rsel");
      var shown = visibleRuns();
      var i = shown.indexOf(r);
      var next =
        e.key === "ArrowRight"
          ? (i + 1) % shown.length
          : e.key === "ArrowLeft"
            ? (i - 1 + shown.length) % shown.length
            : e.key === "Home"
              ? 0
              : e.key === "End"
                ? shown.length - 1
                : -1;
      if (e.key === "Delete" && r && r.closable) {
        e.preventDefault();
        closeRun(r);
        var stop = dock.querySelector('.den-rtab[tabindex="0"]');
        if (stop) stop.focus();
        return;
      }
      if (next < 0 || !shown[next]) return;
      e.preventDefault();
      runsApi.select(shown[next].id, { open: dockOpen });
      if (typeof shown[next].onSelect === "function")
        shown[next].onSelect(shown[next].id);
      var to = dock.querySelector('[data-rsel="' + shown[next].n + '"]');
      if (to) to.focus();
    });
    // Drag the top edge to resize (Local Dev's handle): 60px to half the
    // window (R16a), remembered (shell.dockHeight).
    var drag = null;
    dock.addEventListener("mousedown", function (e) {
      if (!e.target.closest || !e.target.closest(".den-dock-grip")) return;
      var out = outEl();
      if (!out) return;
      drag = { y: e.clientY, h: out.offsetHeight };
      document.body.style.cursor = "ns-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
    document.addEventListener("mousemove", function (e) {
      if (!drag) return;
      var out = outEl();
      if (!out) return;
      dockH = dockCap(drag.h + drag.y - e.clientY);
      out.style.height = dockH + "px";
    });
    document.addEventListener("mouseup", function () {
      if (!drag) return;
      drag = null;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      if (state.dockHeight !== dockH) {
        state.dockHeight = dockH;
        saveShell({ dockHeight: dockH });
      }
    });
  }
  renderDock();

  // ── Errors people can see and act on (R26c, R26d, MD-2; dev.38) ───────
  // denShell.api(method, url, body?, opts?) is the one client path for a
  // call: it resolves with the data (JSON, else text) or throws a typed
  // error (name "DenApiError": status, code, requestId, method, url,
  // network, data, retry). The server's errors are { ok: false, error,
  // code, requestId } (R26b); a 200 with ok:false is an error too. One a
  // page doesn't catch becomes a toast: the message, the request id,
  // Retry and Copy details.
  //
  // Every same-origin fetch that fails at the network level (the server
  // stopped or is restarting) raises the banner "Den's server isn't
  // responding — retrying"; it probes /api/server-info with backoff and
  // clears itself when the server answers. Meanwhile `den:server` (detail
  // { up }) fires on window and the status chip reads unknown.
  //
  // Banners sit at the top of the page's content (the prototype's
  // .note-banner): the unreachable one. (A newer engine on disk, MD-2, is
  // the update pill's: the server fills data-engine-stale on #den-shell;
  // header.js's server-info poll calls setEngine.)
  function apiError(message, o) {
    var e = new Error(message);
    e.name = "DenApiError";
    e.denApi = true;
    e.status = o.status || 0;
    e.code = o.code || (o.network ? "network" : "http_" + e.status);
    e.requestId = o.requestId || null;
    e.method = o.method;
    e.url = o.url;
    e.network = !!o.network;
    e.data = o.data === undefined ? null : o.data;
    e.retry = o.retry || null;
    return e;
  }
  function pathOf(url) {
    return String(url || "").split("?")[0];
  }
  function api(method, url, body, opts) {
    opts = opts || {};
    method = String(method || "GET").toUpperCase();
    var init = { method: method, headers: {} };
    if (body !== undefined && body !== null) {
      init.headers["Content-Type"] = "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    if (opts.signal) init.signal = opts.signal;
    if (opts.headers)
      for (var h in opts.headers) init.headers[h] = opts.headers[h];
    var what = method + " " + pathOf(url);
    var retry =
      opts.retry ||
      (method === "GET"
        ? function () {
            location.reload();
          }
        : function () {
            return api(method, url, body, opts).then(function () {
              toast(t("api.retried"));
            });
          });
    return fetch(url, init).then(
      function (r) {
        var get = function (k) {
          return r.headers && r.headers.get ? r.headers.get(k) || "" : "";
        };
        var isJson = /json/.test(get("Content-Type"));
        var parsed = isJson
          ? r.json().catch(function () {
              return null;
            })
          : typeof r.text === "function"
            ? r.text()
            : Promise.resolve(null);
        return parsed.then(function (data) {
          var failed =
            !r.ok || (data && typeof data === "object" && data.ok === false);
          if (!failed) return data;
          var msg =
            data && typeof data === "object" && typeof data.error === "string"
              ? data.error
              : typeof data === "string" && data.trim()
                ? data.trim().slice(0, 300)
                : t("api.failed", { what: what }) + " (" + r.status + ")";
          // SEC-1: a sign-in refusal in the page's language, with its command.
          if (
            data &&
            data.code === "signin_required" &&
            (data.scope === "agents" || data.scope === "terminal")
          ) {
            var cmd = /`([^`]+)`/.exec(String(data.error || ""));
            msg =
              (data.scope === "agents"
                ? t("err.signin.agents")
                : t("err.signin.terminal")) +
              (cmd ? ". " + t("err.signin.lead", { cmd: cmd[1] }) : "");
          } else if (data && data.code === "signin_required") {
            // 0.4.71: a write from a page with no session: the one line
            // (and the banner's Sign in), never a silent failure.
            msg = t("shell.signin.line");
            signinBanner({ signedIn: false, csrf: null });
          }
          throw apiError(msg, {
            status: r.status,
            code: data && typeof data === "object" ? data.code : null,
            requestId:
              (data && typeof data === "object" && data.requestId) ||
              get("X-Request-Id") ||
              null,
            method: method,
            url: url,
            data: data,
            retry: retry,
          });
        });
      },
      function (err) {
        if (err && err.name === "AbortError") throw err;
        throw apiError(t("api.network", { what: what }), {
          network: true,
          method: method,
          url: url,
          retry: retry,
        });
      },
    );
  }
  /** The text "Copy details" puts on the clipboard (no stack, no body). */
  function errorDetails(err) {
    return [
      "Den " + (versionText() || "unknown"),
      (err.method || "GET") + " " + pathOf(err.url),
      "Status " + (err.network ? "no answer" : err.status),
      "Code " + (err.code || ""),
      "Request " + (err.requestId || "none"),
      "Message " + err.message,
      "Page " + location.pathname,
      "Time " + new Date().toISOString(),
    ].join("\n");
  }
  function versionText() {
    var v =
      document.querySelector && document.querySelector("#version-pill .v-txt");
    var s = v ? String(v.textContent || "").replace(/^v/, "") : "";
    return s && s !== "…" ? s : "";
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText)
      return navigator.clipboard.writeText(text).catch(function () {});
    return Promise.resolve();
  }
  var errToastTimer = null;
  /** An error toast: message, request id, Retry, Copy details, ×. */
  function errorToast(err) {
    if (!document.body || !document.createElement) return;
    var old = document.querySelector && document.querySelector(".den-toast");
    if (old && old.remove) old.remove();
    clearTimeout(toastTimer);
    clearTimeout(errToastTimer);
    var el = document.createElement("div");
    el.className = "den-toast den-toast-err";
    el.setAttribute("role", "alert");
    el.innerHTML =
      '<span class="den-te-ic" aria-hidden="true">⚠</span>' +
      '<span class="den-te-msg"><span class="den-te-t"></span>' +
      (err.requestId
        ? '<span class="den-te-id">' +
          esc(t("api.request", { id: err.requestId })) +
          "</span>"
        : "") +
      "</span>" +
      (err.retry
        ? '<button type="button" class="den-tbtn" data-te="retry">' +
          esc(t("api.retry")) +
          "</button>"
        : "") +
      '<button type="button" class="den-tbtn" data-te="copy">' +
      esc(t("api.copy")) +
      "</button>" +
      '<button type="button" class="den-tx" data-te="close" aria-label="' +
      esc(t("api.close")) +
      '">×</button>';
    el.querySelector(".den-te-t").textContent = err.message;
    var hold = false;
    var arm = function () {
      clearTimeout(errToastTimer);
      errToastTimer = setTimeout(function () {
        if (!hold && el.remove) el.remove();
      }, 12000);
    };
    el.addEventListener("mouseenter", function () {
      hold = true;
    });
    el.addEventListener("mouseleave", function () {
      hold = false;
      arm();
    });
    el.addEventListener("focusin", function () {
      hold = true;
    });
    el.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("[data-te]");
      if (!b) return;
      var act = b.getAttribute("data-te");
      if (act === "close") el.remove();
      else if (act === "copy")
        copyText(errorDetails(err)).then(function () {
          b.textContent = t("api.copied");
        });
      else if (act === "retry") {
        el.remove();
        try {
          var p = err.retry();
          if (p && typeof p.catch === "function")
            p.catch(function (again) {
              if (again && again.denApi) errorToast(again);
            });
        } catch (again) {
          if (again && again.denApi) errorToast(again);
        }
      }
    });
    document.body.appendChild(el);
    clearOfMarked(el);
    arm();
  }
  if (typeof window.addEventListener === "function")
    window.addEventListener("unhandledrejection", function (e) {
      var r = e && e.reason;
      if (!r || !r.denApi) return;
      if (e.preventDefault) e.preventDefault();
      errorToast(r);
    });

  // Banners (.note-banner): at the top of the page's content.
  var BANNERS = {};
  function bannerHost() {
    var main =
      document.getElementById && document.getElementById("den-content");
    if (!main) return null;
    var box = document.getElementById("den-banners");
    if (!box) {
      box = document.createElement("div");
      box.id = "den-banners";
      box.className = "den-banners";
      box.setAttribute("aria-live", "polite");
    }
    if (main.firstChild !== box) main.insertBefore(box, main.firstChild);
    // A page whose content is already inset (edge, settings) needs none.
    var pad = 0;
    try {
      pad = parseFloat(getComputedStyle(main).paddingLeft) || 0;
    } catch (e) {
      pad = 0;
    }
    box.classList.toggle("den-banners-inset", pad >= 12);
    return box;
  }
  /** Show (or replace) banner `id`: { title?, text, action?: { label, run } }. */
  function showBanner(id, b) {
    BANNERS[id] = b;
    paintBanners();
  }
  function hideBanner(id) {
    if (!BANNERS[id]) return;
    delete BANNERS[id];
    paintBanners();
  }
  function paintBanners() {
    var box = bannerHost();
    if (!box) {
      if (document.readyState === "loading")
        document.addEventListener("DOMContentLoaded", paintBanners, {
          once: true,
        });
      return;
    }
    var ids = Object.keys(BANNERS);
    box.hidden = ids.length === 0;
    box.innerHTML = ids
      .map(function (id) {
        var b = BANNERS[id];
        return (
          '<div class="den-banner warn" data-banner="' +
          esc(id) +
          '" role="status"><span class="den-bn-ic" aria-hidden="true">' +
          (b.tone === "addr" ? "●" : "⚠") +
          "</span>" +
          (b.tone === "addr" ? '<span class="den-bn-body">' : "") +
          (b.title ? "<b>" + esc(b.title) + "</b>" : "") +
          '<span class="den-bn-t">' +
          esc(b.text) +
          "</span>" +
          (b.note ? '<span class="den-bn-n">' + esc(b.note) + "</span>" : "") +
          (b.link
            ? '<a class="den-bn-a" href="' +
              esc(b.link.href) +
              '">' +
              esc(b.link.label) +
              "</a>"
            : "") +
          (b.tone === "addr" ? "</span>" : "") +
          (b.dismiss
            ? '<button type="button" class="den-bn-x" data-bn-x="' +
              esc(id) +
              '" aria-label="' +
              esc(b.dismiss.label) +
              '">×</button>'
            : "") +
          (b.action
            ? '<button type="button" class="den-tbtn" data-bn-act="' +
              esc(id) +
              '">' +
              esc(b.action.label) +
              "</button>"
            : "") +
          "</div>"
        );
      })
      .join("");
  }
  document.addEventListener("click", function (e) {
    var x = e.target && e.target.closest && e.target.closest("[data-bn-x]");
    if (x) {
      var bx = BANNERS[x.getAttribute("data-bn-x")];
      if (bx && bx.dismiss) bx.dismiss.run();
      return;
    }
    var b = e.target && e.target.closest && e.target.closest("[data-bn-act]");
    if (!b) return;
    var ban = BANNERS[b.getAttribute("data-bn-act")];
    if (ban && ban.action) ban.action.run();
  });

  // MD-2: the engine on disk is not the one this server runs: a new
  // version of Den is installed. The shared update pill (den-ui,
  // /kit/update-pill.js) offers it over the top bar. Reload restarts Den's
  // server in place (Restart Den, D64: the working pop-up waits for the
  // new server), then reloads the page so it runs the new version. With
  // unsaved text in a composer or form, Reload asks first. "Not now" holds
  // for that version in this tab (sessionStorage), on every page.
  var UPD_SS = "den.update.dismissed";
  var upd = { pill: null, version: null, want: null, loading: null };
  function updDismissed(v) {
    try {
      return sessionStorage.getItem(UPD_SS) === v;
    } catch (e) {
      return false;
    }
  }
  /** Typed text a reload would lose: a composer's or a form's. */
  function unsavedText() {
    var els = document.querySelectorAll(
      "textarea:not(.xterm-helper-textarea), form input, [contenteditable='true']",
    );
    var skip = /^(hidden|checkbox|radio|button|submit|reset|file|range|color)$/;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest && el.closest(".den-upd")) continue;
      if (el.isContentEditable && el.tagName !== "TEXTAREA") {
        if ((el.textContent || "").trim()) return true;
        continue;
      }
      if (el.tagName === "INPUT" && skip.test(el.type || "")) continue;
      if (el.value !== el.defaultValue && String(el.value || "").trim() !== "")
        return true;
    }
    return false;
  }
  function loadUpdatePill() {
    if (upd.loading) return upd.loading;
    var css = new Promise(function (resolve) {
      if (document.getElementById("den-upd-css")) return resolve();
      var l = document.createElement("link");
      l.id = "den-upd-css";
      l.rel = "stylesheet";
      l.href = "/kit/update-pill.css";
      l.onload = l.onerror = function () {
        resolve();
      };
      document.head.appendChild(l);
    });
    upd.loading = Promise.all([import("/kit/update-pill.js"), css]).then(
      function (r) {
        return r[0].showUpdate;
      },
    );
    return upd.loading;
  }
  function hideUpdate() {
    if (upd.pill) upd.pill.hide();
    upd.pill = null;
    upd.version = null;
  }
  function updReload() {
    import("/restart-den.js")
      .then(function (m) {
        return m.restartDen({ confirm: false, from: "update-pill" });
      })
      .then(function (info) {
        if (info) location.reload();
      });
  }
  function setEngine(info) {
    var v = info && info.stale ? String(info.onDisk || "?") : null;
    upd.want = v;
    if (!v || updDismissed(v)) return hideUpdate();
    if (upd.pill && upd.version === v) return;
    loadUpdatePill().then(
      function (showUpdate) {
        if (upd.want !== v || updDismissed(v)) return;
        if (upd.pill && upd.version === v) return;
        hideUpdate();
        upd.version = v;
        upd.pill = showUpdate({
          message: t("upd.msg"),
          reloadLabel: t("upd.reload"),
          dismissLabel: t("upd.notNow"),
          cancelLabel: t("upd.cancel"),
          region: t("upd.region"),
          askFirst: function () {
            return unsavedText() ? { message: t("upd.ask") } : null;
          },
          onReload: updReload,
          onDismiss: function () {
            upd.pill = null;
            upd.version = null;
            try {
              sessionStorage.setItem(UPD_SS, v);
            } catch (e) {
              /* no storage: dismissed on this page only */
            }
          },
        });
      },
      function () {
        upd.loading = null;
      },
    );
  }
  if (host.dataset.engineStale) {
    try {
      var eng = JSON.parse(host.dataset.engineStale);
      eng.stale = true;
      setEngine(eng);
    } catch (e) {
      /* a malformed attribute: no pill */
    }
  }

  // 0.4.3: the edge is reachable from other machines (the server fills
  // data-edge-exposed on #den-shell). One line; dismissed per browser.
  var EDGE_LS = "den.edgeExposed.dismissed";
  var edgeDismissed = false;
  try {
    edgeDismissed = localStorage.getItem(EDGE_LS) === "1";
  } catch (e) {
    edgeDismissed = false;
  }
  if (host.dataset.edgeExposed && !edgeDismissed)
    showBanner("edge-exposed", {
      text: host.dataset.edgeExposed,
      action: {
        label: t("api.close"),
        run: function () {
          try {
            localStorage.setItem(EDGE_LS, "1");
          } catch (e) {
            /* no storage: dismissed for this page only */
          }
          hideBanner("edge-exposed");
        },
      },
    });

  // Issue 455 (mock v3): Den's address is answered by another server (its
  // port is held), so Den serves at its own port for now. Once per browser
  // and working address: shown on the first page, and again only when the
  // working address changes; × dismisses it for good for that address. It
  // never comes back on every page while the port stays held: the fact
  // lives in Edge and `doctor`.
  var ADDR_LS = "den.address.banner";
  /** A page's href, from its NAV registry entry (R11a). */
  function navHref(id) {
    for (var i = 0; i < NAV.length; i++)
      if (NAV[i].id === id) return NAV[i].href;
    return "/";
  }
  function addressBannerText(s) {
    var host = "";
    try {
      host = new URL(s.wanted).hostname;
    } catch (e) {
      host = String(s.wanted || "");
    }
    if (s.wantedAnswer !== "other")
      return t("edgeAddr.banner.none", { host: host });
    if (s.owner)
      return t("edgeAddr.banner.held", {
        port: s.port,
        owner: s.owner.owner,
        name: s.owner.name,
        host: host,
      });
    if (s.answeredAs)
      return t("edgeAddr.banner.heldBare", {
        port: s.port,
        owner: s.answeredAs,
        host: host,
      });
    return t("edgeAddr.banner.unknown", { port: s.port, host: host });
  }
  function addressBanner() {
    var seen = null;
    try {
      seen = localStorage.getItem(ADDR_LS);
    } catch (e) {
      seen = null;
    }
    fetch("/api/edge/address", { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (s) {
        if (
          !s ||
          !s.wanted ||
          !s.address ||
          s.wantedAnswer !== "other" ||
          s.address === s.wanted ||
          seen === s.address
        )
          return;
        // Shown once for this address: a later page shows nothing.
        try {
          localStorage.setItem(ADDR_LS, s.address);
        } catch (e) {
          /* no storage: shown on this page only */
        }
        showBanner("den-address", {
          tone: "addr",
          title: t("edgeAddr.banner.title", { address: s.address }),
          text: addressBannerText(s),
          link: { href: navHref("edge"), label: t("edgeAddr.banner.fix") },
          dismiss: {
            label: t("edgeAddr.banner.dismiss"),
            run: function () {
              hideBanner("den-address");
            },
          },
        });
      })
      .catch(function () {
        /* no answer: nothing to say */
      });
  }
  window.addEventListener("den:address-changed", function () {
    hideBanner("den-address");
  });

  // The config fails validation (0.4.1): the server marks every page it
  // serves while it does (data-config-invalid on #den-shell), and the first
  // /api answer of 422 config_invalid marks it too. From then on the shell
  // and its modules start none of the polls and streams that read the
  // config (health, edge, workspaces, applications, the org config, …):
  // each would only answer 422 again. A reload once fixed starts them.
  var configBad = host.dataset.configInvalid === "1";
  // SEC-1b: a refusal page (421 "Wrong address", or signed out): the server
  // marks it (data-api-off), since every /api call from it would answer
  // the same refusal. The shell starts none of its polls and streams, the
  // same gate as an invalid config, and the status chip reads unknown.
  var apiOffPage = host.dataset.apiOff === "1";
  function apiOff() {
    return apiOffPage;
  }
  function configInvalid() {
    return configBad || apiOffPage;
  }
  // Issue 455: the address banner reads web.secret, web.url and the edge
  // config only (config-free), so only a refusal page skips it.
  if (!apiOffPage) addressBanner();
  function markConfigInvalid() {
    if (configBad) return;
    configBad = true;
    try {
      window.dispatchEvent(new CustomEvent("den:config-invalid"));
    } catch (e) {
      /* no CustomEvent */
    }
  }

  // R26d: the server unreachable.
  var server = {
    up: true,
    downs: 0,
    delay: 0,
    timer: null,
    tick: null,
    nextAt: 0,
  };
  var baseFetch =
    typeof window.fetch === "function" ? window.fetch.bind(window) : null;
  // A same-origin refusal or error (4xx, 5xx) is read in full here and
  // handed on as the same answer, already read. A caller that only looks
  // at the status (`r.ok ? r.json() : null`) otherwise leaves its body
  // unread, and the browser holds that request open: a session refused
  // every 3 s (a test install's fixture person) kept the page from ever
  // settling. Its body, status and headers stay readable as before.
  var NO_BODY = { 204: 1, 205: 1, 304: 1 };
  function readRefusal(input, r) {
    if (
      !r ||
      r.ok ||
      !r.body ||
      NO_BODY[r.status] ||
      typeof Response !== "function" ||
      !sameOrigin(input)
    )
      return r;
    return r.text().then(
      function (text) {
        try {
          return new Response(text, {
            status: r.status,
            statusText: r.statusText,
            headers: r.headers,
          });
        } catch (e) {
          return r;
        }
      },
      function () {
        return r;
      },
    );
  }
  var rawFetch = baseFetch
    ? function (input, init) {
        return baseFetch(input, init).then(function (r) {
          return readRefusal(input, r);
        });
      }
    : null;
  function sameOrigin(input) {
    var u =
      typeof input === "string"
        ? input
        : input && (typeof input.url === "string" ? input.url : input.href);
    if (!u) return false;
    if (u.charAt(0) === "/" && u.charAt(1) !== "/") return true;
    try {
      return new URL(u, location.href).origin === location.origin;
    } catch (e) {
      return false;
    }
  }
  function serverState(up) {
    if (server.up === up) return;
    server.up = up;
    if (document.body && document.body.classList)
      document.body.classList.toggle("den-server-down", !up);
    try {
      window.dispatchEvent(
        new CustomEvent("den:server", { detail: { up: up } }),
      );
    } catch (e) {
      /* no CustomEvent */
    }
  }
  function paintDown() {
    var left = Math.max(0, Math.ceil((server.nextAt - Date.now()) / 1000));
    showBanner("net", {
      text: t("net.down"),
      note: left > 0 ? t("net.next", { s: left }) : "",
      action: { label: t("net.now"), run: probeNow },
    });
  }
  function serverUnreachable() {
    if (!server.up) return;
    server.downs++;
    serverState(false);
    server.delay = 1000;
    scheduleProbe();
  }
  function scheduleProbe() {
    clearTimeout(server.timer);
    clearInterval(server.tick);
    server.nextAt = Date.now() + server.delay;
    paintDown();
    server.tick = setInterval(paintDown, 1000);
    server.timer = setTimeout(probe, server.delay);
  }
  function probeNow() {
    clearTimeout(server.timer);
    probe();
  }
  function probe() {
    if (!rawFetch) return;
    rawFetch("/api/server-info", { cache: "no-store" }).then(
      function () {
        serverBack();
      },
      function () {
        if (server.up) return;
        server.delay = Math.min(server.delay * 2, 15000);
        scheduleProbe();
      },
    );
  }
  function serverBack() {
    clearTimeout(server.timer);
    clearInterval(server.tick);
    hideBanner("net");
    serverState(true);
  }
  // SEC-1a: every same-origin call that changes something (POST, PUT,
  // PATCH, DELETE), through denShell.api() or a page's own fetch(), carries
  // X-Den-CSRF with the token GET /api/session hands out. The token is per
  // server start: a 403 `csrf` (the server restarted) fetches a fresh one
  // and retries once. Never sent to another origin.
  var CSRF_METHODS = { POST: 1, PUT: 1, PATCH: 1, DELETE: 1 };
  // 0.4.15: the approval key (web-session.ts). A sign-in's 303 carries it
  // in the URL fragment (#ak=…), which never reaches a server: keep it in
  // this origin's localStorage (other localhost ports can't read it),
  // strip it from the address bar, and send it with every same-origin
  // change as X-Den-Approve-Key. Only approving needs it.
  var APPROVE_KEY_STORE = "den.approveKey";
  (function takeApproveKey() {
    var m = /(?:^#|&)ak=([A-Za-z0-9_-]{43})(?:&|$)/.exec(location.hash || "");
    if (!m) return;
    try {
      localStorage.setItem(APPROVE_KEY_STORE, m[1]);
    } catch (e) {
      /* storage blocked: this browser signs in again to approve */
    }
    try {
      history.replaceState(
        history.state,
        "",
        location.pathname + location.search,
      );
    } catch (e) {
      location.hash = "";
    }
  })();
  function approveKey() {
    try {
      return localStorage.getItem(APPROVE_KEY_STORE);
    } catch (e) {
      return null;
    }
  }
  var csrf = { token: null, pending: null };
  function csrfToken(fresh) {
    if (fresh) csrf.token = null;
    if (csrf.token) return Promise.resolve(csrf.token);
    if (!csrf.pending)
      // ?welcome=1: this request alone spends the after-sign-in welcome
      // (the toast below); every other /api/session caller only reads.
      csrf.pending = rawFetch("/api/session?welcome=1", {
        cache: "no-store",
        credentials: "same-origin",
      })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(
          function (b) {
            csrf.pending = null;
            csrf.token = b && typeof b.csrf === "string" ? b.csrf : null;
            applyIdentity(b);
            signinBanner(b);
            viewMode(b);
            return csrf.token;
          },
          function () {
            csrf.pending = null;
            return null;
          },
        );
    return csrf.pending;
  }
  /**
   * Issue 796: an agent's read-only view (GET /api/session `view`). One
   * line says so, and no write control is live: every button, field and
   * switch outside the rail is disabled as it appears. Tabs, menus and
   * disclosures (they change nothing) and search boxes stay. The server
   * refuses every write all the same, and the person's approval dialog
   * never opens here.
   */
  var VIEW = null;
  var VIEW_KEEP =
    '[role="tab"],[aria-haspopup],[aria-expanded],[aria-controls],' +
    '[data-nav],[data-visit],[data-den-view-ok],input[type="search"],' +
    '[role="combobox"],[role="searchbox"]';
  function viewLock(root) {
    if (!VIEW || !root || !root.querySelectorAll) return;
    var all = root.querySelectorAll(
      'button,input,select,textarea,[contenteditable="true"]',
    );
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (
        (nav && nav.contains(el)) ||
        el.closest("#den-banners") ||
        el.matches(VIEW_KEEP)
      )
        continue;
      if (el.isContentEditable) el.setAttribute("contenteditable", "false");
      else el.disabled = true;
      el.setAttribute("aria-disabled", "true");
      el.setAttribute("data-den-view-off", "");
      el.title = t("shell.view.off");
    }
  }
  function viewMode(b) {
    if (!b || !b.view || VIEW) return;
    VIEW = b.view;
    document.documentElement.setAttribute("data-den-view", "read-only");
    hideBanner("signin");
    showBanner("view", {
      title: t("shell.view.title"),
      text: t("shell.view.line", { agent: String(VIEW.agent || "") }),
    });
    apClose();
    var run = function () {
      viewLock(document);
      if (typeof MutationObserver === "undefined") return;
      new MutationObserver(function (list) {
        for (var i = 0; i < list.length; i++)
          for (var j = 0; j < list[i].addedNodes.length; j++) {
            var n = list[i].addedNodes[j];
            if (n.nodeType !== 1) continue;
            if (n.matches && n.matches("button,input,select,textarea"))
              viewLock(n.parentNode);
            else viewLock(n);
          }
      }).observe(document.body, { childList: true, subtree: true });
    };
    if (document.body) run();
    else document.addEventListener("DOMContentLoaded", run, { once: true });
  }
  /**
   * 0.4.71: a page read on this machine with no session (a bookmark, a
   * tab opened before, an agent's plain page) changes nothing until it
   * signs in. One line and a Sign in button, to Den's own sign-in page,
   * then back here. `web up` signs in by itself (its one-time link).
   */
  function signinBanner(b) {
    if (b && b.signedIn === false && !b.actor && b.csrf == null)
      showBanner("signin", {
        text: t("shell.signin.line"),
        action: {
          label: t("shell.signin.btn"),
          run: function () {
            location.assign(
              "/signin?next=" +
                encodeURIComponent(
                  location.pathname + location.search + location.hash,
                ),
            );
          },
        },
      });
    else hideBanner("signin");
  }
  function isRequest(input) {
    return typeof Request !== "undefined" && input instanceof Request;
  }
  function methodOf(input, init) {
    var m = (init && init.method) || (isRequest(input) && input.method);
    return String(m || "GET").toUpperCase();
  }
  function withCsrf(input, init, token) {
    var headers = new Headers(
      (init && init.headers) || (isRequest(input) ? input.headers : undefined),
    );
    headers.set("X-Den-CSRF", token);
    var ak = approveKey();
    if (ak && !headers.has("X-Den-Approve-Key"))
      headers.set("X-Den-Approve-Key", ak);
    return Object.assign({}, init || {}, { headers: headers });
  }
  function csrfFetch(input, init) {
    // A body that can be sent twice (not a stream) may be retried.
    var body = init && init.body;
    var again =
      !isRequest(input) &&
      (body == null ||
        typeof body === "string" ||
        (typeof FormData !== "undefined" && body instanceof FormData) ||
        (typeof URLSearchParams !== "undefined" &&
          body instanceof URLSearchParams) ||
        (typeof Blob !== "undefined" && body instanceof Blob));
    var send = function (token) {
      return rawFetch(input, token ? withCsrf(input, init, token) : init);
    };
    return csrfToken(false).then(function (token) {
      return send(token).then(function (r) {
        if (!again || !r || r.status !== 403) return r;
        return r
          .clone()
          .json()
          .then(
            function (b) {
              if (!b || b.code !== "csrf") return r;
              return csrfToken(true).then(function (fresh) {
                return fresh ? send(fresh) : r;
              });
            },
            function () {
              return r;
            },
          );
      });
    });
  }
  if (rawFetch && !window.fetch.__denShell) {
    var wrapped = function (input, init) {
      var sentDown = server.up ? -1 : server.downs;
      var p =
        CSRF_METHODS[methodOf(input, init)] && sameOrigin(input)
          ? csrfFetch(input, init)
          : rawFetch(input, init);
      if (!p || typeof p.then !== "function") return p;
      return p.then(
        function (r) {
          if (!server.up && sentDown === server.downs && sameOrigin(input))
            serverBack();
          if (r && r.status === 422 && !configBad && sameOrigin(input))
            r.clone()
              .json()
              .then(function (b) {
                if (b && b.code === "config_invalid") markConfigInvalid();
              })
              .catch(function () {});
          return r;
        },
        function (err) {
          if (err && err.name === "TypeError" && sameOrigin(input))
            serverUnreachable();
          throw err;
        },
      );
    };
    wrapped.__denShell = true;
    window.fetch = wrapped;
    // The token is in hand before the first click needs it.
    if (!apiOffPage) csrfToken(false);
  }

  // ── ON-3: an agent's held write waits for the person ─────────────────
  // (approval-routes.ts) Every page asks GET /api/approvals every few
  // seconds while it is in view, and opens the oldest request: Den's own
  // words for it (the agent's note only quoted), Review (what it will do),
  // Later, Deny, Allow. Allow and Deny go through the wrapped fetch above,
  // so they carry the CSRF token and the approval key; the server decides
  // who may approve (a browser that isn't signed in is told to sign in).
  // The frame is the Start dialog's (persona-ui.css's .pe-dlg).
  var ap = {
    dlg: null,
    shown: null,
    later: {},
    busy: false,
    css: null,
    polling: false,
  };
  function apCss() {
    if (ap.css) return ap.css;
    ap.css = new Promise(function (done) {
      if (document.querySelector('link[href="/persona-ui.css"]')) return done();
      var l = document.createElement("link");
      l.rel = "stylesheet";
      l.href = "/persona-ui.css";
      l.onload = l.onerror = function () {
        done();
      };
      document.head.appendChild(l);
    });
    return ap.css;
  }
  // issue 206: date-times in the person's own zone, from the kit's
  // time.js (a module, loaded once). Until it is in, the browser's Intl
  // with <html data-den-tz> (the person's pick) does the same.
  var kitTime = null;
  try {
    import("/kit/time.js")
      .then(function (m) {
        kitTime = m;
        m.upgradeTimes();
      })
      .catch(function () {});
  } catch (e) {
    /* no modules: the fallback stays */
  }
  function localTime(iso) {
    if (kitTime) return kitTime.formatTime(iso, { style: "time" });
    var d = new Date(iso);
    if (isNaN(d)) return "";
    var root = document.documentElement;
    try {
      return d.toLocaleTimeString(root.lang || undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: root.getAttribute("data-den-tz") || undefined,
      });
    } catch (e) {
      return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    }
  }

  function apWhat(a) {
    var p = a.params || {};
    var key =
      "ap.do." +
      a.action +
      (p.isNew
        ? ".new"
        : p.activates
          ? ".activates"
          : p.inProject
            ? ".project"
            : p.loosens
              ? ".loosens"
              : p.clears
                ? ".clear"
                : "");
    var s = t(key, p);
    if (s !== key) return s;
    s = String(a.summary || a.what || a.action);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
  // Issue 746: the bell words a held write (its Allow row, a lapsed item)
  // as this dialog does, in the page's language.
  window.denApWhat = apWhat;
  // Issue 199: Done, and for a project's mode, which agents follow it now
  // and which keep their own mode.
  function apDoneWords(a, res) {
    var out = [t("ap.done", { what: apWhat(a) })];
    if (res && res.following && res.following.length)
      out.push(t("ap.res.following", { list: res.following.join(", ") }));
    if (res && res.ownMode && res.ownMode.length)
      out.push(
        t("ap.res.own", {
          list: res.ownMode
            .map(function (o) {
              return t("ap.own.item", { agent: o.agent, mode: o.mode });
            })
            .join(", "),
        }),
      );
    return out.join(" ");
  }
  function apDialog() {
    if (ap.dlg) return ap.dlg;
    var d = document.createElement("dialog");
    d.className = "pe-dlg den-ap-dlg";
    d.id = "den-ap-dlg";
    d.setAttribute("aria-labelledby", "den-ap-h");
    d.innerHTML =
      '<form method="dialog">' +
      '<h2 id="den-ap-h"></h2>' +
      '<p class="help den-ap-who" id="den-ap-who" hidden></p>' +
      '<p class="den-ap-what" id="den-ap-what"></p>' +
      '<p class="help" id="den-ap-note" hidden></p>' +
      // Issue 199: agents that won't follow a project's mode, and the
      // person's one choice to make them (off by default).
      '<div class="den-ap-own" id="den-ap-own" hidden>' +
      '<p class="help" id="den-ap-own-h"></p>' +
      '<ul class="den-ap-own-list" id="den-ap-own-list"></ul>' +
      '<label class="den-ap-follow" id="den-ap-follow-row">' +
      '<input type="checkbox" id="den-ap-follow"> ' +
      '<span id="den-ap-follow-l"></span></label>' +
      "</div>" +
      '<pre class="den-ap-det" id="den-ap-det" hidden></pre>' +
      '<p class="help" id="den-ap-waits"></p>' +
      '<p class="err" id="den-ap-err" role="alert" hidden></p>' +
      '<div class="btns">' +
      '<button type="button" class="den-btn" id="den-ap-review" aria-expanded="false" aria-controls="den-ap-det"></button>' +
      '<span class="sp help" id="den-ap-more"></span>' +
      '<button type="button" class="den-btn" id="den-ap-later"></button>' +
      '<button type="button" class="den-btn" id="den-ap-deny"></button>' +
      '<button type="button" class="den-btn primary" id="den-ap-allow"></button>' +
      "</div></form>";
    document.body.appendChild(d);
    var $ = function (id) {
      return d.querySelector("#" + id);
    };
    $("den-ap-review").addEventListener("click", function () {
      var det = $("den-ap-det");
      det.hidden = !det.hidden;
      $("den-ap-review").textContent = t(det.hidden ? "ap.review" : "ap.hide");
      $("den-ap-review").setAttribute("aria-expanded", String(!det.hidden));
    });
    $("den-ap-later").addEventListener("click", function () {
      apLater();
    });
    // Esc is Later: the request keeps waiting (and the agent with it).
    d.addEventListener("cancel", function (e) {
      e.preventDefault();
      apLater();
    });
    $("den-ap-deny").addEventListener("click", function () {
      apDecide("deny");
    });
    $("den-ap-allow").addEventListener("click", function () {
      apDecide("allow");
    });
    ap.dlg = d;
    return d;
  }
  function apLater() {
    if (ap.shown) ap.later[ap.shown.id] = 1;
    apClose();
  }
  function apClose() {
    ap.shown = null;
    if (ap.dlg && ap.dlg.open) ap.dlg.close();
  }
  function apShow(a, more) {
    var d = apDialog();
    var $ = function (id) {
      return d.querySelector("#" + id);
    };
    var same = ap.shown && ap.shown.id === a.id;
    ap.shown = a;
    // No agent token: say so, and what to do if no agent was asked.
    $("den-ap-h").textContent = t("ap.title", {
      agent: a.agent ? t("ap.agent", { name: a.agent }) : t("ap.noAgent"),
    });
    $("den-ap-who").hidden = !!a.agent;
    $("den-ap-who").textContent = a.agent ? "" : t("ap.noAgentWarn");
    $("den-ap-what").textContent = apWhat(a);
    var note = $("den-ap-note");
    note.hidden = !a.note;
    note.textContent = a.note ? t("ap.says") + " “" + a.note + "”" : "";
    $("den-ap-det").textContent = apDetailLines(a).join("\n");
    // Issue 199: the agents that keep their own mode, and the choice.
    var own = a.ownMode || [];
    $("den-ap-own").hidden = !own.length;
    $("den-ap-own-h").textContent = own.length ? t("ap.own.h") : "";
    var ol = $("den-ap-own-list");
    ol.textContent = "";
    own.forEach(function (o) {
      var li = document.createElement("li");
      li.textContent = t("ap.own.item", { agent: o.agent, mode: o.mode });
      ol.appendChild(li);
    });
    var offers = (a.choices || []).indexOf("follow") >= 0;
    $("den-ap-follow-row").hidden = !offers;
    $("den-ap-follow-l").textContent = t("ap.own.follow");
    if (!same) $("den-ap-follow").checked = false;
    $("den-ap-waits").textContent = t("ap.waits", {
      time: localTime(a.expiresAt),
    });
    $("den-ap-more").textContent = more ? t("ap.more", { n: more }) : "";
    $("den-ap-later").textContent = t("ap.later");
    $("den-ap-deny").textContent = t("ap.deny");
    $("den-ap-allow").textContent = t("ap.allow");
    if (!same) {
      $("den-ap-det").hidden = true;
      $("den-ap-review").textContent = t("ap.review");
      $("den-ap-review").setAttribute("aria-expanded", "false");
      $("den-ap-err").hidden = true;
    }
    if (!d.open)
      apCss().then(function () {
        if (ap.shown && ap.shown.id === a.id && !d.open) d.showModal();
      });
  }
  function apError(msg) {
    var e = apDialog().querySelector("#den-ap-err");
    e.textContent = msg;
    e.hidden = false;
  }
  function apDecide(decision) {
    var a = ap.shown;
    if (!a || ap.busy) return;
    ap.busy = true;
    var btns = ap.dlg.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) btns[i].disabled = true;
    // Issue 698: the button pressed shows the kit's dots until the answer.
    var pressed = ap.dlg.querySelector(
      decision === "allow" ? "#den-ap-allow" : "#den-ap-deny",
    );
    var releaseDots =
      window.denShell && window.denShell.holdDots
        ? window.denShell.holdDots(pressed)
        : function () {};
    // Issue 199: the person's choice, sent with Allow only.
    var follow =
      decision === "allow" &&
      (a.choices || []).indexOf("follow") >= 0 &&
      ap.dlg.querySelector("#den-ap-follow").checked;
    fetch("/api/approvals/" + encodeURIComponent(a.id) + "/decide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        follow
          ? { decision: decision, choices: { follow: true } }
          : { decision: decision },
      ),
    })
      .then(function (r) {
        return r.json().then(
          function (b) {
            return { ok: r.ok, b: b || {} };
          },
          function () {
            return { ok: false, b: {} };
          },
        );
      })
      .then(
        function (x) {
          if (!x.ok) {
            apError(x.b.error || t("ap.failed", { error: x.b.code || "?" }));
            return;
          }
          var res = x.b.result;
          if (decision === "allow" && res && res.ok === false)
            toast(t("ap.failed", { error: res.error || "?" }));
          else if (decision === "allow" && res && res.restarting) {
            // SRV-1a: Den restarts now: the in-place wait, as Restart Den.
            apClose();
            (window.denRestart
              ? Promise.resolve(window.denRestart)
              : import("/restart-den.js").then(function (m) {
                  return m.restartDen;
                })
            ).then(function (f) {
              f({ confirm: false, post: false });
            });
            return;
          } else if (
            decision === "allow" &&
            res &&
            res.connect === true &&
            a.action === "hub_connect"
          ) {
            toast(t("ap.hubSwitchSignin", { url: res.url || "" }));
            window.denShell
              .busyAction(
                "connect",
                function (headers) {
                  return api(
                    "POST",
                    "/api/hub/connect",
                    { switch: true },
                    { headers },
                  );
                },
                {
                  button: pressed,
                  onDone: function (r) {
                    location.assign(r.location);
                  },
                  onFail: function (e) {
                    apClose();
                    toast(t("ap.failed", { error: (e && e.message) || "?" }));
                  },
                },
              )
              .catch(function (e) {
                apClose();
                toast(t("ap.failed", { error: (e && e.message) || "?" }));
              });
            return;
          } else if (decision === "allow") toast(apDoneWords(a, res));
          // Issue 334: the page that asked hears what ran (a new app key,
          // in it once: the server forgets it after this answer).
          if (decision === "allow" && res && res.ok !== false)
            window.dispatchEvent(
              new CustomEvent("den:approval-done", {
                detail: { id: a.id, action: a.action, result: res },
              }),
            );
          apClose();
          apPoll();
        },
        function (e) {
          apError(String((e && e.message) || e));
        },
      )
      .then(function () {
        return releaseDots();
      })
      .then(function () {
        ap.busy = false;
        for (var j = 0; j < btns.length; j++) btns[j].disabled = false;
      });
  }
  // Reading what waits needs what approving needs (approvals.ts): the
  // session's CSRF token and the approval key, on a GET too. A browser
  // without them is told only that something waits, and to sign in.
  function apList(fresh) {
    var ak = approveKey();
    // No approval key: only the count, to say "sign in to see it".
    if (!ak)
      return rawFetch("/api/approvals?count=1", {
        cache: "no-store",
        credentials: "same-origin",
      }).then(function (r) {
        return r.ok
          ? r.json().then(function (b) {
              return { code: "signin_to_approve", waiting: b && b.waiting };
            })
          : null;
      });
    return csrfToken(fresh).then(function (token) {
      var h = { "X-Den-Approve-Key": ak };
      if (token) h["X-Den-CSRF"] = token;
      return rawFetch("/api/approvals", {
        cache: "no-store",
        credentials: "same-origin",
        headers: h,
      }).then(function (r) {
        return r.json().then(
          function (b) {
            if (!fresh && r.status === 403 && b && b.code === "csrf")
              return apList(true);
            return b;
          },
          function () {
            return null;
          },
        );
      });
    });
  }
  function apSignin(b) {
    if (b && b.code === "signin_to_approve" && b.waiting > 0)
      // D67: a Sign in button, to Den's own sign-in page (GitHub, or a
      // code another signed-in browser allows); back here after it. The
      // command line is only under its Other ways.
      showBanner("approvals", {
        title: t("ap.signin.title"),
        text: t("ap.signin"),
        action: {
          label: t("ap.signin.btn"),
          run: function () {
            location.assign(
              "/signin?again=1&next=" +
                encodeURIComponent(
                  location.pathname + location.search + location.hash,
                ),
            );
          },
        },
      });
    else hideBanner("approvals");
  }
  // Issue 334: a page that just asked (Settings › Embedding) opens the
  // dialog now, not at the next poll.
  window.addEventListener("den:approvals-poll", function () {
    apPoll();
  });
  function apPoll() {
    // Issue 796: an agent's read-only view never opens the person's asks.
    if (VIEW) return;
    // One ask at a time: a tick while the last is still open sends none.
    if (document.hidden || ap.busy || ap.polling) return;
    ap.polling = true;
    apList(false).then(
      function (b) {
        ap.polling = false;
        apSignin(b);
        var list = (b && b.ok && b.pending) || [];
        var open = list.filter(function (a) {
          return !ap.later[a.id];
        });
        if (!open.length) return apClose();
        var cur =
          (ap.shown &&
            open.filter(function (a) {
              return a.id === ap.shown.id;
            })[0]) ||
          open[0];
        apShow(cur, open.length - 1);
      },
      function () {
        ap.polling = false;
      },
    );
  }
  // D67: another computer's signed-out page shows a code and asks to be
  // let in: a signed-in browser asks "Allow this computer?" here
  // (Settings › Access lists them too). Issue 819: the person types the
  // code that computer's screen shows; it is never shown here. Not signed
  // in, the list is refused and nothing shows.
  var pr = { dlg: null, shown: null, later: {}, polling: false, off: false };
  // Issue 819: a typed code as the server reads it (any case, spaces and
  // dashes ignored); Allow once it has six characters.
  function prTyped(v) {
    return String(v == null ? "" : v)
      .toUpperCase()
      .replace(/[\s-]/g, "");
  }
  function prAge(w) {
    var m = Math.floor((Date.now() - Date.parse(w.createdAt)) / 60000);
    return !isFinite(m) || m < 1 ? t("pair.ageNow") : t("pair.age", { n: m });
  }
  function prWhen(w) {
    var parts = [prAge(w)];
    // The person's chosen time zone (localTime: the kit's, or its fallback).
    var at = w.fromLogin ? localTime(w.fromLogin) : "";
    if (at) parts.push(t("pair.fromLogin", { time: at }));
    return parts.join(" ");
  }
  function prDialog() {
    if (pr.dlg) return pr.dlg;
    var d = document.createElement("dialog");
    d.className = "pe-dlg den-ap-dlg";
    d.id = "den-pair-dlg";
    d.setAttribute("aria-labelledby", "den-pair-h");
    d.innerHTML =
      '<form method="dialog" autocomplete="off">' +
      '<h2 id="den-pair-h"></h2>' +
      '<p class="den-ap-what" id="den-pair-what"></p>' +
      '<p class="help" id="den-pair-from"></p>' +
      '<p class="help" id="den-pair-when"></p>' +
      '<p class="help den-ap-who" id="den-pair-unexpected"></p>' +
      // Issue 1333: an empty box with a visible edge, and no example code
      // in it (a grey "K7Q-42M" read as the code itself).
      '<label for="den-pair-code-in" id="den-pair-code-label" style="display:block;font-weight:600;margin-top:8px"></label>' +
      '<input id="den-pair-code-in" class="den-pair-code" autocomplete="off" spellcheck="false" autocapitalize="characters" maxlength="12" ' +
      'style="display:block;font:600 22px var(--mono);letter-spacing:.08em;width:10ch;margin:4px 0 0;padding:4px 8px;border:1px solid var(--line-strong, var(--line, currentColor));border-radius:6px;background:var(--bg, transparent);color:inherit">' +
      '<p class="help" id="den-pair-help"></p>' +
      '<p class="err" id="den-pair-err" role="alert" hidden></p>' +
      '<div class="btns">' +
      '<span class="sp"></span>' +
      '<button type="button" class="den-btn" id="den-pair-later"></button>' +
      '<button type="button" class="den-btn" id="den-pair-deny"></button>' +
      '<button type="button" class="den-btn primary" id="den-pair-allow" disabled></button>' +
      "</div></form>";
    document.body.appendChild(d);
    var input = d.querySelector("#den-pair-code-in");
    var allow = d.querySelector("#den-pair-allow");
    var sync = function () {
      allow.disabled = prTyped(input.value).length !== 6;
    };
    input.addEventListener("input", sync);
    var later = function () {
      if (pr.shown) pr.later[pr.shown.ref] = true;
      pr.shown = null;
      if (d.open) d.close();
    };
    d.querySelector("#den-pair-later").addEventListener("click", later);
    d.addEventListener("cancel", function (e) {
      e.preventDefault();
      later();
    });
    var decide = function (verb) {
      var w = pr.shown;
      if (!w) return;
      var err = d.querySelector("#den-pair-err");
      var body =
        verb === "approve"
          ? { ref: w.ref, code: prTyped(input.value) }
          : { ref: w.ref };
      // Issue 1054: the pressed button shows the kit's dots until the answer.
      var release = window.denShell.holdDots(
        d.querySelector(
          verb === "approve" ? "#den-pair-allow" : "#den-pair-deny",
        ),
      );
      api("POST", "/api/web/" + verb, body)
        .then(
          function (x) {
            release();
            return x;
          },
          function (e) {
            release();
            throw e;
          },
        )
        .then(
          function () {
            pr.shown = null;
            if (d.open) d.close();
            if (verb === "approve") toast(t("pair.allowed"));
          },
          function (e) {
            // Issue 320: a request that ended (its page withdrew it, or it
            // expired or was used): nothing happened, said plainly. Only
            // Close stays.
            var code = e && e.code;
            var gone =
              code === "ended" || code === "unknown"
                ? t("pair.ended")
                : code === "expired"
                  ? t("pair.expired")
                  : "";
            // Issue 819: only a person's signed-in browser approves a device,
            // with the code its screen shows.
            var who =
              code === "approve_not_agent" || code === "fixture_cannot_approve"
                ? t("set.access.approveNotAgent")
                : code === "approve_needs_browser" ||
                    code === "signin_to_approve"
                  ? t("set.access.approveNeedsBrowser")
                  : code === "wrong" || code === "malformed"
                    ? t("pair.wrong")
                    : code === "rate_limited"
                      ? t("pair.busy")
                      : "";
            err.textContent = gone || who || (e && e.message) || String(e);
            err.hidden = false;
            if (gone) {
              allow.hidden = true;
              input.hidden = true;
              d.querySelector("#den-pair-code-label").hidden = true;
              d.querySelector("#den-pair-deny").hidden = true;
              d.querySelector("#den-pair-later").textContent = t("pair.close");
            } else if (verb === "approve") {
              input.focus();
              input.select();
            }
          },
        );
    };
    d.querySelector("#den-pair-deny").addEventListener("click", function () {
      decide("deny");
    });
    allow.addEventListener("click", function () {
      decide("approve");
    });
    // Enter in the code field approves (never closes the dialog).
    d.querySelector("form").addEventListener("submit", function (e) {
      e.preventDefault();
      if (!allow.disabled && !allow.hidden) decide("approve");
    });
    pr.dlg = d;
    return d;
  }
  function prShow(w) {
    var d = prDialog();
    var $ = function (id) {
      return d.querySelector("#" + id);
    };
    pr.shown = w;
    $("den-pair-h").textContent = t("pair.title");
    $("den-pair-what").textContent = t("pair.what", {
      device: w.device || t("pair.aDevice"),
      // 0.4.71: a request from this machine says so, never a bare
      // 127.0.0.1: a person sees where it came from before Allow.
      client: /^(127\.|::1$|::ffff:127\.)/.test(String(w.client || ""))
        ? t("pair.local")
        : w.client || "",
    });
    // Issue 1333: where it came from (its address, and mesh name when it
    // has one), the Den address it opened, and when.
    var addr = w.client || t("pair.unknownAddr");
    var time = localTime(w.createdAt) || "";
    $("den-pair-from").textContent = w.clientName
      ? t("pair.fromNamed", {
          name: w.clientName,
          client: addr,
          host: w.host || location.host,
          time: time,
        })
      : t("pair.from", {
          client: addr,
          host: w.host || location.host,
          time: time,
        });
    $("den-pair-unexpected").textContent = t("pair.unexpected");
    $("den-pair-when").textContent = prWhen(w);
    $("den-pair-code-label").textContent = t("pair.codeLabel");
    $("den-pair-code-label").hidden = false;
    $("den-pair-code-in").value = "";
    $("den-pair-code-in").hidden = false;
    $("den-pair-help").textContent = t("pair.help");
    $("den-pair-err").hidden = true;
    $("den-pair-later").textContent = t("ap.later");
    $("den-pair-deny").textContent = t("ap.deny");
    $("den-pair-allow").textContent = t("pair.allow");
    $("den-pair-deny").hidden = false;
    $("den-pair-allow").hidden = false;
    $("den-pair-allow").disabled = true;
    if (!d.open) d.showModal();
    // Issue 1333: Deny first; Allow waits for a typed code.
    $("den-pair-deny").focus();
  }
  function prPoll() {
    // One ask at a time; refused once (a session that may not read it, as
    // a test install's fixture person), never again on this page.
    if (document.hidden || pr.polling || pr.off) return;
    // One question at a time: an approval's dialog first.
    if (ap.dlg && ap.dlg.open) return;
    pr.polling = true;
    rawFetch("/api/web/waiting", {
      cache: "no-store",
      credentials: "same-origin",
      // An ask that never answers frees the next tick after 20 s.
      signal:
        typeof AbortSignal !== "undefined" && AbortSignal.timeout
          ? AbortSignal.timeout(20000)
          : undefined,
    })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) pr.off = true;
        return r.ok ? r.json() : null;
      })
      .then(
        function (b) {
          pr.polling = false;
          // Never this browser's own request (it signed in another way).
          var own = "";
          try {
            own = sessionStorage.getItem("den-pair-mine") || "";
          } catch (e) {
            /* no storage */
          }
          var now = Date.now();
          // Issue 819: a request past its time is dropped (the server
          // refuses it too). The server lists a link's, then the newest.
          var list = ((b && b.waiting) || []).filter(function (w) {
            return (
              w &&
              w.ref &&
              w.ref !== own &&
              !pr.later[w.ref] &&
              !(w.expiresAt && Date.parse(w.expiresAt) <= now)
            );
          });
          if (!list.length) {
            pr.shown = null;
            if (pr.dlg && pr.dlg.open) pr.dlg.close();
            return;
          }
          var same =
            pr.shown &&
            list.filter(function (w) {
              return w.ref === pr.shown.ref;
            })[0];
          if (same) {
            // Still waiting: only its age changes; the typed code stays.
            if (pr.dlg)
              pr.dlg.querySelector("#den-pair-when").textContent = prWhen(same);
            return;
          }
          prShow(list[0]);
        },
        function () {
          pr.polling = false;
        },
      );
  }
  if (!apiOffPage && !configBad && rawFetch) {
    setInterval(apPoll, 3000);
    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) apPoll();
    });
    setTimeout(apPoll, 300);
    setInterval(prPoll, 3000);
    setTimeout(prPoll, 600);
  }

  // ── the UI language (R19): a user pref ───────────────────────────────
  // /api/settings `language` (user.yml), then a reload: the server serves
  // every page with that language's catalog from its first paint.
  function setLanguage(l) {
    if (l === lang) return Promise.resolve(false);
    // busy-ok: picked from a menu that has closed; the page reloads in it
    return api("POST", "/api/settings", { language: l }).then(function () {
      location.reload();
      return true;
    });
  }
  // The tab's title names the page in the page's language.
  (function () {
    var label = page === SETTINGS.id ? SETTINGS.label : null;
    NAV.forEach(function (n) {
      if (n.id === page) label = n.label;
    });
    var title = String(document.title || "");
    var at = title.lastIndexOf(" · ");
    if (label && at >= 0)
      document.title = title.slice(0, at) + " · " + t(label);
  })();

  // D32: the rail's Agents badge on every page: helpers running now
  // (GET /api/sessions/helpers, a count). The Agents page sets it itself
  // from its own list. Quiet on any failure: the badge just isn't there.
  (function () {
    // Issue 482: the Terminals page is the same page (agents-page.js).
    if (
      page === "agents" ||
      page === "terminal" ||
      typeof rawFetch !== "function"
    )
      return;
    function poll() {
      // A refusal page or a bad config: no polls (each would be refused).
      if (configInvalid()) return;
      if (document.hidden) return void setTimeout(poll, 15000);
      rawFetch("/api/sessions/helpers", {
        cache: "no-store",
        credentials: "same-origin",
      })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(
          function (b) {
            var n = b && typeof b.running === "number" ? b.running : 0;
            if (n !== state.helpersRunning) setState({ helpersRunning: n });
            var w = b && typeof b.needs === "number" ? b.needs : 0;
            if (w !== state.agentsNeedYou) setState({ agentsNeedYou: w });
          },
          function () {},
        )
        .then(function () {
          setTimeout(poll, 15000);
        });
    }
    setTimeout(poll, 1500);
  })();

  // The rail's Hub link (hubItem): GET /api/hub?rail=1 (which leaves
  // Connect's one-time result for Settings) at load and every minute while
  // the page shows. Quiet on any failure: the link just isn't there.
  (function () {
    if (typeof rawFetch !== "function") return;
    var last = "";
    function poll() {
      // A refusal page or a bad config: no polls (each would be refused).
      if (configInvalid()) return;
      if (document.hidden) return void setTimeout(poll, 60000);
      rawFetch("/api/hub?rail=1", {
        cache: "no-store",
        credentials: "same-origin",
      })
        .then(function (r) {
          return r.ok ? r.json() : null;
        })
        .then(
          function (b) {
            var h =
              b && b.configured
                ? {
                    configured: true,
                    state: b.state,
                    url: b.url,
                    team: b.team,
                    teamUrl: b.teamUrl,
                    unread: b.unread,
                    // Issue 406: who Hub says this is, for the account entry.
                    login: b.login,
                    name: b.name,
                  }
                : null;
            var k = JSON.stringify(h);
            if (k !== last) {
              last = k;
              setState({ hub: h });
              // Issue 646: pages that name the company (a project's Hub
              // chip) redraw from it.
              try {
                window.dispatchEvent(new CustomEvent("den:hub", { detail: h }));
              } catch (e) {
                /* none */
              }
            }
          },
          function () {},
        )
        .then(function () {
          setTimeout(poll, 60000);
        });
    }
    setTimeout(poll, 800);
  })();

  /**
   * FB (den#81): the Report button for a dialog's, drawer's or popover's
   * footer (Ward: visible in every pop-up, never only in a menu): the flat
   * speech bubble, the word, ⌘⇧F (phones hide it). A click anywhere on a
   * [data-den-report] opens Report an issue over the pop-up, which stays.
   */
  function reportButton(inFoot, inTop) {
    if (state.reportOff) return "";
    return DUI.reportButtonHtml({ inFoot: inFoot, inTop: inTop, lang: lang });
  }
  /**
   * issue 143: a pop-up's own Report footer, for one that draws or repaints
   * itself after it shows: drawn with it, it is there at once and stays
   * through a repaint (the injector's comes a frame late and is wiped).
   */
  /**
   * Issue 274: the working pop-up's code (busy-den.js, the kit's busy.js),
   * one load per page. It loads while the page is idle after it opens, so
   * a person's first action sends its request at once, not after a
   * download; a failed load is tried again on the next action.
   */
  var busyMod = null;
  /**
   * Issue 1434: hold a button at once, as the kit does (aria-busy and
   * aria-disabled, never disabled, which drops focus to <body>). True when
   * the aria-disabled is the hold's own.
   */
  function preHold(b) {
    var own = b.getAttribute("aria-disabled") !== "true";
    b.setAttribute("aria-busy", "true");
    b.setAttribute("aria-disabled", "true");
    return own;
  }
  /** Issue 1434: a click on a held button stops here, before the page's. */
  window.addEventListener(
    "click",
    function (e) {
      for (var n = e.target; n && n.getAttribute; n = n.parentNode)
        if (
          n.getAttribute("aria-busy") === "true" &&
          n.getAttribute("aria-disabled") === "true"
        ) {
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
    },
    true,
  );
  function loadBusy() {
    if (!busyMod)
      busyMod = import("/busy-den.js").catch(function (err) {
        busyMod = null;
        throw err;
      });
    return busyMod;
  }
  function warmBusy() {
    loadBusy().catch(function () {
      /* the action that needs it loads it again */
    });
  }
  if (typeof window.requestIdleCallback === "function")
    window.requestIdleCallback(warmBusy, { timeout: 1500 });
  else setTimeout(warmBusy, 500);

  function reportFoot() {
    var b = reportButton();
    return b ? '<div class="den-rb-foot">' + b + "</div>" : "";
  }
  document.addEventListener("click", function (e) {
    var b =
      e.target && e.target.closest
        ? e.target.closest("[data-den-report]")
        : null;
    if (!b) return;
    e.preventDefault();
    openReport();
  });

  /** FB (den#81): the Report an issue dialog (the kit's, through report-den.js). */
  function openReport(opts) {
    if (state.reportOff) return Promise.resolve(null);
    return import("/report-den.js").then(function (m) {
      return m.openReport(opts || {});
    });
  }
  // FB (den#81): every dialog, drawer and popover gets the Report button
  // in its footer (report-inject.js), kept apart from the form.
  if (typeof MutationObserver === "function")
    import("/report-inject.js")
      .then(function (m) {
        m.startReportInjector({
          button: reportButton,
          off: function () {
            return !!state.reportOff;
          },
        });
      })
      .catch(function () {
        /* the rail's and the shortcut's Report still work */
      });
  registerCommand({
    id: "report",
    label: function () {
      return t("fb.palette");
    },
    keywords: ["report", "feedback", "bug", "issue"],
    run: function () {
      openReport();
    },
  });
  // My reports: the person's reports live from GitHub, and the drafts.
  function openMyReports() {
    if (state.reportOff) return Promise.resolve(null);
    return import("/report-den.js").then(function (m) {
      return m.openMyReports();
    });
  }
  registerCommand({
    id: "my-reports",
    label: function () {
      return t("fb.mine");
    },
    keywords: ["my reports", "reports", "drafts", "feedback", "replies"],
    run: function () {
      openMyReports();
    },
  });

  window.denShell = {
    /** Issue 646: the rail's Hub status (team, url, state), or null. */
    hub: function () {
      return state.hub;
    },
    /** FB (den#81): opens Report an issue (opts.draft: one to finish). */
    report: openReport,
    /** FB: My reports (the person's reports and the drafts). */
    myReports: openMyReports,
    /**
     * FB: the footer Report button's HTML ("" when reports are off);
     * reportButton(true): first in a pop-up's own button row (issue 143).
     */
    reportButton: reportButton,
    /** issue 143: that button in a footer of its own ("" when off). */
    reportFoot: reportFoot,
    /**
     * UK-2: the working pop-up for a slow action, the kit's (busy-den.js
     * names Den's actions): busyAction(name, run(headers), opts).
     */
    busyAction: function (name, run, opts) {
      // Held at once, before the kit has loaded (issue 1434: aria-disabled,
      // not disabled, so it keeps focus; the click guard stops its clicks).
      var b = opts && opts.button;
      var own = b ? preHold(b) : false;
      return loadBusy().then(
        function (m) {
          return m.busyAction(name, run, opts);
        },
        function (err) {
          // The kit didn't load: let the button go, then fail as before.
          if (b) {
            b.removeAttribute("aria-busy");
            if (own) b.removeAttribute("aria-disabled");
          }
          throw err;
        },
      );
    },
    /**
     * Issue 698: the kit's pulsing dots alone, no pop-up, for a wait that
     * says its own words (a stream, a form with its own error line).
     * holdDots(button) holds it at once; it returns release(), which gives
     * the label back (a label the page drew meanwhile stays).
     */
    holdDots: function (button) {
      if (!button) return function () {};
      var own = preHold(button);
      var held = loadBusy()
        .then(function (m) {
          m.holdDots(button, true);
          return m;
        })
        .catch(function (err) {
          // Never silent (issue 1054: a missing export hid a row's dots);
          // the button is still let go on release.
          console.error("holdDots", err);
          return null;
        });
      return function () {
        return held.then(function (m) {
          if (m) m.holdDots(button, false);
          else {
            button.removeAttribute("aria-busy");
            if (own) button.removeAttribute("aria-disabled");
          }
        });
      };
    },
    /**
     * Issue 1054: a row that waits for its save (a drag): the kit's dots
     * at its end and aria-busy; it returns release().
     */
    holdRow: function (row) {
      if (!row) return function () {};
      row.setAttribute("aria-busy", "true");
      var held = loadBusy()
        .then(function (m) {
          m.holdRow(row, true);
          return m;
        })
        .catch(function (err) {
          // Never silent (issue 1054: a missing export hid a row's dots);
          // the row is still let go on release.
          console.error("holdRow", err);
          return null;
        });
      return function () {
        return held.then(function (m) {
          if (m) m.holdRow(row, false);
          else row.removeAttribute("aria-busy");
        });
      };
    },
    /** Light rail item `id` for this page (null: the page's own). */
    setRailLit: function (id) {
      var next = id || page;
      if (next === railLit) return;
      railLit = next;
      renderRail();
    },
    registerGroup: registerGroup,
    registerNav: registerNav,
    addMessages: function (l, msgs) {
      MESSAGES[l] = Object.assign({}, MESSAGES[l] || {}, msgs || {});
      renderRail(true);
    },
    t: t,
    tr: tr,
    localize: localize,
    /** R19: the page's language, the ones with a catalog, and a switch. */
    lang: function () {
      return lang;
    },
    languages: function () {
      return LANGUAGES.slice();
    },
    setLanguage: setLanguage,
    /** A number in the page's language (Intl.NumberFormat options). */
    formatNumber: num,
    setState: setState,
    getState: function () {
      return state;
    },
    pin: pin,
    unpin: unpin,
    isPinned: isPinned,
    /** Issue 168: a project's colour name (null: none, or not known yet). */
    projectColour: function (slug) {
      return Object.prototype.hasOwnProperty.call(projectColourMap, slug)
        ? projectColourMap[slug]
        : null;
    },
    toast: toast,
    toastAction: toastAction,
    /** R26c: a call that resolves with its data or throws a DenApiError. */
    api: api,
    /** R26c: the error toast for a DenApiError (what an uncaught one gets). */
    errorToast: errorToast,
    /** A banner at the top of the content: { title?, text, note?, action? }. */
    showBanner: showBanner,
    hideBanner: hideBanner,
    /** MD-2: { stale, loaded, onDisk, message? } from /api/server-info. */
    setEngine: setEngine,
    /** R26d: whether the server answers (false while the banner shows). */
    serverUp: function () {
      return server.up;
    },
    /**
     * 0.4.1: true once the config is known to fail validation, or on a
     * refusal page (apiOff): the config polls and streams don't start.
     */
    configInvalid: configInvalid,
    /** SEC-1b: a refusal page (421, signed out): no /api call would answer. */
    apiOff: apiOff,
    /** The browser-tab icon (appearance.js: the active theme's, per mode). */
    setFavicon: setFavicon,
    /** The org part of the scope: "/ ORG <title>", static (one org). */
    setOrg: setOrg,
    setOrgs: setOrgs,
    setWorkspaces: setWorkspaces,
    workspaceNames: workspaceNames,
    // D51: Hub's link for ⌘K (null: none set up).
    hubLink: hubLink,
    /** Repaint the Env part from #env-sel (after setting its value). */
    syncEnv: syncEnv,
    syncPinToggles: pinToggles,
    registerCommand: registerCommand,
    unregisterCommand: unregisterCommand,
    commands: commands,
    /** A .pop menu below `anchor` (the model as the scope menus'). */
    openMenu: openMenu,
    /**
     * The top layer (0.4.17): show(el, anchor, { align: "left"|"right",
     * gap }) puts a page's own menu above everything, placed by its
     * anchor; hide(el). The page hiding it (display: none) closes it too.
     */
    topLayer: { show: topShow, hide: topHide },
    /**
     * 0.4.18: the service panel. svc-panel.js registers { open, close,
     * visit }; openServicePanel(id, opener) opens it beside opener.
     */
    setServicePanel: setServicePanel,
    openServicePanel: function (id, opener) {
      if (servicePanel) servicePanel.open(id, opener);
    },
    closeMenu: function () {
      closeMenu(false);
    },
    groups: function () {
      return GROUPS.slice().sort(byOrder);
    },
    nav: function () {
      return NAV.slice();
    },
    /**
     * Every page the rail can lead to (issue 297): the NAV registry, hidden
     * and conditional pages included, then Settings. { id, href } each.
     */
    pages: function () {
      return NAV.map(function (n) {
        return { id: n.id, href: n.href };
      }).concat([{ id: SETTINGS.id, href: SETTINGS.href }]);
    },
    /** NAV in the rail's order (groups, then your order), hidden included. */
    orderedNav: orderedNav,
    setNavPrefs: setNavPrefs,
    setPins: setPins,
    setCollapsed: setCollapsed,
    setDock: setDock,
    /** The runs dock (R16): every page's output, one path. */
    runs: runsApi,
    /** The page header (R20): { el, h1, sub, act, tabs(spec), setSub }, or null. */
    pageHeader: pageHeader,
    /** Wire a role=tablist as WAI-ARIA tabs (roving tabindex, keys, panels). */
    wireTabs: wireTabs,
    registerSettingsCategory: registerSettingsCategory,
    registerSetting: registerSetting,
    settings: function () {
      return SETTING_ROWS.slice();
    },
    settingsCategories: function () {
      return SETTING_CATS.slice().sort(byOrder);
    },
  };

  // The ready path for a script that loads before shell.js:
  // window.denShellQueue is an array of functions, each called with
  // denShell once it exists (now); a later push runs at once. Then
  // `den-shell:ready` fires on window.
  var queued = Array.isArray(window.denShellQueue) ? window.denShellQueue : [];
  function runQueued(fn) {
    if (typeof fn !== "function") return;
    try {
      fn(window.denShell);
    } catch (err) {
      warn("a denShellQueue function threw: " + (err && err.message));
    }
  }
  window.denShellQueue = {
    push: function () {
      for (var i = 0; i < arguments.length; i++) runQueued(arguments[i]);
      return 0;
    },
    length: 0,
  };
  queued.forEach(runQueued);
  try {
    window.dispatchEvent(
      new CustomEvent("den-shell:ready", { detail: window.denShell }),
    );
  } catch (e) {
    /* no CustomEvent: the queue still ran */
  }
  // The queue has drained and ready has fired: a page still without its
  // group (or a setting without its category) a tick from now warns.
  settled = true;
  checkOrphansSoon();

  // The server's prefs win over the local copy.
  if (typeof fetch === "function" && !apiOff())
    fetch("/api/settings")
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (s) {
        if (s && s.feedback_enabled === false) setState({ reportOff: true });
        if (!s || !s.shell) return;
        setState({
          pinList: pinTuples(s.shell.pins),
          pinsLoaded: true,
          collapsed: s.shell.collapsed === true,
          hidden: Array.isArray(s.shell.hidden) ? s.shell.hidden : [],
          order: Array.isArray(s.shell.order) ? s.shell.order : [],
          folded: Array.isArray(s.shell.folded) ? s.shell.folded : [],
          dock: s.shell.dock === true,
          dockHeight:
            typeof s.shell.dockHeight === "number" ? s.shell.dockHeight : 0,
        });
        remember();
        dockFromPrefs();
      })
      .catch(function () {});

  // The Edge page shows once the edge is configured (no Docker asked).
  if (typeof fetch === "function" && !configInvalid())
    fetch("/api/edge?probe=1")
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (e) {
        if (!e) return;
        setState({ edge: e.configured === true });
        remember();
      })
      .catch(function () {});

  // Den's own parts of the frame (the kit's shell.css, linked in each
  // page's <head>, has the bar, the rail and the drawer): the scope, the
  // search, the chips, menus, the page header, the toast, the banners,
  // the status drawer, the palette, the service panel and the runs dock.
  var style = document.createElement("style");
  style.id = "den-shell-styles";
  style.textContent = [
    // The scope crumbs, the ⌘K search, the bell and ◐ ▾ are the kit's
    // (den-ui 0.7.0, shell.css): Den keeps only what it puts in them.
    // Menus (.pop, .ml, .mi, .hr: R18)
    ".den-pop { position: fixed; z-index: 45; background: var(--raised); border: 1px solid var(--border-strong);",
    "  border-radius: 10px; box-shadow: var(--shadow); padding: 6px; min-width: 220px;",
    "  max-height: calc(100vh - 72px); overflow-y: auto; box-sizing: border-box;",
    "  font: 14px/1.45 var(--sans); color: var(--text); }",
    ".den-pop:focus { outline: none; }",
    // The top layer (0.4.17): a page's menu placed by its anchor (topShow), not
    // where the UA puts a popover.
    // No inset here: top and left are topPlace's (an !important inset beat them,
    // and every menu sat at the window's corner, 0.4.17-dev.0).
    ".den-toplayer { position: fixed !important; margin: 0 !important;",
    "  right: auto !important; bottom: auto !important; z-index: 1000; overflow-y: auto;",
    "  color: var(--text); }",
    // LK-1: the admin-password prompt is a <dialog> in the top layer (a popover, or
    // a modal over another modal): placed by its top/left, no UA box.
    // D68: every other modal dialog centred, as the browser centres it: a
    // page's `* { margin: 0 }` reset took away the UA's margin: auto, and
    // the dialog sat in the window's top-left corner. One rule, every page.
    "dialog:modal:not(.den-pop):not(.den-toplayer) { margin: auto; }",
    "dialog.den-pop { margin: 0; inset: auto; max-width: none; }",
    "dialog.den-pop::backdrop { background: transparent; }",
    ".den-pop :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
    ".den-pop .den-ml { font: 11px var(--mono); color: var(--faint); text-transform: uppercase;",
    "  letter-spacing: .07em; padding: 6px 8px 2px; }",
    ".den-pop .den-mi { display: flex; width: 100%; align-items: center; gap: 8px; background: none;",
    "  border: 0; padding: 6px 8px; border-radius: 6px; cursor: pointer; text-align: left;",
    "  font: inherit; color: inherit; text-decoration: none; box-sizing: border-box; }",
    ".den-pop .den-mi:hover, .den-pop .den-mi:focus { background: var(--sunken); }",
    // The ✓ is drawn, not read (aria-checked says it): alt text "".
    ".den-pop .den-mi[aria-checked='true']::after { content: '✓' / ''; margin-left: auto; color: var(--accent-text); }",
    ".den-pop .den-mi-l { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".den-pop .den-mtag { font: 11px var(--mono); color: var(--muted); }",
    ".den-pop .den-hr { height: 1px; background: var(--border); margin: 6px 0; }",
    // The page's one main landmark (#den-content) holds all its content
    // and lays it out as the body did (a column), so pages keep their look.
    // Issue 283: positioned, so what a page places absolutely inside it
    // (a visually hidden label, .den-sr) stays in it rather than
    // stretching the document past the window.
    "body.den-has-shell > #den-content { display: flex; flex-direction: column; flex: 1 1 auto;",
    "  min-height: 0; min-width: 0; position: relative; }",
    "body.den-has-shell > #den-content:focus { outline: none; }",
    // The page header (.ph, R20, 0.3.0-dev.32), the prototype's sizes: it
    // sits in .main's 20px/24px inset (pages keep their own content
    // full-bleed below it). .ptabs are the page tabs below it.
    "#den-content > .den-ph { display: flex; align-items: flex-end; gap: 16px; flex-wrap: wrap;",
    "  flex: none; margin: 0 0 16px; padding: 20px 24px 0; font: 14px/1.45 var(--sans); color: var(--text); box-sizing: border-box; }",
    ".den-ph h1 { font: 600 22px/1.2 var(--display); margin: 0; padding: 0; text-wrap: balance; color: var(--text); }",
    ".den-ph .sub { color: var(--muted); font-size: 13px; margin: 4px 0 0; padding: 0; min-height: 1.45em; }",
    ".den-ph .act { margin-left: auto; display: flex; gap: 8px; }",
    ".den-ph [hidden], .den-ptabs[hidden], [role='tabpanel'][hidden] { display: none !important; }",
    ".ptabs.den-ptabs { flex: none; margin: 0 24px 18px; }",
    ".ptabs { display: flex; gap: 2px; border-bottom: 1px solid var(--border); overflow-x: auto; }",
    ".ptabs [role='tab'] { background: none; border: 0; padding: 8px 12px; color: var(--muted); cursor: pointer;",
    "  border-bottom: 2px solid transparent; margin: 0 0 -1px; white-space: nowrap; font: inherit; font-size: 14px;",
    "  line-height: 1.45; text-decoration: none; }",
    ".ptabs [role='tab']:hover { color: var(--text); }",
    ".ptabs [role='tab'][aria-selected='true'] { color: var(--text); border-bottom-color: var(--accent); font-weight: 500; }",
    // The key caps (⌘K, Report's ⌘⇧F) are the kit's (.den-kbd, den-ui 0.7.0).
    ".den-chip { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--border);",
    "  border-radius: 999px; padding: 3px 10px; background: var(--surface); cursor: pointer; font: inherit;",
    "  font-size: 13px; white-space: nowrap; flex-shrink: 0; color: var(--text); }",
    ".den-chip:hover { border-color: var(--border-strong); }",
    ".den-chip.bad { border-color: color-mix(in srgb, var(--bad) 50%, var(--border)); }",
    ".den-chip .den-n { font-variant-numeric: tabular-nums; }",
    ".den-chip .den-dot, .den-drawer .den-dot, .den-pal .den-dot { margin: 0; }",
    ".den-chip[aria-expanded='true'] { border-color: var(--border-strong); }",
    ".den-chip[hidden] { display: none; }",
    // The bell's own rows (its button, badge, panel, heading, plain rows and
    // empty state are the kit's, den-ui 0.7.0).
    ".den-bell-sc button { font: inherit; font-size: 12px; background: none; border: 0;",
    "  color: var(--accent-text); cursor: pointer; padding: 2px 4px; }",
    // "Mark read" as "Mark all read": not the scope line's mono capitals.
    ".den-bell-sc button { font: 500 12px var(--sans); text-transform: none; letter-spacing: normal; }",
    ".den-bell-sc { display: flex; align-items: center; padding: 8px 12px 2px; color: var(--muted);",
    "  font: 11px var(--mono); text-transform: uppercase; letter-spacing: .04em; }",
    ".den-bell-sc span { flex: 1; }",
    ".den-tlink { color: var(--accent-text); }",
    // Bell v6: a long question's two lines, ×N repeats, Older, the ⊘ ask.
    ".den-bell-t { flex: 1; min-width: 0; overflow-wrap: anywhere; }",
    // Issue 167: the pick item's line under its title.
    ".den-bell-sub { display: block; margin-top: 2px; color: var(--muted); font-size: 12.5px; }",
    // Issue 746: the Allow row's Review, and the lines it opens.
    ".den-bell-rv { display: inline; font: 500 12.5px var(--sans); background: none; border: 0;",
    "  color: var(--accent-text); cursor: pointer; padding: 4px 0; margin-top: 2px; }",
    ".den-bell-det { display: block; margin-top: 4px; padding: 6px 8px; border-radius: 6px;",
    "  background: var(--surface-2, var(--surface)); border: 1px solid var(--border);",
    "  color: var(--text); font-size: 12.5px; }",
    ".den-bell-det[hidden] { display: none; }",
    // Allow and Deny stay put when Review opens: the row keeps to its top,
    // on a phone too (the kit centers a phone's rows).
    ".den-bell-row.den-bell-allow { align-items: flex-start; }",
    ".den-bell-detl { overflow-wrap: anywhere; }",
    // Issue 110 (mock v3): a Coach Apply's card: Change, Why, Reversible,
    // then Allow and Deny; on a phone they are full width, 44 px, stacked.
    ".den-bell-cdl { display: grid; grid-template-columns: auto 1fr; gap: 4px 10px; margin: 8px 0 0; font-size: 12.5px; }",
    ".den-bell-cr { display: contents; }",
    ".den-bell-cdl dt { color: var(--muted); }",
    ".den-bell-cdl dd { margin: 0; overflow-wrap: anywhere; }",
    ".den-bell-cb { display: flex; gap: 6px; flex-shrink: 0; }",
    "@media (max-width: 600px) { .den-bell-row.den-bell-coach { flex-wrap: wrap; }",
    "  .den-bell-coach .den-bell-cb { flex-direction: column; width: 100%; }",
    "  .den-bell-coach .den-bell-cb .den-btn { width: 100%; min-height: 44px; } }",
    // A phone's finger needs 44 px to hit Review.
    "@media (max-width: 600px) { .den-bell-rv { display: inline-flex; align-items: center; min-height: 44px; padding: 0 4px 0 0; } }",
    ".den-bell-tw { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }",
    ".den-bell-t.long { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }",
    ".den-bell-row.rep { padding-left: 28px; }",
    // Issue 187: a row that opens on a click anywhere shows the pointer.
    ".den-bell-row.opens { cursor: pointer; }",
    ".den-bell-x, .den-bell-row .den-ib { font: 500 11px var(--mono); background: none; color: var(--muted);",
    "  border: 1px solid var(--border); border-radius: 999px; padding: 0 6px; min-height: 20px; cursor: pointer; }",
    ".den-bell-row .den-ib { border-color: transparent; }",
    ".den-bell-older { display: block; width: 100%; text-align: left; font: inherit; color: var(--muted);",
    "  background: none; border: 0; border-top: 1px solid var(--border); padding: 8px 12px; cursor: pointer; }",
    ".den-bell-older::before { content: '\\25B8  '; }",
    ".den-bell-older[aria-expanded=true]::before { content: '\\25BE  '; }",
    ".den-bell-ask { margin: 8px 12px; padding: 10px 12px; border: 1px solid var(--border-strong); border-radius: 8px;",
    "  background: var(--bg); }",
    ".den-bell-ask p { margin: 0 0 6px; }",
    ".den-bell-ask div { display: flex; gap: 8px; }",
    // A phone: the small buttons 32px (the kit's shell.css makes the
    // panel full width and its rows 44px).
    "@media (max-width: 480px) {",
    "  .den-bell-x, .den-bell-row .den-ib, .den-tbtn { min-height: 32px; min-width: 32px; } }",
    "#den-lock { border-color: color-mix(in srgb, var(--warn) 55%, var(--border)); }",
    ".den-dot.run { background: var(--accent); animation: den-pulse 1.2s infinite; }",
    ".den-dot.pending { background: var(--faint); animation: den-pulse 1.2s infinite; }",
    "@keyframes den-pulse { 50% { opacity: .35; } }",
    "@media (prefers-reduced-motion: reduce) { .den-dot.run, .den-dot.pending { animation: none; } }",
    // Buttons (.den-btn, .sm, .primary) are the kit's general button:
    // button.css (issue 556), linked in every page with the frame
    // (KIT_PAGE_CSS).
    // A phone's top bar makes room for Report: Runs is in the dock bar.
    "@media (max-width: 480px) { #den-runs { display: none; } }",
    // …and the status chip's words shorten (…) rather than push the page
    // sideways, whatever they say.
    // The kit's chips give way under 1100px (issue 303): Den's chip words
    // end in … when they do.
    ".den-top .den-chip .den-n { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    "@media (max-width: 720px) { .den-top .den-chips, .den-top #den-status { min-width: 0; flex-shrink: 1; } }",
    // D27: Visit is a link styled as a button (a.den-btn: the kit's).
    "a.den-pvisit { text-decoration: none; display: inline-flex; align-items: center; justify-content: center; }",
    "a.den-pvisit { display: grid; }",
    ".den-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 100%); z-index: 41;",
    "  box-sizing: content-box; background: var(--surface); border-left: 1px solid var(--border);",
    "  box-shadow: var(--shadow); display: flex; flex-direction: column; font: 14px/1.45 var(--sans);",
    "  color: var(--text); }",
    ".den-drawer :focus-visible, .den-pal :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
    ".den-drawer .den-dh { display: flex; align-items: center; gap: 10px; padding: 14px 16px;",
    "  border-bottom: 1px solid var(--border); }",
    ".den-drawer .den-dh h2 { margin: 0; font: 600 16px var(--display); flex: 1; }",
    ".den-drawer .den-db { overflow-y: auto; padding: 12px 16px 24px; display: grid; gap: 16px; align-content: start; }",
    ".den-drawer .den-none { margin: 0; color: var(--muted); }",
    ".den-sec { font: 600 13px var(--mono); text-transform: uppercase; letter-spacing: .07em; color: var(--muted);",
    "  margin: 0 0 10px; }",
    ".den-cards, .den-grps { display: grid; gap: 14px; }",
    ".den-cards { gap: 8px; }",
    ".den-prob-card { border: 1px solid color-mix(in srgb, var(--bad) 45%, var(--border));",
    "  background: color-mix(in srgb, var(--bad) 7%, var(--surface)); border-radius: var(--radius);",
    "  padding: 10px 12px; display: grid; gap: 6px; }",
    ".den-prob-card .den-t { display: flex; gap: 8px; align-items: center; font-weight: 600; }",
    ".den-prob-card .den-t .den-mono { font-weight: 400; color: var(--muted); }",
    ".den-prob-card .den-s { color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }",
    ".den-prob-card .den-a { display: flex; gap: 6px; flex-wrap: wrap; }",
    ".den-grp h3 { margin: 0 0 6px; font: 600 12px var(--mono); color: var(--muted); display: flex;",
    "  justify-content: space-between; text-transform: uppercase; letter-spacing: .06em; }",
    ".den-svl { display: grid; gap: 2px; }",
    ".den-svl button { display: flex; align-items: center; gap: 8px; background: none; border: 0; padding: 4px 6px;",
    "  border-radius: 5px; cursor: pointer; text-align: left; font: inherit; color: inherit; min-width: 0; }",
    ".den-svl button:hover { background: var(--sunken); }",
    ".den-svl .den-mono { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".den-svl .den-ms { margin-left: auto; font: 12px var(--mono); color: var(--faint);",
    "  font-variant-numeric: tabular-nums; white-space: nowrap; }",
    // Command palette (.pal-wrap, .pal: R17)
    ".den-pal-wrap { position: fixed; inset: 0; z-index: 50; display: grid; justify-items: center;",
    "  align-items: start; padding: 12vh 16px 0; background: rgb(0 0 0 / 0.35); font: 14px/1.45 var(--sans);",
    "  color: var(--text); }",
    ".den-pal { width: min(620px, 100%); box-sizing: content-box; background: var(--raised);",
    "  border: 1px solid var(--border-strong); border-radius: 12px; box-shadow: var(--shadow); overflow: hidden; }",
    ".den-pal input { width: 100%; box-sizing: border-box; border: 0; border-bottom: 1px solid var(--border);",
    "  background: transparent; padding: 14px 16px; font-family: var(--sans); font-size: 16px; color: var(--text);",
    // line-height too: a page's `input { font: inherit }` (Settings) must not reach it.
    "  line-height: normal; outline: none; margin: 0; }",
    ".den-pal ul { list-style: none; margin: 0; padding: 6px; max-height: 50vh; overflow-y: auto; }",
    ".den-pal li { display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 7px; cursor: pointer; }",
    ".den-pal li[aria-selected='true'] { background: color-mix(in srgb, var(--accent) 16%, transparent); }",
    ".den-pal li .den-pal-l { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".den-pal li .den-kind { margin-left: auto; font: 11px var(--mono); color: var(--faint); text-transform: uppercase;",
    "  letter-spacing: .05em; white-space: nowrap; }",
    ".den-pal li .den-sub { color: var(--faint); font: 12px var(--mono); white-space: nowrap; }",
    // D51: Hub when it can't be opened: greyed, its reason in words.
    ".den-pal li.den-off .den-pal-l { color: var(--muted); }",
    ".den-pal li.den-off .den-sub { font: 12px var(--sans); white-space: normal; min-width: 0; }",
    ".den-pal li.den-pal-empty { cursor: default; color: var(--muted); }",
    ".den-pal .den-foot { display: flex; gap: 14px; padding: 8px 14px; border-top: 1px solid var(--border);",
    "  color: var(--faint); font-size: 12px; flex-wrap: wrap; }",
    // The admin-password prompt (.pop form, .pop input, .note: R8, LK-0)
    ".den-pop form { display: grid; gap: 8px; padding: 6px 8px 8px; width: 260px; box-sizing: content-box; margin: 0; }",
    ".den-pop input:not([type='checkbox']) { border: 1px solid var(--border); background: var(--bg); color: var(--text);",
    "  border-radius: var(--radius-button); padding: 6px 8px; font: inherit; font-size: 13.3333px; line-height: normal; }",
    ".den-pop .den-note, .den-pop .den-mnote { color: var(--muted); font-size: 12.5px; margin: 0; }",
    ".den-pop .den-mnote { padding: 4px 8px; max-width: 260px; }",
    ".den-pop .den-lock-save { display: flex; gap: 6px; align-items: center; color: var(--muted); font-size: 12.5px; }",
    ".den-pop .den-lock-save[hidden], .den-pop .den-lock-err[hidden], .den-mslot[hidden] { display: none; }",
    ".den-pop .den-lock-err { color: var(--bad); font-size: 12.5px; }",
    ".den-pop #den-lock-t { overflow-wrap: anywhere; }",
    // 0.4.45: a heading never breaks inside a word (ja has no spaces, so
    // ブランチ broke into single characters in a narrow column).
    "h1, h2, h3, th { word-break: keep-all; overflow-wrap: break-word; }",
    // The service panel (svc-panel.js): beside its row, a bottom sheet at phone width.
    ".den-pop.den-svp { width: 340px; max-width: calc(100vw - 16px); box-sizing: border-box; padding: 0;",
    "  max-height: calc(100dvh - 16px); overflow-y: auto; min-width: 0; }",
    ".den-svp-h { display: grid; gap: 4px; padding: 12px 12px 10px; border-bottom: 1px solid var(--border); }",
    ".den-svp-t { display: flex; align-items: center; gap: 8px; min-width: 0; }",
    ".den-svp-t .den-dot, .den-svp-ag .den-dot, .den-svp-line .den-dot { margin: 0; }",
    // Line heights pinned to the mock's (its mono font's normal), whatever the theme's font.
    ".den-svp-t b { flex: 1; min-width: 0; font: 600 14px/21px var(--mono); overflow: hidden;",
    "  text-overflow: ellipsis; white-space: nowrap; }",
    ".den-svp-x { padding: 2px 6px; margin: -4px -6px -4px 0; }",
    ".den-svp-meta { display: flex; align-items: center; gap: 4px 8px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); }",
    ".den-wsp { font: 11px/16px var(--mono); border-radius: 999px; padding: 0 7px; white-space: nowrap;",
    "  border: 1px solid var(--border); color: var(--muted); }",
    ".den-svp-st { color: var(--ok); } .den-svp-st.bad { color: var(--bad); }",
    ".den-svp-st.off { color: var(--faint); } .den-svp-st.run { color: var(--accent-text); }",
    ".den-svp-ms { font: 11.5px var(--mono); color: var(--faint); }",
    ".den-svp-url { font: 12px/17px var(--mono); color: var(--faint); overflow-wrap: anywhere; }",
    ".den-svp-acts { display: flex; gap: 6px; flex-wrap: wrap; padding: 10px 12px; }",
    ".den-svp-sec { display: grid; gap: 6px; padding: 8px 12px 10px; border-top: 1px solid var(--border); }",
    ".den-svp-k { font: 11px/16px var(--mono); color: var(--faint); text-transform: uppercase; letter-spacing: .07em; }",
    ".den-svp-line { display: flex; align-items: center; gap: 8px; font-size: 13px; }",
    ".den-svp-line .den-svp-sp { margin-left: auto; }",
    ".den-svp-ok { color: var(--ok); } .den-svp-bad { color: var(--bad); } .den-svp-none { color: var(--faint); }",
    ".den-svp-ag { display: grid; grid-template-columns: auto minmax(0, 1fr) auto auto; gap: 0 8px;",
    "  align-items: center; font-size: 13px; }",
    ".den-svp-nm { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }",
    ".den-svp-as { font: 11px var(--mono); color: var(--faint); white-space: nowrap; }",
    ".den-wbdg { font: 10.5px var(--mono); color: var(--warn); border: 1px solid color-mix(in srgb, var(--warn) 45%, transparent);",
    "  border-radius: 999px; padding: 0 6px; }",
    ".den-svp-help { font-size: 12px; color: var(--faint); line-height: 1.4; }",
    ".den-svp-sub { font-size: 11.5px; color: var(--muted); }",
    ".den-svp-off .den-svp-nm { color: var(--faint); font-weight: 400; }",
    ".den-svp-also { display: grid; gap: 6px; } .den-svp-also > summary { font-size: 11.5px; color: var(--muted); cursor: pointer; }",
    ".den-svp-also[open] > summary { margin-bottom: 4px; }",
    ".den-svp-foot { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 8px 12px 10px;",
    "  border-top: 1px solid var(--border); }",
    ".den-svp-grow { margin-left: auto; }",
    ".den-lnk { color: var(--accent-text); cursor: pointer; font: inherit; font-size: 12.5px; text-decoration: underline;",
    "  background: none; border: 0; padding: 0; }",
    ".den-scrim.den-svp-scrim { z-index: 43; }",
    ".den-pop.den-svp.den-sheet.den-toplayer { top: auto !important; left: 0 !important; right: 0 !important;",
    "  bottom: 0 !important; width: auto; max-width: none; border-bottom: 0; border-radius: 14px 14px 0 0;",
    "  max-height: 85dvh; padding-bottom: env(safe-area-inset-bottom, 0px); }",
    ".den-pop.den-svp.den-sheet::before { content: ''; display: block; width: 36px; height: 4px; border-radius: 2px;",
    "  background: var(--border-strong); margin: 8px auto 0; }",
    ".den-pop.den-svp.den-sheet .den-svp-acts .den-btn { flex: 1 1 auto; padding: 9px 12px; }",
    // Toast (.toast)
    ".den-toast { position: fixed; bottom: 70px; left: 50%; transform: translateX(-50%);",
    "  background: var(--raised); border: 1px solid var(--border-strong); border-radius: 8px;",
    "  padding: 8px 14px; box-shadow: var(--shadow); z-index: 60; font: 14px/1.45 var(--sans);",
    "  color: var(--text); }",
    // The error toast (R26c): .toast with the message, its request id and
    // the prototype's small buttons (.btn.sm).
    ".den-toast-err { display: flex; align-items: center; gap: 10px; max-width: min(640px, calc(100vw - 32px));",
    "  border-color: color-mix(in srgb, var(--bad) 45%, var(--border-strong)); }",
    ".den-toast-act { display: flex; align-items: center; gap: 10px; max-width: min(640px, calc(100vw - 32px)); }",
    ".den-tacts { display: flex; align-items: center; gap: 10px; flex: none; }",
    ".den-tlink { white-space: nowrap; }",
    "@media (max-width: 480px) { .den-toast-act { flex-direction: column; align-items: stretch;",
    "  width: calc(100vw - 32px); box-sizing: border-box; gap: 8px; }",
    "  .den-tacts { justify-content: space-between; } }",
    ".den-toast-err .den-te-ic { color: var(--bad); }",
    ".den-toast-err .den-te-msg { display: flex; flex-direction: column; min-width: 0; overflow-wrap: anywhere; }",
    ".den-toast-err .den-te-id { font: 11px var(--mono); color: var(--faint); }",
    ".den-tbtn { border: 1px solid var(--border); background: var(--surface); color: var(--text);",
    "  border-radius: var(--radius-button); padding: 2px 9px; font: 500 12.5px/1.45 var(--sans);",
    "  cursor: pointer; white-space: nowrap; }",
    ".den-tbtn:hover { border-color: var(--border-strong); }",
    ".den-tx { border: 0; background: none; color: var(--faint); cursor: pointer; font: 16px/1 var(--sans); padding: 0 2px; }",
    ".den-tx:hover { color: var(--text); }",
    ".den-toast :focus-visible, .den-banners :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
    // Banners (.note-banner): the unreachable server (R26d) and others, at
    // the top of the content.
    ".den-banners { flex: none; margin: 16px 24px 0; display: grid; gap: 8px; font: 14px/1.45 var(--sans); }",
    ".den-banners.den-banners-inset { margin: 0 0 16px; }",
    ".den-banners[hidden] { display: none; }",
    ".den-banner { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; font-size: 12.5px;",
    "  color: var(--muted); border: 1px dashed var(--border-strong); border-radius: var(--radius);",
    "  padding: 8px 12px; }",
    ".den-banner b { color: var(--text); }",
    ".den-banner.warn { border-color: color-mix(in srgb, var(--warn) 55%, var(--border-strong)); }",
    ".den-banner .den-bn-ic { color: var(--warn); }",
    ".den-banner .den-bn-t { color: var(--text); }",
    ".den-banner .den-bn-n { font: 11px var(--mono); color: var(--faint); }",
    ".den-banner .den-tbtn { margin-left: auto; align-self: center; }",
    // Issue 455: the address banner: a title line, then why and the fix
    // link; × sits top-right beside the title in a 44px box, at every width.
    ".den-banner .den-bn-body { flex: 1 1 0; min-width: 0; overflow-wrap: anywhere; }",
    ".den-banner .den-bn-body b { display: block; font-size: 14px; }",
    ".den-banner .den-bn-body .den-bn-t { margin-right: 6px; }",
    ".den-banner .den-bn-a { color: var(--accent-text); text-decoration: underline; }",
    ".den-banner .den-bn-x { flex: 0 0 44px; margin: -12px -10px -12px auto; align-self: flex-start; width: 44px; height: 44px; padding: 0; border: 0; background: transparent; color: var(--muted); font-size: 22px; line-height: 1; cursor: pointer; border-radius: var(--radius-button, 8px); }",
    ".den-banner .den-bn-x:hover { color: var(--text); background: var(--surface-2, transparent); }",
    // The runs dock (.dock, .bar, .runs, .rtab, pre: R16), at the foot of
    // the content column; content-box as in the prototype.
    ".den-dock { flex: none; order: 99; position: sticky; bottom: 0; z-index: 14; min-width: 0;",
    "  border-top: 1px solid var(--border); background: var(--surface); font: 14px/1.45 var(--sans);",
    "  color: var(--text); box-sizing: content-box; }",
    ".den-dock :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }",
    ".den-dock .den-bar { display: flex; align-items: center; gap: 10px; box-sizing: content-box;",
    "  padding: 6px max(16px, env(safe-area-inset-right, 0px)) calc(6px + env(safe-area-inset-bottom, 0px)) 16px;",
    "  font-size: 13px; color: var(--muted); }",
    ".den-dock .den-bar b { color: var(--text); font-weight: 500; }",
    ".den-dock .den-runs-l { display: flex; gap: 6px; overflow-x: auto; flex: 1; min-width: 0; }",
    ".den-dock .den-rtab-w { position: relative; display: inline-flex; flex: none; }",
    ".den-dock .den-rtab { display: inline-flex; gap: 6px; align-items: center; border: 1px solid var(--border);",
    "  border-radius: 6px; padding: 2px 8px; background: var(--bg); cursor: pointer; white-space: nowrap;",
    "  font: 12px var(--mono); color: inherit; box-sizing: content-box; margin: 0; }",
    ".den-dock .den-rtab[aria-selected='true'] { border-color: var(--accent); }",
    ".den-dock .den-rtab .den-dot { margin: 0; }",
    // A run closes from its tab (Local Dev's tabs did): room for the ×.
    ".den-dock .den-rtab.den-x { padding-right: 22px; }",
    ".den-dock .den-rtab-x { position: absolute; top: 0; bottom: 0; right: 4px; display: flex; align-items: center;",
    "  padding: 0 3px; border: 0; background: none; cursor: pointer; font: 13px var(--sans); color: var(--faint); }",
    ".den-dock .den-rtab-x:hover { color: var(--bad); }",
    ".den-dock .den-dock-acts { display: flex; gap: 2px; flex: none; }",
    ".den-dock pre { margin: 0; height: 170px; overflow: auto; max-height: 50vh; padding: 10px 16px; font: 12px/1.5 var(--mono);",
    "  background: var(--sunken); border-top: 1px solid var(--border); color: var(--muted);",
    "  box-sizing: content-box; white-space: pre-wrap; word-break: break-all; }",
    ".den-dock pre a { color: var(--accent-text); }",
    // The panes' line classes, kept.
    ".den-dock pre .cmd { color: var(--accent-text); }",
    ".den-dock pre .err, .den-dock pre .done-fail { color: var(--bad); }",
    ".den-dock pre .warn, .den-dock pre .done-none { color: var(--warn); }",
    ".den-dock pre .ok, .den-dock pre .done-ok { color: var(--ok); }",
    ".den-dock pre .phase { color: var(--text); font-weight: 600; }",
    ".den-dock-grip { display: none; position: absolute; left: 0; right: 0; top: -3px; height: 6px;",
    "  cursor: ns-resize; z-index: 1; }",
    ".den-dock.open .den-dock-grip { display: block; }",
    // Narrow (the prototype's 860 and 720px steps): chip labels hide, the
    // dots stay; then the scope hides and the search is its icon.
    // Den's chips are wider than the prototype's (the full version, real
    // counts): the scope's keys give way from 960px, not 860, so the bar
    // fits without the scope shrinking.
    "@media (max-width: 960px) { .den-scope .den-k { display: none; } }",
    // (The kit's shell.css hides the crumbs' keys at 860px, the crumbs and
    // the search's words at 720px.)
    "@media (max-width: 860px) { .den-chip .den-lbl-l { display: none; } }",
    // A phone's tap targets (issue 209, T9): the dock's buttons 32 px or
    // more each way. The top bar's, and the title visually hidden, are the
    // kit's shell.css (den-ui 0.7.0).
    "@media (max-width: 479.98px) {",
    "  .den-dock .den-ib, .den-dock .den-rtab { min-height: 32px; min-width: 32px; }",
    "}",
    // Issue 168: project colours (workspace-picker.js projectColour). Eight,
    // none orange or red, each 3:1 against the page in both modes, for
    // edges, dots and tiles only: text is never coloured by project. An
    // element names its project's colour with data-pc; --pc is the colour.
    // The colours themselves are theme tokens (--pc-<name>, /theme.css).
    '[data-pc="blue"] { --pc: var(--pc-blue); }',
    '[data-pc="teal"] { --pc: var(--pc-teal); }',
    '[data-pc="green"] { --pc: var(--pc-green); }',
    '[data-pc="purple"] { --pc: var(--pc-purple); }',
    '[data-pc="pink"] { --pc: var(--pc-pink); }',
    '[data-pc="gold"] { --pc: var(--pc-gold); }',
    '[data-pc="brown"] { --pc: var(--pc-brown); }',
    '[data-pc="slate"] { --pc: var(--pc-slate); }',
    ".den-pc { display: inline-block; width: 10px; height: 10px; border-radius: 50%;",
    "  background: var(--pc, var(--faint)); flex: none; vertical-align: 0; margin-inline-end: 6px; }",
  ].join("\n");
  document.head.appendChild(style);
})();
