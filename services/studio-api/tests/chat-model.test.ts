import { describe, expect, test } from 'bun:test';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createDeepAgent } from 'deepagents';
import { z } from 'zod';
import { BuilderChatModel } from '../src/builder/chat-model.ts';
import { LlmProvider } from '../src/llm/provider.ts';
import type { LlmCompletion, LlmRequest, LlmToolSpec, ProviderKind } from '../src/llm/provider.ts';

/**
 * The provider boundary as the adapter sees it: the next scripted answer, and
 * every request kept, so a test can assert what the vendor would have received.
 */
class StubProvider extends LlmProvider {
  readonly kind: ProviderKind = 'openai-compatible';
  readonly model = 'stub-model';
  readonly requests: LlmRequest[] = [];
  readonly #answers: LlmCompletion[];

  constructor(answers: readonly LlmCompletion[]) {
    super();
    this.#answers = [...answers];
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    this.requests.push(request);
    const answer = this.#answers.shift();
    if (answer === undefined) throw new Error('the stub was asked for one answer more than it was given');
    return answer;
  }
}

/** What a vendor reports for a completion, minus the part a test cares about. */
function answer(fields: Partial<LlmCompletion>): LlmCompletion {
  return { content: '', inputTokens: 11, outputTokens: 7, latencyMs: 3, model: 'stub-model', ...fields };
}

const ADD_SHIFT: LlmToolSpec = {
  name: 'add_shift',
  description: 'Add one shift to the schedule',
  parameters: { type: 'object', properties: { employeeId: { type: 'string' } }, required: ['employeeId'] },
};

describe('builder chat model', () => {
  test('a plain completion becomes an AIMessage carrying the text and the vendor usage', async () => {
    const provider = new StubProvider([answer({ content: 'Two shifts are unassigned.' })]);
    const model = new BuilderChatModel({ provider });

    const reply = await model.invoke([new SystemMessage('You build workflows.'), new HumanMessage('What is missing?')]);

    expect(reply.content).toBe('Two shifts are unassigned.');
    // The default message structure types `usage_metadata` away, so the value is
    // read through the AIMessage guard and widened before it is asserted on.
    const usage: unknown = AIMessage.isInstance(reply) ? reply.usage_metadata : undefined;
    expect(usage).toEqual({ input_tokens: 11, output_tokens: 7, total_tokens: 18 });
    // The conversation goes to the provider as turns, not as one flattened
    // prompt: the roles are what the model reads to know who said what.
    expect(provider.requests).toEqual([
      {
        system: 'You build workflows.',
        user: 'What is missing?',
        messages: [{ role: 'user', content: 'What is missing?' }],
      },
    ]);
  });

  test('a completion with tool calls becomes an AIMessage with parsed arguments', async () => {
    const provider = new StubProvider([
      answer({
        toolCalls: [{ id: 'call_1', name: 'add_shift', arguments: '{"employeeId":"e1","startsAt":"09:00"}' }],
      }),
    ]);
    const model = new BuilderChatModel({ provider });

    const reply = await model.invoke([new HumanMessage('Add a shift for e1')]);

    expect(reply.tool_calls).toEqual([
      { id: 'call_1', name: 'add_shift', args: { employeeId: 'e1', startsAt: '09:00' } },
    ]);
  });

  test('a tool call with unparseable arguments keeps the call with empty arguments', async () => {
    const provider = new StubProvider([
      answer({ toolCalls: [{ id: 'call_2', name: 'add_shift', arguments: '{"employeeId":' }] }),
    ]);
    const model = new BuilderChatModel({ provider });

    const reply = await model.invoke([new HumanMessage('Add a shift for e1')]);

    expect(reply.tool_calls).toEqual([{ id: 'call_2', name: 'add_shift', args: {} }]);
  });

  test('a vendor-shaped function declaration binds without throwing', async () => {
    const provider = new StubProvider([answer({ content: 'Done.' })]);
    // The shape LangChain's structured-output strategy binds: the vendor's own
    // function definition, not a wrapper tool.
    const bound = new BuilderChatModel({ provider }).bindTools([
      {
        type: 'function',
        function: {
          name: 'extract_1',
          description: 'Tool for extracting structured output from the model’s response.',
          parameters: { type: 'object', properties: { rationale: { type: 'string' } } },
        },
      },
    ]);

    await bound.invoke([new HumanMessage('Answer with the structured output.')]);

    expect(provider.requests[0]?.tools).toEqual([
      {
        name: 'extract_1',
        description: 'Tool for extracting structured output from the model’s response.',
        parameters: { type: 'object', properties: { rationale: { type: 'string' } } },
      },
    ]);
  });

  test('the request carries the bound declarations and the whole exchange in order', async () => {
    const provider = new StubProvider([answer({ content: 'Done.' })]);
    const model = new BuilderChatModel({ provider, tools: [ADD_SHIFT] });

    await model.invoke([
      new SystemMessage('You build workflows.'),
      new HumanMessage('Add a shift for e1'),
      new AIMessage({ content: 'On it.', tool_calls: [{ id: 'call_1', name: 'add_shift', args: { employeeId: 'e1' } }] }),
      new ToolMessage({ content: 'shift for e1 added', tool_call_id: 'call_1', name: 'add_shift' }),
    ]);

    const [request] = provider.requests;
    expect(request?.tools).toEqual([ADD_SHIFT]);
    expect(request?.toolChoice).toBe('auto');
    // The conversation keeps its shape: a user turn, the assistant turn that
    // called, and the result as a tool turn the model can tell apart from prose.
    expect(request?.messages).toEqual([
      { role: 'user', content: 'Add a shift for e1' },
      {
        role: 'assistant',
        content: 'On it.',
        toolCalls: [{ id: 'call_1', name: 'add_shift', arguments: '{"employeeId":"e1"}' }],
      },
      { role: 'tool', content: 'shift for e1 added', toolCallId: 'call_1', name: 'add_shift' },
    ]);
  });

  test('a LangChain tool bound through bindTools reaches the provider as a declaration', async () => {
    const provider = new StubProvider([answer({ content: 'Done.' })]);
    const structured = tool(({ employeeId }: { employeeId: string }) => `shift for ${employeeId} added`, {
      name: 'add_shift',
      description: 'Add one shift to the schedule',
      schema: z.object({ employeeId: z.string() }),
    });

    const bound = new BuilderChatModel({ provider }).bindTools([structured]);
    await bound.invoke([new HumanMessage('Add a shift for e1')]);

    const [spec] = provider.requests[0]?.tools ?? [];
    expect(spec?.name).toBe('add_shift');
    expect(spec?.description).toBe('Add one shift to the schedule');
    // The Zod schema arrived as the JSON Schema both vendors expect.
    expect(spec?.parameters).toMatchObject({
      type: 'object',
      properties: { employeeId: { type: 'string' } },
      required: ['employeeId'],
    });
  });
});

describe('builder chat model under deep agents', () => {
  test('the agent loop calls the tool and answers from the result', async () => {
    const seen: Record<string, unknown>[] = [];
    const addShift = tool(
      (input: { employeeId: string }) => {
        seen.push(input);
        return `shift for ${input.employeeId} added`;
      },
      { name: 'add_shift', description: 'Add one shift to the schedule', schema: z.object({ employeeId: z.string() }) },
    );

    // One scripted call, then a final answer: the shape of every agent turn.
    const provider = new StubProvider([
      answer({ toolCalls: [{ id: 'call_1', name: 'add_shift', arguments: '{"employeeId":"e1"}' }] }),
      answer({ content: 'Added the shift for e1.', inputTokens: 24, outputTokens: 9 }),
    ]);
    const agent = createDeepAgent({ model: new BuilderChatModel({ provider }), tools: [addShift] });

    const result = await agent.invoke({ messages: [new HumanMessage('Add a shift for e1')] });

    expect(seen).toEqual([{ employeeId: 'e1' }]);
    expect(result.messages.at(-1)?.text).toBe('Added the shift for e1.');

    // The runtime bound its own tools alongside ours, and the second turn saw
    // the tool exchange the first turn produced.
    const first = provider.requests[0];
    const second = provider.requests[1];
    expect(first?.tools?.map((spec) => spec.name)).toContain('add_shift');
    const toolTurn = second?.messages?.find((turn) => turn.role === 'tool');
    expect(toolTurn?.content).toContain('shift for e1 added');
    const callTurn = second?.messages?.find((turn) => turn.role === 'assistant' && turn.toolCalls !== undefined);
    expect(callTurn?.toolCalls?.[0]).toMatchObject({ name: 'add_shift' });
    expect(callTurn?.toolCalls?.[0]?.arguments).toContain('e1');

  });
});
