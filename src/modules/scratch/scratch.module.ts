import { Body, Controller, Get, Injectable, Module, Post } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { uuidv7 } from 'uuidv7';

import { ConnectionProvider } from '../../database/connection.provider';
import { scratchNotes } from '../../database/schema';
import { requireRequestContext, requireTenantContext } from '../../shared/context';
import { RequirePermission } from '../authz';

/**
 * The walking skeleton's throwaway module (implementation-roadmap §4.1 item 2).
 *
 * **Deleted when the platform spine lands.** One file, deliberately — a module
 * that is going to be removed should be removable by `rm`, and spreading it
 * across four layer folders would make deleting it look like a refactor.
 *
 * What it exists to prove, and nothing else:
 *
 * - one route reaches a handler through the *full* guard chain: request-id,
 *   rate limit, JWT, tenant status, permission, transaction, validation,
 *   envelope, filters;
 * - `app.tenant_id` is set inside the request transaction, so RLS scopes the
 *   read without the query saying so;
 * - a write lands with the context's tenant and the policy's `WITH CHECK`
 *   refuses one that disagrees.
 *
 * The permission key is `auth.session.read`, borrowed from authentication.md §2.
 * That is deliberate: ADR-0005 makes permission keys immortal and code-defined,
 * so a skeleton that minted `scratch.note.read` would leave a permanent key
 * behind for a table that no longer exists.
 */

const SCRATCH_PERMISSION = 'auth.session.read';

export class CreateScratchNoteDto {
  @ApiProperty({ example: 'the skeleton walked' })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  body!: string;
}

@Injectable()
export class ScratchNoteRepository {
  constructor(private readonly connection: ConnectionProvider) {}

  /**
   * No `where` clause on the tenant, on purpose.
   *
   * A real repository would extend `TenantScopedRepository` and have the
   * predicate injected. Here the omission is the assertion: if this returns only
   * the caller's rows, it is RLS doing it, which is exactly what leak test L2
   * checks and what the second isolation layer is for.
   */
  async list(): Promise<{ id: string; body: string }[]> {
    return this.connection
      .handle()
      .select({ id: scratchNotes.id, body: scratchNotes.body })
      .from(scratchNotes);
  }

  async create(tenantId: string, userId: string | undefined, body: string): Promise<string> {
    const id = uuidv7();
    await this.connection
      .handle()
      .insert(scratchNotes)
      .values({ id, tenantId, body, createdBy: userId, updatedBy: userId });
    return id;
  }
}

@ApiTags('scratch')
@Controller('scratch-notes')
export class ScratchController {
  constructor(private readonly notes: ScratchNoteRepository) {}

  @Get()
  @RequirePermission(SCRATCH_PERMISSION)
  @ApiOperation({ operationId: 'listScratchNotes', summary: 'Walking-skeleton probe (temporary)' })
  async list() {
    return this.notes.list();
  }

  @Post()
  @RequirePermission(SCRATCH_PERMISSION)
  @ApiOperation({ operationId: 'createScratchNote', summary: 'Walking-skeleton probe (temporary)' })
  async create(@Body() dto: CreateScratchNoteDto) {
    const tenant = requireTenantContext();
    const request = requireRequestContext();
    const id = await this.notes.create(tenant.tenantId, request.userId, dto.body);
    return { id };
  }
}

@Module({
  controllers: [ScratchController],
  providers: [ScratchNoteRepository],
})
export class ScratchModule {}
