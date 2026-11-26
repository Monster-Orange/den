# Move an install to another machine

This page moves a whole Den install, with its projects, agents and their conversations, from
one machine (the old host) to another (the new host). Its address stays the same, and its
agents pick up where they left off.

Some steps still have no Den command. Each of those links the issue that adds one. Until it
ships, an agent does that step; the person never edits DNS, proxies or files by hand.

`<cli>` below is your install's command (`den`, or your distribution's).

- [Before you start](#before-you-start)
- [1. List the secrets and identities](#1-list-the-secrets-and-identities)
- [2. Prepare the new host](#2-prepare-the-new-host)
- [3. Carry what doesn't change while it runs](#3-carry-what-doesnt-change-while-it-runs)
- [4. Cut over](#4-cut-over)
- [5. Start on the new host](#5-start-on-the-new-host)
- [6. Move the address](#6-move-the-address)
- [7. Stop the old host's copy](#7-stop-the-old-hosts-copy)
- [8. Check](#8-check)
- [Roll back](#roll-back)

## Before you start

- Both machines are on the same mesh (for example Tailscale), and the old host can SSH to the
  new one.
- The new host has Docker, Node, git and the agent runtime (for example Claude Code) installed,
  and its desktop login is running. Den's services and agents run in that login (launchd on
  macOS). An SSH session can't unlock the macOS login keychain, so anything that reads or writes
  a keychain secret runs in the desktop login, not over SSH.
- Run `<cli> doctor` on the old host and note what it says, so you can compare after.

## 1. List the secrets and identities

Before anything moves, list every secret and identity the install uses, by name only. Never
print a value. For each one, choose: a new one per machine (preferred, so each machine's can be
revoked on its own), or carry the existing one over.

| What | Where Den reads it | Usually |
|---|---|---|
| Secrets backend token (1Password service account, Doppler sign-in, …) | `secrets` in user.yml, often `keychain:<item>` | New per machine. A 1Password service account reaches only the vaults it was given when it was made, so check the new host's account can read the vaults you need. If it can't, the person decides between a new account and carrying the old token. |
| Hub install token | `hub.token` in user.yml, often `file:<path>` | Carry today; a per-machine token is [issue 1267](https://github.com/Monster-Orange/den/issues/1267) |
| Den's web secret, owner record, actor tokens, browser sessions | the state dir | Carry, so signed-in browsers keep working |
| Agent runtime sign-in | the runtime's own login | New per machine (one browser sign-in) |
| GitHub (gh, git over https) | gh's keyring | New per machine (one device code) |
| Agents' commit-signing key | git config `user.signingkey` | New per machine, added to GitHub as a signing key |
| Edge TLS | `edge.tls` | A certificate issued by DNS challenge: let the renewer issue it again on the new host, or carry its files. A private CA (`tls: mkcert` with its own CAROOT): carry the CA as is, so devices that trust it keep working; the new host trusts it once with `<cli> edge trust`. |
| DNS provider token for certificates | the renewer's token file | Carry from the secrets backend |
| Each repo's local secrets (`.env` files a repo builds from its secrets backend) | the repos | Build again on the new host from the backend; copy only files the backend can't rebuild |

A token that is carried now lives on two machines. Rotating it means updating both, until the old
host's copy is retired. Write that down where the install's owners will see it.

Put every step only the person can do (a browser sign-in, an admin password, a new service
account) in one short list, and ask once.

Carrying a keychain secret: move it from the old host's keychain to the new host's without it
ever being in a command line, a file or a log. For example, pipe it into `security -i` on the new
host, run in its desktop login. Store it under its own item name if the new host already has an
item by that name, and point the install's config at it. A held write for this is
[issue 1265](https://github.com/Monster-Orange/den/issues/1265).

## 2. Prepare the new host

1. Clone the install's repo (your distribution repo, or the folder Den runs from) to the same
   path, and run `npm ci` there.
2. Check out each project repo at the same path, branch and commit as on the old host
   (`<cli> repo clone` for a missing one). Leave the new host's own uncommitted work alone: set it
   aside under another name, never overwrite it. Branches that exist only on the old host can be
   pushed straight to the new host's repo over SSH.
3. Install the secrets backend's CLI if the install uses one.

## 3. Carry what doesn't change while it runs

While the install still runs on the old host, copy across:

- `config/local/` (user.yml, workspaces.yml, the service catalog). It holds references to
  secrets, not their values.
- The edge's certificate and CA folders, and the renewer's token file.
- Container volumes for stacks that are stopped. Create each volume on the new host with the same
  name and its Compose labels (`com.docker.compose.project`, `com.docker.compose.volume`), then
  stream a tar of it across. Carrying volumes as part of the move is
  [issue 1268](https://github.com/Monster-Orange/den/issues/1268).

A large folder of worktrees can be copied now and again at cut-over: the second copy sends only
what changed.

## 4. Cut over

1. Stop the install's agents on the old host: unload the sessions job (`launchctl bootout` on
   macOS), so launchd doesn't start the session host again, and confirm `<cli> sessions list`
   shows nothing running. Keep the old host's web page and edge up until the new host answers.
2. Copy the state dir to the new host, without its runtime files (`bin/`, `logs/`, `web.json`,
   `sessions.sock`, `daemons.json`, `den-procs/`, `sessions/`, `web-boots.json`) and without
   any `*.lock` file (`web-sessions.lock`, `sessions.lock`, `verify/schedules.lock`). A lock is
   judged stale by whether its pid runs on this machine, so one copied from the old host can
   hold up sign-in writes on the new one. A person who signs in on the old host after this copy
   signs in again on the new one.
3. Copy each agent's conversation file from the agent runtime's folder (for Claude Code, the
   transcript named by the agent's resume token, under `~/.claude/projects/<agent folder>/`).
   Without it the agent can't resume on the new host.
4. Carry the folder trust the person already gave, for the agents' folders only (for Claude
   Code, `hasTrustDialogAccepted` in `~/.claude.json`). Never grant a folder the person didn't
   trust on the old host. An agent whose folder isn't trusted waits on the runtime's "trust this
   folder?" prompt, and Den rings the bell for it.
5. Copy the agents' worktrees: branch heads and uncommitted changes, at the same paths, or the
   whole folder again if you copied it in step 3.

One export and one import for all of this is
[issue 1265](https://github.com/Monster-Orange/den/issues/1265).

## 5. Start on the new host

1. Point the secrets reference in user.yml at the new host's item if it changed.
2. `<cli> service install --mode login` starts Den's web service in the desktop login. Den brings
   back the agents that were running, each in its own conversation.
3. Create the Docker network the edge joins if it doesn't exist yet
   (`docker network create <network>`; the network is in `edge.docker_labels.network`), then
   `<cli> edge up`.
4. Start the certificate renewer if the install has one.
5. If another proxy owns the new host's ports 80 and 443 (`edge.publish: false`), route the
   install's names to its edge there. `<cli> edge route --for <proxy>` prints the route.

## 6. Move the address

The address is one split-DNS name: it resolves to 127.0.0.1 on the machine that runs the
install, and to that machine's mesh IP everywhere else (`web.url` is required, never
localhost).

1. Point the mesh DNS answer for the install's zone at the new host's mesh IP.
2. Check from a third device on the mesh that the name now reaches the new host.
3. On the new host itself, the name should resolve to 127.0.0.1.

Den doesn't change the DNS record yet: [issue 1266](https://github.com/Monster-Orange/den/issues/1266)
adds that, as a held write. A local resolver on the host, so its own name is loopback there, is
[issue 1276](https://github.com/Monster-Orange/den/issues/1276). Until 1276 ships, the host may get
its own mesh IP back. That works, because the traffic stays on the machine.

## 7. Stop the old host's copy

Once the new host answers by name:

1. `<cli> service uninstall` on the old host. It removes the web and sessions jobs. A bare
   `launchctl bootout` is not enough: the job files stay, and the next login or reboot starts
   the old copy again next to the new one, both resuming the same conversations. Rolling back is
   `<cli> service install`.
2. `<cli> edge down` on the old host, and stop its certificate renewer.
3. Hub tokens stay as they are. Revoking the old host's copy waits for
   [issue 1267](https://github.com/Monster-Orange/den/issues/1267).

## 8. Check

On the new host:

- `<cli> doctor`: the secrets backend is available, Hub is connected, the owner is linked, and
  nothing new is red compared with the old host's run.
- `<cli> sessions list`: every agent that was running is running.
- Each agent answers a message.
- From another device: the address gives the sign-in page, with a certificate the device trusts.

## Roll back

1. On the new host: `<cli> edge down`, then `<cli> service uninstall`, for the reason step 7
   gives.
2. Point the DNS answer back at the old host's mesh IP.
3. On the old host: `<cli> service install`, then `<cli> edge up`.

The old host's state dir was never changed by the move, so it starts where it stopped. Anything
the agents did on the new host in between stays there.
