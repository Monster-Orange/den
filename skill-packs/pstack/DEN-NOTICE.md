# pstack in Den

These files come from pstack, by Lauren Tan, under the MIT License in `LICENSE` beside this file.

Source: https://github.com/cursor/plugins/tree/41e400932eca14f289e7db717a70455256b6d388/pstack

Den writes `.claude-plugin/plugin.json` and this file. Every other file is upstream's, unchanged, except for the patches below.

## Left out

- `.cursor-plugin`: Cursor's plugin manifest; Den writes a Claude Code one in .claude-plugin/.
- `.gitignore`: npm leaves it out of a published package, so the installed copy would fail its hash check.
- `README.md`: upstream's README is built around poteto-mode, which is left out; this file says what Den ships.
- `agents/poteto-agent.md`: the subagent poteto-mode starts; poteto-mode is left out.
- `assets`: a logo no agent reads.
- `automations`: it sets up Cursor cloud automations.
- `docs/guide`: upstream's guide is built around poteto-mode, which is left out; no skill reads it.
- `plugin.json`: upstream's Cursor manifest; Den writes a Claude Code one in .claude-plugin/.
- `skills/automate-me`: it sets up Cursor cloud automations.
- `skills/make-bot-ui`: a line matches Den's check for private names (a false match in upstream's text), and Den's repo is public.
- `skills/poteto-help`: its guide to pstack is a guide to poteto-mode, which is left out.
- `skills/poteto-mode`: it tells agents and their subagents never to ask a person, to add no review or sign-off above their kickoff, and that external actions proceed without asking: the opposite of Den's held writes and reviews. Its playbooks and scripts go with it.
- `skills/setup-pstack`: it writes ~/.claude/rules/, outside the agent's folders.
- `skills/statechart/references/render.md`: it installs an npm renderer.
- `skills/statechart/scripts/test`: 377 test files with a dev dependency.

## Changed

- `statechart-run-no-download.patch`: skills/statechart/scripts/run.ts: TLC runs only from a local jar named by TLA2TOOLS; the mise download of TLC and Java is gone.
- `statechart-skill-no-download.patch`: skills/statechart/SKILL.md: says nothing is downloaded or installed, and no longer points at the left-out renderer.
- `no-poteto-mode-pointers.patch`: skills/arena, figure-it-out, no-comments, recall, show-me-your-work and swarm, and docs/harness/claude-code.md: the pointers to poteto-mode and its subagent, which are left out, are gone; each step says the same without them.

## Off by default

- `statechart`: its TLC run is CPU-heavy and runs outside Den's gate.
