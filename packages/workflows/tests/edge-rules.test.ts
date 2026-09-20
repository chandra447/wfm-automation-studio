import { describe, expect, test } from 'bun:test';
import { edgeRefusal } from '../src/edge-rules.ts';
import { coverageRescueWorkflow } from '../src/templates/demo-workflows.ts';
import type { WorkflowDefinition } from '../src/dsl.ts';

/**
 * The one rule three callers ask: may this edge exist? The applier turns the
 * answer into a refusal a model reads, the validator into a diagnostic, and the
 * canvas into whether a drag lands. These tests are why the rule lives in the
 * package rather than inside the canvas, which no test here can watch.
 */

const definition: WorkflowDefinition = coverageRescueWorkflow;

describe('edgeRefusal', () => {
  test('an edge the DSL allows has nothing to say', () => {
    // Every port in the seeded workflow is wired, so a legal new edge needs one
    // freed up first. This is also what the canvas sees mid-edit.
    const edited = structuredClone(definition);
    edited.edges = edited.edges.filter((edge) => !(edge.from === 'send_offers' && edge.to === 'cover_note'));
    expect(edgeRefusal(edited, { from: 'send_offers', to: 'filled_end', port: 'always' })).toBeNull();
  });

  test('a second edge on a port names the target it would replace', () => {
    const refusal = edgeRefusal(definition, { from: 'send_offers', to: 'stopped_end', port: 'always' });
    expect(refusal).toBe('"always" already goes to cover_note, and a port carries one target');
  });

  test('the same edge twice is refused by name', () => {
    const refusal = edgeRefusal(definition, { from: 'send_offers', to: 'cover_note', port: 'always' });
    expect(refusal).toBe('already connected to cover_note on always');
  });

  test('a target that takes no input is refused with its kind', () => {
    const refusal = edgeRefusal(definition, { from: 'cover_note', to: 'when_shift_cancelled', port: 'always' });
    expect(refusal).toBe('a trigger node cannot be targeted by an edge');
  });

  test('a source that ends a path cannot emit', () => {
    const refusal = edgeRefusal(definition, { from: 'filled_end', to: 'cover_note', port: 'always' });
    expect(refusal).toBe('a end node cannot emit an edge; it ends a path');
  });

  test('an unknown port is refused with the ones the kind has', () => {
    expect(edgeRefusal(definition, { from: 'rank_candidates', to: 'coverage_policy', port: 'approved' })).toBe(
      'a ai_decision node has no "approved" port; it has always',
    );
  });

  test('a node cannot feed itself', () => {
    expect(edgeRefusal(definition, { from: 'cover_note', to: 'cover_note', port: 'always' })).toBe(
      'a node cannot feed itself',
    );
  });

  test('a node that does not exist is refused by id', () => {
    expect(edgeRefusal(definition, { from: 'ghost', to: 'cover_note', port: 'always' })).toBe('no node "ghost"');
  });

  test('the edge being re-checked does not refuse itself', () => {
    // The canvas re-checks edges it is already drawing, so the edge under
    // inspection has to be excluded from the rules that look at the graph.
    const existing = { from: 'send_offers', to: 'cover_note', port: 'always' } as const;
    expect(edgeRefusal(definition, existing)).toBe('already connected to cover_note on always');
    expect(edgeRefusal(definition, existing, { ignore: existing })).toBeNull();
  });
});
