# Agents under their own OS login

With `agents.os_login: on` in `config/local/user.yml`, agents are to run as a
second OS user, not as the person. That is the boundary between the person and
their agents: an agent can't read the person's files, keychain or Den's state.

Not in use yet: setup makes the login and doctor checks it, but Den's server
doesn't start agents through it until a later slice. Until then agents still
run as the person, and setup and doctor say so.

It is off by default. The person turns it on once, at setup, by answering yes
at a terminal: a piped yes is refused. The admin password is asked only when
the first sudo step runs. `remove` turns it off only once nothing is left. Only user.yml
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

| path                   | owner, mode        | what                                                   |
| ---------------------- | ------------------ | ------------------------------------------------------ |
| `bin/`                 | root, 0755         | so is every folder above it                            |
| `bin/den-agent-launch` | root, 0555         | the only thing the person may run as the agents user   |
| `home/`                | agents user, 0700  | the agents user's home, and its only one               |
| `agents/`              | person:group, 2750 | the agent files: the group reads, only the person adds |

And `/etc/sudoers.d/den-<person>` (root, 0440) holds one rule, with no
password, no `ALL` and no wildcard in the command:

```
<person> ALL=(<agents user>) NOPASSWD: <launcher>
```

## The person's home

The agents' login must not read the person's home. Doctor fails when the home
has any group or other permission bit, or (on macOS) an ACL entry that lets
someone else in. Setup closes an open home to 0700, as a step it shows. So
Den's runtime must live outside the person's home: setup refuses to start, and
doctor fails, while it is inside.

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

## One login for all of a person's agents

All of one person's agents share the one login. So they can read and write
each other's `own/` folders and see each other's environment. The boundary is
between the person and their agents, not between agents.

When Den's server reads an agent's `own/` files (a later slice), it runs as the
person and reads files the login can write. It opens them with `O_NOFOLLOW`
and checks them with `lstat`, never following a link.

## Before Den starts agents through the login

These hold before the server starts any agent as the agents' login:

1. With `agents.os_login` on, a launch that fails is refused. Den never falls
   back to running the agent as the person.
2. All of a person's agents share one uid, and a process can read the
   environment of another with the same uid (`/proc/<pid>/environ` on Linux,
   `ps -E` on macOS). So a sign-in token is never in a process's environment:
   it comes on an inherited file descriptor. Each `own/` folder can be written
   by every agent, so either each agent (or project) gets its own login, or the
   sandbox denies looking at other processes.
3. The person's Den never trusts or follows a link in `own/`.
4. Every launch checks that the agents' login can't write Den's runtime, or
   any folder above it, before it starts.
