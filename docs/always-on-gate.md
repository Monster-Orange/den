# Always-on gate: agents keep running through a logout

A checklist for the lead's gate machine. It proves, on a real logout, what
the unit tests prove with fake `launchctl`, `sudo` and `claude` binaries:
under Keep agents running after logout (`service install --mode always`),
Den's jobs and every agent they run keep running when the person logs
out, and agents sign in with the long-lived token from the install's
secrets store, not the login keychain.

It needs a person at the machine (the logout, the admin password, the
token). Run it on a test distribution, never on an install people are
using. Nothing here is run by CI or by an agent.

Below, `acme` is the test distribution's CLI and `<label>` its
`web.service` label (`./bin/acme service install --plan` prints it).

## Before

1. A test distribution on a recent Den, with a secrets backend that keeps
   secrets (`secrets.provider: 1password` or `doppler`) reachable without
   the desktop. 1Password: `secrets.onepassword.token` set to `file:` or
   `env:`, not `keychain:`. Doppler: a CLI token that isn't kept only in
   the login keychain.
2. Make the agents' token once, in a terminal: `claude setup-token`. Then
   paste it in Settings › Agents › Keep agents running after logout ›
   Sign-in token and Save, or `./bin/acme agents token set` and paste it
   at the prompt. It isn't shown, and it never goes on the command line.
3. `./bin/acme agents token status` prints `✓ agents sign in with the
token set <date> (in <store>)`.

## Install in mode always

4. `./bin/acme service install --plan`: `mode: always`. (A new install
   picks it; an older one: `--mode always`, or Settings › Agents › Keep
   agents running after logout › Apply.)
5. `./bin/acme service install`: one admin password. It ends `✓ <label>
running (always)`.
6. `./bin/acme doctor`. The service row says `always (system)`, and the
   agent sign-in row says `token` with the date it was set. Neither says
   "agents will not be able to sign in after logout".
7. `plutil -p /Library/LaunchDaemons/<label>.plist` and the `.sessions`
   plist: `UserName` is you, `EnvironmentVariables` has
   `DEN_AGENT_SIGNIN => token`, and no token value.

## Start an agent

8. Start one agent from the Agents page (any persona, in a test project).
   Give it a prompt that takes a while, or one that waits.
9. Note its name and its process start time:
   `ps -o pid,lstart,command -ax | grep -i claude`. Note the boot time
   (`sysctl kern.boottime`) and the time now
   (`TZ=America/Los_Angeles date`).

## Log out and back in

10. Apple menu › Log Out. Wait at least `ui.restart_wait_seconds` (90 s)
    at the login window.
11. Optional, from another machine over ssh while logged out:
    `./bin/acme agents list -w <project>` shows the agent running, and
    `curl -s <web.url>/api/server-info` answers.
12. Log back in.

## After

13. The agent from step 8 is still running: same pid, and a start time
    before the logout (step 9). Its terminal shows it kept working, and it
    answers a new prompt without asking to sign in.
14. The bell has "While <title> was away, N kept running and M came back:
    <names>", and `<names>` includes the agent from step 8.
15. `./bin/acme doctor` again: as in step 6.

## Fail-closed check (optional)

16. Clear the token: `./bin/acme agents token clear` (it asks y/N), or
    Settings' Clear beside Save. Then start a new agent. The start warns: "agents will not be able to sign in after
    logout". `doctor`'s agent sign-in row warns the same, and
    `agents token status` warns under mode always. Set it again with
    `agents token set`.

## Record

Write the result on the issue (built, real logout shown or not): the Den
version, the mode, each step's outcome, the agent's pid and start time
against the boot and logout times, and the bell's text. Never paste the
token or the store's output.
