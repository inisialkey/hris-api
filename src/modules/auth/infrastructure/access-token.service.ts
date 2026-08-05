import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { type CryptoKey, SignJWT, importPKCS8, importSPKI, jwtVerify } from 'jose';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import type { AccessTokenClaims, AccessTokenPort } from '../application/ports/auth-services.port';

/** A-014: EdDSA (Ed25519), `kid` rotation, and the verifier pins the algorithm. */
const ALG = 'EdDSA';

/**
 * Mints and verifies access tokens.
 *
 * **No permission claims** (ADR-0004, BR-AUTH-012). Guards resolve permissions
 * from a 60-second Redis cache, so a role edit bites within the cache TTL rather
 * than within the token lifetime — and revocation semantics stay answerable.
 *
 * The algorithm is pinned on verify rather than read from the token header.
 * Accepting the header's `alg` is how a signed token becomes an unsigned one.
 */
@Injectable()
export class AccessTokenService implements AccessTokenPort, OnModuleInit {
  private privateKey!: CryptoKey;
  private readonly publicKeys = new Map<string, CryptoKey>();
  private activeKid = '';
  private ttlSeconds = 900;

  constructor(
    private readonly config: ConfigService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  async onModuleInit(): Promise<void> {
    this.activeKid = this.config.getOrThrow<string>('JWT_ACTIVE_KID');
    this.ttlSeconds = Number(this.config.get<string>('ACCESS_TOKEN_TTL') ?? '900');

    this.privateKey = await importPKCS8(this.config.getOrThrow<string>('JWT_PRIVATE_KEY'), ALG);

    // The whole verify set, not just the active one: rotation leaves older kids
    // valid until the window expires, and a token minted five minutes ago must
    // not die because a new key was written (environments.md §6.3).
    const set = JSON.parse(this.config.getOrThrow<string>('JWT_PUBLIC_KEYS')) as Record<
      string,
      string
    >;
    for (const [kid, pem] of Object.entries(set)) {
      this.publicKeys.set(kid, await importSPKI(pem, ALG));
    }

    if (!this.publicKeys.has(this.activeKid)) {
      throw new Error(`JWT_ACTIVE_KID ${this.activeKid} is absent from JWT_PUBLIC_KEYS`);
    }
  }

  async sign(claims: AccessTokenClaims): Promise<{ token: string; expiresInSeconds: number }> {
    const now = Math.floor(this.clock.now().getTime() / 1000);
    const token = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: ALG, kid: this.activeKid })
      .setIssuedAt(now)
      .setExpirationTime(now + this.ttlSeconds)
      .sign(this.privateKey);

    return { token, expiresInSeconds: this.ttlSeconds };
  }

  /** `null` on any failure — the caller maps to a catalog code, not this. */
  async verify(token: string): Promise<AccessTokenClaims | null> {
    try {
      const { payload, protectedHeader } = await jwtVerify(
        token,
        (header) => {
          const key = header.kid ? this.publicKeys.get(header.kid) : undefined;
          // `kid` is required, not optional: a token whose header names no key,
          // or names one outside the rotation window, is not verifiable.
          if (!key) throw new Error('unknown kid');
          return key;
        },
        {
          algorithms: [ALG],
          // 30 s leeway, platform-fixed (authentication.md §9): a phone's clock
          // drifts, and `exp` is still evaluated server-side only.
          clockTolerance: 30,
          currentDate: this.clock.now(),
        },
      );
      void protectedHeader;

      // BR-AUTH-012: refresh material never authenticates a request.
      if (payload.typ !== 'access') return null;
      if (typeof payload.sub !== 'string') return null;
      if (typeof payload.tenantId !== 'string') return null;
      if (typeof payload.sid !== 'string') return null;

      return { sub: payload.sub, tenantId: payload.tenantId, sid: payload.sid, typ: 'access' };
    } catch {
      return null;
    }
  }
}
