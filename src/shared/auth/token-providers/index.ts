/**
 * Token-provider strategy — how Den mints a bearer token for a test user.
 *
 * Selected per environment by `auth.provider` in config/environments/<env>.json:
 *
 *   auth0      Resource Owner Password grant against an Auth0 tenant
 *   cognito    AWS Cognito InitiateAuth (USER_PASSWORD_AUTH) over HTTPS — no SDK
 *   local-jwt  self-signed HS256 token for local stacks that trust a shared secret
 *   none       environment has no auth; minting throws
 *
 * When `auth` is omitted, an `auth0` block implies "auth0", else "none".
 * Adding a provider = implement TokenProvider and register it in PROVIDERS.
 */
import jwt from "jsonwebtoken";
import { envSelector } from "../../environment/env-selector.js";
import { getSecretsProvider } from "../../secrets/index.js";
import type {
  AuthProviderName,
  EnvironmentConfig,
  Environment,
} from "../../types/index.js";
import { mintAuth0JWT } from "./auth0.js";

export interface MintedToken {
  accessToken: string;
  expiresIn: number;
  tokenType: string;
}

export interface MintOptions {
  clientSecret?: string;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export interface TokenProvider {
  readonly name: AuthProviderName;
  mint(
    envConfig: EnvironmentConfig,
    username: string,
    password: string,
    options?: MintOptions,
  ): Promise<MintedToken>;
}

export function resolveAuthProviderName(
  cfg: EnvironmentConfig,
): AuthProviderName {
  return cfg.auth?.provider ?? (cfg.auth0 ? "auth0" : "none");
}

const auth0Provider: TokenProvider = {
  name: "auth0",
  mint: (cfg, u, p, o = {}) =>
    mintAuth0JWT(cfg.name as Environment, u, p, {
      clientSecret: o.clientSecret,
    }),
};

interface CognitoAuthResult {
  AuthenticationResult?: {
    AccessToken?: string;
    IdToken?: string;
    ExpiresIn?: number;
    TokenType?: string;
  };
  ChallengeName?: string;
  __type?: string;
  message?: string;
}

const cognitoProvider: TokenProvider = {
  name: "cognito",
  async mint(cfg, username, password, o = {}) {
    const c = cfg.auth?.cognito;
    if (!c) throw new Error(`auth.cognito is not set for ${cfg.name}`);
    const res = await (o.fetchImpl ?? fetch)(
      `https://cognito-idp.${c.region}.amazonaws.com/`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-amz-json-1.1",
          "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
        },
        body: JSON.stringify({
          AuthFlow: "USER_PASSWORD_AUTH",
          ClientId: c.clientId,
          AuthParameters: { USERNAME: username, PASSWORD: password },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    const data = (await res.json()) as CognitoAuthResult;
    const r = data.AuthenticationResult;
    const token = c.useIdToken ? r?.IdToken : r?.AccessToken;
    if (!res.ok || !token) {
      const why = data.ChallengeName
        ? `challenge ${data.ChallengeName} (complete it once in the hosted UI)`
        : `${data.__type ?? res.status} — ${data.message ?? "no token returned"}`;
      throw new Error(
        `Cognito login failed for "${username}" (${cfg.name}): ${why}`,
      );
    }
    return {
      accessToken: token,
      expiresIn: r?.ExpiresIn ?? 3600,
      tokenType: r?.TokenType ?? "Bearer",
    };
  },
};

const localJwtProvider: TokenProvider = {
  name: "local-jwt",
  async mint(cfg, username, _password, o = {}) {
    const l = cfg.auth?.localJwt;
    if (!l) throw new Error(`auth.localJwt is not set for ${cfg.name}`);
    const env = o.env ?? process.env;
    const secret =
      env[l.secretKey] ??
      (await getSecretsProvider().tryGet({
        vault: "",
        item: "",
        field: l.secretKey,
        key: l.secretKey,
      }));
    if (!secret) {
      throw new Error(
        `local-jwt signing secret ${l.secretKey} not found in env or the secrets backend`,
      );
    }
    const ttl = l.ttlSeconds ?? 3600;
    const claims = { email: username, ...l.claims };
    const accessToken = jwt.sign(claims, secret, {
      algorithm: "HS256",
      // A configured `sub` claim (e.g. a user id) wins over the username.
      ...("sub" in claims ? {} : { subject: username }),
      expiresIn: ttl,
      ...(l.issuer ? { issuer: l.issuer } : {}),
      ...(l.audience ? { audience: l.audience } : {}),
    });
    return { accessToken, expiresIn: ttl, tokenType: "Bearer" };
  },
};

const noneProvider: TokenProvider = {
  name: "none",
  async mint(cfg) {
    throw new Error(
      `Environment ${cfg.name} has no auth provider configured (auth.provider: none). ` +
        `Set auth.provider in config/environments/${cfg.name}.json.`,
    );
  },
};

const PROVIDERS: Record<AuthProviderName, TokenProvider> = {
  auth0: auth0Provider,
  cognito: cognitoProvider,
  "local-jwt": localJwtProvider,
  none: noneProvider,
};

export function getTokenProvider(name: AuthProviderName): TokenProvider {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown auth provider "${String(name)}"`);
  return p;
}

/** Mint a token for `env` with whatever provider that environment configures. */
export async function mintAccessToken(
  env: Environment,
  username: string,
  password: string,
  options: MintOptions = {},
): Promise<MintedToken> {
  const cfg = await envSelector.loadEnvironment(env);
  return getTokenProvider(resolveAuthProviderName(cfg)).mint(
    cfg,
    username,
    password,
    options,
  );
}
