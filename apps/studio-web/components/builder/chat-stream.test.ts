import { describe, expect, test } from 'bun:test';
import type { BuilderStreamEvent, BuilderToolCall } from '@wfm/workflows';
import { applyStreamEvent, emptyLiveTurn } from './chat-stream';

const started: BuilderToolCall = {
  id: 'a',
  name: 'read_graph',
  state: 'running',
  input: { nodeId: 'n1' },
  output: null,
  error: null,
};

const other: BuilderToolCall = { ...started, id: 'b' };

describe('the builder chat stream', () => {
  test('a new model run discards the text of the previous one', () => {
    const events: readonly BuilderStreamEvent[] = [
      { type: 'token', run: 'preamble', text: 'I will look at ' },
      { type: 'token', run: 'preamble', text: 'the graph first.' },
      { type: 'token', run: 'answer', text: 'Two nodes ' },
      { type: 'token', run: 'answer', text: 'approve the cancellation.' },
    ];
    const turn = events.reduce(applyStreamEvent, emptyLiveTurn);

    expect(turn.run).toBe('answer');
    expect(turn.text).toBe('Two nodes approve the cancellation.');
  });

  test('a tool call that reports again updates in place, in arrival order', () => {
    const events: readonly BuilderStreamEvent[] = [
      { type: 'tool', call: started },
      { type: 'tool', call: other },
      { type: 'tool', call: { ...started, state: 'done', output: { nodes: 2 } } },
    ];
    const turn = events.reduce(applyStreamEvent, emptyLiveTurn);

    expect(turn.calls.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(turn.calls[0]?.state).toBe('done');
    expect(turn.calls[0]?.output).toEqual({ nodes: 2 });
    expect(turn.calls[1]?.state).toBe('running');
  });

  test('a tool call that fails keeps its error', () => {
    const events: readonly BuilderStreamEvent[] = [
      { type: 'tool', call: started },
      { type: 'tool', call: { ...started, state: 'failed', error: 'the node is gone' } },
    ];
    const turn = events.reduce(applyStreamEvent, emptyLiveTurn);

    expect(turn.calls).toHaveLength(1);
    expect(turn.calls[0]?.error).toBe('the node is gone');
  });
});
