import { checkReparent, type GraphEdge } from './graph';

/**
 * A chain six deep, plus a two-node branch hanging off the root — enough shape
 * to move a subtree into a place it does not fit.
 *
 *   d1 → d2 → d3 → d4 → d5 → d6
 *   d1 → b1 → b2
 */
const chain: GraphEdge[] = [
  { id: 'd1', parentId: null },
  { id: 'd2', parentId: 'd1' },
  { id: 'd3', parentId: 'd2' },
  { id: 'd4', parentId: 'd3' },
  { id: 'd5', parentId: 'd4' },
  { id: 'd6', parentId: 'd5' },
  { id: 'b1', parentId: 'd1' },
  { id: 'b2', parentId: 'b1' },
];

const DEPTH_CAP = 6;

describe('BR-ORG-004 cycles', () => {
  it('refuses a department that is its own parent', () => {
    expect(checkReparent(chain, 'd3', 'd3', DEPTH_CAP)).toBe('cycle');
  });

  it('refuses a parent taken from the node’s own subtree', () => {
    expect(checkReparent(chain, 'd2', 'd5', DEPTH_CAP)).toBe('cycle');
  });

  it('allows a move that only goes sideways', () => {
    expect(checkReparent(chain, 'b1', 'd2', DEPTH_CAP)).toBe('ok');
  });

  it('does not spin on a loop that is already in the data', () => {
    const looped: GraphEdge[] = [
      { id: 'x', parentId: 'y' },
      { id: 'y', parentId: 'x' },
    ];
    expect(checkReparent(looped, 'z', 'x')).toBe('cycle');
  });
});

describe('BR-ORG-004 depth', () => {
  it('accepts a leaf landing on the last allowed level', () => {
    // b2 is a leaf; under d5 it sits at 6.
    expect(checkReparent(chain, 'b2', 'd5', DEPTH_CAP)).toBe('ok');
  });

  it('refuses a leaf one level past the cap', () => {
    expect(checkReparent(chain, 'b2', 'd6', DEPTH_CAP)).toBe('too-deep');
  });

  it('measures the whole subtree, not the node being moved', () => {
    // b1 is two levels tall. Under d4 its leaf would land at 6 — legal — but
    // under d5 the leaf lands at 7 even though b1 itself would sit at 6.
    expect(checkReparent(chain, 'b1', 'd4', DEPTH_CAP)).toBe('ok');
    expect(checkReparent(chain, 'b1', 'd5', DEPTH_CAP)).toBe('too-deep');
  });

  it('caps a top-level subtree at the same six levels', () => {
    expect(checkReparent(chain, 'd1', null, DEPTH_CAP)).toBe('ok');
    expect(checkReparent([...chain, { id: 'd7', parentId: 'd6' }], 'd1', null, DEPTH_CAP)).toBe(
      'too-deep',
    );
  });

  it('treats a node that does not exist yet as a leaf', () => {
    // Creation runs the same check: a new child of d5 lands at 6, of d6 at 7.
    expect(checkReparent(chain, 'new', 'd5', DEPTH_CAP)).toBe('ok');
    expect(checkReparent(chain, 'new', 'd6', DEPTH_CAP)).toBe('too-deep');
  });
});

describe('reporting lines', () => {
  it('has no depth cap — an org chart is as deep as the company is', () => {
    const deep: GraphEdge[] = Array.from({ length: 20 }, (_, index) => ({
      id: `p${String(index)}`,
      parentId: index === 0 ? null : `p${String(index - 1)}`,
    }));
    expect(checkReparent(deep, 'new', 'p19')).toBe('ok');
  });

  it('still refuses a cycle', () => {
    expect(checkReparent(chain, 'd4', 'd6')).toBe('cycle');
  });
});
