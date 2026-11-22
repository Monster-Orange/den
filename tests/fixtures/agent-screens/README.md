# Agent screens (issue 770)

Screens for the screen rules in `src/shared/agents/detect`, one folder per
rule set: `<state>-<what>.txt` is the rendered screen (no escapes, rows
right-trimmed). A `.json` beside it gives what the terminal title (OSC 0/2,
`oscTitle`) or progress (OSC 9, `oscProgress`) said, when the rules read
it. The name's first word is the state the rules must read: `working`,
`blocked` or `idle`.

These are built from each agent's own screen text, as its rule set names
it; they are not captures. Claude's recorded captures are in
`../claude-code-screens`, and tests/unit/agents/screen-rules.test.ts reads
those too.
