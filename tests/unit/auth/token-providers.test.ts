import { describe, it, expect, jest } from "@jest/globals";
import jwt from "jsonwebtoken";
import {
  getTokenProvider,
  resolveAuthProviderName,
} from "../../../src/shared/auth/token-providers/index.js";
import type { EnvironmentConfig } from "../../../src/shared/types/index.js";

const base: EnvironmentConfig = {
  name: "local",
  baseUrls: {
    web: "http://localhost:3000",
    api: "http://localhost:8000",
    services: {},
  },
  timeouts: { api: 1000, pageLoad: 1000 },
};

describe("auth provider selection", () => {
  it("is driven by config: explicit provider wins, auth0 block implies auth0, else none", () => {
    expect(
      resolveAuthProviderName({ ...base, auth: { provider: "cognito" } }),
    ).toBe("cognito");
    expect(
      resolveAuthProviderName({
        ...base,
        auth0: { domain: "d", clientId: "c", audience: "a" },
      }),
    ).toBe("auth0");
    expect(resolveAuthProviderName(base)).toBe("none");
  });

  it("none refuses to mint with a pointer to the config file", async () => {
    await expect(getTokenProvider("none").mint(base, "u", "p")).rejects.toThrow(
      /config\/environments\/local\.json/,
    );
  });
});

describe("cognito strategy", () => {
  const cfg: EnvironmentConfig = {
    ...base,
    auth: {
      provider: "cognito",
      cognito: { region: "us-east-1", clientId: "abc123" },
    },
  };

  it("calls InitiateAuth USER_PASSWORD_AUTH and returns the access token", async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        AuthenticationResult: {
          AccessToken: "at",
          IdToken: "it",
          ExpiresIn: 900,
          TokenType: "Bearer",
        },
      }),
    })) as unknown as typeof fetch;
    const t = await getTokenProvider("cognito").mint(cfg, "a@b.c", "pw", {
      fetchImpl,
    });
    expect(t).toEqual({
      accessToken: "at",
      expiresIn: 900,
      tokenType: "Bearer",
    });
    const [url, init] = (fetchImpl as unknown as jest.Mock).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://cognito-idp.us-east-1.amazonaws.com/");
    expect((init.headers as Record<string, string>)["X-Amz-Target"]).toBe(
      "AWSCognitoIdentityProviderService.InitiateAuth",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: "abc123",
      AuthParameters: { USERNAME: "a@b.c", PASSWORD: "pw" },
    });
  });

  it("surfaces challenges and errors", async () => {
    const challenge = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ChallengeName: "NEW_PASSWORD_REQUIRED" }),
    })) as unknown as typeof fetch;
    await expect(
      getTokenProvider("cognito").mint(cfg, "u", "p", { fetchImpl: challenge }),
    ).rejects.toThrow(/NEW_PASSWORD_REQUIRED/);
    const denied = jest.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({
        __type: "NotAuthorizedException",
        message: "Incorrect username or password.",
      }),
    })) as unknown as typeof fetch;
    await expect(
      getTokenProvider("cognito").mint(cfg, "u", "p", { fetchImpl: denied }),
    ).rejects.toThrow(/NotAuthorizedException/);
  });
});

describe("local-jwt strategy", () => {
  it("signs an HS256 token with the configured secret and claims", async () => {
    const cfg: EnvironmentConfig = {
      ...base,
      auth: {
        provider: "local-jwt",
        localJwt: {
          secretKey: "LOCAL_JWT_SECRET",
          issuer: "den",
          audience: "proto",
          claims: { role: "admin" },
        },
      },
    };
    const t = await getTokenProvider("local-jwt").mint(
      cfg,
      "dev@example.com",
      "",
      {
        env: { LOCAL_JWT_SECRET: "shh" },
      },
    );
    const decoded = jwt.verify(t.accessToken, "shh", {
      audience: "proto",
      issuer: "den",
    }) as jwt.JwtPayload;
    expect(decoded.sub).toBe("dev@example.com");
    expect(decoded.role).toBe("admin");
    expect(t.expiresIn).toBe(3600);
  });
});
