import { normaliseSteps, resolverRefs, validateConditions, validateSteps } from './step-config';

const UUID = '01931b7c-0000-7000-8000-000000000001';

const step = (over: Record<string, unknown> = {}) => ({
  quorum: 'any',
  resolvers: [{ type: 'direct_manager', levels: 1 }],
  onVacancy: { policy: 'fallback_role' },
  onSelfApproval: 'reroute_next_level',
  ...over,
});

const fields = (entries: { field: string }[]) => entries.map((entry) => entry.field);

describe('step config validation (§8)', () => {
  it('accepts the shape §4 documents', () => {
    expect(validateSteps([step()], 5)).toEqual([]);
  });

  it('refuses an empty chain and one past the depth cap', () => {
    expect(fields(validateSteps([], 5))).toEqual(['steps']);
    expect(fields(validateSteps([step(), step(), step()], 2))).toEqual(['steps']);
  });

  it('addresses each failure to its exact path, so the editor can mark a control', () => {
    const entries = validateSteps([step({ quorum: 'most' }), step({ slaHours: 0 })], 5);
    expect(fields(entries)).toEqual(['steps[0].quorum', 'steps[1].slaHours']);
  });

  it('requires at least one resolver per step', () => {
    expect(fields(validateSteps([step({ resolvers: [] })], 5))).toEqual(['steps[0].resolvers']);
  });

  it('refuses `direct_manager` at level 0 — that is the requester', () => {
    const entries = validateSteps(
      [step({ resolvers: [{ type: 'direct_manager', levels: 0 }] })],
      5,
    );
    expect(fields(entries)).toEqual(['steps[0].resolvers[0].levels']);
  });

  it('checks the reference field each resolver type actually carries', () => {
    const entries = validateSteps(
      [
        step({ resolvers: [{ type: 'position_holder' }] }),
        step({ resolvers: [{ type: 'specific_user', userId: 'not-a-uuid' }] }),
      ],
      5,
    );
    expect(fields(entries)).toEqual([
      'steps[0].resolvers[0].positionId',
      'steps[1].resolvers[0].userId',
    ]);
  });

  it('validates a fallback resolver as strictly as a step resolver', () => {
    const entries = validateSteps(
      [step({ onVacancy: { policy: 'fallback_resolver', resolver: { type: 'nope' } } })],
      5,
    );
    expect(fields(entries)).toEqual(['steps[0].onVacancy.resolver.type']);
  });

  it('reads an absent vacancy block as the ladder default rather than refusing it', () => {
    const raw = {
      quorum: 'all',
      resolvers: [{ type: 'direct_manager', levels: 2 }],
      onSelfApproval: 'allow',
    };
    expect(validateSteps([raw], 5)).toEqual([]);
    expect(normaliseSteps([raw])[0]?.onVacancy).toEqual({ policy: 'fallback_role' });
  });
});

describe('condition validation (§8)', () => {
  it('accepts a field the request type declares', () => {
    expect(
      validateConditions([{ field: 'dayCount', op: 'gt', value: 5 }], 'leave.request'),
    ).toEqual([]);
  });

  it('refuses a field belonging to another request type', () => {
    // `costAmount` is training's. A chain is bound to one type precisely so its
    // rules cannot reference fields that type never sends.
    expect(
      fields(validateConditions([{ field: 'costAmount', op: 'gt', value: 1 }], 'leave.request')),
    ).toEqual(['conditions[0].field']);
  });

  it('refuses an operator outside the declared set', () => {
    expect(
      fields(validateConditions([{ field: 'dayCount', op: 'like', value: 5 }], 'leave.request')),
    ).toEqual(['conditions[0].op']);
  });

  it('requires `in` to carry a list', () => {
    expect(
      fields(
        validateConditions([{ field: 'leaveTypeCode', op: 'in', value: 'sick' }], 'leave.request'),
      ),
    ).toEqual(['conditions[0].value']);
  });

  it('treats no conditions as the catch-all rather than an error', () => {
    expect(validateConditions(null, 'leave.request')).toEqual([]);
    expect(validateConditions([], 'leave.request')).toEqual([]);
  });
});

describe('resolver reference collection', () => {
  it('includes fallback resolvers, which is where a dead reference hides', () => {
    const steps = normaliseSteps([
      step({
        resolvers: [{ type: 'position_holder', positionId: UUID }],
        onVacancy: {
          policy: 'fallback_resolver',
          resolver: { type: 'role_holders', roleId: UUID },
        },
      }),
    ]);
    expect(resolverRefs(steps).map((ref) => ref.path)).toEqual([
      'steps[0].resolvers[0]',
      'steps[0].onVacancy.resolver',
    ]);
  });
});
