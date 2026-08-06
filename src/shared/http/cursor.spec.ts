import { AppErrorException } from '../unwrap';
import { decodeCursor, encodeCursor } from './cursor';

/** api-standards §5.3: opaque, round-trippable, and never a 500 when abused. */
describe('cursor', () => {
  const position = {
    occurredAt: '2026-08-05T10:00:00.000Z',
    id: '01920000-0000-7000-8000-000000000001',
  };

  it('round-trips a position', () => {
    expect(decodeCursor(encodeCursor(position))).toEqual(position);
  });

  it('is base64url — safe in a query string', () => {
    // `+` in a query string decodes to a space, which is how a base64 cursor
    // becomes a `VAL_INVALID_CURSOR` for one caller in a thousand.
    expect(encodeCursor(position)).not.toMatch(/[+/=]/);
  });

  const garbage: [string, string][] = [
    ['not base64 at all', '!!!!'],
    ['valid base64, not JSON', Buffer.from('hello', 'utf8').toString('base64url')],
    ['JSON, but not a pair', Buffer.from('{"a":1}', 'utf8').toString('base64url')],
    ['pair of the wrong types', Buffer.from('[1,2]', 'utf8').toString('base64url')],
    ['unparseable date', Buffer.from(`["banana","${position.id}"]`, 'utf8').toString('base64url')],
    [
      'id that is not a uuid',
      Buffer.from(`["${position.occurredAt}","nope"]`, 'utf8').toString('base64url'),
    ],
  ];

  // Every one of these would otherwise reach the database as a cast and come
  // back as the server's 500 for the client's typo.
  it.each(garbage)('refuses %s with VAL_INVALID_CURSOR', (_label, cursor) => {
    try {
      decodeCursor(cursor);
      throw new Error('expected a refusal');
    } catch (error) {
      expect(error).toBeInstanceOf(AppErrorException);
      expect((error as AppErrorException).error.code).toBe('VAL_INVALID_CURSOR');
    }
  });
});
