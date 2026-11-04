# make/test.mk — Test execution
#
# Synthetic (browser/Playwright), integration (API), performance (k6),
# and smoke tests (service-repo owned files, den harness).
# Results, reporting, JWT token cache, and process cleanup also live here.

.PHONY: test test-syn-all test-int-all test-perf-all test-perf \
        test-smk test-smk- test-smk-all test-smk-global \
        smoke-link smoke-status smoke-clone smoke-clone-status \
        synth-link synth-status test-framework \
        int-jwt-clear int-jwt-status \
        results results-flaky results-api results-perf \
        report clean-reports test-down _open-report .check-auth

# Sessions are created fresh by global-setup on every run — nothing to check.
.check-auth:
	@true

# Interactive test runner
test: .check-auth
	@echo "Starting interactive test runner..."
	@npm run cli

# ── Synthetic tests (browser, Playwright) ────────────────────────────────────

test-syn-all: .check-auth
	@echo "🧪 Running ALL synthetic tests (headless)..."
	@echo "🌍 Environment: $(env)"
	@echo ""
	@SYNTH_REPO=$(repo) npx tsx src/pillars/browser/setup.ts && \
	SYNTH_REPO=$(repo) npx playwright test --config=src/pillars/browser/playwright.config.ts
	@[ ! "$$CI" = "true" ] && [ -d "playwright-report" ] && $(MAKE) --no-print-directory _open-report || true

# make test-syn-<module>
test-syn-%: .check-auth
	@MODULE_NAME=$(subst test-syn-,,$@); \
	STAGING_DIR=".synth-run/$(repo)/$$MODULE_NAME"; \
	echo "🧪 Staging synthetic tests for repo=$(repo)..."; \
	SYNTH_REPO=$(repo) npx tsx src/pillars/browser/setup.ts || exit 1; \
	if [ -d "$$STAGING_DIR" ]; then \
		echo "🧪 Running synthetic/$$MODULE_NAME tests..."; \
		echo "🌍 Environment: $(env)"; \
		echo ""; \
		SYNTH_REPO=$(repo) npx playwright test --config=src/pillars/browser/playwright.config.ts "$$STAGING_DIR/"; \
	else \
		echo "❌ Module '$$MODULE_NAME' not found in .synth-run/$(repo)/"; \
		echo ""; \
		echo "Available modules:"; \
		find ".synth-run/$(repo)" -maxdepth 1 -type d ! -path ".synth-run/$(repo)" ! -name "node_modules" -exec basename {} \; 2>/dev/null | sort | sed 's/^/  - test-syn-/' || true; \
		exit 1; \
	fi
	@[ ! "$$CI" = "true" ] && [ -d "playwright-report" ] && $(MAKE) --no-print-directory _open-report || true

# ── Integration tests (API, Playwright) ──────────────────────────────────────

test-int-all: .check-auth
	@echo "🧪 Running ALL integration tests (headless)..."
	@echo "🌍 Environment: $(env)"
	@echo ""
	@npx playwright test --config=src/pillars/api/playwright.config.ts
	@[ ! "$$CI" = "true" ] && [ -d "playwright-report" ] && $(MAKE) --no-print-directory _open-report || true

# make test-int-<module>
test-int-%: .check-auth
	@MODULE_NAME=$(subst test-int-,,$@); \
	if [ -d "src/pillars/api/tests/$$MODULE_NAME" ]; then \
		echo "🧪 Running integration/$$MODULE_NAME API tests..."; \
		echo "🌍 Environment: $(env)"; \
		echo ""; \
		npx playwright test --config=src/pillars/api/playwright.config.ts src/pillars/api/tests/$$MODULE_NAME/; \
	else \
		echo "❌ Module 'src/pillars/api/tests/$$MODULE_NAME' not found"; \
		echo ""; \
		echo "Available modules:"; \
		find src/pillars/api/tests/ -maxdepth 1 -type d ! -name "tests" ! -name "_*" -exec basename {} \; | sort | sed 's/^/  - test-int-/'; \
		exit 1; \
	fi
	@[ ! "$$CI" = "true" ] && [ -d "playwright-report" ] && $(MAKE) --no-print-directory _open-report || true

# ── Performance tests (k6) ────────────────────────────────────────────────────

test-perf-all: .check-auth
	@echo "🧪 Running ALL performance tests..."
	@echo "🌍 Environment: $(env)"
	@echo ""
	@if ! which k6 > /dev/null 2>&1; then echo "❌ k6 not installed. Run: brew install k6"; exit 1; fi
	@npx tsx src/ui/cli/index.ts run --pillar=performance --environment=$(env) $(if $(repo),--repo=$(repo),)

# make test-perf module=<name> env=<env>
test-perf: .check-auth
	@if [ -z "$(module)" ]; then echo "❌ Usage: make test-perf module=<name|repo/name> env=<env>"; exit 1; fi
	@echo "🧪 Running performance module $(module)..."
	@echo "🌍 Environment: $(env)"
	@echo ""
	@if ! which k6 > /dev/null 2>&1; then echo "❌ k6 not installed. Run: brew install k6"; exit 1; fi
	@npx tsx src/ui/cli/index.ts run --pillar=performance --environment=$(env) --module=$(module)

# make test-perf-<module> — shorthand for `make test-perf module=<module>`.
# Suites come from the distribution (<dist root>/tests/pillars/perf/<module>/
# test.js) or a registered repo's manifest; the engine ships none, so the CLI
# resolves the module rather than a path under this checkout.
test-perf-%: .check-auth
	@MODULE_NAME=$(subst test-perf-,,$@); \
	echo "🧪 Running performance module $$MODULE_NAME..."; \
	echo "🌍 Environment: $(env)"; \
	echo ""; \
	if ! which k6 > /dev/null 2>&1; then echo "❌ k6 not installed. Run: brew install k6"; exit 1; fi; \
	npx tsx src/ui/cli/index.ts run --pillar=performance --environment=$(env) --module=$$MODULE_NAME

# ── Smoke tests ───────────────────────────────────────────────────────────────
# Test files live in service repos (e.g. ../<repo>/). den provides the harness.
#
# Usage:
#   make smoke-link repo=shop            Link sibling repo into .den/
#   make test-smk-all repo=<repo>        All smoke tests for one repo
#   make test-smk-api-all env=sandbox    All api suites against sandbox
#   make test-smk-api-items              Dev iteration: just the items suite
#   make test-smk-global                 All repos, one combined report (CI)

# synth-link is an alias for smoke-link — both share the .den/<repo>/ directory.
synth-link: smoke-link

synth-status:
	@echo "🔍 Linked Repo Synthetics Config"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@if [ ! -d ".den" ] || [ -z "$$(ls -A .den 2>/dev/null)" ]; then \
		echo "  (none — run: make synth-link repo=<repo>)"; \
	else \
		for entry in .den/*/; do \
			name=$$(basename "$$entry"); \
			if [ -f "$$entry/.den.yml" ] || [ -f "$$entry/.den.json" ]; then \
				synth=$$(node scripts/manifest-read.cjs "$$entry" synth-testdir 2>/dev/null || echo "?"); \
				echo "  ✅ $$name  (synthetics.testDir: $$synth)"; \
			else \
				echo "  ⚠  $$name  (no .den.yml)"; \
			fi; \
		done; \
	fi
	@echo ""

smoke-link:
	@mkdir -p .den
	@if [ -d ".den/$(repo)" ]; then \
		echo "ℹ️  .den/$(repo) already exists (remove it first to re-link)"; \
	elif [ -d "../$(repo)" ]; then \
		ln -sf "../../$(repo)" ".den/$(repo)"; \
		echo "✅ Linked .den/$(repo) → ../$(repo)"; \
		if [ -f ".den/$(repo)/.den.yml" ] || [ -f ".den/$(repo)/.den.json" ]; then \
			echo "   Manifest found — services available:"; \
			node scripts/manifest-read.cjs ".den/$(repo)" smoke-keys 2>/dev/null | tr ' ' '\n' | sed "s/^/     • /" || true; \
		else \
			echo "   ⚠  No .den.yml found in $(repo) root"; \
		fi; \
	else \
		echo "❌ Repo '../$(repo)' not found as a sibling directory."; \
		exit 1; \
	fi

# Clone repos at their deployed SHA for non-local smoke tests.
# Usage: make smoke-clone env=staging [repo=shop]
smoke-clone:
	@if [ "$(env)" = "local" ]; then \
		echo "ℹ  smoke-clone is not needed for env=local (uses sibling symlink)"; \
	else \
		echo "📦 Cloning repos at deployed SHA for env=$(env)..."; \
		if [ -n "$(repo)" ]; then \
			npx tsx src/pillars/smoke/setup-env.ts --env $(env) --repo $(repo); \
		else \
			npx tsx src/pillars/smoke/setup-env.ts --env $(env); \
		fi; \
	fi

# Show what's currently cloned in .smoke-clones/ and at which SHA.
smoke-clone-status:
	@echo "🔍 Smoke Clones (.smoke-clones/)"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@if [ ! -d ".smoke-clones" ] || [ -z "$$(ls -A .smoke-clones 2>/dev/null)" ]; then \
		echo "  (none — run: make smoke-clone env=<env>)"; \
	else \
		for repo_dir in .smoke-clones/*/; do \
			repo_name=$$(basename "$$repo_dir"); \
			for env_dir in "$$repo_dir"*/; do \
				[ -d "$$env_dir" ] || continue; \
				env_name=$$(basename "$$env_dir"); \
				sha_file="$$env_dir.deployed-sha"; \
				if [ -f "$$sha_file" ]; then \
					sha=$$(cat "$$sha_file"); \
					echo "  ✅ $$repo_name @ $$env_name  →  $${sha:0:8}"; \
				else \
					echo "  ⚠  $$repo_name @ $$env_name  (no .deployed-sha — incomplete clone?)"; \
				fi; \
			done; \
		done; \
	fi
	@echo ""

smoke-status:
	@echo "🔍 Linked Smoke Test Repos"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@if [ ! -d ".den" ] || [ -z "$$(ls -A .den 2>/dev/null)" ]; then \
		echo "  (none — run: make smoke-link repo=<repo>)"; \
	else \
		for entry in .den/*/; do \
			name=$$(basename "$$entry"); \
			if [ -f "$$entry/.den.yml" ] || [ -f "$$entry/.den.json" ]; then \
				services=$$(node scripts/manifest-read.cjs "$$entry" smoke-keys 2>/dev/null | tr ' ' ', ' || echo "?"); \
				echo "  ✅ $$name  (services: $$services)"; \
			else \
				echo "  ⚠  $$name  (no .den.yml)"; \
			fi; \
		done; \
	fi
	@echo ""

# List available services — make test-smk or make test-smk-
test-smk test-smk-:
	@echo "💨 Smoke Tests (repo=$(repo))"
	@echo ""
	@echo "Available services:"
	@node scripts/manifest-read.cjs ".den/$(repo)" smoke-keys 2>/dev/null \
		| tr ' ' '\n' | grep . | sed "s/.*/  make test-smk-&-<suite>  (dev iteration — partial)/" \
		|| echo "  (none — run: make smoke-link repo=$(repo))"
	@echo ""
	@echo "  make test-smk-all          (all services, one combined report) ← use this"
	@echo "  make test-smk-global       (all repos, one combined report)    ← use this in CI"
	@echo ""
	@echo "To list suites within a service:"
	@echo "  make test-smk-<service>-   (e.g. make test-smk-api-)"

# All smoke tests for all services in the linked repo — one combined report
test-smk-all:
	@echo "💨 Running ALL smoke tests (repo=$(repo), env=$(env))..."
	@echo ""
	@if [ "$(env)" != "local" ] && [ "$${USE_LOCAL_CHECKOUT:-0}" != "1" ]; then \
		npx tsx src/pillars/smoke/setup-env.ts --env $(env) --repo $(repo) || exit 1; \
	fi
	@SERVICES=$$(node scripts/manifest-read.cjs ".den/$(repo)" smoke-keys 2>/dev/null) \
	|| (echo "❌ Cannot read manifest for repo=$(repo). Run: make smoke-link repo=$(repo)"; exit 1); \
	for svc in $$SERVICES; do \
		SMOKE_SERVICE=$$svc SMOKE_REPO=$(repo) npx tsx src/pillars/smoke/setup.ts || exit 1; \
	done && \
	SMOKE_REPO=$(repo) \
		npx playwright test --config=src/pillars/smoke/playwright-all.config.ts && \
	npx tsx src/pillars/smoke/ensure-smoke-teardown.ts
	@[ ! "$$CI" = "true" ] && [ "$$OPEN_REPORT" = "1" ] && [ -d "playwright-report" ] && $(MAKE) --no-print-directory _open-report || true

# All smoke tests across ALL registered repos — one combined report (use in CI)
test-smk-global:
	@echo "💨 Running ALL smoke tests across ALL registered repos (env=$(env))..."
	@echo ""
	@if [ "$(env)" != "local" ] && [ "$${USE_LOCAL_CHECKOUT:-0}" != "1" ]; then \
		npx tsx src/pillars/smoke/setup-env.ts --env $(env) || exit 1; \
	fi
	@npx tsx src/pillars/smoke/setup-global.ts && \
	npx playwright test --config=src/pillars/smoke/playwright-global.config.ts && \
	npx tsx src/pillars/smoke/ensure-smoke-teardown.ts
	@[ ! "$$CI" = "true" ] && [ "$$OPEN_REPORT" = "1" ] && [ -d "playwright-report" ] && $(MAKE) --no-print-directory _open-report || true

# All suites for a specific service — make test-smk-api-all
test-smk-%-all:
	@SERVICE=$(subst test-smk-,,$(subst -all,,$@)); \
	echo "💨 Running ALL $$SERVICE smoke tests (repo=$(repo), env=$(env))..."; \
	echo ""; \
	if [ "$(env)" != "local" ] && [ "$${USE_LOCAL_CHECKOUT:-0}" != "1" ]; then \
		npx tsx src/pillars/smoke/setup-env.ts --env $(env) --repo $(repo) || exit 1; \
	fi; \
	SMOKE_SERVICE=$$SERVICE SMOKE_REPO=$(repo) npx tsx src/pillars/smoke/setup.ts && \
	SMOKE_SERVICE=$$SERVICE SMOKE_REPO=$(repo) \
		npx playwright test --config=src/pillars/smoke/playwright.config.ts && \
	npx tsx src/pillars/smoke/ensure-smoke-teardown.ts
	@[ ! "$$CI" = "true" ] && [ "$$OPEN_REPORT" = "1" ] && [ -d "playwright-report" ] && $(MAKE) --no-print-directory _open-report || true

# Specific suite — make test-smk-api-items
test-smk-%:
	@FULL="$(subst test-smk-,,$@)"; \
	SERVICE="$${FULL%%-*}"; \
	SUITE="$${FULL#*-}"; \
	if [ -z "$$SUITE" ] || [ "$$SUITE" = "$$SERVICE" ]; then \
		echo "❌ No suite specified for service '$$SERVICE'"; \
		echo ""; \
		echo "Available suites:"; \
		TEST_DIR=$$(node scripts/manifest-read.cjs ".den/$(repo)" smoke-testdir "$$SERVICE" 2>/dev/null); \
		if [ -n "$$TEST_DIR" ]; then \
			find ".den/$(repo)/$$TEST_DIR" -maxdepth 1 -type d \
				! -path ".den/$(repo)/$$TEST_DIR" \
				! -name "__*" ! -name "_*" \
				-exec basename {} \; 2>/dev/null | sort | sed "s/^/  make test-smk-$$SERVICE-/"; \
		fi; \
		echo ""; \
		echo "  make test-smk-$$SERVICE-all   (run all suites)"; \
		exit 1; \
	fi; \
	SUITE_DIR=".smoke-run/$(repo)-$$SERVICE/$$SUITE"; \
	echo "💨 Running $$SERVICE/$$SUITE smoke tests (repo=$(repo), env=$(env))..."; \
	echo ""; \
	if [ "$(env)" != "local" ] && [ "$${USE_LOCAL_CHECKOUT:-0}" != "1" ]; then \
		npx tsx src/pillars/smoke/setup-env.ts --env $(env) --repo $(repo) || exit 1; \
	fi; \
	SMOKE_SERVICE=$$SERVICE SMOKE_REPO=$(repo) npx tsx src/pillars/smoke/setup.ts && \
	if [ ! -d "$$SUITE_DIR" ]; then \
		echo "❌ Suite '$$SUITE' not found: $$SUITE_DIR"; \
		echo ""; \
		echo "Available suites:"; \
		find ".smoke-run/$(repo)-$$SERVICE" -maxdepth 1 -type d \
			! -path ".smoke-run/$(repo)-$$SERVICE" ! -name "node_modules" \
			-exec basename {} \; 2>/dev/null | sort | sed "s/^/  make test-smk-$$SERVICE-/"; \
		exit 1; \
	fi; \
	SMOKE_SERVICE=$$SERVICE SMOKE_REPO=$(repo) \
		npx playwright test --config=src/pillars/smoke/playwright.config.ts "$$SUITE_DIR" && \
	npx tsx src/pillars/smoke/ensure-smoke-teardown.ts
	@[ ! "$$CI" = "true" ] && [ "$$OPEN_REPORT" = "1" ] && [ -d "playwright-report" ] && $(MAKE) --no-print-directory _open-report || true

# ── JWT token cache ───────────────────────────────────────────────────────────

int-jwt-clear:
	@echo "🗑️  Clearing integration JWT token cache for env=$(env)..."
	@rm -f "playwright/.auth/api-token-admin-$(env).json"
	@rm -f "playwright/.auth/api-token-user-$(env).json"
	@rm -f "playwright/.auth/api-token-beta-$(env).json"
	@echo "✅ Token cache cleared for $(env). Tokens will be re-fetched on next test run."

int-jwt-status:
	@echo "🔍 Integration JWT Token Cache Status"
	@echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
	@for e in local dev sandbox staging production; do \
		echo ""; \
		echo "  $$e:"; \
		for role in admin user beta; do \
			f="playwright/.auth/api-token-$$role-$$e.json"; \
			if [ -f "$$f" ]; then \
				expires=$$(node -e "try{var d=JSON.parse(require('fs').readFileSync('$$f','utf8'));var m=Math.round((d.expiresAt-Date.now())/60000);console.log(m>0?'\u2705 '+d.email+' ('+m+'m remaining)':'\u26a0\ufe0f  '+d.email+' (EXPIRED)')}catch(e){console.log('\u274c (unreadable)')}" 2>/dev/null || echo "❌ (error)"); \
				echo "    $$role: $$expires"; \
			else \
				echo "    $$role: ❌ NOT CACHED"; \
			fi; \
		done; \
	done
	@echo ""
	@echo "  Run: make int-jwt-clear [env=<env>]  to force re-fetch"
	@echo "  Credentials: 1Password (eval \$$(op signin)) or CI ENV vars"

# ── Results & reports ─────────────────────────────────────────────────────────

results:
	@node scripts/view-results.js summary synthetic local

results-flaky:
	@node scripts/view-results.js flaky synthetic local

results-api:
	@node scripts/view-results.js summary integration local

results-perf:
	@node scripts/view-results.js summary performance local

# Internal: open playwright-report, handling port conflicts gracefully.
# Skipped when PLAYWRIGHT_HTML_OPEN=never (set by the web UI server).
_open-report:
	@[ "$$PLAYWRIGHT_HTML_OPEN" = "never" ] && exit 0 || true; \
	REPORT_PORT=9323; \
	EXISTING_PID=$$(lsof -ti:$$REPORT_PORT 2>/dev/null); \
	if [ -n "$$EXISTING_PID" ]; then \
		echo "⚠️  Port $$REPORT_PORT is already in use (PID $$EXISTING_PID)."; \
		printf "   Kill it and open the report? [y/N] "; \
		read ANSWER; \
		if [ "$$ANSWER" = "y" ] || [ "$$ANSWER" = "Y" ]; then \
			kill $$EXISTING_PID 2>/dev/null && sleep 0.5; \
			echo "✅ Process killed."; \
		else \
			echo "Aborted."; \
			exit 0; \
		fi; \
	fi; \
	echo "📊 Opening test report..."; \
	npx playwright show-report playwright-report

report:
	@if [ ! -d "playwright-report" ]; then \
		echo "❌ No report found. Run tests first:"; \
		echo "   • make test-syn-all  (browser tests)"; \
		echo "   • make test-int-all  (API tests)"; \
		exit 1; \
	fi
	@$(MAKE) --no-print-directory _open-report

clean-reports:
	@echo "🧹 Cleaning HTML reports..."
	@rm -rf playwright-report
	@echo "✅ HTML reports cleaned (JSONL results preserved)"

# Stop running test processes. Named `test-down` because `make down` stops
# SERVICES (make/local_dev.mk) — the old `make down` silently killed test
# processes while every service container kept running.
test-down:
	@echo "🛑 Stopping any running tests..."
	@pkill -f "playwright" 2>/dev/null || true
	@pkill -f "k6" 2>/dev/null || true
	@pkill -f "node.*cli" 2>/dev/null || true
	@echo "✅ All tests stopped"

# Deprecated: use make preflight
test-framework:
	@echo "⚠️  'make test-framework' is deprecated — use 'make preflight' instead"
	@$(MAKE) preflight
