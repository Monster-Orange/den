# make/local_dev.mk — Local Dev environment manager
#
# Manages the Local Dev experience: service clones, workspaces, web UI,
# secrets setup, repo registration, auth configuration, and AWS profiles.

.PHONY: down den-up den-down den-restart den-status den-services \
        den-graph den-logs \
        den-register den-setup den-sync den-workspace \
        den-init den-validate den-local-dev den-setup-secrets den-setup-1password \
        register-repos aws-configure auth-configure \
        web dev-dns

# ── Service management ────────────────────────────────────────────────────────

# Start always_on services in the active workspace.
# Usage: make den-up  OR  make den-up args="shop/api tasks-runner"
den-up:
	@if ! npx tsx scripts/setup-secrets.ts --gate; then \
		echo ""; \
		echo "🔑  secrets.required is set and the secrets backend is not ready."; \
		echo ""; \
		$(MAKE) den-setup-secrets || exit 1; \
	fi
	@./bin/den up $(args)

# Stop services in the active workspace. `make down` is the short form most
# people reach for, so it stops SERVICES; use `make test-down` for Playwright/k6.
# Usage: make down  OR  make down args="files-api -w files-api"
down den-down:
	@./bin/den down $(args)

den-restart:
	@./bin/den restart $(args)

den-status:
	@./bin/den status

# Tail live local logs for a repo's service (offers to start it when down).
# Usage: make den-logs  OR  make den-logs args="shop"
den-logs:
	@./bin/den logs $(args)

den-services:
	@./bin/den services

# Derive and show the system dependency graph.
# Usage: make den-graph  OR  make den-graph args="--all --diff"
den-graph:
	@./bin/den graph $(args)

# Check for updates and pull managed repos.
den-sync:
	@./bin/den sync $(args)

# ── Workspaces ────────────────────────────────────────────────────────────────

# Usage: make den-workspace args="list"
#        make den-workspace args="use feat-streaming"
#        make den-workspace args="create feat-streaming"
den-workspace:
	@./bin/den workspace $(args)

# ── Catalog & repo setup ──────────────────────────────────────────────────────

# Register a repo in the service catalog (interactive).
# Usage: make den-register  OR  make den-register args=/path/to/repo
den-register:
	@./bin/den register $(args)

# Run setup for registered services.
# Usage: make den-setup  OR  make den-setup args="shop tasks-runner"
den-setup:
	@./bin/den setup $(args)

# Scaffold a new .den.yml in a target directory (interactive).
# Usage: make den-init  OR  make den-init args=/path/to/repo
den-init:
	@./bin/den init $(args)

# Heal config/den.yml — fills missing required keys (currently github_org).
# Idempotent. Safe for existing users whose den.yml pre-dates github_org.
den-heal-config:
	@npx tsx scripts/heal-config.ts

# Validate a .den.yml file or URL.
# Usage: make den-validate args=/path/to/repo
#        make den-validate args=/path/to/repo/.den.yml
den-validate:
	@./bin/den validate $(args)

# Toggle the local dev experience on or off (per-engineer, gitignored).
# Usage: make den-local-dev args=on|off
den-local-dev:
	@./bin/den local-dev $(args)

# Set up developer secrets with the configured backend (secrets.provider).
den-setup-secrets:
	@npx tsx scripts/setup-secrets.ts

# 1Password strategy only: populate the "Developer API Keys" item.
den-setup-1password:
	@npx tsx scripts/setup-1password.ts

# Show where test discovery gets its repos. With Local Dev enabled (default)
# it follows the workspace — nothing to register. Hosted / no-local setups get
# the legacy sibling scan (also forceable with args=--legacy), which writes
# config/local/registered-repos.json (gitignored).
register-repos:
	@npx tsx src/scripts/register-repos.ts $(args)

# Map den environments → AWS CLI profiles for CloudWatch logs and re-auth.
# Writes to config/local/aws-profiles.json (gitignored).
aws-configure:
	@npx tsx src/scripts/configure-aws-profiles.ts

# Per-engineer admin 1Password setup — staging/production only.
# Saves config/local/admin-auth-{env}.json (gitignored, no password stored).
auth-configure:
	@E2E_ENVIRONMENT=$(env) npx tsx scripts/auth-configure.ts
	@$(MAKE) int-jwt-clear env=$(env)

# ── Web UI ────────────────────────────────────────────────────────────────────

# Browser-based runner + Local Dev dashboard at http://localhost:<web.port> (default 7777),
# and https://<brand>.<edge.domain> once `edge up` has run. Never opens a browser:
# it prints the address instead.
# PORT=8080 make web          — run on a different port.
# make web silent=true        — suppress request logs (banner still shown).
web:
	@if ! npx tsx scripts/setup-secrets.ts --gate; then \
		echo ""; \
		echo "🔑  secrets.required is set and the secrets backend is not ready."; \
		echo ""; \
		$(MAKE) den-setup-secrets || exit 1; \
	fi
	@echo "🌐 Starting the web UI..."
	@_PORT=$${PORT:-$$(./node_modules/.bin/tsx -e 'import("./src/shared/edge/config.ts").then(m=>console.log(m.readWebPort()))' 2>/dev/null || echo 7777)}; \
	_HOST=$$(grep -q "127.0.0.1 den" /etc/hosts 2>/dev/null && echo "den" || echo "localhost"); \
	_SILENT_FLAG=$$([ "$(silent)" = "true" ] && echo "--silent" || echo ""); \
	echo "   http://$$_HOST:$$_PORT"; \
	npx tsx src/ui/server/index.ts $$_SILENT_FLAG

# OPTIONAL, legacy: add a bare 'den' alias to /etc/hosts (needs sudo) so
# http://den:7777 resolves. Not needed — http://den.localhost:7777
# already resolves in Chromium/Firefox, and http://localhost:7777 everywhere.
# Requires sudo.
dev-dns:
	@if grep -q "127.0.0.1 den" /etc/hosts 2>/dev/null; then \
		echo "✅ /etc/hosts already has '127.0.0.1 den'"; \
	else \
		echo "Adding '127.0.0.1 den' to /etc/hosts (requires sudo)..."; \
		echo '127.0.0.1 den' | sudo tee -a /etc/hosts > /dev/null; \
		echo "✅ Done. You can now use http://den:7777"; \
	fi
