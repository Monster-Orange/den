/**
 * Screen rules for the Antigravity CLI, `agy` (issue 97), from herdr
 * (https://github.com/herdrdev/herdr), src/detect/manifests/antigravity.toml
 * at commit e8d7d9705a7a2c89cef4dd42079379f05685af87.
 *
 * Copyright 2026 the herdr authors. Licensed under the Apache License,
 * Version 2.0; see THIRD_PARTY_NOTICES at the repository root.
 * Modified by Den: the TOML is rewritten as a TypeScript module. The rules
 * themselves are unchanged. herdr has no idle rule for agy: an idle screen
 * is unknown here, and Den's other signals decide.
 *
 * herdr-origin: src/detect/manifests/antigravity.toml
 * vendored-screen-text: herdr src/detect/manifests/antigravity.toml (the
 * screen text of another product, matched exactly; the words gate leaves
 * it out)
 *
 * herdr's notes, from Antigravity CLI 1.2.17 live pane reads and captures
 * from 1.1.28 through 1.2.16: dialogs replace the prompt box and end with
 * a key-hint row directly above the "esc to cancel" footer (permission:
 * "↑/↓ Navigate · tab Amend · …"; question: "↑/↓ Navigate · enter Select ·
 * esc Skip"; trust: "↑/↓ Navigate · enter Confirm"). A working turn draws
 * a braille spinner above the prompt box, and "esc to cancel" directly
 * under the box's bottom border. The idle footer reads "? for shortcuts".
 */
import type { RuleSet } from "../engine.js";

export const ANTIGRAVITY_RULES: RuleSet = {
  id: "agy",
  version: "2026.10.05.1",
  min_engine_version: 1,
  updated_at: "2026-10-05T00:00:00Z",
  aliases: ["antigravity", "antigravity-cli"],
  rules: [
    {
      id: "permission_prompt",
      state: "blocked",
      priority: 300,
      region: "bottom_non_empty_lines(2)",
      visible_blocker: true,
      contains: ["navigate", "tab amend"],
    },
    {
      id: "question_prompt",
      state: "blocked",
      priority: 290,
      region: "bottom_non_empty_lines(2)",
      visible_blocker: true,
      contains: ["navigate", "esc skip"],
    },
    {
      id: "trust_prompt",
      state: "blocked",
      priority: 280,
      region: "bottom_non_empty_lines(8)",
      visible_blocker: true,
      contains: [
        "do you trust the contents of this project?",
        "yes, i trust this folder",
        "enter confirm",
      ],
    },
    // Pre-1.1.28 permission dialog.
    {
      id: "legacy_permission_prompt",
      state: "blocked",
      priority: 270,
      region: "whole_recent",
      visible_blocker: true,
      contains: ["requesting permission for:"],
      any: [
        { contains: ["do you want to proceed?"] },
        { contains: ["tab amend", "edit command"] },
      ],
    },
    {
      id: "esc_cancel_footer_working",
      state: "working",
      priority: 110,
      region: "bottom_non_empty_lines(2)",
      visible_working: true,
      regex: ["(?m)^\\s*─{3,}\\s*esc to cancel\\b"],
    },
    {
      id: "spinner_working",
      state: "working",
      priority: 100,
      region: "bottom_non_empty_lines(12)",
      visible_working: true,
      line_regex: ["^\\s*[\\u2801-\\u28FF]+\\s+\\S"],
    },
  ],
};
