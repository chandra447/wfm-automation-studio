import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeLlmProvider, type FakeLlmServer } from '../../../packages/testkit/src/fake-llm.ts';
import { loadModelCatalogue, loadModelCatalogueFromEnv } from '../src/llm/catalogue.ts';
import {
  AnthropicProvider,
  LlmProviderError,
  OpenAiCompatibleProvider,
  type LlmToolSpec,
  type OpenAiCompatibleOptions,
} from '../src/llm/provider.ts';

const CATALOGUE_MODEL = 'deepseek/deepseek-v4.1-flash';
const CUSTOMER_KEY = 'sk-customer-key-1234';

/** The declaration a caller hands the provider, and the call the fake answers with. */
const PICK_CANDIDATE_TOOL: LlmToolSpec = {
  name: 'pick_candidate',
  description: 'Pick the employee for the shift.',
  parameters: {
    type: 'object',
    properties: { candidateId: { type: 'string' } },
    required: ['candidateId'],
  },
};
const PICK_CANDIDATE_ARGUMENTS = '{"candidateId":"44444444-4444-4444-8444-000000000003","reason":"rest rule"}';

/** The model catalogue is the allow-list, so it is the file, not a code path. */
describe('model catalogue', () => {
  test('exposes every model declared in config/models.jsonl, prices and all', async () => {
    const catalogue = await loadModelCatalogueFromEnv({ MODEL_CATALOGUE_PATH: 'config/models.jsonl' });
    const ids = catalogue.models().map((model) => model.id);

    expect(ids).toContain(CATALOGUE_MODEL);
    expect(ids).toContain('deepseek/deepseek-v3.2');
    expect(catalogue.defaultModel().id).toBe(CATALOGUE_MODEL);
    expect(catalogue.modelById(CATALOGUE_MODEL)).toMatchObject({
      provider: 'openai-compatible',
      jsonMode: true,
      inputCentsPerMillion: 15,
      outputCentsPerMillion: 60,
    });
    // A line may leave `default` out; it means the same as false.
    expect(catalogue.modelById('deepseek/deepseek-v3.2')?.default).toBe(false);
    expect(catalogue.modelById('not-a-real-model')).toBeUndefined();
  });

  test('rejects a malformed line with the file and line number', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'catalogue-'));
    try {
      const complete =
        '{"id":"a","label":"A","provider":"openai-compatible","contextWindow":1000,' +
        '"maxOutputTokens":100,"jsonMode":true,"toolCalls":true,"inputCentsPerMillion":1,"outputCentsPerMillion":2,"default":true}';
      const unknownField = join(dir, 'unknown-field.jsonl');
      await Bun.write(unknownField, `${complete}\n{"id":"b","label":"B","provider":"openai-compatible"}\n`);
      await expect(loadModelCatalogue(unknownField)).rejects.toThrow(/unknown-field\.jsonl:2/);
      await expect(loadModelCatalogue(unknownField)).rejects.toThrow(/is not a model descriptor/);

      const notJson = join(dir, 'not-json.jsonl');
      await Bun.write(notJson, `${complete}\n{"id":"b",}\n`);
      await expect(loadModelCatalogue(notJson)).rejects.toThrow(/not-json\.jsonl:2 is not valid JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('openai-compatible provider', () => {
  let fake: FakeLlmServer;

  beforeAll(() => {
    fake = startFakeLlmProvider({ toolCallArguments: PICK_CANDIDATE_ARGUMENTS });
  });

  afterAll(() => {
    fake.stop();
  });

  test('sends the bearer key and the model, and reports the usage the vendor returned', async () => {
    const provider = new OpenAiCompatibleProvider({
      kind: 'openai-compatible',
      baseUrl: fake.url,
      apiKey: CUSTOMER_KEY,
      model: CATALOGUE_MODEL,
      jsonMode: true,
    });

    const completion = await provider.complete({
      system: 'Pick a candidate.',
      user: 'Tool data: {"shift.candidates":{"candidates":[]}}',
    });

    expect(completion.model).toBe(CATALOGUE_MODEL);
    expect(completion.latencyMs).toBeGreaterThanOrEqual(0);
    expect(completion.content).toContain('employeeIds');
    // No declarations were sent, so there is nothing for the model to call.
    expect(completion.toolCalls).toBeUndefined();

    const [sent] = fake.requests();
    expect(sent).toBeDefined();
    if (sent === undefined) throw new Error('the provider recorded no request');
    expect(sent.authorization).toBe(`Bearer ${CUSTOMER_KEY}`);
    expect(sent.model).toBe(CATALOGUE_MODEL);
    expect(sent.messageCount).toBe(2);
    // The tokens are the vendor's own report, not a count of what we sent.
    expect(completion.inputTokens).toBe(sent.promptTokens);
    expect(completion.outputTokens).toBe(sent.completionTokens);
    expect(completion.inputTokens).toBeGreaterThan(0);
  });

  test('a vendor error carries its status and whether a retry could help', async () => {
    const rejected = await new OpenAiCompatibleProvider({
      kind: 'openai-compatible',
      baseUrl: `${fake.url}/no-such-endpoint`,
      apiKey: CUSTOMER_KEY,
      model: CATALOGUE_MODEL,
      jsonMode: true,
    })
      .complete({ system: 's', user: 'u' })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(rejected).toBeInstanceOf(LlmProviderError);
    if (!(rejected instanceof LlmProviderError)) throw new Error('expected a provider error');
    expect(rejected.status).toBe(404);
    expect(rejected.permanent).toBe(true);
    expect(rejected.message).toContain('no route');

    const unreachable = await new OpenAiCompatibleProvider({
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: CUSTOMER_KEY,
      model: CATALOGUE_MODEL,
      jsonMode: true,
      timeoutMs: 2_000,
    })
      .complete({ system: 's', user: 'u' })
      .then(
        () => null,
        (error: unknown) => error,
      );

    expect(unreachable).toBeInstanceOf(LlmProviderError);
    if (!(unreachable instanceof LlmProviderError)) throw new Error('expected a provider error');
    expect(unreachable.permanent).toBe(false);
    expect(unreachable.status).toBeNull();
  });

  test('carries the tool declarations and asks for an automatic choice', async () => {
    fake.reset();
    const provider = new OpenAiCompatibleProvider({
      kind: 'platform',
      baseUrl: fake.url,
      apiKey: CUSTOMER_KEY,
      model: CATALOGUE_MODEL,
      jsonMode: false,
    });

    const completion = await provider.complete({ system: 'Pick one.', user: 'u', tools: [PICK_CANDIDATE_TOOL] });

    // The model only called, so there is no prose, and the arguments are still
    // the vendor's string rather than a parsed object.
    expect(completion.content).toBe('');
    expect(completion.toolCalls).toEqual([
      { id: 'call_fake_1', name: 'pick_candidate', arguments: PICK_CANDIDATE_ARGUMENTS },
    ]);

    const [sent] = fake.requests();
    expect(sent?.kind).toBe('tool_call');
    expect(sent?.body).toEqual({
      model: CATALOGUE_MODEL,
      messages: [
        { role: 'system', content: 'Pick one.' },
        { role: 'user', content: 'u' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'pick_candidate',
            description: 'Pick the employee for the shift.',
            parameters: {
              type: 'object',
              properties: { candidateId: { type: 'string' } },
              required: ['candidateId'],
            },
          },
        },
      ],
      tool_choice: 'auto',
    });
  });

  test('a caller that forbids calls gets no declarations on the wire', async () => {
    fake.reset();
    const provider = new OpenAiCompatibleProvider({
      kind: 'platform',
      baseUrl: fake.url,
      apiKey: CUSTOMER_KEY,
      model: CATALOGUE_MODEL,
      jsonMode: false,
    });

    const completion = await provider.complete({
      system: 'Pick one.',
      user: 'u',
      tools: [PICK_CANDIDATE_TOOL],
      toolChoice: 'none',
    });

    const [sent] = fake.requests();
    // Nothing for the model to choose from, so it answers in prose as before.
    expect(sent?.kind).toBe('candidate_choice');
    expect(sent?.body).toEqual({
      model: CATALOGUE_MODEL,
      messages: [
        { role: 'system', content: 'Pick one.' },
        { role: 'user', content: 'u' },
      ],
    });
    expect(completion.toolCalls).toBeUndefined();
    expect(completion.content).toContain('employeeIds');
  });
});

interface Captured {
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

interface CaptureServer {
  url: string;
  captured: Captured[];
  stop: () => void;
}

/** Records what a provider puts on the wire, which the fake provider does not expose. */
function startCaptureServer(reply: (path: string) => unknown): CaptureServer {
  const captured: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body: unknown = await request.json().catch(() => null);
      captured.push({ path: url.pathname, headers: Object.fromEntries(request.headers), body });
      return Response.json(reply(url.pathname));
    },
  });
  return { url: server.url.origin, captured, stop: () => void server.stop(true) };
}

describe('provider wire format', () => {
  test('asks for a JSON object only when the model declares json mode', async () => {
    const server = startCaptureServer(() => ({ choices: [{ message: { content: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 2 } }));
    try {
      const options: OpenAiCompatibleOptions = {
        kind: 'platform',
        baseUrl: `${server.url}/v1`,
        apiKey: 'sk-platform-key',
        model: CATALOGUE_MODEL,
        jsonMode: true,
      };
      await new OpenAiCompatibleProvider({ ...options, jsonMode: true }).complete({ system: 'Pick one.', user: 'u' });
      await new OpenAiCompatibleProvider({ ...options, jsonMode: false }).complete({ system: 'Pick one.', user: 'u' });

      expect(server.captured.map((entry) => entry.path)).toEqual(['/v1/chat/completions', '/v1/chat/completions']);
      expect(server.captured.map((entry) => entry.body)).toEqual([
        {
          model: CATALOGUE_MODEL,
          messages: [
            { role: 'system', content: 'Pick one.' },
            { role: 'user', content: 'u' },
          ],
          response_format: { type: 'json_object' },
        },
        {
          model: CATALOGUE_MODEL,
          messages: [
            { role: 'system', content: 'Pick one.' },
            { role: 'user', content: 'u' },
          ],
        },
      ]);
    } finally {
      server.stop();
    }
  });

  test('speaks the Anthropic messages protocol and maps its usage fields', async () => {
    const server = startCaptureServer(() => ({
      content: [{ type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: 11, output_tokens: 5 },
    }));
    try {
      const provider = new AnthropicProvider({
        baseUrl: `${server.url}/v1`,
        apiKey: 'sk-anthropic-key',
        model: 'claude-sonnet',
      });
      const completion = await provider.complete({ system: 'Reply in JSON.', user: 'u', jsonSchemaHint: '{"ok":boolean}' });

      expect(completion).toEqual({
        content: '{"ok":true}',
        inputTokens: 11,
        outputTokens: 5,
        latencyMs: expect.any(Number),
        model: 'claude-sonnet',
      });
      expect(server.captured.map((entry) => entry.path)).toEqual(['/v1/messages']);
      expect(server.captured.map((entry) => entry.headers['x-api-key'])).toEqual(['sk-anthropic-key']);
      expect(server.captured.map((entry) => entry.headers['anthropic-version'])).toEqual(['2023-06-01']);
      expect(server.captured.map((entry) => entry.body)).toEqual([
        {
          model: 'claude-sonnet',
          max_tokens: 4096,
          system: 'Reply in JSON.\n\nRespond with JSON matching: {"ok":boolean}',
          messages: [{ role: 'user', content: 'u' }],
        },
      ]);
    } finally {
      server.stop();
    }
  });

  test('carries tool declarations and reads a tool_use block back', async () => {
    const server = startCaptureServer(() => ({
      content: [
        // A block this layer does not act on must not fail the parse.
        { type: 'thinking', thinking: 'weighing the candidates' },
        { type: 'text', text: 'Picking the closest candidate.' },
        {
          type: 'tool_use',
          id: 'toolu_01',
          name: 'pick_candidate',
          input: { candidateId: '44444444-4444-4444-8444-000000000003', reason: 'rest rule' },
        },
      ],
      usage: { input_tokens: 21, output_tokens: 9 },
    }));
    try {
      const provider = new AnthropicProvider({
        baseUrl: `${server.url}/v1`,
        apiKey: 'sk-anthropic-key',
        model: 'claude-sonnet',
      });
      const completion = await provider.complete({ system: 'Pick one.', user: 'u', tools: [PICK_CANDIDATE_TOOL] });

      expect(completion.content).toBe('Picking the closest candidate.');
      // The block's `input` object is re-serialised, so the caller still owns parsing it.
      expect(completion.toolCalls).toEqual([
        { id: 'toolu_01', name: 'pick_candidate', arguments: PICK_CANDIDATE_ARGUMENTS },
      ]);
      expect(server.captured.map((entry) => entry.path)).toEqual(['/v1/messages']);
      expect(server.captured.map((entry) => entry.body)).toEqual([
        {
          model: 'claude-sonnet',
          max_tokens: 4096,
          system: 'Pick one.',
          messages: [{ role: 'user', content: 'u' }],
          tools: [
            {
              name: 'pick_candidate',
              description: 'Pick the employee for the shift.',
              input_schema: {
                type: 'object',
                properties: { candidateId: { type: 'string' } },
                required: ['candidateId'],
              },
            },
          ],
          tool_choice: { type: 'auto' },
        },
      ]);
    } finally {
      server.stop();
    }
  });

  test('a response with only a tool_use block is a call, not an error', async () => {
    const server = startCaptureServer(() => ({
      content: [
        {
          type: 'tool_use',
          id: 'toolu_02',
          name: 'pick_candidate',
          input: { candidateId: '44444444-4444-4444-8444-000000000003' },
        },
      ],
      usage: { input_tokens: 7, output_tokens: 4 },
    }));
    try {
      const provider = new AnthropicProvider({
        baseUrl: `${server.url}/v1`,
        apiKey: 'sk-anthropic-key',
        model: 'claude-sonnet',
      });
      const completion = await provider.complete({ system: 'Pick one.', user: 'u', tools: [PICK_CANDIDATE_TOOL] });

      expect(completion.content).toBe('');
      expect(completion.toolCalls).toEqual([
        { id: 'toolu_02', name: 'pick_candidate', arguments: '{"candidateId":"44444444-4444-4444-8444-000000000003"}' },
      ]);
    } finally {
      server.stop();
    }
  });

  test('an Anthropic caller that forbids calls gets no declarations on the wire', async () => {
    const server = startCaptureServer(() => ({
      content: [{ type: 'text', text: '{"ok":true}' }],
      usage: { input_tokens: 3, output_tokens: 2 },
    }));
    try {
      const provider = new AnthropicProvider({
        baseUrl: `${server.url}/v1`,
        apiKey: 'sk-anthropic-key',
        model: 'claude-sonnet',
      });
      const completion = await provider.complete({
        system: 'Pick one.',
        user: 'u',
        tools: [PICK_CANDIDATE_TOOL],
        toolChoice: 'none',
      });

      expect(completion.toolCalls).toBeUndefined();
      expect(server.captured.map((entry) => entry.body)).toEqual([
        {
          model: 'claude-sonnet',
          max_tokens: 4096,
          system: 'Pick one.',
          messages: [{ role: 'user', content: 'u' }],
        },
      ]);
    } finally {
      server.stop();
    }
  });
});
