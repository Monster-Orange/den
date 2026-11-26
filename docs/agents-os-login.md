# Agents under their own OS login

With `agents.os_login: on` in `config/local/user.yml`, agents run as a second
OS user, not as the person. That is the boundary between the person and their
agents: an agent can't read the person's files, keychain or Den's state.

It is off by default. The person turns it on once, at setup. Only user.yml
holds the setting, which agents can't write: set in the distribution's
`den.yml`, it is refused. Turning it off through `setting_change` widens what
agents can do, so it needs the person's Allow.

## What setup makes

`agents os-login setup` shows the person every step, then runs them with sudo.
`agents os-login remove` undoes each one, and `doctor` checks them all.

One agents user and one group per person:

|       | agents user            | group           |
| ----- | ---------------------- | --------------- |
| Linux | `den-agents-<person>`  | `den-<person>`  |
| macOS | `_den_agents_<person>` | `_den_<person>` |

On macOS both are hidden, with system ids. The agents user has no sudo, no
login shell and no home outside Den's agent files.

Under `/opt/den/<person>`:

| path                   | owner, mode        | what                                                 |
| ---------------------- | ------------------ | ---------------------------------------------------- |
| `bin/`                 | root, 0755         | so is every folder above it                          |
| `bin/den-agent-launch` | root, 0555         | the only thing the person may run as the agents user |
| `home/`                | agents user, 0700  | the agents user's home, and its only one             |
| `agents/`              | person:group, 3770 | the agent files (sticky)                             |

And `/etc/sudoers.d/den-<person>` (root, 0440) holds one rule, with no
password, no `ALL` and no wildcard in the command:

```
<person> ALL=(<agents user>) NOPASSWD: <launcher>
```

Root writes the launcher and the rule from stdin, out of Den's memory, then
reads them back: never from a file anyone else can write. Den's state folder
stays the person's at 0700.

## The launcher

It takes one agent id (Den's pattern) and Den's launch nonce (32 lower-case
hex). It clears the environment down to an allowlist (`LAUNCH_ENV`) and runs
only the runtime written into it at setup:
`<runtime> agents session <id> <nonce>`. The nonce is good for one token
write, so seeing it in `ps` gives nothing.

## An agent's launch files

Den's server runs as the person and writes, for each agent:

| path                      | owner, mode        | what                                     |
| ------------------------- | ------------------ | ---------------------------------------- |
| `agents/<id>/`            | person:group, 2750 | the person writes; the agents user reads |
| `agents/<id>/launch.json` | person, 0640       | what `agents session` starts             |
| `agents/<id>/own/`        | person:group, 2770 | the agent's own files (handoff, notes)   |

So the agents user reads its launch file and can't change, rename or add one.
No sudo is needed after setup. `launch.json` never holds a secret, and an env
name that looks like a secret's is refused before anything is written.
`doctor` and `agents session` run the same check on these files.

## Starting a session

`agents session <id> <nonce>` runs as the agents user, in this order, so a bad
launch file never gets a token:

1. the agent's launch files, only if they pass the check;
2. the sign-in token, on the session's terminal, after Den's nonce marker;
3. its own temp folder, `<home>/t/den-XXXXXX` at 0700;
4. the runtime, in the agent sandbox, with the token in its environment only.

A sandbox that can't start ends the launch: an agent never runs unsandboxed.
The temp folder goes when the runtime ends, however it ends.

The agents user's own sandbox policy is not in yet, so for now step 4 always
refuses and no agent starts this way.
