# Makefile — den orchestration
#
# Entry points, help, first-time setup, and dev utilities.
# Test targets live in make/test.mk; local dev targets in make/local_dev.mk.

.PHONY: help help-test help-localdev help-full \
        setup up install compile bld cli blt preflight lint clean

.DEFAULT_GOAL := help

# ── Globals ───────────────────────────────────────────────────────────────────

# Environment selection — defaults to local.
# Usage: make test-syn-all env=staging
env ?= local
export E2E_ENVIRONMENT=$(env)
OPEN_REPORT ?= 0

# Secrets backend is a strategy chosen in config/den.yml (secrets.provider:
# doppler | 1password | env). Override per shell:
#   DEN_SECRETS_PROVIDER=env make up
# OP_ACCOUNT is only consulted when the 1password strategy is selected.
OP_ACCOUNT ?= example.1password.com
export OP_ACCOUNT

# Repo for the smoke and browser pillars — no default: make test-smk-all repo=<repo>
repo ?=

# ── Setup display helpers ─────────────────────────────────────────────────────
# Usage: $(call SETUP_STEP,1,Dependencies)  /  $(call SETUP_SUBSECTION)
define SETUP_STEP
@printf '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n  STEP $(1) · $(2)\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
endef
define SETUP_SUBSECTION
@printf '\n  ──────────────────────────────────────────\n\n'
endef

# ── Sub-makefiles ─────────────────────────────────────────────────────────────
include make/test.mk
include make/local_dev.mk
include make/journeys.mk
include make/security.mk
include make/demo.mk

# ── Default goal ──────────────────────────────────────────────────────────────
.DEFAULT_GOAL := help

# ── Help ──────────────────────────────────────────────────────────────────────

help:
	@printf '\nden\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
	@printf 'Primary:\n'
	@printf '  make setup        — first-time setup wizard\n'
	@printf '  make up           — choose: run tests or start web service\n'
	@printf '  make test         — interactive test runner\n'
	@printf '  make web          — start den web UI at http://localhost:7777\n\n'
	@printf 'CLI / Build:\n'
	@printf '  make compile      — build the den CLI distro into dist/\n'
	@printf '  make bld          — alias for compile\n'
	@printf '  make cli          — build and link den into ~/.local/bin\n'
	@printf '  make blt          — run preflight, then build\n\n'
	@printf 'Maintenance:\n'
	@printf '  make install      — install npm deps + Playwright browsers\n'
	@printf '  make preflight    — format, lint/fix, unit tests, config checks\n'
	@printf '  make lint         — run the same lint as CI (eslint --fix)\n'
	@printf '  make clean        — remove node_modules, dist, coverage, reports\n'
	@printf '  make test-down    — kill running Playwright / k6 processes\n\n'
	@printf 'Testing:\n'
	@printf '  make help-test    — all test commands\n\n'
	@printf 'Local Dev:\n'
	@printf '  make den-up     — start always_on services in active workspace\n'
	@printf '  make down          — stop services (alias: make den-down)\n'
	@printf '  make den-status — show service health\n'
	@printf '  make den-logs   — tail local logs for a repo\n'
	@printf '  make help-localdev — all local dev commands\n\n'
	@printf '📊 Dev-Tooling Telemetry:\n'
	@printf '  make dev-metrics-report   — analyze dev-tooling telemetry (DEV_METRICS_ARGS="--from-sentry")\n'
	@printf '  make dev-metrics-history  — git-forensics workaround-index report\n\n'
	@printf 'Reference:\n'
	@printf '  make help-full     — complete target reference\n\n'

help-test:
	@{ \
	printf '\nden — Test Commands\n'; \
	printf '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'; \
	printf 'SYNTHETIC TESTS  (browser, Playwright)\n'; \
	printf '  make test-syn-all                    All browser tests\n'; \
	printf '  make test-syn-all env=staging        Against staging\n'; \
	printf '  make test-syn-<module>               Single module (auth, items, …)\n\n'; \
	printf 'INTEGRATION TESTS  (API, Playwright)\n'; \
	printf '  make test-int-all                    All integration tests\n'; \
	printf '  make test-int-<module>               Single module\n\n'; \
	printf 'PERFORMANCE TESTS  (k6)\n'; \
	printf '  make test-perf-all                   All performance tests\n'; \
	printf '  make test-perf-<module>              Single module\n'; \
	printf '  make test-perf module=<m> env=<e>    Explicit module + env\n\n'; \
	printf 'SMOKE TESTS  (service-repo owned, den harness)\n'; \
	printf '  make smoke-link repo=<r>             Link sibling repo into .den/\n'; \
	printf '  make smoke-status                    List linked repos + services\n'; \
	printf '  make smoke-clone env=<e>             Clone repos at deployed SHA\n'; \
	printf '  make smoke-clone-status              Show current clones\n'; \
	printf '  make test-smk-all                    All smoke tests [repo=<r>]\n'; \
	printf '  make test-smk-global                 All repos, one combined report  ← CI\n'; \
	printf '  make test-smk-<svc>-all              All suites for one service\n'; \
	printf '  make test-smk-<svc>-<suite>          Single suite  ← dev iteration\n'; \
	printf '  OPEN_REPORT=1 make test-smk-...      Open HTML report after run\n\n'; \
	printf 'JOURNEYS  (agent-driven E2E, explicit env= REQUIRED)\n'; \
	printf '  make test-jrn-all env=<e>            All journeys allowing <e>\n'; \
	printf '  make test-jrn-<name> env=<e>         Single journey by spec name\n'; \
	printf '  JOURNEYS_MODEL=<id> required; CURSOR_API_KEY auto-read from 1Password\n\n'; \
	printf 'SECURITY  (OWASP ZAP of our own services, explicit env= REQUIRED)\n'; \
	printf '  make test-sec-all env=<e>            All targets (baseline mode)\n'; \
	printf '  make test-sec-<svc> env=<e>          One service  [repo=<r>]\n'; \
	printf '  ... mode=baseline|api|full|all       dry_run=1 prints docker cmds only\n'; \
	printf '  hosts: security.owned_hosts in config/den.yml (local edge only)\n'; \
	printf '  production = passive baseline only, needs DEN_ALLOW_PROD=1\n\n'; \
	printf 'JWT TOKENS  (integration tests)\n'; \
	printf '  make int-jwt-status                  Show cached token status + expiry\n'; \
	printf '  make int-jwt-clear                   Clear cache (forces re-fetch)\n'; \
	printf '  make int-jwt-clear env=staging       For a specific environment\n\n'; \
	printf 'RESULTS & REPORTS\n'; \
	printf '  make report                          Open HTML report\n'; \
	printf '  make results                         JSONL summary — synthetic\n'; \
	printf '  make results-api                     JSONL summary — integration\n'; \
	printf '  make results-perf                    JSONL summary — performance\n'; \
	printf '  make results-flaky                   Tests that flip pass/fail\n'; \
	printf '  make clean-reports                   Remove HTML reports (JSONL preserved)\n\n'; \
	printf 'ENVIRONMENTS  (default: local)\n'; \
	printf '  local / dev / sandbox / staging / production\n'; \
	printf '  Add env= to any test command:  make test-syn-all env=staging\n\n'; \
	} | less -R

help-localdev:
	@{ \
	printf '\nden — Local Dev Commands\n'; \
	printf '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'; \
	printf 'SERVICE MANAGEMENT\n'; \
	printf '  make den-up                         Start always_on services in active workspace\n'; \
	printf '  make den-up args="shop/api ..."     Start specific services\n'; \
	printf '  make down                              Stop services (alias: make den-down)\n'; \
	printf '  make den-restart                    Restart services\n'; \
	printf '  make den-status                     Show service health\n'; \
	printf '  make den-logs args="shop"           Tail local logs for a repo\n'; \
	printf '  make den-services                   List all registered services\n'; \
	printf '  make den-sync                       Check for and pull updates\n\n'; \
	printf 'WORKSPACES\n'; \
	printf '  make den-workspace args="list"\n'; \
	printf '  make den-workspace args="use <name>"\n'; \
	printf '  make den-workspace args="create <name>"\n\n'; \
	printf 'SETUP & CONFIGURATION\n'; \
	printf '  make setup                             First-time setup wizard\n'; \
	printf '  make den-register                   Register a repo in the service catalog\n'; \
	printf '  make den-setup                      Run setup for registered services\n'; \
	printf '  make den-init                       Scaffold a new .den.yml\n'; \
	printf '  make den-heal-config                Backfill config/den.yml defaults\n'; \
	printf '  make den-validate                   Validate a .den.yml\n'; \
	printf '  make den-local-dev args=on|off      Toggle local dev mode\n'; \
	printf '  make den-setup-secrets              Set up developer secrets (Doppler/1Password/env)\n'; \
	printf '  make register-repos                    Show test repo sources (legacy scan: args=--legacy)\n'; \
	printf '  make auth-configure env=staging        Link your admin secret → staging\n'; \
	printf '  make auth-configure env=production     Link your admin secret → production\n'; \
	printf '  make aws-configure                     Map environments → AWS CLI profiles\n\n'; \
	printf 'WEB UI\n'; \
	printf '  make web                               Launch at http://localhost:7777\n'; \
	printf '  make dev-dns                           Optional: add a bare "den" alias to /etc/hosts (sudo)\n'; \
	printf '  PORT=8080 make web                     Run on a different port\n\n'; \
	} | less -R

help-full:
	@{ \
	echo "den — Full Reference"; \
	echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"; \
	echo ""; \
	echo "FIRST-TIME SETUP"; \
	echo "  make setup              Interactive wizard: deps, config, auth, local dev"; \
	echo ""; \
	echo "ENTRY POINTS"; \
	echo "  make up                 Choose: run tests (1) or start web service (2)"; \
	echo "  make test               Interactive test runner"; \
	echo "  make web                den web UI + Local Dev dashboard at :7777"; \
	echo ""; \
	echo "MAINTENANCE"; \
	echo "  make install            Update npm deps + Playwright browsers"; \
	echo "  make compile            Build the den CLI distro into dist/"; \
	echo "  make bld                Alias for compile"; \
	echo "  make cli                Build and link den into ~/.local/bin"; \
	echo "  make blt                Run preflight, then build"; \
	echo "  make preflight          Format + lint + unit tests + type-check (run before committing)"; \
	echo "  make clean              Remove node_modules, dist, coverage, reports"; \
	echo "  make test-down          Kill running Playwright / k6 processes"; \
	echo ""; \
	echo "AUTHENTICATION"; \
	echo "  Credentials are fetched fresh on every test run — nothing stored on disk."; \
	echo "  Local: configured secrets backend.  CI: ENV vars."; \
	echo ""; \
	echo "  local / dev / sandbox  — shared test accounts from the secrets backend"; \
	echo "    (the items each environment's auth block names)."; \
	echo ""; \
	echo "  staging / production   — personal account required:"; \
	echo "    make auth-configure env=staging     # one-time per engineer"; \
	echo "    make auth-configure env=production"; \
	echo ""; \
	echo "  CI (all envs)          — ENV vars override everything:"; \
	echo "    E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD"; \
	echo "    E2E_USER_EMAIL  / E2E_USER_PASSWORD"; \
	echo ""; \
	echo "API JWT TOKENS  (integration tests)"; \
	echo "  make int-jwt-status              Show cached token status + expiry"; \
	echo "  make int-jwt-clear               Clear cached tokens (forces fresh fetch)"; \
	echo "  make int-jwt-clear env=staging   Clear tokens for a specific environment"; \
	echo ""; \
	echo "  Tokens fetched via Auth0 ROPC, cached to playwright/.auth/"; \
	echo ""; \
	echo "SYNTHETIC TESTS  (browser, Playwright)"; \
	echo "  make test-syn-all                Run all synthetic tests"; \
	echo "  make test-syn-all env=staging    Run against staging"; \
	echo "  make test-syn-<module>           Run one module"; \
	echo ""; \
	echo "  make synth-link repo=<r>         Link sibling repo into .den/"; \
	echo "  make synth-status                Show linked repos + synthetics config"; \
	echo ""; \
	echo "INTEGRATION TESTS  (API, Playwright)"; \
	echo "  make test-int-all                Run all integration tests"; \
	echo "  make test-int-<module>           Run one module"; \
	echo ""; \
	echo "PERFORMANCE TESTS  (k6)"; \
	echo "  make test-perf-all               Run all performance tests"; \
	echo "  make test-perf-<module>          Run one module"; \
	echo "  make test-perf module=<m>        Explicit module (supports repo/name)"; \
	echo ""; \
	echo "SMOKE TESTS  (service repo owns files, den provides harness)"; \
	echo "  make smoke-link repo=<r>         Link sibling repo into .den/"; \
	echo "  make smoke-status                List linked repos + services"; \
	echo "  make smoke-clone env=staging     Clone repos at deployed SHA"; \
	echo "  make smoke-clone-status          Show current clones"; \
	echo "  make test-smk-all                All smoke tests, one combined report [repo=<r>]"; \
	echo "  make test-smk-global             All smoke tests across ALL repos — use in CI"; \
	echo "  make test-smk-api-items          Dev iteration: just the items suite"; \
	echo "  make test-smk-all env=staging    Against a specific environment"; \
	echo "  USE_LOCAL_CHECKOUT=1 make test-smk-all env=staging    Use linked repo against cloud env"; \
	echo "  OPEN_REPORT=1 make test-smk-api-all                   Open HTML report after run"; \
	echo ""; \
	echo "  Format:  make test-smk-<service>-<suite> [env=<env>] [repo=<repo>]"; \
	echo ""; \
	echo "ENVIRONMENTS  (default: local)"; \
	echo "  local / dev / sandbox / staging / production"; \
	echo "  All test commands accept env=:  make test-syn-all env=staging"; \
	echo ""; \
	echo "RESULTS"; \
	echo "  make report              Open HTML report (screenshots, traces, videos)"; \
	echo "  make results             JSONL summary — synthetic tests"; \
	echo "  make results-api         JSONL summary — integration tests"; \
	echo "  make results-perf        JSONL summary — performance tests"; \
	echo "  make results-flaky       Find tests that flip between pass/fail"; \
	echo ""; \
	echo "LOCAL DEV  (see also: make help-localdev)"; \
	echo "  make web                 Launch at http://localhost:7777"; \
	echo "  PORT=8080 make web       Run on a different port"; \
	echo "  make den-up           Start always_on services"; \
	echo "  make down                Stop services (alias: make den-down)"; \
	echo "  make den-status       Show service health"; \
	echo "  make den-logs         Tail local logs for a repo"; \
	echo "  make den-sync         Pull updates for managed repos"; \
	echo ""; \
	echo "CLEANUP"; \
	echo "  make clean               Remove node_modules, dist, coverage, reports"; \
	echo "  make clean-reports       Remove HTML reports (JSONL preserved)"; \
	echo "  make test-down           Kill running Playwright / k6 processes"; \
	} | less -R

# ── Entry points ──────────────────────────────────────────────────────────────

# Choose: run tests or start web service
up:
	@printf '\n🚀 den · What would you like to do?\n\n'
	@printf '  1. Run tests interactively   (make test)\n'
	@printf '  2. Start as a web service    (make web)\n\n'
	@read -p "  Enter 1 or 2: " choice; \
	case "$$choice" in \
		1) $(MAKE) test ;; \
		2) $(MAKE) web ;; \
		*) echo "  Invalid choice. Run 'make test' or 'make web' directly." ;; \
	esac

# ── First-time setup ──────────────────────────────────────────────────────────
# Four labeled sections:
#   1. Dependencies        (always runs)
#   2. General config      (web UI address, developer secrets)
#   3. Testing config      (auth accounts, repo registration, AWS profiles)
#   4. Local Dev config    (enable flag, default workspace)
setup:
	@printf '\n🚀 den · Setup\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
	@printf '  This wizard walks you through five sections:\n'
	@printf '    1. Install dependencies\n    2. General configuration\n'
	@printf '    3. Testing configuration\n    4. Local Dev configuration\n'
	@printf '    5. Install the den CLI\n\n'

	$(call SETUP_STEP,1,Dependencies)
	@echo "📦 Installing npm dependencies..."
	@npm install
	@echo ""
	@echo "🎭 Installing Playwright browsers..."
	@npx playwright install chromium firefox webkit
	@echo ""
	@echo "🔑 Checking secrets backend CLI (config/den.yml → secrets.provider)..."
	@set -- $$(npx tsx scripts/setup-secrets.ts --cli 2>/dev/null); \
	provider="$${1:-doppler}"; bin="$${2:--}"; formula="$${3:--}"; \
	if [ "$$bin" = "-" ]; then \
		echo "  ✓ backend '$$provider' needs no CLI."; \
	elif which "$$bin" > /dev/null 2>&1; then \
		echo "  ✓ $$bin ($$($$bin --version 2>/dev/null | head -1)) for backend '$$provider'"; \
	else \
		echo "⚠️  $$bin not found (backend '$$provider')."; \
		read -p "  Install it now? (Y/n): " answer; \
		if [ -z "$$answer" ] || [ "$$answer" = "y" ] || [ "$$answer" = "Y" ]; then \
			if [ "$$(uname)" = "Darwin" ] && which brew > /dev/null 2>&1; then \
				echo "  Installing $$formula via Homebrew..."; \
				brew install "$$formula" || echo "  ⚠️  Install failed — run: brew install $$formula"; \
			else \
				echo "  Install $$bin manually (Homebrew formula: $$formula), then re-run make setup."; \
			fi; \
		else \
			echo "  Skipping. Install later with: brew install $$formula"; \
			echo "  Or use another backend: set secrets.provider in config/local/user.yml (env | 1password | doppler)."; \
		fi; \
	fi
	@echo ""
	@echo "⚡ Checking for k6..."
	@if ! which k6 > /dev/null 2>&1; then \
		echo "⚠️  k6 not found (required for performance tests)."; \
		read -p "  Install k6 now? (Y/n): " answer; \
		if [ -z "$$answer" ] || [ "$$answer" = "y" ] || [ "$$answer" = "Y" ]; then \
			if [ "$$(uname)" = "Darwin" ]; then \
				echo "  Installing k6 via Homebrew..."; \
				brew install k6; \
			else \
				echo "  Please install k6 manually: https://k6.io/docs/get-started/installation/"; \
				exit 1; \
			fi; \
		else \
			echo "  Skipping. Install later with: brew install k6"; \
		fi; \
	else \
		echo "  ✓ k6 ($$(k6 version | head -1))"; \
	fi
	@echo ""
	@echo "📁 Creating output directories..."
	@mkdir -p results reports playwright/.auth
	@echo "  ✓ results/  reports/  playwright/.auth/"

	$(call SETUP_STEP,2,General Configuration)
	@echo "⚙️  den config (config/den.yml)"
	@echo "  Ensures required keys are populated. Idempotent — no-op if already"
	@echo "  healthy. Fills in github_org from this den checkout's origin."
	@npx tsx scripts/heal-config.ts
	$(call SETUP_SUBSECTION)
	@echo "🌐 Web UI address"
	@echo "  'make web' serves the UI at http://localhost:7777 — no setup needed."
	@echo "  Chromium-based browsers and Firefox also resolve http://den.localhost:7777"
	@echo "  to this machine on their own (RFC 6761), so no /etc/hosts edit or sudo."
	@if grep -q "127.0.0.1 den" /etc/hosts 2>/dev/null; then \
		echo "  ✓ Legacy /etc/hosts alias found — http://den:7777 works too."; \
	fi
	$(call SETUP_SUBSECTION)
	@echo "🔑 Developer secrets"
	@echo "  den reads test-account passwords and your saved sudo password from"
	@echo "  the configured secrets backend (Doppler by default; 1Password or plain"
	@echo "  env vars are drop-in — see secrets.provider in config/den.yml)."
	@echo "  Each repo's own 'make up' manages its own secrets; this is only den's."
	@echo ""
	@if npx tsx scripts/setup-secrets.ts --check 2>/dev/null; then \
		echo "  ✓ secrets backend ready."; \
	else \
		read -p "  Set up developer secrets now? (Y/n): " answer; \
		if [ -z "$$answer" ] || [ "$$answer" = "y" ] || [ "$$answer" = "Y" ]; then \
			$(MAKE) --no-print-directory den-setup-secrets \
				|| echo "  ⚠️  Secrets not set up yet — setup continues. Re-run: make den-setup-secrets"; \
		else \
			echo "  Skipping. Run 'make den-setup-secrets' when ready."; \
		fi; \
	fi

	$(call SETUP_STEP,3,Testing Configuration)
	@echo "  den runs synthetic, API, smoke, and performance tests against"
	@echo "  local, dev, sandbox, staging, and production environments."
	@echo "  The steps below configure the credentials and repo sources that"
	@echo "  power those test runs."
	@echo ""
	@echo "🔐 Admin account authentication"
	@echo "  Tests create fresh sessions on every run via the secrets backend."
	@echo "  local / dev / sandbox use shared test accounts — no setup needed."
	@echo "  staging and production require a personal admin account (one-time"
	@echo "  per environment, stored in config/local/ and never committed)."
	@echo ""
	@if [ -f config/local/admin-auth-staging.json ]; then \
		echo "  ✓ Staging admin account already configured."; \
		echo ""; \
		read -p "  Reconfigure staging admin account? (y/N): " answer; \
		if [ "$$answer" = "y" ] || [ "$$answer" = "Y" ]; then \
			$(MAKE) auth-configure env=staging; \
		else \
			echo "  Skipping. Run 'make auth-configure env=staging' to update."; \
		fi; \
	else \
		read -p "  Configure admin account for staging? (Y/n): " answer; \
		if [ -z "$$answer" ] || [ "$$answer" = "y" ] || [ "$$answer" = "Y" ]; then \
			$(MAKE) auth-configure env=staging; \
		else \
			echo "  Skipping. Run 'make auth-configure env=staging' when ready."; \
		fi; \
	fi
	@echo ""
	@if [ -f config/local/admin-auth-production.json ]; then \
		echo "  ✓ Production admin account already configured."; \
		echo ""; \
		read -p "  Reconfigure production admin account? (y/N): " answer; \
		if [ "$$answer" = "y" ] || [ "$$answer" = "Y" ]; then \
			$(MAKE) auth-configure env=production; \
		else \
			echo "  Skipping. Run 'make auth-configure env=production' to update."; \
		fi; \
	else \
		read -p "  Configure admin account for production? (Y/n): " answer; \
		if [ -z "$$answer" ] || [ "$$answer" = "y" ] || [ "$$answer" = "Y" ]; then \
			$(MAKE) auth-configure env=production; \
		else \
			echo "  Skipping. Run 'make auth-configure env=production' when ready."; \
		fi; \
	fi
	$(call SETUP_SUBSECTION)
	@echo "🔭 Test repo sources"
	@echo "  Smoke, performance, and synthetics discovery follows your Local Dev"
	@echo "  workspace: every standard system repo is a test source out of the"
	@echo "  box, managed (section 4 seeds it) — nothing to register."
	@echo ""
	@$(MAKE) register-repos
	$(call SETUP_SUBSECTION)
	@echo "☁️  AWS profile mapping"
	@echo "  den uses your AWS CLI profiles to fetch CloudWatch logs and run"
	@echo "  health checks against cloud environments. Each environment"
	@echo "  (dev, sandbox, staging, production) maps to a named AWS CLI profile"
	@echo "  so den can authenticate as you without storing credentials."
	@echo ""
	@if [ -f config/local/aws-profiles.json ]; then \
		echo "  ✓ AWS profiles already configured."; \
		echo ""; \
		read -p "  Reconfigure AWS profiles? (y/N): " answer; \
		if [ "$$answer" = "y" ] || [ "$$answer" = "Y" ]; then \
			$(MAKE) aws-configure; \
		else \
			echo "  Skipping. Run 'make aws-configure' to update."; \
		fi; \
	else \
		read -p "  Configure AWS profiles now? (Y/n): " answer; \
		if [ -z "$$answer" ] || [ "$$answer" = "y" ] || [ "$$answer" = "Y" ]; then \
			$(MAKE) aws-configure; \
		else \
			echo "  Skipping. Run 'make aws-configure' when ready."; \
		fi; \
	fi

	$(call SETUP_STEP,4,Local Dev Configuration)
	@echo "  den's Local Dev mode manages your local service dependencies —"
	@echo "  cloning repos, starting services in dependency order, and showing"
	@echo "  a live health dashboard via 'make web'."
	@echo "  Enable this if you do hands-on service development locally."
	@echo "  Skip it if you only use den to run tests against cloud environments."
	@echo ""
	@if grep -q "local_dev: true" config/local/user.yml 2>/dev/null; then \
		echo "  ✓ Local Dev already enabled."; \
		echo ""; \
		read -p "  Reconfigure Local Dev? (y/N): " answer; \
		if [ "$$answer" != "y" ] && [ "$$answer" != "Y" ]; then \
			echo "  Skipping. Run 'make den-local-dev args=off' to disable."; \
		else \
			npx tsx src/ui/cli/index.ts local-dev on; \
			printf '\n  ──────────────────────────────────────────\n\n'; \
			echo "🗂️  Default workspace"; \
			echo "  den will add every standard system repo to your default"; \
			echo "  workspace as managed (no prompts, nothing cloned yet —"; \
			echo "  den clones each repo on first use). Flip any repo you"; \
			echo "  actively develop to dev-managed later in the web UX."; \
			echo ""; \
			read -p "  Set up default workspace now? (Y/n): " answer2; \
			if [ -z "$$answer2" ] || [ "$$answer2" = "y" ] || [ "$$answer2" = "Y" ]; then \
				npx tsx src/scripts/setup-default-workspace.ts; \
			else \
				echo "  Skipping. Run 'npx tsx src/scripts/setup-default-workspace.ts' when ready."; \
			fi; \
		fi; \
	else \
		read -p "  Enable Local Dev? (Y/n): " answer; \
		if [ -z "$$answer" ] || [ "$$answer" = "y" ] || [ "$$answer" = "Y" ]; then \
			npx tsx src/ui/cli/index.ts local-dev on; \
			printf '\n  ──────────────────────────────────────────\n\n'; \
			echo "🗂️  Default workspace"; \
			echo "  den will add every standard system repo to your default"; \
			echo "  workspace as managed (no prompts, nothing cloned yet —"; \
			echo "  den clones each repo on first use). Flip any repo you"; \
			echo "  actively develop to dev-managed later in the web UX."; \
			echo ""; \
			read -p "  Set up default workspace now? (Y/n): " answer2; \
			if [ -z "$$answer2" ] || [ "$$answer2" = "y" ] || [ "$$answer2" = "Y" ]; then \
				npx tsx src/scripts/setup-default-workspace.ts; \
			else \
				echo "  Skipping. Run 'npx tsx src/scripts/setup-default-workspace.ts' when ready."; \
			fi; \
		else \
			npx tsx src/ui/cli/index.ts local-dev off; \
			echo "  Local Dev disabled. Run 'make den-local-dev args=on' to enable later."; \
		fi; \
	fi

	$(call SETUP_STEP,5,Install the den CLI)
	@echo "  Symlinks the 'den' command into ~/.local/bin (compiling a dist/"
	@echo "  fallback first) so you can run 'den' from any repo."
	@echo ""
	@$(MAKE) cli

	@printf '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n  ✅  Setup complete!\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n'
	@printf '  den --help   — the den CLI (now installed on your PATH)\n'
	@printf '  make test       — interactive CLI to run tests\n'
	@printf '  make web        — start den as a web service (Local Dev)\n'
	@printf '  make help       — common commands reference\n'
	@printf '  make help-full  — full command listing\n\n'

# ── Dev utilities ─────────────────────────────────────────────────────────────

install:
	@echo "📦 Installing dependencies..."
	@npm install
	@npx playwright install

compile:
	@echo "🔨 Building den CLI distro..."
	@npm run build

bld: compile

cli: compile
	@set -e; \
	local_bin="$(HOME)/.local/bin"; \
	target="$$local_bin/den"; \
	echo "🔗 Installing den CLI into $$local_bin..."; \
	mkdir -p "$$local_bin"; \
	chmod +x "$(CURDIR)/bin/den"; \
	ln -sfn "$(CURDIR)/bin/den" "$$target"; \
	echo "✓ den CLI installed at $$target"; \
	echo "  -> $(CURDIR)/bin/den"; \
	case ":$$PATH:" in \
	  *":$$local_bin:"*) ;; \
	  *) \
	    echo ""; \
	    echo "⚠️  $$local_bin is not in your PATH."; \
	    shell_name="$$(basename "$${SHELL:-/bin/zsh}")"; \
	    case "$$shell_name" in \
	      zsh)  profile="$$HOME/.zshrc" ;; \
	      bash) if [ -f "$$HOME/.bash_profile" ]; then profile="$$HOME/.bash_profile"; else profile="$$HOME/.bashrc"; fi ;; \
	      *)    profile="" ;; \
	    esac; \
	    if [ -n "$$profile" ] && grep -qs '\.local/bin' "$$profile"; then \
	      echo "   $$profile already exports it — restart your shell, or run:"; \
	      echo '     export PATH="$$HOME/.local/bin:$$PATH"'; \
	    elif [ -n "$$profile" ] && [ -t 0 ]; then \
	      printf '   Add it to %s now? [y/N] ' "$$profile"; \
	      read -r answer < /dev/tty || answer=""; \
	      case "$$answer" in \
	        [Yy]*) \
	          printf '\n# Added by den (make cli) — keep den on the PATH\nexport PATH="$$HOME/.local/bin:$$PATH"\n' >> "$$profile"; \
	          echo "   ✓ Added to $$profile — restart your shell, or run:"; \
	          echo '     export PATH="$$HOME/.local/bin:$$PATH"'; \
	          ;; \
	        *) \
	          echo "   Skipped. Add this to your shell profile when ready:"; \
	          echo '     export PATH="$$HOME/.local/bin:$$PATH"'; \
	          ;; \
	      esac; \
	    else \
	      echo "   Add this to your shell profile ($$shell_name):"; \
	      echo '     export PATH="$$HOME/.local/bin:$$PATH"'; \
	    fi; \
	    ;; \
	esac

blt: preflight bld

# Run the same lint CI runs (preflight step 2️⃣): eslint over all .ts with auto-fix.
lint:
	@echo "🔍 Linting and auto-fixing (matches CI)..."
	@npm run lint:fix

preflight:
	@echo "🚀 Running preflight checks..."
	@echo ""
	@echo "1️⃣  Formatting code..."
	@npm run format
	@echo ""
	@echo "2️⃣  Linting and auto-fixing..."
	@npm run lint:fix
	@echo ""
	@echo "3️⃣  Running unit tests with coverage..."
	@npm run test:unit
	@echo ""
	@echo "4️⃣  Type-checking (tsc --noEmit, baselined config)..."
	@npx tsc --noEmit -p tsconfig.typecheck.json
	@echo "   ✓ type-check: OK"
	@echo ""
	@echo "5️⃣  Validating Playwright pillar configs (dry-run)..."
	@for cfg in src/pillars/api/playwright.config.ts src/pillars/browser/playwright.config.ts src/pillars/smoke/playwright.config.ts; do \
	  out=$$(npx playwright test --config=$$cfg --list 2>&1 || true); \
	  if echo "$$out" | grep -qiE "first argument must use|^.*error.*cannot find module.*pillars"; then \
	    echo "$$out"; \
	    echo ""; \
	    echo "❌ Config validation failed: $$cfg"; \
	    exit 1; \
	  fi; \
	  echo "   ✓ $$cfg: OK"; \
	done
	@echo ""
	@echo "✅ Preflight checks passed!"
	@echo "   • Code formatted"
	@echo "   • Linting passed"
	@echo "   • Unit tests passed"
	@echo "   • Type-check passed"
	@echo "   • Pillar configs valid"

# Create a GitHub release from the current package.json version + CHANGELOG.md entry.
# Usage: make release                     — release current version
#        make release args="--backfill-all"  — backfill all historical versions
release:
	@bash scripts/create-release.sh $(args)

clean:
	@echo "🧹 Cleaning up..."
	@rm -rf node_modules dist coverage reports/* .playwright
	@echo "✅ Clean complete"
