# Guardrail lint

A copy of Monster Orange's shared lint rules. Each rule turns an anti-pattern an agent was caught making into a check. CI's pull request job runs it on the lines a change adds:

```
node scripts/guardrail-lint/mo-gates.mjs --base origin/main   # the lines this branch adds
node scripts/guardrail-lint/mo-gates.mjs --all                # every tracked file
```

A hit is excused by `mo-lint-ok: <reason>` on its line or the line above. An excuse with no reason doesn't count.

The rules live upstream. Change them there, then copy `mo-gates.mjs`, `rules.json` and `rules/` here unchanged.
