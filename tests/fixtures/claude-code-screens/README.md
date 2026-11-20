# Claude Code screens (issue 664)

Screens captured from Claude Code 2.1.329, 120 columns by 40 rows, with
`tmux capture-pane -e` (the screen's text with its colour escapes, one line
per row). Paths, the login, the model and the plan were replaced with
placeholders. Used by tests/unit/agents/agent-input-state.test.ts and
tests/unit/agents/trust-prompt-capture.test.ts.

- `1-trust.raw`: the folder-trust question, first choice "No, exit".
- `1b-trust-yes-selected.raw`: the same, with "Yes, I trust this folder" selected.
- `2-input-prompt.raw`: the input prompt at start.
- `2b-input-prompt-after-turn.raw`: the input prompt after a turn, a suggestion in the box.
- `3-tool-dialog.raw`: a dialog for a Bash command.
- `3b-tool-dialog-redraw.raw`: the same dialog 4 s later (byte-identical).
- `4-after-no.raw`: after Esc on that dialog, then the input prompt.
