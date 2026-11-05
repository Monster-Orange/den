# make/secrets-1password.mk — targets of the 1password secrets strategy.
#
# den.mk includes this file only when the distribution selects
# `secrets.provider: 1password` (or DEN_SECRETS_PROVIDER=1password). No other
# distribution has these targets.

.PHONY: $(DEN_TARGET_PREFIX)-setup-1password auth-configure

# Populate the developer-keys item at secrets.developer_keys.{vault,item}
# (else the vault and item of secrets.refs.sudo). No default location.
$(DEN_TARGET_PREFIX)-setup-1password:
	@$(DEN_TSX) $(DEN_ENGINE)/scripts/setup-1password.ts

# Per-engineer admin setup in your own 1Password — staging/production only.
# Saves config/local/admin-auth-{env}.json (gitignored, no password stored).
auth-configure:
	@E2E_ENVIRONMENT=$(env) $(DEN_TSX) $(DEN_ENGINE)/scripts/auth-configure.ts
	@$(MAKE) int-jwt-clear env=$(env)
