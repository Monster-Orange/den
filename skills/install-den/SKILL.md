---
name: install-den
description: Install Den, Monster Orange's local dev orchestrator, and hand the person over to Den's own agent, in five minutes. Use when the person says "set up Den", "install Den", "get me started with Den", or pastes a link to this file.
---

# Install Den

You are installing Den on this person's machine. Den runs their repos locally and shows them in a browser. Your job
is short: install it, name it, start it, and hand over the link. **Den's own agent takes it from there.** It adds
their repos and starts their services, with the person allowing each change in the browser.

You do three things only. You don't add repos or create workspaces: those are Den's own agent's job. Keep your
messages short and plain.

## Hard rules

- **Never ask for a token, password or secret in chat.** If a step needs one, tell the person which command to run
  themselves.
- **Never edit the person's repos.** Don't touch them at all.
- **Send nothing off this machine.** No uploads, no telemetry. The only download is Den from npm.
- **Sudo is the person's job.** Never run `sudo` yourself.
- **Never open the setup link yourself**, and never fetch it. It signs in one browser, once. Give it to the person.
- Every step below is safe to re-run. If you are unsure whether a step ran, run it again.

## 1. Install Den, after checking Node and git

Run these and read the results. Don't install anything without saying so first.

1. `node --version`: needs **22.13 or later**. If it's older or missing, say so and suggest their usual installer
   (for example `brew install node`, or `nvm install 22`).
2. `npm --version`: needs 9 or later. It comes with Node.
3. `git --version`: needs to be there.

If anything is missing, stop here, tell them what and how to fix it, and wait.

## 2. Pick the folder and the name

Ask both together, each with a default, so the person can just say "yes":

1. **What should we call your Den?** Default: `den`. Lowercase letters, numbers and dashes. This also becomes its
   command, so `acme` gives you `./bin/acme`.
2. **Where should it live?** Default: `~/<name>`. It must be a new or empty folder.

Below, `<name>` is the name and `<dir>` the folder.

Every Den command below takes `--json`. It then prints one JSON object on stdout and its log on stderr. Read `ok`
first. When `ok` is false, the object says why (`error`) and either a command to run (`fix`) or a question for the
person (`ask`).

1. `npx @monster-orange/den@latest create <name> <dir> --yes --json`. It answers `{ok, dir, cli, existed, port}`. If the
   folder already holds this Den, it answers `ok` with `existed: true` and changes nothing. When another Den already
   uses the usual port, it picks the next free one and says so (`portPicked`).
2. `cd <dir> && npm install`
3. From here on, the Den command is `./bin/<name>`, run from `<dir>`.

## 3. Start the web server and hand over the link

1. `./bin/<name> web up --no-open --json`. It answers `{ok, url, port}`.
2. `./bin/<name> web claim-link --json`. It answers `{url, expiresAt}`: a one-time setup link that signs the
   person's browser in, so they can allow Den's agent's changes. It lasts 30 minutes and works once.
3. Hand over, in a few short sentences:
   - **Open** the `url` from `claim-link`, in your browser on this machine. "Den's own agent takes it from there."
   - **Your Den** lives in `<dir>`, and its command is `./bin/<name>`.
   - If the link has expired, run `./bin/<name> web claim-link` yourself for a new one.

That's all. Don't go on to add repos.

## When something fails

1. Read the JSON. If it has `fix`, run that command, then re-run the step that failed.
2. If it has `ask`, the person has to decide or act. Ask them the question, show any `choices` numbered, and wait.
3. If there is neither, ask the person **one** clear question, with your best guess as the default.
4. If you're stuck after two tries, stop. Tell them what you ran, what it said, and where Den writes its logs
   (`~/.<name>/`), so they can get help.
