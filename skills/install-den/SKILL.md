---
name: install-den
description: Install and set up Den, Monster Orange's local dev orchestrator, for a developer in five minutes. Use when the person says "set up Den", "install Den", "get me started with Den", or pastes a link to this file.
---

# Install Den

You are setting up Den on this person's machine. Den runs their repos locally, shows them in a browser, and gives you
(the agent) an MCP server to work with. Aim to be done in five minutes. Keep your messages short and plain.

## Hard rules

- **Never ask for a token, password or secret in chat.** If a step needs one, tell the person which command to run
  themselves.
- **Never edit the person's repos.** Den's files go in the Den folder only. Read the repo; don't write to it.
- **Send nothing off this machine.** No uploads, no telemetry, no pasting their code anywhere. The only downloads are
  Den from npm and a repo the person gave you as a git URL.
- **Sudo is the person's job.** Never run `sudo` yourself. When a Den step needs it, Den asks for the password in its
  own prompt (in the terminal or the browser), and the person types it there.
- Every step below is safe to re-run. If you are unsure whether a step ran, run it again.

## 1. Check the prerequisites

Run these and read the results. Don't install anything without saying so first.

1. `node --version`: needs **22.13 or later**. If it's older or missing, say so and suggest their usual installer
   (for example `brew install node`, or `nvm install 22`).
2. `npm --version`: needs 9 or later. It comes with Node.
3. `git --version`: needs to be there.
4. `docker info`: only matters if the repo runs in containers (it has a `docker-compose.yml` or `compose.yaml`).
   If Docker is needed and not running, ask them to start it.

If anything is missing, stop here, tell them what and how to fix it, and wait.

## 2. Ask at most three questions

Ask them together, each with a default, so the person can just say "yes":

1. **Where should your Den live?** Default: `~/den`. It must be a new or empty folder.
2. **Which repo should we start with?** Default: the folder you're in now. A local path or a git URL.
3. **What should we call your Den?** Default: `den`. Lowercase letters, numbers and dashes. This also becomes the
   command name, so `acme` gives you `./bin/acme`.

Below, `<dir>` is the Den folder, `<repo>` the repo path, and `<name>` the name.

## 3. Create the Den

Every Den command below takes `--json`. It then prints one JSON object on stdout and its log on stderr. Read `ok`
first. When `ok` is false, the object says why (`error`) and either a command to run (`fix`) or a question for the
person (`ask`, sometimes with `choices`).

1. `npx @monster-orange/den create <name> <dir> --yes --json`. It answers `{ok, dir, cli, existed, port, next}`. If
   the folder already holds this Den, it answers `ok` with `existed: true` and changes nothing. `port` is the browser
   UI's port. When another Den already uses the usual one on this machine, Den picks the next free port and says so
   (`portPicked`). Remember the port for the hand-back.
2. `cd <dir> && npm install`
3. From here on, the Den command is `./bin/<name>`, run from `<dir>`.

## 4. Add the repo without changing it

1. `./bin/<name> repo add <repo> --json`. `<repo>` can be a path or a git URL. Den clones a URL into its own folder.
   - If the repo has its own `.<name>.yml`, Den uses it.
   - If it doesn't, Den works out how the repo starts and writes a side-car manifest into `<dir>/manifests/`. It never
     writes into the repo. It looks for a Makefile `up` target, then a compose file, then the `dev` or `start` script
     in `package.json`. `--sidecar` asks for this explicitly, and fails if the repo has its own manifest.
   - If you can see which port the app listens on, add `--health http://localhost:<port>/`. Den then checks that it
     answers.
2. If the answer has `ask` and `choices`, Den couldn't tell how the repo starts, and it wrote nothing. Ask the person
   **one** question: the `ask` text, with the choices numbered. Then re-run with their answer:
   `./bin/<name> repo add <repo> --run "<their command>" --json`.
3. The answer names the repo (`repo`), the workspace it joined (`workspace`) and where its manifest is (`manifest`).
   A workspace is Den's name for a set of repos that run together. The first one is called `default`.

## 5. Start it and check it

1. `./bin/<name> up <repo> --json`. `<repo>` is the `repo` value from step 4. Each service comes back with a
   `result` (`started` or `already-running`) and a `health` (`ok`, or `unknown` when it has no health check).
2. `./bin/<name> web up --no-open --json`. This starts the browser UI, and answers `{ok, url, port}`. The MCP server
   reads through it.
3. `./bin/<name> doctor --json`. Each check comes back as `ok`, `warn` or `fail`. The checks are Node, git, Docker
   (only if a repo needs it), the web server (with its `url` and `port`) and Den's MCP. Fix every `fail` before you hand back.

## 6. Connect yourself to Den's MCP

1. `./bin/<name> mcp connect --runtime <you> --json`. `<you>` is `claude`, `codex`, `gemini` or `grok`. For any other
   agent, `./bin/<name> mcp config` prints the JSON to add by hand.
2. `./bin/<name> mcp clients` shows whether you are connected.
3. If the answer has `restart: true`, you load the new MCP server only when you start again. Tell the person to
   restart you once.

## 7. Hand back

Tell the person, in a few short sentences. Explain every name you use the first time (for example, "a workspace is a
set of repos that run together").

- **Open:** the `url` from `web up` or from the doctor's `web` check, for example `http://localhost:<port>`. Never
  assume a port: use the one Den gave you.
- **What's running:** each service from `up`, and whether it's healthy.
- **Your Den:** where it lives (`<dir>`) and its command (`./bin/<name>`).
- **Decisions, if any:** as numbered yes/no questions, for example "1. Restart me now so I can use Den's tools?"
- **Three next things we can do together:**
  1. Add another repo.
  2. Look at a service's logs, or run its tests.
  3. Start an agent session on this repo from the browser.

## When something fails

1. Read the JSON. If it has `fix`, run that command, then re-run the step that failed.
2. If it has `ask`, the person has to decide or act (sudo, a password, starting Docker, signing in). Ask them the
   question, show any `choices` numbered, and wait.
3. If there is neither, ask the person **one** clear question, with your best guess as the default.
4. Never work around a failure by editing their repo, turning off a check, or skipping a step without saying so.
5. If you're stuck after two tries, stop. Tell them what you ran, what it said, and where Den writes its logs
   (`~/.<name>/`), so they can get help.
