import { Controller, Get, Header, Inject } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CLOCK, type Clock } from '../../../shared/clock.port';
import { requireRequestContext } from '../../../shared/context';
import { unwrap } from '../../../shared/unwrap';
import { AuthenticatedOnly } from '../../authz';
import { ProfileService } from '../application/profile.service';
import { RevealService } from '../application/reveal.service';
import { toBusinessDate } from '../domain/dates';
import { toProfileResponse } from './employee.mapper';

/**
 * §7's `/me` surfaces — the mobile bootstrap read, the self reveal, and the
 * manager team list.
 *
 * **`@AuthenticatedOnly()` throughout, and that is the rule rather than a
 * shortcut.** These are self and team scope by construction (BR-AUTHZ-009), so
 * there is no key to check and — under ADR-0005's lazy-resolution amendment —
 * no permission set to resolve either. That matters on exactly this path: the
 * cache is keyed per user and an employee appears about twice a day, so an
 * eager lookup here would be a guaranteed miss on the hottest route in the
 * product.
 */
@ApiTags('employee')
@Controller('me')
export class MeController {
  constructor(
    private readonly profile: ProfileService,
    private readonly reveal: RevealService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  @Get('profile')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'getOwnProfile', summary: 'Masked self profile (§4.3)' })
  async ownProfile() {
    const userId = this.callerId();
    return toProfileResponse(unwrap(await this.profile.ownProfile(userId, this.today())));
  }

  /**
   * UC-EMP-003, self path. Same audit row as the admin reveal — §4.3 registers
   * the key, not the route — and the same `no-store`, because the value is
   * rendered from memory and never persisted (ADR-0016 decision 6).
   */
  @Get('profile/sensitive')
  @AuthenticatedOnly()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ operationId: 'revealOwnProfile', summary: 'Own full values — audited' })
  async ownSensitive() {
    return unwrap(await this.reveal.revealOwn(this.callerId()));
  }

  @Get('team')
  @AuthenticatedOnly()
  @ApiOperation({ operationId: 'getOwnTeam', summary: 'UC-EMP-011 — direct reports' })
  async team() {
    return { data: unwrap(await this.profile.team(this.callerId(), this.today())) };
  }

  /**
   * A request that reached here has passed `JwtAuthGuard`, so a missing user id
   * is a wiring bug rather than an anonymous caller. Throwing is right: it is
   * `SYS_INTERNAL` through the global filter, which is what an impossible state
   * should look like, rather than a 404 that would read as "you have no profile".
   */
  private callerId(): string {
    const userId = requireRequestContext().userId;
    if (!userId) throw new Error('authenticated route reached with no user id');
    return userId;
  }

  private today(): string {
    return toBusinessDate(this.clock.now());
  }
}
