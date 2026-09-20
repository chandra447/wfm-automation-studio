import type { BuilderFocus, BuilderStreamEvent, BuilderToolCall } from '@wfm/workflows';

/**
 * A turn while it is still arriving: the text of the model run currently
 * streaming, the tool calls it has made so far, and the last place it asked the
 * canvas to look. It is deliberately separate from the finished turn, which is
 * built from the response `done` carries.
 */
export interface LiveTurn {
  /** The model run the text belongs to; null until the first token arrives. */
  run: string | null;
  text: string;
  calls: readonly BuilderToolCall[];
  focus: BuilderFocus | null;
}

export const emptyLiveTurn: LiveTurn = { run: null, text: '', calls: [], focus: null };

/**
 * A turn makes several model calls — a preamble beside the tool calls, and the
 * harness's own summary when the conversation is long — and only the last one is
 * the answer. So text from any run other than the current one replaces the
 * text rather than appending to it: showing the preamble is the failure this
 * rule exists to prevent.
 *
 * `done` and `error` end the turn rather than describe it, so they leave it
 * alone; the caller reads the response and drops the live turn.
 */
export function applyStreamEvent(turn: LiveTurn, event: BuilderStreamEvent): LiveTurn {
  switch (event.type) {
    case 'token':
      return event.run === turn.run
        ? { ...turn, text: turn.text + event.text }
        : { ...turn, run: event.run, text: event.text };
    case 'tool':
      return { ...turn, calls: upsertCall(turn.calls, event.call) };
    case 'focus':
      return { ...turn, focus: event.focus };
    case 'done':
    case 'error':
      return turn;
  }
}

/** The same call arrives again as it moves from running to done or failed. */
function upsertCall(calls: readonly BuilderToolCall[], call: BuilderToolCall): readonly BuilderToolCall[] {
  const index = calls.findIndex((candidate) => candidate.id === call.id);
  if (index === -1) return [...calls, call];
  return calls.map((candidate, at) => (at === index ? call : candidate));
}
