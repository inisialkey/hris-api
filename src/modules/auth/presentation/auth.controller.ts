import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';

import { requireRequestContext, requireTenantContext } from '../../../shared/context';
import { RateLimit } from '../../../shared/http/rate-limit';
import { unwrap } from '../../../shared/unwrap';
import { AuthenticatedOnly, Public } from '../../authz';
import { LoginUseCase } from '../application/login.use-case';
import { IDENTITY_QUERY, type IdentityQueryPort } from '../application/ports/auth-services.port';
import { LoginDto } from './dto/login.dto';

/**
 * Operation-style paths (`/auth/<operation>`) are a sanctioned deviation from
 * api-standards §1's resource grammar: login is an operation, not a resource
 * (authentication.md §7).
 *
 * Controllers are mappers. Three lines is the budget — command, unwrap, respond
 * — and a fourth line of logic belongs in the use case (coding-standards §2).
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly login: LoginUseCase,
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
  async submit(@Body() dto: LoginDto, @Req() req: Request) {
    const result = await this.login.execute({
      email: dto.email,
      password: dto.password,
      tenantId: dto.tenantId,
      rememberDevice: dto.rememberDevice ?? false,
      ip: req.ip ?? req.socket.remoteAddress ?? 'unknown',
      userAgent: req.header('user-agent'),
    });

    const value = unwrap(result);
    // The picker response carries no tokens — the client re-calls with a
    // `tenantId` (UC-AUTH-001 step 6).
    if (value.kind === 'picker') return { tenantChoices: value.tenantChoices };

    const { kind, ...session } = value;
    void kind;
    return session;
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

    return {
      // `name` and `employeeId` are declared by authentication.md §7 and are
      // absent here on purpose. Both live on `employees`, which the employee
      // module owns, and reading another module's table directly is the ADR-0001
      // boundary violation this architecture exists to prevent. They arrive with
      // that module's query port — which is also when there is a name to return.
      user: { id: request.userId, email: user?.email },
      tenant: tenant ? { id: tenant.id, name: tenant.name, status: tenant.status } : null,
      permissions: [...(authorization?.permissions ?? [])],
      companyScope:
        authorization?.companyScope === 'all' ? null : [...(authorization?.companyScope ?? [])],
    };
  }
}
