import { describe, expect, test } from 'bun:test';
import { parseTemplateExpression, referencedNodeIds, resolveTemplate, resolveTemplateMap } from '../src/templates.ts';

describe('template parsing', () => {
  test('recognises the three supported forms', () => {
    expect(parseTemplateExpression('input.payload.shiftId')).toEqual({ kind: 'input', path: 'payload.shiftId' });
    expect(parseTemplateExpression('nodes.rank.output.employeeIds')).toEqual({
      kind: 'node',
      nodeId: 'rank',
      path: 'employeeIds',
    });
    expect(parseTemplateExpression('now+4h')).toEqual({ kind: 'now', offsetMinutes: 240 });
    expect(parseTemplateExpression('now-30m')).toEqual({ kind: 'now', offsetMinutes: -30 });
  });

  test('rejects expressions it cannot resolve', () => {
    expect(parseTemplateExpression('secrets.aws_key')).toBeNull();
    expect(parseTemplateExpression('nodes.rank.employeeIds')).toBeNull();
  });

  test('collects the node ids a template depends on', () => {
    expect(referencedNodeIds('{{nodes.rank.output.employeeIds}} and {{nodes.policy.output.passed}}')).toEqual([
      'rank',
      'policy',
    ]);
  });
});

describe('template resolution', () => {
  const scope = {
    input: { payload: { shiftId: 'shift-1', hoursUntilStart: 7.5 } },
    nodes: { rank: { output: { employeeIds: ['e1', 'e2'], costDeltaCents: 18400 } } },
    now: new Date('2026-09-20T06:00:00.000Z'),
  };

  test('resolves event payload paths', () => {
    expect(resolveTemplate('{{input.payload.shiftId}}', scope)).toBe('shift-1');
  });

  test('resolves upstream node outputs', () => {
    expect(resolveTemplate('{{nodes.rank.output.costDeltaCents}}', scope)).toBe('18400');
  });

  test('computes timestamp offsets from now', () => {
    expect(resolveTemplate('{{now+4h}}', scope)).toBe('2026-09-20T10:00:00.000Z');
    expect(resolveTemplate('{{now-30m}}', scope)).toBe('2026-09-20T05:30:00.000Z');
  });

  test('keeps arrays and numbers typed when the whole value is one expression', () => {
    const resolved = resolveTemplateMap(
      {
        employeeIds: '{{nodes.rank.output.employeeIds}}',
        shiftId: '{{input.payload.shiftId}}',
        expiresAt: '{{now+4h}}',
        reason: 'Coverage for {{input.payload.shiftId}}',
      },
      scope,
    );
    expect(resolved.employeeIds).toEqual(['e1', 'e2']);
    expect(resolved.shiftId).toBe('shift-1');
    expect(resolved.expiresAt).toBe('2026-09-20T10:00:00.000Z');
    expect(resolved.reason).toBe('Coverage for shift-1');
  });
});
