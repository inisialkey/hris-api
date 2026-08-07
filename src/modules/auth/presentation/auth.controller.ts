import {
  Body,
  Controller,
  Get,
  Inject,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';

import {
  requireRequestContext,
  requireTenantContext,
  type RequestContext,
} from '../../../shared/context';
import { REFRESH_COOKIE, readCookieValue } from '../../../shared/http/cookies';
import { RateLimit } from '../../../shared/http/rate-limit';
import type { OffsetMeta } from '../../../shared/envelope';
import { sharedErrors } from '../../../shared/shared.errors';
import { AppErrorException, unwrap } from '../../../shared/unwrap';
import { AuthenticatedOnly, Public } from '../../authz';
import { AccountAdminUseCase } from '../application/account-admin.use-case';
import { AUTH_DEFAULTS } from '../application/auth-defaults';
import { DeviceUseCase } from '../application/device.use-case';
import { LoginUseCase } from '../application/login.use-case';
import { PasswordUseCase } from '../application/password.use-case';
import { RefreshUseCase } from '../application/refresh.use-case';
import { SessionUseCase, type SessionActor } from '../application/session.use-case';
import { IDENTITY_QUERY, type IdentityQueryPort } from '../application/ports/auth-services.port';
import { authErrors } from '../domain/auth.errors';
import {
  ChangePasswordDto,
  InviteAcceptDto,
  OwnerListQueryDto,
  RefreshDto,
  ResetConfirmDto,
  ResetRequestDto,
} from './dto/auth-flows.dto';
import { LoginDto } from './dto/login.dto';

/**
 * Operation-style paths (`/auth/<operation>`) are a sanctioned deviation from
 * api-standards §1's resource grammar: login is an operation, not a resource
 * (authentication.md §7). `sessions` and `devices` follow resource grammar.
 *
 * Controllers are mappers. Command, unwrap, respond — plus the cookie split §7
 * assigns to this layer: web sessions carry the refresh token in an `httpOnly`
 * cookie scoped to the refresh path, mobile carries it in the body.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private readonly login: LoginUseCase,
    private readonly refreshUseCase: RefreshUseCase,
    private readonly sessions: SessionUseCase,
    private readonly devices: DeviceUseCase,
    private readonly passwords: PasswordUseCase,
    private readonly accountAdmin: AccountAdminUseCase,
    @Inject(IDENTITY_QUERY) private readonly identity: IdentityQueryPort,
  ) {}

  @Post('login')
  @Public()
  // security-standards §3: per-email carries the anti-stuffing load, per-IP is
  // the NAT-tolerant backstop. Both must pass.
  @RateLimit(
    { limit: 5, seconds: 60, by: 'body:email' },
    { limit: 20, seconds: 3600, by: 'body:email' },
    { limit: 30, seconds: 60, by: 'ip' },
    { limit: 300, seconds: 3600, by: 'ip' },
  )
  @ApiOperation({ operationId: 'login', summary: 'Password login with per-tenant identity' })
  async submit(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.login.execute({
      email: dto.email,
      password: dto.password,
      tenantId: dto.tenantId,
      rememberDevice: dto.rememberDevice ?? false,
      ip: req.ip ?? req.socket.remoteAddress ?? 'unknown',
      userAgent: req.header('user-agent'),
      device: dto.device,
      replaceDeviceId: dto.replaceDeviceId,
    });

    const value = unwrap(result);
    // The picker response carries no tokens — the client re-calls with a
    // `tenantId` (UC-AUTH-001 step 6).
    if (value.kind === 'picker') return { tenantChoices: value.tenantChoices };

    const { kind, web, refreshToken, ...session } = value;
    void kind;
    if (!web) return { ...session, refreshToken };

    this.setRefreshCookie(res, refreshToken, dto.rememberDevice ?? false);
    return session;
  }

  @Post('refresh')
  @Public()
  // §3's refresh row: 10/min per session — the token hash is the session proxy.
  @RateLimit({ limit: 10, seconds: 60, by: 'refresh-token' })
  @ApiOperation({ operationId: 'refresh', summary: 'Rotate the refresh token (BR-AUTH-004/005)' })
  async refresh(
    @Body() dto: RefreshDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const presented = dto.refreshToken ?? readCookieValue(req.headers.cookie, REFRESH_COOKIE);
    if (!presented) throw new AppErrorException(authErrors.refreshInvalid());

    const value = unwrap(
      await this.refreshUseCase.execute({
        refreshToken: presented,
        fcmToken: dto.fcmToken,
      }),
    );

    if (!value.web) {
      return {
        accessToken: value.accessToken,
        expiresInSeconds: value.expiresInSeconds,
        refreshToken: value.refreshToken,
      };
    }
    this.setRefreshCookie(res, value.refreshToken, value.persistCookie);
    return { accessToken: value.accessToken, expiresInSeconds: value.expiresInSeconds };
  }

  @Post('logout')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'logout', summary: 'Revoke the acting session (idempotent)' })
  async logout(@Res({ passthrough: true }) res: Response) {
    const value = unwrap(await this.sessions.logout(this.actor('auth.session.revoke')));
    this.clearRefreshCookie(res);
    return value;
  }

  /**
   * The client bootstrap contract (authentication.md §7).
   *
   * `@AuthenticatedOnly()` and not a permission key: identity care is available
   * to every role. It is also the route that proves ADR-0005's lazy resolution —
   * `permissions` here is the *first* thing that asks for the set, and on the
   * self-service routes that follow, nothing ever does.
   */
  @Get('me')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'me', summary: 'Current identity, permissions and company scope' })
  async me() {
    const request = requireRequestContext();
    const ctx = requireTenantContext();
    const authorization = await request.authorization?.resolve();

    const user = request.userId ? await this.identity.findUser(request.userId) : null;
    const tenant = await this.identity.findTenant(ctx.tenantId);
    // `name` and `employeeId` (§7) came back with the employee module on
    // 2026-08-06, through its published `employee_directory` view rather than
    // its table — the channel ADR-0001 rule 6 exists for. `null` for a user
    // with no employee row, which is what makes `employeeId` optional in the
    // contract (A-195).
    const employee = request.userId
      ? await this.identity.findEmployeeIdentity(request.userId)
      : null;

    return {
      user: {
        id: request.userId,
        email: user?.email,
        name: employee?.fullName ?? null,
        employeeId: employee?.employeeId ?? null,
      },
      tenant: tenant ? { id: tenant.id, name: tenant.name, status: tenant.status } : null,
      permissions: [...(authorization?.permissions ?? [])],
      companyScope:
        authorization?.companyScope === 'all' ? null : [...(authorization?.companyScope ?? [])],
    };
  }

  @Get('sessions')
  @AuthenticatedOnly()
  @ApiOperation({
    operationId: 'listSessions',
    summary: 'Own sessions, or any user with auth.session.read',
  })
  async listSessions(@Query() query: OwnerListQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const value = unwrap(
      await this.sessions.list(this.actor('auth.session.read'), {
        userId: query.userId,
        page,
        pageSize,
      }),
    );
    return { data: value.rows, meta: offsetMeta(page, pageSize, value.total) };
  }

  @Post('sessions/:id/revoke')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'revokeSession', summary: 'Revoke a session (no-op when dead)' })
  async revokeSession(
    @Param('id', ParseUUIDPipe) id: string,
    @Res({ passthrough: true }) res: Response,
  ) {
    const actor = this.actor('auth.session.revoke');
    const value = unwrap(await this.sessions.revoke(actor, id));
    // Revoking the acting session behaves as logout (UC-AUTH-004).
    if (id === actor.sessionId) this.clearRefreshCookie(res);
    return value;
  }

  @Post('sessions/revoke-others')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'revokeOtherSessions', summary: 'Kill all but the acting session' })
  async revokeOtherSessions() {
    return unwrap(await this.sessions.revokeOthers(this.actor('auth.session.revoke')));
  }

  @Get('devices')
  @AuthenticatedOnly()
  @ApiOperation({
    operationId: 'listDevices',
    summary: 'Own devices, or any user with auth.device.read',
  })
  async listDevices(@Query() query: OwnerListQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const value = unwrap(
      await this.devices.list(this.actor('auth.device.read'), {
        userId: query.userId,
        page,
        pageSize,
      }),
    );
    return { data: value.rows, meta: offsetMeta(page, pageSize, value.total) };
  }

  @Post('devices/:id/revoke')
  @AuthenticatedOnly()
  @ApiOperation({
    operationId: 'revokeDevice',
    summary: 'Revoke a device and cascade its sessions',
  })
  async revokeDevice(@Param('id', ParseUUIDPipe) id: string) {
    return unwrap(await this.devices.revoke(this.actor('auth.device.revoke'), id));
  }

  @Post('password/reset-request')
  @Public()
  // §3's reset row: same email/IP split as login, tighter budgets.
  @RateLimit({ limit: 3, seconds: 3600, by: 'body:email' }, { limit: 30, seconds: 3600, by: 'ip' })
  @ApiOperation({
    operationId: 'requestPasswordReset',
    summary: 'Always 200, identical shape and timing',
  })
  requestPasswordReset(@Body() dto: ResetRequestDto) {
    // Fire-and-forget: the 200 leaves before any lookup starts, which is what
    // makes the timing identical whether the email exists or not (BR-AUTH-010).
    this.passwords.requestReset(dto.email).catch((error: unknown) => {
      this.logger.error(`password reset request failed: ${String(error)}`);
    });
    return {};
  }

  @Post('password/reset-confirm')
  @Public()
  @RateLimit({ limit: 30, seconds: 60, by: 'ip' })
  @ApiOperation({
    operationId: 'confirmPasswordReset',
    summary: 'Consume a reset token, revoke all sessions',
  })
  async confirmPasswordReset(@Body() dto: ResetConfirmDto) {
    return unwrap(await this.passwords.confirmReset(dto.token, dto.newPassword));
  }

  @Post('password/change')
  @AuthenticatedOnly()
  @ApiOperation({
    operationId: 'changePassword',
    summary: 'Verify current, set new, revoke others',
  })
  async changePassword(@Body() dto: ChangePasswordDto) {
    const { canActOnOthers, ...identity } = this.actor('');
    void canActOnOthers; // change is own-scope only; no key exists for it
    return unwrap(await this.passwords.change(identity, dto.currentPassword, dto.newPassword));
  }

  @Post('invite/accept')
  @Public()
  @RateLimit({ limit: 30, seconds: 60, by: 'ip' })
  @ApiOperation({ operationId: 'acceptInvite', summary: 'Set the first credential from an invite' })
  async acceptInvite(@Body() dto: InviteAcceptDto) {
    return unwrap(await this.passwords.acceptInvite(dto.token, dto.password));
  }

  @Post('users/:id/unlock')
  @AuthenticatedOnly()
  @ApiOperation({
    operationId: 'unlockUser',
    summary: 'Clear the administrative lock (auth.user.unlock)',
  })
  async unlockUser(@Param('id', ParseUUIDPipe) id: string) {
    const actor = await this.requireKey('auth.user.unlock');
    return unwrap(await this.accountAdmin.unlock(actor.userId, id));
  }

  @Post('users/:id/reset')
  @AuthenticatedOnly()
  @ApiOperation({
    operationId: 'resetUser',
    summary: 'Issue a reset token for a user (auth.user.reset)',
  })
  async resetUser(@Param('id', ParseUUIDPipe) id: string) {
    const actor = await this.requireKey('auth.user.reset');
    return unwrap(
      await this.passwords.requestResetForUser(
        { userId: actor.userId, tenantId: actor.tenantId },
        id,
      ),
    );
  }

  /**
   * The acting identity plus the endpoint's own escalation key as a thunk — an
   * own-scope call never resolves permissions (ADR-0005's lazy rule).
   */
  private actor(key: string): SessionActor {
    const request = requireRequestContext();
    const tenant = requireTenantContext();
    if (!request.userId || !request.sessionId) {
      throw new AppErrorException(authErrors.tokenInvalid());
    }
    return {
      tenantId: tenant.tenantId,
      userId: request.userId,
      sessionId: request.sessionId,
      canActOnOthers: async () => {
        const authorization = await this.resolve(request);
        return authorization.has(key);
      },
    };
  }

  /**
   * §7's admin rows answer a missing key with 404, not 403 — "miss or no
   * permission → 404 (existence hiding)" — which is why these two routes check
   * imperatively instead of via `@RequirePermission` (that guard's refusal is a
   * 403 that would distinguish the two probes).
   */
  private async requireKey(key: string): Promise<{ userId: string; tenantId: string }> {
    const request = requireRequestContext();
    const tenant = requireTenantContext();
    if (!request.userId) throw new AppErrorException(authErrors.tokenInvalid());
    const permissions = await this.resolve(request);
    if (!permissions.has(key)) throw new AppErrorException(sharedErrors.notFound());
    return { userId: request.userId, tenantId: tenant.tenantId };
  }

  private async resolve(request: RequestContext): Promise<ReadonlySet<string>> {
    const authorization = await request.authorization?.resolve();
    return authorization?.permissions ?? new Set();
  }

  private setRefreshCookie(res: Response, token: string, persist: boolean): void {
    res.cookie(REFRESH_COOKIE, token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      // Path-scoped to the refresh operation (ADR-0004) — no other endpoint
      // ever sees the cookie ride in.
      path: '/api/v1/auth/refresh',
      // Remembered sessions persist to the web absolute cap; unremembered ones
      // die with the browser session (ADR-0004's checkbox).
      ...(persist ? { maxAge: AUTH_DEFAULTS.refreshAbsoluteDaysWeb * 24 * 3600 * 1000 } : {}),
    });
  }

  private clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth/refresh' });
  }
}

function offsetMeta(page: number, pageSize: number, totalItems: number): OffsetMeta {
  return { page, pageSize, totalItems, totalPages: Math.ceil(totalItems / pageSize) };
}
