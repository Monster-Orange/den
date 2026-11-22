/**
 * Screen rules for Gemini (issue 770), from herdr
 * (https://github.com/herdrdev/herdr), src/detect/manifests/gemini.toml
 * at commit e8d7d9705a7a2c89cef4dd42079379f05685af87.
 *
 * Copyright 2026 the herdr authors. Licensed under the Apache License,
 * Version 2.0; see THIRD_PARTY_NOTICES at the repository root.
 * Modified by Den: the TOML is rewritten as a TypeScript module. The rules
 * themselves are unchanged.
 *
 * herdr-origin: src/detect/manifests/gemini.toml
 */
import type { RuleSet } from "../engine.js";

export const GEMINI_RULES: RuleSet = {
  id: "gemini",
  version: "2026.06.10.1",
  min_engine_version: 1,
  updated_at: "2026-06-10T00:00:00Z",
  rules: [
    {
      id: "apply_or_allow_change",
      state: "blocked",
      priority: 300,
      region: "whole_recent",
      visible_blocker: true,
      any: [
        {
          contains: ["│ Apply this change"],
        },
        {
          contains: ["│ Allow execution"],
        },
        {
          all: [
            {
              contains: ["yes"],
            },
            {
              any: [
                {
                  contains: ["waiting for user confirmation"],
                },
                {
                  contains: ["│ Do you want to proceed"],
                },
                {
                  contains: ["do you want to proceed?"],
                },
              ],
            },
          ],
        },
        {
          line_regex: ["(?i)^\\s*❯.*(yes|allow)"],
        },
      ],
    },
    {
      id: "esc_cancel_working",
      state: "working",
      priority: 100,
      region: "whole_recent",
      visible_working: true,
      contains: ["esc to cancel"],
    },
  ],
};
