# pstack in Den

These files come from pstack, by Lauren Tan, under the MIT License in `LICENSE` beside this file.

Source: https://github.com/cursor/plugins/tree/41e400932eca14f289e7db717a70455256b6d388/pstack

Den writes `.claude-plugin/plugin.json` and this file. Every other file is upstream's, unchanged, except for the patches below.

## Left out

- `.cursor-plugin`: Cursor's plugin manifest; Den writes a Claude Code one in .claude-plugin/.
- `.gitignore`: npm leaves it out of a published package, so the installed copy would fail its hash check.
- `assets`: a logo no agent reads.
- `automations`: it sets up Cursor cloud automations.
- `docs/guide/01-setup.md`: a line matches Den's check for private names (a false match in upstream's text), and Den's repo is public.
- `docs/guide/images`: pictures no agent reads.
- `skills/automate-me`: it sets up Cursor cloud automations.
- `skills/make-bot-ui`: a line matches Den's check for private names (a false match in upstream's text), and Den's repo is public.
- `skills/poteto-mode/playbooks/autopilot-full.md`: it has subagents merge pull requests and push after rebases; Den hands a green pull request to whoever merges.
- `skills/poteto-mode/playbooks/babysit.md`: it polls GitHub with watch-pr; Den watches checks with github_watch.
- `skills/poteto-mode/playbooks/shipping.md`: it merges with gh pr merge and pushes with --force-with-lease; Den never does either.
- `skills/poteto-mode/scripts/watch-pr`: it polls GitHub every 60 seconds; Den watches checks with github_watch.
- `skills/setup-pstack`: it writes ~/.claude/rules/, outside the agent's folders.
- `skills/statechart/references/render.md`: it installs an npm renderer.
- `skills/statechart/scripts/test`: 377 test files with a dev dependency.

## Changed

- `statechart-run-no-download.patch`: skills/statechart/scripts/run.ts: TLC runs only from a local jar named by TLA2TOOLS; the mise download of TLC and Java is gone.
- `statechart-skill-no-download.patch`: skills/statechart/SKILL.md: says nothing is downloaded or installed, and no longer points at the left-out renderer.

## Off by default

- `statechart`: its TLC run is CPU-heavy and runs outside Den's gate.
