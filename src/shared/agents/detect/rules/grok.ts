/**
 * Screen rules for Grok (issue 770), from herdr
 * (https://github.com/herdrdev/herdr), src/detect/manifests/grok.toml
 * at commit e8d7d9705a7a2c89cef4dd42079379f05685af87.
 *
 * Copyright 2026 the herdr authors. Licensed under the Apache License,
 * Version 2.0; see THIRD_PARTY_NOTICES at the repository root.
 * Modified by Den: the TOML is rewritten as a TypeScript module. The rules
 * themselves are unchanged.
 *
 * herdr-origin: src/detect/manifests/grok.toml
 * vendored-screen-text: herdr src/detect/manifests/grok.toml (the screen
 * text of another product, matched exactly; the words gate leaves it out)
 */
import type { RuleSet } from "../engine.js";

export const GROK_RULES: RuleSet = {
  id: "grok",
  version: "2026.10.05.1",
  min_engine_version: 3,
  updated_at: "2026-10-05T00:00:00Z",
  aliases: ["grok-build"],
  rules: [
    {
      id: "osc_title_blocked",
      state: "blocked",
      priority: 1300,
      region: "osc_title",
      visible_blocker: true,
      contains: ["Action Required"],
    },
    {
      id: "option_dialog_blocked",
      state: "blocked",
      priority: 1200,
      region: "whole_recent",
      visible_blocker: true,
      line_regex: ["^\\s*┃\\s+[0-9a-z]+\\s+\\([●○]\\)\\s"],
    },
    {
      id: "permission_hints_blocked",
      state: "blocked",
      priority: 1190,
      region: "bottom_non_empty_lines(2)",
      visible_blocker: true,
      contains: [":select", "ctrl+o:yolo", "ctrl+c:cancel"],
    },
    {
      id: "question_dialog_hints_blocked",
      state: "blocked",
      priority: 1185,
      region: "bottom_non_empty_lines(2)",
      visible_blocker: true,
      contains: ["tab:scrollback", "shift+x:dismiss"],
    },
    {
      id: "permission_scope_selector",
      state: "blocked",
      priority: 1180,
      region: "whole_recent",
      visible_blocker: true,
      contains: ["yes, proceed", "no, reject"],
      any: [
        {
          contains: ["use ← → to choose permission whitelist scope"],
        },
        {
          contains: ["←/→:scope"],
        },
      ],
    },
    {
      id: "osc_progress_working",
      state: "working",
      priority: 1150,
      region: "osc_progress",
      visible_working: true,
      regex: ["^4;1;-1$"],
    },
    {
      id: "osc_title_idle",
      state: "idle",
      priority: 1100,
      region: "osc_title",
      visible_idle: true,
      regex: ["(?:^| - )grok$"],
      not: [
        {
          regex: ["[\\x{2800}-\\x{28FF}]"],
        },
      ],
    },
    {
      id: "osc_title_working",
      state: "working",
      priority: 1000,
      region: "osc_title",
      visible_working: true,
      regex: ["(?:^|\\s)[\\x{2801}-\\x{28FF}](?:\\s|$)"],
    },
    {
      id: "osc_progress_idle",
      state: "idle",
      priority: 950,
      region: "osc_progress",
      visible_idle: true,
      regex: ["^4;0;0$"],
    },
    {
      id: "spinner_status_working",
      state: "working",
      priority: 1160,
      region: "whole_recent",
      visible_working: true,
      line_regex: ["^\\s*[\\x{2801}-\\x{28FF}]\\s.*\\[stop\\]\\s*$"],
    },
    {
      id: "esc_cancel_hints_working",
      state: "working",
      priority: 1155,
      region: "bottom_non_empty_lines(2)",
      visible_working: true,
      contains: ["ctrl+.:shortcuts"],
      any: [
        {
          contains: ["esc:cancel"],
        },
        {
          contains: ["ctrl+c:cancel"],
        },
      ],
    },
    {
      id: "waiting_tool_working",
      state: "working",
      priority: 1140,
      region: "whole_recent",
      visible_working: true,
      any: [
        {
          all: [
            {
              contains: ["ctrl+c:cancel", "ctrl+enter:interject"],
            },
            {
              contains: ["waiting"],
            },
          ],
        },
        {
          line_regex: [
            "^\\s*[\\x{2801}-\\x{28FF}]\\s+(Run|Read|Search|List)\\b",
          ],
        },
      ],
    },
    {
      id: "prompt_hints_idle",
      state: "idle",
      priority: 100,
      region: "bottom_non_empty_lines(2)",
      visible_idle: true,
      contains: ["ctrl+.:shortcuts"],
      not: [
        {
          contains: ["esc:cancel"],
        },
        {
          contains: ["ctrl+c:cancel"],
        },
      ],
    },
  ],
};
