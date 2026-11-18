# Hub contract fixtures

This folder holds the shape of each request Den makes to Hub, one folder per Den version. Hub's contract suite reads these files to test Hub against real Den requests, including older Den versions (its skew matrix).

The files hold shapes only. They have no data and no tokens, and no names of real organizations, apps or hosts.

## The handshake

Den sends these three headers on every call to Hub, the connect calls included:

| Header               | Value                                                                                                                                                          |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `X-Den-Version`      | Den's exact version (semver), from its `package.json`.                                                                                                         |
| `X-Den-Protocol`     | A whole number, starting at 1. It goes up only when a request or reply shape changes in a way that breaks the other side.                                      |
| `X-Den-Capabilities` | Capability names: lowercase, sorted, comma-separated, no spaces. The list lives in `src/shared/hub-compat.ts` (`DEN_CAPABILITIES`), with one comment per name. |

Den's proxy for agents drops any copy of these headers that an agent sets. Den's own values always win.

Hub answers with `X-Hub-Version`, `X-Hub-Protocol` and `X-Hub-Compat` (`ok`, `degraded` or `unsupported`), plus `X-Hub-Compat-Reason`:

- Den keeps the latest answer for each Hub.
- `degraded` and `unsupported` show on the Hub row in Settings and in `doctor`, with Hub's reason.
- `unsupported` means Den sends Hub reads only. Den refuses a write before any of it is sent, so a write is never partial. Calls under `/connect/` still go, so a person can reconnect or disconnect.
- A Hub that sends no `X-Hub-Compat` (an older Hub) counts as "not reported". That is never an error.
- Den's code branches on capabilities, never on version arithmetic.

## The format

```
docs/hub-contract/
  README.md
  den-<major.minor.patch>/
    manifest.json
    <call>.request.json
  hub-<exact semver>/      Hub's response fixtures, by pull request
```

`manifest.json`:

```json
{
  "den_version": "<exact semver>",
  "protocol": 1,
  "capabilities": ["<name>", "..."],
  "exported_at": "<iso8601 of the export>",
  "generator": "scripts/hub-contract-export.mjs"
}
```

`<call>.request.json`:

```json
{
  "method": "POST",
  "path": "/api/installs/self/deliveries/:id/ack",
  "headers": { "Authorization": "Bearer <token>", "X-Den-Version": "..." },
  "body": { "state": "done", "version": 1 },
  "body_schema": { "$schema": "https://json-schema.org/draft/2020-12/schema" }
}
```

- `path` is the path and query on Hub. A `:name` segment stands for a value, such as `:id`.
- `headers` holds every header Den sets, sorted by name. The three handshake headers carry the values from the export, the exact version included.
- `body` is the JSON body, or `null` when there is none.
- `body_schema` is optional. When present, it is a JSON Schema (2020-12) for the body.

A Den folder is named for the version without its pre-release or build part. Versions `0.4.71-dev.1`, `0.4.71-dev.3` and `0.4.71` all use `den-0.4.71/`, so a dev bump needs no new export. Inside the folder, `manifest.den_version` and the `X-Den-Version` header keep the exact version the export ran at.

## Placeholders

Every value that would be data is a placeholder:

| Placeholder | Stands for                                     |
| ----------- | ---------------------------------------------- |
| `<token>`   | A token, code or PKCE verifier                 |
| `<uuid>`    | An id: an agent, a Hub project, an MCP session |
| `<team>`    | A GitHub owner (organization or user)          |
| `<project>` | A project's slug or name                       |
| `<iso8601>` | A time (UTC)                                   |
| `<sha>`     | A commit or content hash                       |
| `<host>`    | A host name                                    |

## The calls

| File               | Den's code                          | What it is                                               |
| ------------------ | ----------------------------------- | -------------------------------------------------------- |
| `connect-token`    | `hubExchange`                       | Trades the one-time code for the install's token (PKCE). |
| `connect-revoke`   | `hubRevoke`                         | Revokes the install's token (Disconnect).                |
| `mcp-initialize`   | `fetchHubTools`                     | Den's own MCP `initialize`, before it reads Hub's tools. |
| `mcp-tools-list`   | `fetchHubTools`                     | Den's own MCP `tools/list`.                              |
| `install-projects` | `hubPutProjects`, `projectSyncBody` | The install's project map.                               |
| `delivery-ack`     | `hubAckDelivery`, `ackBody`         | A delivery's state.                                      |

Den doesn't make the following agreed calls itself, so they have no file: `mcp-hub_whoami`, `mcp-hub_search`, `mcp-hub_artifact_create` and `mcp-hub_ask` (held). An agent makes these MCP `tools/call` requests through Den's proxy (`/hub/mcp`). Den passes the agent's body as the agent sent it. Den sets only these headers:

- `Authorization` with the install's token;
- `X-Den-Agent`, `X-Den-Agent-Id`, `X-Den-Session`, `X-Den-Workspace`, `X-Den-Repos`, `X-Den-Project`, and `X-Den-Scope` for the server agent;
- the three handshake headers.

It passes on the agent's `Accept`, `Content-Type`, `Mcp-Session-Id`, `Mcp-Protocol-Version` and `Last-Event-ID`.

Connect's first step (`/connect/authorize`) is a browser navigation to Hub, so Den can't set headers on it. Its handshake starts at `connect-token`.

## How the folder is made

`npm run hub-contract:export` runs `scripts/hub-contract-export.mjs`. The script builds each request with the same code that sends it: it calls Den's real functions with placeholder inputs and a fetch that records the request instead of sending it. Then it writes `den-<major.minor.patch>/`. Nobody writes these files by hand.

- The export keeps three versions per side: the newest three `den-*` folders. It removes older ones.
- `tests/unit/shared/hub-contract.test.ts` builds the requests again and compares their shapes with the folder for the version in `package.json`. It compares methods, paths, bodies and header names and values. It checks `X-Den-Version` and `manifest.den_version` only by their format, so a folder exported at one dev version still holds after the next dev bump. The test fails when a request changes without a new export. Run the export and commit the folder with the change.
- A dev bump keeps the same folder. A new patch, minor or major version needs a new folder, so the release commit runs the export.

## Hub's folders

Hub's response fixtures arrive by pull request to this repository, in `hub-<major.minor.patch>/` folders. They follow the same rules: shapes only, the same placeholders, and three versions kept.
