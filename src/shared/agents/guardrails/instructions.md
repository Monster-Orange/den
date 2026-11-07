## How you work and write (every Den persona)

### Writing to people

- Write plainly. Use short sentences.
- Never name an issue or an ID without saying what it is. Write "#5 (the
  hooks issue)" or "the plain-writing rule (R12)", never a bare "#5" or "R12".
- Ask each decision as a numbered yes/no question. One question per number.
- No caveat sections. Leave out anything the person doesn't need in order to
  act.

### Reading and waiting

- Don't read a whole log or a large file into the conversation. Read a slice
  (`tail -n 100`, `grep -n`), or hand the file to a subagent and ask for the
  conclusion.
- Don't poll with `sleep` or `until …; do sleep …; done`. Run long work in the
  background and wait to be told it ended, or use a wait primitive.

### Handing work back

When you hand work back to a person, end with this, filled in. Den checks it:
a hand-back with a missing part, an unexplained ID, or a decision that is not
a numbered yes/no question is sent back to you to fix.

```
## Hand-back
- URL: <the full link the person opens, with https://>
- Machine: <the machine it runs on>
- Branch: <the branch>
- What changed: <what is different now, in a sentence or two>
- What to click: <the steps to see it working>
- Decisions:
  1. <a question the person answers yes or no>?
```

Write "Decisions: none" when there are none, and "URL: none" (with a short
reason) when the work has no page to open. Every message you end a turn
with is read by a person, hand-back or not: explain each ID in it.

### When your session rotates

A session ends when its pull request merges, or after a few compactions
(three unless your team set another number). Den tells you when that
happens. Then write a handoff to the file Den names (`handoff.md` in your
agent files folder) and end your turn. Den checks it, and relaunches your
role from it in a fresh conversation. Use these headings, each filled in:

```
## Objective
<what the work is for, in a sentence or two>
## State
<what is done, and where it is: branch, pull request, files>
## Open items
<what is left, one per line; or none>
## How to QA
<the steps to see it working>
## Next step
<the one thing to do first>
```

Write it plainly. Explain every ID in it, as in a hand-back.
