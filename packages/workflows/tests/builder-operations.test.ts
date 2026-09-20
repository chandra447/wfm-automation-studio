import { describe, expect, test } from 'bun:test';
import {
  applyOperations,
  builderOperationSchema,
  coverageRescueWorkflow,
  coverageRescueLayout,
  emptyLayout,
  type WorkflowDefinition,
} from '../src/index.ts';

/**
 * The builder's edit language. A model proposes these operations, so the tests
 * care about the two things that decide whether an agent can be trusted with
 * them: a rejected operation explains itself, and an edit that would break the
 * graph is dropped rather than half-applied.
 */

const definition: WorkflowDefinition = coverageRescueWorkflow;
const layout = coverageRescueLayout;

function run(operations: unknown[], from: WorkflowDefinition = definition, canvas = layout) {
  const parsed = operations.map((operation) => builderOperationSchema.parse(operation));
  return applyOperations(from, canvas, parsed);
}

describe('applyOperations', () => {
  test('adds a node, wires it into the graph, and places it', () => {
    const outcome = run([
      { op: 'add_node', id: 'escalation_note', type: 'artifact', label: 'Escalation note' },
      { op: 'disconnect', from: { node: 'cover_note', port: 'always' }, to: 'filled_end' },
      { op: 'connect', from: { node: 'cover_note', port: 'always' }, to: 'escalation_note' },
      { op: 'connect', from: { node: 'escalation_note', port: 'always' }, to: 'filled_end' },
    ]);

    expect(outcome.reverted).toBe(false);
    expect(outcome.rejected).toEqual([]);
    expect(outcome.applied).toHaveLength(4);
    expect(outcome.definition.nodes.map((node) => node.id)).toContain('escalation_note');
    expect(outcome.definition.edges).toContainEqual({
      from: 'escalation_note',
      to: 'filled_end',
      port: 'always',
    });
    expect(outcome.layout.positions['escalation_note']).toBeDefined();
    expect(outcome.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  });

  test('config lands on the node it was aimed at', () => {
    const outcome = run([
      { op: 'update_node', id: 'manager_approval', config: { timeoutMinutes: 45 } },
      { op: 'update_node', id: 'cover_note', config: { body: 'Approver said {{run.feedback}}' } },
    ]);

    const approval = outcome.definition.nodes.find((node) => node.id === 'manager_approval');
    const note = outcome.definition.nodes.find((node) => node.id === 'cover_note');
    expect(approval?.config).toMatchObject({ timeoutMinutes: 45 });
    expect(note?.config).toMatchObject({ body: 'Approver said {{run.feedback}}' });
  });

  test('a config key the kind does not declare is refused with the keys it does', () => {
    const outcome = run([{ op: 'add_node', id: 'note_x', type: 'artifact', config: { template: 'x' } }]);

    expect(outcome.applied).toEqual([]);
    expect(outcome.rejected[0]?.reason).toContain('has no config key "template"');
    expect(outcome.rejected[0]?.reason).toContain('name, format, body');
    expect(outcome.definition.nodes.map((node) => node.id)).not.toContain('note_x');
  });

  test('a port the source kind does not have is refused with the ports it has', () => {
    const outcome = run([{ op: 'connect', from: { node: 'cover_note', port: 'approved' }, to: 'filled_end' }]);

    expect(outcome.rejected[0]?.reason).toContain('no "approved" port');
    expect(outcome.rejected[0]?.reason).toContain('always');
    expect(outcome.definition.edges).toHaveLength(definition.edges.length);
  });

  test('an edge into a kind that takes no input is refused with the kind named', () => {
    const outcome = run([{ op: 'connect', from: { node: 'cover_note', port: 'always' }, to: 'when_shift_cancelled' }]);

    expect(outcome.applied).toEqual([]);
    expect(outcome.rejected[0]?.reason).toBe('a trigger node cannot be targeted by an edge');
    expect(outcome.definition.edges).toHaveLength(definition.edges.length);
  });

  test('a duplicate id, a missing node, and a self-loop are each refused', () => {
    const outcome = run([
      { op: 'add_node', id: 'cover_note', type: 'end' },
      { op: 'connect', from: { node: 'missing', port: 'always' }, to: 'filled_end' },
      { op: 'connect', from: { node: 'cover_note', port: 'always' }, to: 'cover_note' },
      { op: 'remove_node', id: 'ghost' },
    ]);

    expect(outcome.rejected.map((rejection) => rejection.reason)).toEqual([
      'node id "cover_note" already exists',
      'no node "missing"',
      'a node cannot feed itself',
      'no node "ghost"',
    ]);
    expect(outcome.applied).toEqual([]);
  });

  test('one bad operation does not throw away the good ones', () => {
    const outcome = run([
      { op: 'update_node', id: 'manager_approval', config: { timeoutMinutes: 30 } },
      { op: 'connect', from: { node: 'ghost', port: 'always' }, to: 'filled_end' },
    ]);

    expect(outcome.applied).toEqual(['updated manager_approval']);
    expect(outcome.rejected).toHaveLength(1);
    const approval = outcome.definition.nodes.find((node) => node.id === 'manager_approval');
    expect(approval?.config).toMatchObject({ timeoutMinutes: 30 });
  });

  test('an edit that would leave the graph invalid is dropped whole', () => {
    const outcome = run([
      { op: 'add_node', id: 'orphan', type: 'artifact', label: 'Orphan' },
      { op: 'move_node', id: 'cover_note', position: { x: 10, y: 10 } },
    ]);

    expect(outcome.reverted).toBe(true);
    expect(outcome.applied).toEqual([]);
    expect(outcome.rejected.at(-1)?.reason).toContain('validation error');
    expect(outcome.rejected.at(-1)?.reason).toContain('NO_TERMINAL_PATH@orphan');
    expect(outcome.definition).toEqual(definition);
    expect(outcome.layout).toEqual(layout);
  });

  test('removing a node takes its edges with it, and the path can be re-routed in the same edit', () => {
    const outcome = run([
      { op: 'remove_node', id: 'operations_approval' },
      { op: 'connect', from: { node: 'coverage_policy', port: 'failed' }, to: 'stopped_end' },
    ]);

    expect(outcome.reverted).toBe(false);
    expect(outcome.applied[0]).toContain('removed operations_approval and 3 edge(s)');
    expect(outcome.definition.nodes.map((node) => node.id)).not.toContain('operations_approval');
    expect(
      outcome.definition.edges.some((edge) => edge.from === 'operations_approval' || edge.to === 'operations_approval'),
    ).toBe(false);
    expect(outcome.definition.edges).toContainEqual({
      from: 'coverage_policy',
      to: 'stopped_end',
      port: 'failed',
    });
  });

  test('removing a node that carries the only path to an end is refused', () => {
    const outcome = run([{ op: 'remove_node', id: 'cover_note' }]);

    expect(outcome.reverted).toBe(true);
    expect(outcome.definition.nodes.map((node) => node.id)).toContain('cover_note');
  });

  test('an edit never mutates the definition it was handed', () => {
    const before = structuredClone(definition);
    run([
      { op: 'update_node', id: 'manager_approval', config: { timeoutMinutes: 15 } },
      { op: 'move_node', id: 'cover_note', position: { x: 1, y: 2 } },
    ]);

    expect(definition).toEqual(before);
  });

  test('an empty operation list returns the graph unchanged', () => {
    const outcome = applyOperations(definition, emptyLayout(), []);

    expect(outcome.applied).toEqual([]);
    expect(outcome.reverted).toBe(false);
    expect(outcome.definition).toEqual(definition);
  });

  test('the operation schema refuses what the applier cannot reason about', () => {
    expect(builderOperationSchema.safeParse({ op: 'connect', from: { node: 'a' }, to: 'b' }).success).toBe(false);
    expect(builderOperationSchema.safeParse({ op: 'add_node', id: 'Bad Id', type: 'end' }).success).toBe(false);
    expect(builderOperationSchema.safeParse({ op: 'add_node', id: 'a', type: 'not_a_kind' }).success).toBe(false);
    expect(builderOperationSchema.safeParse({ op: 'drop_table', id: 'a' }).success).toBe(false);
  });
});
