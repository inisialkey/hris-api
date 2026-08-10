import { guardCell, guardValue } from './injection';

describe('BR-IMP-010 export injection defense', () => {
  it('apostrophe-prefixes each of the four characters the rule names', () => {
    for (const prefix of ['=', '+', '-', '@']) {
      expect(guardCell(`${prefix}HYPERLINK("https://x")`)).toBe(`'${prefix}HYPERLINK("https://x")`);
    }
  });

  it('leaves an ordinary value alone', () => {
    expect(guardCell('Budi Santoso')).toBe('Budi Santoso');
    expect(guardCell('')).toBe('');
  });

  it('guards only the leading character — a formula is only a formula at the start', () => {
    expect(guardCell('A=B')).toBe('A=B');
    expect(guardCell('e-mail')).toBe('e-mail');
  });

  it('guards a negative-looking string, which is the rule’s deliberate cost', () => {
    // `-500` typed into a text column arrives quoted. The alternative is a
    // per-column exemption, and an exemption is what an attacker aims at.
    expect(guardCell('-500')).toBe("'-500");
  });

  it('passes numbers and booleans through unchanged so a total still sums', () => {
    expect(guardValue(-500)).toBe(-500);
    expect(guardValue(0)).toBe(0);
    expect(guardValue(true)).toBe(true);
  });

  it('leaves an absent value absent rather than writing the word null', () => {
    expect(guardValue(null)).toBeNull();
  });
});
