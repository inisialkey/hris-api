import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { unwrap } from '../../../shared/unwrap';
import { RequirePermission } from '../../authz';
import { ContractService } from '../application/contract.service';
import { FamilyService } from '../application/family.service';
import {
  CreateContractDto,
  FamilyMemberDto,
  UpdateContractDto,
  UpdateFamilyMemberDto,
} from './dto/employee.dto';

/**
 * §7's two owned sub-resources. Nesting is one level and only for true
 * ownership (naming §3) — a contract has no meaning apart from its employee,
 * which is also why a mismatched id is 404 rather than 403.
 *
 * Unpaginated by §7 (`— (history, small)`): an employee's contracts are counted
 * in single digits and their family members in low tens. The deviation from
 * api-standards §5.1 is the module document's, stated there.
 */
@ApiTags('employee')
@Controller('employees/:employeeId/contracts')
export class EmployeeContractsController {
  constructor(private readonly contracts: ContractService) {}

  @Get()
  @RequirePermission('employee.master.read')
  @ApiOperation({ operationId: 'listEmployeeContracts', summary: 'Contract timeline' })
  async list(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return { data: unwrap(await this.contracts.list(employeeId)) };
  }

  @Post()
  @RequirePermission('employee.master.update')
  @ApiOperation({ operationId: 'createEmployeeContract', summary: 'Renewal — a new row' })
  async create(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: CreateContractDto,
  ) {
    return unwrap(await this.contracts.create(employeeId, dto));
  }

  @Patch(':contractId')
  @RequirePermission('employee.master.update')
  @ApiOperation({ operationId: 'updateEmployeeContract', summary: 'Correct dates or file' })
  async update(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('contractId', ParseUUIDPipe) contractId: string,
    @Body() dto: UpdateContractDto,
  ) {
    return unwrap(await this.contracts.update(employeeId, contractId, dto));
  }

  @Delete(':contractId')
  @RequirePermission('employee.master.update')
  @HttpCode(200)
  @ApiOperation({ operationId: 'deleteEmployeeContract', summary: 'Soft delete a mistaken row' })
  async archive(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('contractId', ParseUUIDPipe) contractId: string,
  ) {
    unwrap(await this.contracts.archive(employeeId, contractId));
    return { id: contractId };
  }
}

@ApiTags('employee')
@Controller('employees/:employeeId/family-members')
export class EmployeeFamilyController {
  constructor(private readonly family: FamilyService) {}

  @Get()
  @RequirePermission('employee.master.read')
  @ApiOperation({ operationId: 'listEmployeeFamilyMembers', summary: 'Family members' })
  async list(@Param('employeeId', ParseUUIDPipe) employeeId: string) {
    return { data: unwrap(await this.family.list(employeeId)) };
  }

  @Post()
  @RequirePermission('employee.master.update')
  @ApiOperation({ operationId: 'createEmployeeFamilyMember', summary: 'Add a family member' })
  async create(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Body() dto: FamilyMemberDto,
  ) {
    return unwrap(
      await this.family.create(employeeId, {
        name: dto.name,
        relationship: dto.relationship,
        birthDate: dto.birthDate ?? null,
        phone: dto.phone ?? null,
        isEmergencyContact: dto.isEmergencyContact ?? false,
      }),
    );
  }

  @Patch(':memberId')
  @RequirePermission('employee.master.update')
  @ApiOperation({ operationId: 'updateEmployeeFamilyMember', summary: 'Edit a family member' })
  async update(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
    @Body() dto: UpdateFamilyMemberDto,
  ) {
    return unwrap(await this.family.update(employeeId, memberId, dto));
  }

  @Delete(':memberId')
  @RequirePermission('employee.master.update')
  @HttpCode(200)
  @ApiOperation({ operationId: 'deleteEmployeeFamilyMember', summary: 'Remove a family member' })
  async archive(
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Param('memberId', ParseUUIDPipe) memberId: string,
  ) {
    unwrap(await this.family.archive(employeeId, memberId));
    return { id: memberId };
  }
}
