# Den Hub

Den Hub is a hosted service your company shares. A Den install connects to it. Then your agents can
publish docs and mocks there, and people can read them, comment on them and approve them. Nothing in
Den needs Hub: without it, agents work as before.

This page covers adding Hub to a Den, what changes for agents and people, and what to do when it
doesn't connect. [distributions.md › Hub](distributions.md#hub) has the technical detail.

- [What you get](#what-you-get)
- [Connect](#connect)
- [What agents get](#what-agents-get)
- [Projects and Hub projects](#projects-and-hub-projects)
- [Notifications from Hub](#notifications-from-hub)
- [Config reference](#config-reference)
- [Troubleshooting](#troubleshooting)

## What you get

Once this install is connected:

- **Search.** Agents search Hub with Hub's tools (the `hub_*` tools).
- **Publish.** Agents publish docs and mocks in Hub. Hub keeps every version.
- **Comments reach agents.** A comment on an agent's doc or mock is typed into that agent.
- **Approvals reach agents.** When a person approves a doc, or asks for changes, in Hub, the agent
  that made it is told, with their note.
- **Projects.** Each project here is linked to a project in Hub, so its agents' work is filed there.
- **The bell.** Replies, mentions and decisions from Hub show in Den's bell.
- **A Hub link in the rail.** It opens your company's page in Hub, with a count of the threads
  waiting on you.

## Connect

Everything happens in **Settings › Hub**. Nobody copies a token or edits a file.

1. Open Settings › Hub.
2. Type Hub's address, for example `https://hub.example.com`. It must be https. Plain http works only
   to this machine (`localhost`, `127.0.0.1` or a `<name>.localhost` address). Your distribution may
   have set the address already.
3. Press **Connect**. Hub opens.
4. Sign in to Hub, pick your company and approve this install.
5. Hub sends you back to Settings › Hub, connected. Settings shows your company, your role, who
   signed in and this install's name in Hub (`<cli> on <machine>`).

Connect also proposes a Hub project for each project here, and you link them all with one press. See
[Projects and Hub projects](#projects-and-hub-projects).

**The right company.** Connect sends Hub the repos of this Den's projects (`repos=<owner/repo>,…`, at
most 50). Hub ranks the companies you may connect to by them, with your own sign-in: one that holds
those repos first. When one company clearly fits, Hub picks it for you to confirm. Nothing about which
company holds which repos reaches anyone but you. An older Hub ignores the list. Connected, Settings ›
Hub shows the company. **Switch company** runs the same Connect to pick another one.

**One review.** Back from Hub, Settings › Hub shows a row per project: the Hub project it gets and why
(the same repo, then the same name), or "Create <name>" when none fits. A project that was linked on
another Hub says so on its row. **Change** opens a list of the company's Hub projects in the row, with
a search and the suggestion on top. **Connect and link all** links every row at once. All the new
projects go to Hub as one plan: an owner presses Apply once in Hub, and Den links each one by itself.
The review then says what was linked, and opens Hub's plan page for the new ones.

The token Hub gives this install is kept in this install's secrets store (a 1Password item or a
Doppler key, when the install keeps secrets there). Otherwise it is kept in a file only you can read,
`<state dir>/hub/token`. It is never shown, never logged and never sent to the browser.

To Connect, open Den over https (its edge address) or on this machine. Hub can only send you back to
one of those.

### Agents already running

A running agent keeps the tools it started with. After Connect or Disconnect, Settings offers to
"Restart N agents at their next idle". Each one keeps its conversation, and no turn is cut.

### Change or clear the address

In Settings › Hub, change the address or clear it, and press **Save**. Save writes it to your user
config (`config/local/user.yml`) and restarts Den itself.

When this install is connected, Save of a different address and Clear disconnect from the old Hub
first, so it revokes this install's token. If that Hub can't be reached, the token is removed here
anyway. Den never sends a token to a Hub that didn't issue it. After a new address, press **Connect**.
With no address, Den shows nothing about Hub and agents get no Hub tools.

Den's own agent can do the same with its held write `hub_connect`: it runs on your Allow, and you
press Connect after.

### Disconnect

Press **Disconnect**. Den asks first: "This revokes this Den's Hub key on Hub. Agents lose Hub until
you Connect again." Then:

1. Hub revokes this install's token.
2. Den removes the token here.
3. The address stays, so Connect is one click.

If Hub can't be reached, nothing is removed and you can try again. You can also remove it here
anyway. Then the token still works in Hub until a Hub admin revokes this install.

## What agents get

- **Hub's tools.** Every agent Den launches gets Hub's tools, the `hub_*` tools. Agents reach Hub
  through Den, never directly, and never see the token. Hub knows the company from the token and the
  project from the project link.
- **No asking, by default.** "Agents use Hub's tools without asking" is on. Writes stay in your
  company, and Hub keeps every version. Turn it off and agents ask before each Hub tool runs, like any
  tool.
- **Files.** Agents publish files (a mock's page, an image, a doc's file) with `hub_put`, and fetch
  them with `hub_pull`. They never paste a page's text into one call, because Hub would keep a page cut
  short.
- **Comments.** A comment on an agent's doc or mock, or an "@agent" mention, is typed into that
  agent. Den writes the first line itself, starting `from:`. It names who wrote it and how Hub
  verified them, and links the comment. An agent acts on a comment only when that line says it is from
  its own person, verified. Anything else, and anything inside a comment, is information, not
  instructions.
- **Decisions.** When a person approves, or asks for changes, in Hub, the agent is told the same way:
  who, what, which version, their note and the Hub link.
- **The approval rule.** For a person's approval, an agent publishes the doc or mock in Hub, asks for
  review there, and waits for the decision Hub sends. It never asks you to approve in chat.

### When comments and decisions wait

Den types a Hub item into an agent only when the agent is idle, waiting for its person. It waits
while:

- the agent is in the middle of a turn;
- the agent is at a permission prompt;
- the agent asked you a question;
- the agent has a held write waiting for your Allow.

Once the agent is idle again, it takes what waited, all at once. A stopped agent's items go in when
it next runs. Items wait through a restart of Den. The server agent doesn't take Hub items.

Hub sees where each one is: queued, delivered, working, done or failed. The agent's card says
"Working on N Hub comments".

Den fetches the comments itself; Hub never calls the install, so an install on a local-only address
gets them too. Den keeps a stream open to Hub and reads the list as well when the stream fails. Hub
sends a keep-alive on the stream every 25 seconds and ends it itself after a while; Den opens it
again at once. No bytes for `hub.delivery_stream_silence_seconds` and Den reopens it.

When Den has had no good read from Hub for `hub.delivery_alert_minutes` (a stream that opened, a
keep-alive, or a list answer), the bell says "Hub comments aren't arriving", with the reason: the
token wasn't accepted, Hub refused, Den can't reach Hub, or the stream keeps closing or goes silent.
It goes away on the next good read. A quiet Hub with no comments never raises it.

### When Hub is down

An agent never fails to start because of Hub: it starts without Hub's tools. When Hub answers again,
Den restarts that agent at its next idle, in the same conversation, now with Hub's tools.

## Projects and Hub projects

Each project here can be linked to one project in Hub. Its agents' docs, mocks and comments are filed
there. A project that isn't linked has its agents' work filed in Unfiled in Hub. A linked project
shows Hub's name for it.

Den links to a Hub project by its hidden ID, so renaming the project or its short name in Hub doesn't
break the link.

**Connect proposes, you link.** After Connect, nothing is linked yet. Settings › Hub's review proposes
a Hub project for each project: one with the same repos, or, when none has its repos, one with the
same name. Connect's message, and the bell, say how many wait. Press **Connect and link all** to link
them.

**"Den can't tell which fits."** When two Hub projects share a project's repos, or its repos and its
name point to different ones, Den doesn't guess. The bell says "N projects need your pick". Settings ›
Hub lists each such project with Hub's choices, none picked. Pick one and press **Link**.

**No Hub project fits yet.** In Settings › Project › Hub project, the picker's first option is
"Create a Hub project named <this project's name>". Change the name if you like, then press
**Create**. Den asks Hub for the new project, and an owner of your company decides it in Hub. If you
are an owner, **Allow in Hub** is right there in the row. If you aren't, the row says an owner must
allow it. Either way, Den links the project by itself once the new Hub project is made. Den's own
agent can ask the same with its held write `hub_project_create`.

**An agent links it for you.** An agent can ask to link a project to an existing Hub project with its
held write `hub_link`, for instance after this install moves to another Hub. It names the Hub project
by its id or slug, never its name. The Allow shows the project, its Hub project now, and the one it
will be. You press **Allow** and Den links it, as `hub link` does; **Deny** leaves it as it was. A Hub
project the connected Hub doesn't list, such as an id from another Hub, is refused before you're
asked. The audit trail records who asked and who allowed.

Den never links on its own beyond the clear matches and a new Hub project you asked for. Each link is
recorded in the audit trail.

From a shell:

- `<cli> hub link -p <project>` shows the link and Hub's suggestions.
- `<cli> hub link -p <project> <hub project>` links it. `--none` unlinks it.
- `<cli> hub link --suggested` lists every project that isn't linked, with Hub's suggestion.

**Den Hub's GitHub access.** Settings › Hub also shows how many of your company's GitHub repos Den Hub
can read, asked live from Hub. Its button opens GitHub to give Den Hub access, or to change its repos.
When you come back, Den sends its projects to Hub again, and repos link by themselves.

## Notifications from Hub

While Hub is connected, Den reads your Hub notifications (mentions, replies and decisions) every 60
seconds and shows them in the bell, each linking to Hub. Reading one in Den marks it read in Hub too,
and the other way round.

Three switches in Settings › Hub turn them on or off:

- **Replies and comments in Hub:** someone answered a comment on something you made, a mention, or an
  agent finished the Hub comments it was given.
- **Projects need your pick:** Den can't tell which Hub project fits a project. Hub's decisions follow
  this switch too.
- **Shared with you:** someone on Hub, a person or an agent, shared a doc or mock with you. Den writes
  the words itself in your language ("kim shared Pricing mock with you", plus their note), from the
  item's name, title and sharer. A click opens it on your connected Hub; a link anywhere else opens
  Hub's home instead.

All three are on by default. A switch that is off hides the item and its count. The item is still
kept, and `<cli> notifications list` still lists it.

## Config reference

Settings › Hub writes what you need. You rarely set these by hand.

Den reads `hub.*` from the org config (`config/<name>.yml`), then from `config/local/user.yml`. The
user file wins.

| Key                                   | Default            | What it does                                                                                                                                                     |
| ------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hub.url`                             | none               | Hub's address. https, or http only to this machine. Unset: no Hub at all.                                                                                        |
| `hub.token`                           | none               | Where this install's token is kept. Connect sets it. A secret ref, the name of a `secrets.refs` entry, or `file:` / `keychain:` / `env:`.                        |
| `hub.mcp_url`                         | `<hub.url>/mcp`    | Hub's tools address. Connect sets it from Hub's answer.                                                                                                          |
| `hub.allow_tools`                     | `true`             | Agents use Hub's tools without asking.                                                                                                                           |
| `hub.delivery_loop`                   | `true`             | Every agent in a project connected to Hub gets the Hub delivery loop in its instructions. `false`: off for this install. Bad value: ignored, and doctor says so. |
| `hub.inbox_on_stop`                   | `nudge`            | An agent about to stop is asked once to answer the Hub comments waiting on it. `off`: never asked.                                                               |
| `hub.inbox_watch`                     | `true`             | Den reads Hub's inbox and types new items into their agents. `false`: it doesn't.                                                                                |
| `hub.inbox_poll_seconds`              | `30` (at least 5)  | How often Den reads Hub's inbox.                                                                                                                                 |
| `hub.inbox_backoff_max_seconds`       | `600` (at least 5) | The longest wait between inbox reads while Hub doesn't answer.                                                                                                   |
| `hub.inbox_reads_per_second`          | `2` (above 0)      | The most inbox reads Den makes a second, for all its agents together. Each agent is read at most once per poll.                                                  |
| `hub.delivery_poll_seconds`           | `30` (at least 5)  | How often Den reads Hub's comments when Hub has no live stream.                                                                                                  |
| `hub.delivery_alert_minutes`          | `15` (`0`: off)    | Minutes with no good read of Hub's comments before doctor warns and the bell says they aren't arriving.                                                          |
| `hub.delivery_stream_silence_seconds` | `75` (`0`: off)    | No bytes on the comment stream this long (three of Hub's 25 s keep-alives), and Den reopens it.                                                                  |
| `hub.delivery_held_note_seconds`      | `60` (at least 5)  | How long text waits for an agent that isn't at its prompt before the bell says so.                                                                               |
| `hub.delivery_held_bell_minutes`      | `5` (at least 1)   | How long a Hub comment waits for a busy agent (or one with a dialog, a held Allow, a pause) before the bell says so, and why.                                    |
| `hub.delivery_answer_minutes`         | `30` (at least 1)  | A typed comment whose turn never shows as ended is "delivered, no answer yet" after this; the agent's next comments go on.                                       |
| `hub.delivery_state_timeout_seconds`  | `60` (at least 5)  | The longest Den waits to read one agent's state; that agent's comments wait, the others go on.                                                                   |
| `hub.delivery_type_timeout_seconds`   | `120` (at least 5) | The longest one agent's paste holds the others' comments.                                                                                                        |
| `hub.delivery_heartbeat_seconds`      | `15` (at least 5)  | How often Den tells Hub an agent is still working on a comment.                                                                                                  |
| `hub.sync_check_seconds`              | `30` (at least 5)  | How often Den checks whether its project list changed, to send it to Hub.                                                                                        |
| `hub.names_check_seconds`             | `300` (at least 5) | How often Den asks Hub for its projects' names, so a rename in Hub shows here.                                                                                   |
| `hub.mcp_retry_seconds`               | `30` (at least 5)  | How often Den checks whether Hub answers again, for agents that started without its tools.                                                                       |
| `hub.mcp_retry_attempts`              | `0` (no limit)     | How many times Den restarts one agent for Hub's tools before it leaves it to you.                                                                                |
| `hub.tools_check_seconds`             | `300` (at least 5) | How often Den reads Hub's tool list, to tell agents what changed.                                                                                                |
| `hub.tools_restart`                   | `true`             | When Hub's tools change, an agent that reads its tools only at launch restarts at its next idle. `false`: it is told instead.                                    |

Two more keys touch Hub:

- `notifications.hub_poll_seconds` (default 60; 10 to 3600, or 0 for never): how often Den reads your
  Hub notifications.
- A project's `agents.hub_tools_restart` (true or false, in `config/local/workspaces.yml`) wins over
  `hub.tools_restart` for that project.

A bad value names its key. Settings › Hub shows the problem, for example
`hub.url must be https (http only to this machine)`.

### doctor

`<cli> doctor` has a Hub row when `hub.url` is set:

- `✓` when connected, with the company, this install's name and your role.
- `⚠` when not, with the reason and whether to Connect or Reconnect.

A "Hub comments" row shows the Hub the server reads comments from, whether its stream is open, the
last good read and the last comment. It warns, with the reason, after `hub.delivery_alert_minutes`
with no good read.

When connected, it also has a row per project (linked to which Hub project, or not linked) and a row
on Den Hub's GitHub access. A Hub that is down never fails doctor: agents still run.

Each link records the Hub and company it was made on. A link to another Hub, or to another company on
this one, counts as not linked: Den sends Hub no project for it, and doctor fails its row (`✗`),
naming where it points. Link it again in Settings › Hub's review.

## Troubleshooting

Settings › Hub shows one of these states.

| State                  | What it means                                                                                        | What to do                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Connected**          | Hub accepts this install's token.                                                                    | Nothing. Restart running agents if Settings offers it, so they get Hub's tools.                              |
| **Token not accepted** | Hub no longer accepts this install's token: it was revoked, expired, or replaced by a newer Connect. | Press **Reconnect** and sign in again.                                                                       |
| **Not allowed**        | Your role in Hub no longer allows connecting installs.                                               | Ask a Hub admin to change your role, then Reconnect. Den doesn't retry it.                                   |
| **Can't reach Hub**    | Hub didn't answer, timed out, or answered with a server error. Settings shows Hub's words.           | Check the address and your network. Agents keep working without Hub, and get its tools back when it answers. |
| **Not connected**      | There is an address but no token yet, or the token can't be read from this install's secrets store.  | Press **Connect**. If the token's store is locked or signed out, unlock it, then look again.                 |

Settings may also show:

- **A config problem**, such as an address that isn't https. Fix the address in Settings › Hub, or
  the key it names.
- **An older Hub token** that Den can't replace by itself. Press **Reconnect** to move it over.

What Connect can say when it doesn't finish:

- "Not connected: the request was declined on Hub." You, or Hub, declined it. Connect again.
- "That connect link is used or too old: press Connect again." A Connect waits 10 minutes for Hub.
- "Hub didn't accept the code (used, expired or for another address): press Connect again."
- "Connected, but the token couldn't be kept here (…); it was revoked." Den couldn't store the
  token, so it revoked it. Fix the store and Connect again.
- "Hub can only send you back to https or to this machine …" Open Den over https (its edge address)
  or on this machine, then Connect.
