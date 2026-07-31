import { randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import { ApiProblem } from "./errors.js";

export interface Session {
  id: string;
  username: string;
  csrfToken: string;
  expiresAt: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  public create(username: string, ttlMs: number): Session {
    const session: Session = {
      id: randomBytes(32).toString("base64url"),
      username,
      csrfToken: randomBytes(32).toString("base64url"),
      expiresAt: Date.now() + ttlMs
    };
    this.sessions.set(session.id, session);
    return session;
  }

  public get(id: string | undefined): Session | undefined {
    if (id === undefined) {
      return undefined;
    }

    const session = this.sessions.get(id);
    if (session === undefined) {
      return undefined;
    }

    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }

    return session;
  }

  public delete(id: string): void {
    this.sessions.delete(id);
  }
}

export function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function getRequestSession(
  request: FastifyRequest,
  config: AppConfig,
  sessions: SessionStore
): Session | undefined {
  const signedCookie = request.cookies[config.sessionCookieName];
  if (signedCookie === undefined) {
    return undefined;
  }

  const unsignedCookie = request.unsignCookie(signedCookie);
  if (!unsignedCookie.valid) {
    return undefined;
  }

  return sessions.get(unsignedCookie.value);
}

export function requireSession(
  request: FastifyRequest,
  config: AppConfig,
  sessions: SessionStore
): Session {
  const session = getRequestSession(request, config, sessions);
  if (session === undefined) {
    throw new ApiProblem(401, "UNAUTHENTICATED", "A valid session is required.", false);
  }

  return session;
}

export function requireCsrf(request: FastifyRequest, session: Session): void {
  const csrfToken = request.headers["x-csrf-token"];
  if (typeof csrfToken !== "string" || !safeEquals(csrfToken, session.csrfToken)) {
    throw new ApiProblem(403, "CSRF_REJECTED", "The CSRF token is missing or invalid.", false);
  }
}
