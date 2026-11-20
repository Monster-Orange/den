# Agent screens (issue 770)

Session output (raw bytes as text: a screen clear, each row, colour escapes,
and the terminal title as OSC 0 where the CLI sets one) for each runtime's
screen rules in `src/shared/agents/detect/rules/`. Used by
tests/unit/agents/status-rules-770.test.ts and
tests/unit/server/attention-screen-770.test.ts.

Den's tests never run a vendor's CLI, so these screens were written out
by hand, row by row, in the shapes each CLI draws: Codex CLI 0.12x's TUI
(its `›` composer, `• Working (14s • esc to interrupt)` status line, the
approval dialog's `Press enter to confirm or esc to cancel` footer and its
transcript overlay's key hints), Gemini CLI's Ink UI (the
`Type your message or @path/to/file` input box, the `(esc to cancel, 7s)`
spinner line, the `Allow execution` and `Apply this change?` boxes), and
Grok Build's, from the shapes its rule file documents (the `[stop]` chip,
the `┃`-guttered option list and its footer hints). Paths and names are
placeholders. Claude Code's idle and blocked screens are the real captures
in `../claude-code-screens/`; `claude/working.raw` is written in their shape.

A file's name starts with the state its rules must give it: `working`,
`blocked`, `idle`, or `viewer` (a transcript viewer: no state change).
`none/` is a plain shell that no rule set may match.

When a CLI changes what it draws, replace its screens with a capture
(`tmux capture-pane -e -p`) and update the rule file from herdr's next
release in the same change.
