import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import Redis from 'ioredis';

import { REDIS } from '../../cache/redis.module';
import { sharedErrors } from '../shared.errors';
import { AppErrorException } from '../unwrap';

export const RATE_LIMIT = 'hris:rate-limit';

export interface RateWindow {
  /** Requests allowed inside the window. */
  limit: number;
  /** Window length in seconds. */
  seconds: number;
  /** What the budget is counted against. */
  by: 'ip' | 'body:email';
}

/**
 * Declares the windows a route is subject to. Several may apply at once and
 * **all** must pass — security-standards §3's login row is `5/min + 20/hour per
 * email` *and* `30/min + 300/hour per IP`, where per-email carries the
 * anti-stuffing load and per-IP is a NAT-tolerant backstop so that an onboarding
 * day on one office wifi does not lock a whole tenant out.
 */
export const RateLimit = (...windows: [RateWindow, ...RateWindow[]]) =>
  SetMetadata(RATE_LIMIT, windows);

/**
 * Chain position 2 (backend-nestjs §5) — **before** any authentication work, so
 * credential stuffing pays no argon2 cost. That ordering is the entire reason
 * this guard sits where it does rather than inside the auth module.
 *
 * ADR-0001 rule 4 makes `shared/` a whitelist, and a rate-limit guard is not on
 * it — ADR-0007 added the envelope interceptor and the idempotency guard, and
 * stopped there. This is the same class of addition and is proposed as a
 * one-line amendment to that whitelist rather than taken silently.
 * // ADR-0001 whitelist amendment (Proposed, hris-handbook PR)
 *
 * Sliding window over a Redis sorted set: drop what fell out of the window,
 * count what is left, admit or refuse. A fixed-window counter would allow twice
 * the limit across a boundary, which on a login route is the difference that
 * matters.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const windows = this.reflector.getAllAndOverride<RateWindow[]>(RATE_LIMIT, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!windows || windows.length === 0) return true;

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const now = Date.now();

    for (const window of windows) {
      const subject = this.subject(req, window.by);
      if (subject === undefined) continue;

      const key = `hris:ratelimit:-:${window.by}:${window.seconds}:${subject}`;
      const cutoff = now - window.seconds * 1000;

      const pipeline = this.redis.multi();
      pipeline.zremrangebyscore(key, 0, cutoff);
      pipeline.zadd(key, now, `${now}-${Math.random()}`);
      pipeline.zcard(key);
      pipeline.expire(key, window.seconds);
      const results = await pipeline.exec();

      const count = Number(results?.[2]?.[1] ?? 0);
      if (count > window.limit) {
        const retryAfterSeconds = window.seconds;
        // `Retry-After` is mandatory on a 429 (security-standards §3).
        http.getResponse<Response>().setHeader('Retry-After', String(retryAfterSeconds));
        throw new AppErrorException(sharedErrors.rateLimited({ retryAfterSeconds }));
      }
    }

    return true;
  }

  private subject(req: Request, by: RateWindow['by']): string | undefined {
    if (by === 'ip') {
      // The trusted-proxy chain is configured at ingress; `X-Forwarded-For` from
      // an arbitrary hop is never trusted (security-standards §3).
      return req.ip ?? req.socket.remoteAddress ?? 'unknown';
    }

    const body: unknown = req.body;
    if (typeof body === 'object' && body !== null && 'email' in body) {
      const { email } = body;
      if (typeof email === 'string') return email.trim().toLowerCase();
    }
    // No email in the body means the DTO will reject the request a moment later;
    // rate-limiting an absent subject would bucket every malformed request into
    // one budget and let one client exhaust it for everybody.
    return undefined;
  }
}
