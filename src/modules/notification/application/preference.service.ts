import { Inject, Injectable } from '@nestjs/common';

import { requireRequestContext } from '../../../shared/context';
import { type Result, fail, ok } from '../../../shared/result';
import { fieldCodes, sharedErrors } from '../../../shared/shared.errors';
import { notificationErrors } from '../domain/notification.errors';
import { PREFERENCE_REPOSITORY, type PreferenceRepositoryPort } from '../domain/notification.ports';
import type { NotificationChannel, PreferenceRow } from '../domain/notification.types';
import { TEMPLATES, findTemplate, templateModule } from '../domain/templates';

/**
 * UC-NTF-005 — the matrix and the single-cell toggle.
 *
 * The matrix is **the code registry merged with the opt-out rows**, in that
 * order, which is what BR-NTF-005's storage model forces: a user who has never
 * opened this screen has no rows, and every cell still has to render. Mandatory
 * templates are returned with their channels and a locked flag rather than
 * omitted — §6 shows them in a locked section, and a client that could not see
 * them would have no way to explain why the security emails keep arriving.
 */
@Injectable()
export class PreferenceService {
  constructor(
    @Inject(PREFERENCE_REPOSITORY) private readonly preferences: PreferenceRepositoryPort,
  ) {}

  async matrix(): Promise<PreferenceRow[]> {
    const optedOut = await this.preferences.listForUser(this.userId());
    const off = new Set(optedOut.map((row) => `${row.templateKey}:${row.channel}`));

    return Object.entries(TEMPLATES).map(([templateKey, template]) => ({
      templateKey,
      module: templateModule(templateKey),
      mandatory: template.mandatory,
      channels: template.channels.map((channel) => ({
        channel,
        // A mandatory template ignores stored rows entirely rather than trusting
        // that none exist: `toggle` refuses to write one, and a row that arrived
        // some other way must not read back as an honoured opt-out.
        enabled: template.mandatory || !off.has(`${templateKey}:${channel}`),
      })),
    }));
  }

  /**
   * §8's two rules, both cross-field and therefore both here rather than on the
   * DTO — the shape check is *"is this a channel"*, and the rule is *"is this a
   * channel **this template** declares"*.
   */
  async toggle(
    templateKey: string,
    channel: NotificationChannel,
    enabled: boolean,
  ): Promise<Result<Record<string, never>>> {
    const template = findTemplate(templateKey);
    if (!template) return fail(invalidEnum('templateKey', templateKey));
    if (!template.channels.includes(channel)) return fail(invalidEnum('channel', channel));

    // BR-NTF-005. Security notices, approval actionables and statutory documents
    // are not opinions, and the refusal is a business failure rather than a
    // silent no-op so the client can say why the switch will not move.
    if (template.mandatory) return fail(notificationErrors.templateMandatory({ templateKey }));

    const userId = this.userId();
    if (enabled) await this.preferences.optIn(userId, templateKey, channel);
    else await this.preferences.optOut(userId, templateKey, channel);

    return ok({});
  }

  private userId(): string {
    const userId = requireRequestContext().userId;
    if (!userId) throw new Error('preference access outside an authenticated request');
    return userId;
  }
}

function invalidEnum(field: string, value: string) {
  return sharedErrors.validationFailed([
    {
      field,
      code: fieldCodes.invalidEnum,
      messageKey: `errors.${fieldCodes.invalidEnum}`,
      params: { value },
    },
  ]);
}
