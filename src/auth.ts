import { Auth, type AuthConfig } from "@auth/core";
import { getToken } from "@auth/core/jwt";
import GitHub from "@auth/core/providers/github";
import Google from "@auth/core/providers/google";
import type { Config } from "./config.ts";

export class AuthError extends Error {}

function sessionCookie(config: Config) {
  const secure = new URL(config.origin).protocol === "https:";
  return {
    secure,
    name: `${secure ? "__Secure-" : ""}authjs.session-token`,
  };
}

export function authConfig(config: Config): AuthConfig {
  const { secure, name: cookieName } = sessionCookie(config);
  const providers = [];
  if (config.googleClientId && config.googleClientSecret) {
    providers.push(
      Google({
        clientId: config.googleClientId,
        clientSecret: config.googleClientSecret,
      }),
    );
  }
  if (config.githubClientId && config.githubClientSecret) {
    providers.push(
      GitHub({
        clientId: config.githubClientId,
        clientSecret: config.githubClientSecret,
      }),
    );
  }
  return {
    providers,
    secret: config.authSecret,
    trustHost: true,
    basePath: "/auth",
    session: { strategy: "jwt" },
    cookies: {
      sessionToken: {
        name: cookieName,
        options: {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure,
        },
      },
    },
    callbacks: {
      jwt({ token, account }) {
        if (account) {
          token.sub = `${account.provider}:${account.providerAccountId}`;
        }
        return token;
      },
      session({ session, token }) {
        if (session.user && token.sub) {
          session.user.id = token.sub;
        }
        return session;
      },
    },
    logger: {
      error() {
        console.error("Authentication failed");
      },
      warn() {},
      debug() {},
    },
  };
}

export async function handleAuth(
  request: Request,
  config: Config,
): Promise<Response> {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("x-forwarded-host");
  headers.delete("x-forwarded-proto");
  return await Auth(
    new Request(new URL(`${url.pathname}${url.search}`, config.origin), {
      method: request.method,
      headers,
      body: request.body,
    }),
    authConfig(config),
  );
}

export async function authenticate(
  request: Request,
  config: Config,
): Promise<string> {
  const { secure, name: cookieName } = sessionCookie(config);
  const headers = new Headers();
  const cookie = request.headers.get("cookie");
  if (cookie && cookie.length <= 8192) headers.set("cookie", cookie);
  const token = await getToken({
    req: new Request(request.url, { headers }),
    secret: config.authSecret,
    cookieName,
    secureCookie: secure,
  });
  if (
    typeof token?.sub !== "string" || token.sub.length < 1 ||
    token.sub.length > 200 || !/^[a-zA-Z0-9:_-]+$/.test(token.sub) ||
    typeof token.exp !== "number" || token.exp <= Date.now() / 1000
  ) {
    throw new AuthError();
  }
  return token.sub;
}
