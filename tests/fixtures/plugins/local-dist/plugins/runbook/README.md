# Team runbook

A browser-tier page plugin: the team's runbook, in the shell's Verify group.

- **May touch:** a nav entry (`ui.nav`) and read-only `/api/*` (`api.read`).
- **Never:** it never calls an action route, never reads secrets and never
  fetches from another host.
