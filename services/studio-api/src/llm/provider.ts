import { z } from 'zod';
import type { LlmProviderKind } from '@wfm/contracts';

/**
 * The model providers behind the studio: one abstract boundary, two concrete
 * transports, no vendor SDK. A provider is a POST and a usage report, so a
 * customer's endpoint and the platform's own are the same code path.
 */

/** `none` means "no provider at all", so it is never a provider's own kind. */
export type ProviderKind = Exclude<LlmProviderKind, 'none'>;

/**
 * One callable the model may ask for, in JSON Schema. The caller owns what the
 * call means: a provider only carries the declaration and the model's request
 * to make it.
 */
export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the arguments, as both protocols expect it. */
  parameters: unknown;
}

/** What the model asked to call, with its arguments still unparsed. */
export interface LlmToolCall {
  id: string;
  name: string;
  /** The vendor's raw JSON string; the caller validates it against the tool. */
  arguments: string;
}

/**
 * One turn of a conversation in the shape both protocols carry. A caller with a
 * conversation to continue sets `messages`; a caller with a single prompt sets
 * `user`, and the provider sends it as one user turn.
 */
export interface LlmTurn {
  role: 'user' | 'assistant' | 'tool';
  content: string;
  /** Assistant turns: what it asked to call, so the results can be matched back. */
  toolCalls?: readonly LlmToolCall[];
  /** Tool turns: which call this answers. */
  toolCallId?: string;
  name?: string;
}

export interface LlmRequest {
  system: string;
  user: string;
  /**
   * The conversation so far, when there is one. A tool-using agent needs this:
   * a tool result flattened into prose loses the structure the model uses to
   * tell a result from something the user said, and it stops calling tools.
   */
  messages?: readonly LlmTurn[];
  /** The JSON the caller expects back, appended to the system message. */
  jsonSchemaHint?: string;
  /** Declarations the model may choose from; absent means a plain completion. */
  tools?: readonly LlmToolSpec[];
  /** `auto` lets the model answer or call; `none` forbids calls. */
  toolChoice?: 'auto' | 'none';
}

export interface LlmCompletion {
  content: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  model: string;
  /** Present when the model chose to call rather than answer. */
  toolCalls?: readonly LlmToolCall[];
}

/**
 * A vendor can spend tens of seconds on a large prompt before the body starts,
 * so this is generous. A body read that outlives it is reported as a timeout,
 * not as a malformed response.
 */
export const DEFAULT_LLM_TIMEOUT_MS = 60_000;

const ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_ANTHROPIC_MAX_TOKENS = 4096;
const ERROR_BODY_LIMIT = 300;

/**
 * `permanent` separates "this will never work" (bad key, unknown model,
 * rejected request) from "call again" (5xx, timeout, rate limit), so a caller
 * can fail a run on the first and let the queue retry the second.
 */
export class LlmProviderError extends Error {
  override readonly name = 'LlmProviderError';
  readonly permanent: boolean;
  readonly status: number | null;

  constructor(message: string, options: { permanent: boolean; status?: number }) {
    super(message);
    this.permanent = options.permanent;
    this.status = options.status ?? null;
  }
}

export abstract class LlmProvider {
  abstract readonly kind: ProviderKind;
  abstract readonly model: string;
  abstract complete(request: LlmRequest): Promise<LlmCompletion>;
}

interface HttpPost {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs: number;
  /** What to call the vendor in an error message. */
  label: string;
}

interface HttpResponse {
  status: number;
  text: string;
  latencyMs: number;
}

async function postJson(request: HttpPost): Promise<HttpResponse> {
  const started = Date.now();
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...request.headers },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LlmProviderError(`${request.label} could not be reached: ${reason}`, { permanent: false });
  }

  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    // A slow vendor can send headers, then stall past the timeout while the
    // body is still arriving. Saying so beats reporting an empty body.
    const reason = error instanceof Error ? error.message : String(error);
    throw new LlmProviderError(
      `${request.label} sent status ${response.status} but the body did not arrive within ${request.timeoutMs}ms: ${reason}`,
      { permanent: false, status: response.status },
    );
  }
  return { status: response.status, text, latencyMs: Date.now() - started };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const errorEnvelopeSchema = z.object({
  error: z.union([z.string(), z.object({ message: z.string() })]),
});

/** The vendor's own words, when the body carries them. */
function vendorMessage(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const envelope = errorEnvelopeSchema.safeParse(parseJson(trimmed));
  if (!envelope.success) return trimmed.slice(0, ERROR_BODY_LIMIT);
  const error = envelope.data.error;
  return typeof error === 'string' ? error : error.message;
}

function failure(label: string, response: HttpResponse): LlmProviderError {
  const detail = vendorMessage(response.text) ?? 'no response body';
  // 4xx means "do not retry", except a timeout or a rate limit, which clear.
  const permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
  return new LlmProviderError(`${label} returned ${response.status}: ${detail}`, {
    permanent,
    status: response.status,
  });
}

function decode<T>(schema: z.ZodType<T>, response: HttpResponse, label: string): T {
  const parsed = schema.safeParse(parseJson(response.text));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'body'} ${issue.message}`).join('; ');
    throw new LlmProviderError(`${label} returned ${response.status} with an unusable body: ${issues}`, {
      permanent: false,
      status: response.status,
    });
  }
  return parsed.data;
}

/** How a caller's JSON hint reaches the vendor: appended to the system message. */
function systemPrompt(request: LlmRequest): string {
  const hint = request.jsonSchemaHint;
  return hint === undefined ? request.system : `${request.system}\n\nRespond with JSON matching: ${hint}`;
}

/**
 * The declarations to put on the wire, or none when there is nothing to choose
 * from or the caller forbade calls. Both transports answer to the same rule, so
 * `none` means the same thing on each.
 */
function declaredTools(request: LlmRequest): readonly LlmToolSpec[] | undefined {
  const tools = request.tools;
  if (tools === undefined || tools.length === 0 || request.toolChoice === 'none') return undefined;
  return tools;
}

/**
 * The conversation in the shape `/chat/completions` takes. A caller with no
 * conversation gets its single prompt as one user turn, so the two callers that
 * exist (a proposal over one event, and an agent over a thread) share one path.
 */
function openAiTurns(request: LlmRequest): unknown[] {
  if (request.messages === undefined) return [{ role: 'user', content: request.user }];
  return request.messages.map((turn) => {
    if (turn.role === 'tool') return { role: 'tool', tool_call_id: turn.toolCallId, content: turn.content };
    if (turn.role === 'assistant' && turn.toolCalls !== undefined && turn.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: turn.content === '' ? null : turn.content,
        tool_calls: turn.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    return { role: turn.role, content: turn.content };
  });
}

/**
 * The same conversation in the shape the Messages API takes, where a tool
 * result is a user turn carrying a `tool_result` block rather than a role of
 * its own.
 */
function anthropicTurns(request: LlmRequest): unknown[] {
  if (request.messages === undefined) return [{ role: 'user', content: request.user }];
  return request.messages.map((turn) => {
    if (turn.role === 'tool') {
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: turn.toolCallId, content: turn.content }],
      };
    }
    if (turn.role === 'assistant' && turn.toolCalls !== undefined && turn.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: [
          ...(turn.content === '' ? [] : [{ type: 'text', text: turn.content }]),
          ...turn.toolCalls.map((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: parseToolArguments(call.arguments),
          })),
        ],
      };
    }
    return { role: turn.role, content: turn.content };
  });
}

/** Anthropic takes the arguments as an object, so a malformed string is sent as an empty one. */
function parseToolArguments(arguments_: string): unknown {
  try {
    return JSON.parse(arguments_);
  } catch {
    return {};
  }
}

const chatCompletionToolCallSchema = z.object({
  id: z.string(),
  function: z.object({ name: z.string(), arguments: z.string() }),
});

const chatCompletionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          // A model that only calls returns no prose, and the vendor says so with null.
          content: z.string().nullish(),
          tool_calls: z.array(chatCompletionToolCallSchema).optional(),
        }),
      }),
    )
    .min(1),
  usage: z.object({ prompt_tokens: z.int().nonnegative(), completion_tokens: z.int().nonnegative() }),
});

export interface OpenAiCompatibleOptions {
  /** `platform` when the studio's own endpoint serves the call. */
  kind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Ask for `response_format: {type: 'json_object'}`. */
  jsonMode: boolean;
  timeoutMs?: number;
}

/**
 * Any OpenAI-compatible endpoint: the platform's (OpenRouter) and a customer's
 * speak the same protocol, so only the base URL, key and model differ.
 */
export class OpenAiCompatibleProvider extends LlmProvider {
  readonly kind: ProviderKind;
  readonly model: string;
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #jsonMode: boolean;
  readonly #timeoutMs: number;

  constructor(options: OpenAiCompatibleOptions) {
    super();
    this.kind = options.kind;
    this.model = options.model;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#jsonMode = options.jsonMode;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const label = `${this.kind} provider`;
    const tools = declaredTools(request);
    const response = await postJson({
      url: `${this.#baseUrl}/chat/completions`,
      headers: { authorization: `Bearer ${this.#apiKey}` },
      timeoutMs: this.#timeoutMs,
      label,
      body: {
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt(request) },
          ...openAiTurns(request),
        ],
        // JSON mode asks for one JSON object as the message content, which is
        // exactly what a caller with tools does not want: the model cannot both
        // be constrained to an object and choose to call something, and it
        // answers with JSON shaped like a call instead of making one.
        ...(this.#jsonMode && tools === undefined ? { response_format: { type: 'json_object' } } : {}),
        ...(tools === undefined
          ? {}
          : {
              tools: tools.map((tool) => ({
                type: 'function',
                function: { name: tool.name, description: tool.description, parameters: tool.parameters },
              })),
              tool_choice: 'auto',
            }),
      },
    });
    if (response.status !== 200) throw failure(label, response);
    const body = decode(chatCompletionSchema, response, label);
    const choice = body.choices.at(0);
    if (choice === undefined) throw failure(label, response);
    const calls = choice.message.tool_calls;
    return {
      content: choice.message.content ?? '',
      inputTokens: body.usage.prompt_tokens,
      outputTokens: body.usage.completion_tokens,
      latencyMs: response.latencyMs,
      model: this.model,
      ...(calls === undefined || calls.length === 0
        ? {}
        : {
            toolCalls: calls.map((call) => ({
              id: call.id,
              name: call.function.name,
              arguments: call.function.arguments,
            })),
          }),
    };
  }
}

/**
 * Anthropic sends block types this layer does not act on (`thinking`, for one),
 * so the schema tags rather than narrows: the two blocks that matter are picked
 * out by tag and anything else is carried along and ignored.
 */
const anthropicContentBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
});

const anthropicMessageSchema = z.object({
  content: z.array(anthropicContentBlockSchema).min(1),
  usage: z.object({ input_tokens: z.int().nonnegative(), output_tokens: z.int().nonnegative() }),
});

export interface AnthropicOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
}

/** Anthropic's Messages API: `x-api-key`, a required version header, and its own usage field names. */
export class AnthropicProvider extends LlmProvider {
  readonly kind: ProviderKind = 'anthropic';
  readonly model: string;
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #maxTokens: number;
  readonly #timeoutMs: number;

  constructor(options: AnthropicOptions) {
    super();
    this.model = options.model;
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.#apiKey = options.apiKey;
    this.#maxTokens = options.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  }

  async complete(request: LlmRequest): Promise<LlmCompletion> {
    const label = 'anthropic provider';
    const tools = declaredTools(request);
    const response = await postJson({
      url: `${this.#baseUrl}/messages`,
      headers: { 'x-api-key': this.#apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      timeoutMs: this.#timeoutMs,
      label,
      body: {
        model: this.model,
        max_tokens: this.#maxTokens,
        system: systemPrompt(request),
        messages: anthropicTurns(request),
        ...(tools === undefined
          ? {}
          : {
              tools: tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.parameters,
              })),
              tool_choice: { type: 'auto' },
            }),
      },
    });
    if (response.status !== 200) throw failure(label, response);
    const body = decode(anthropicMessageSchema, response, label);
    const textBlocks = body.content.filter((block) => block.type === 'text');
    const toolCalls = body.content.flatMap((block) =>
      block.type === 'tool_use' && block.id !== undefined && block.name !== undefined && block.input !== undefined
        ? [{ id: block.id, name: block.name, arguments: JSON.stringify(block.input) }]
        : [],
    );
    // A response that carries neither prose nor a call leaves the caller nothing to act on.
    if (textBlocks.length === 0 && toolCalls.length === 0) {
      throw new LlmProviderError(`${label} returned no text or tool_use block`, {
        permanent: false,
        status: response.status,
      });
    }
    return {
      content: textBlocks.map((block) => block.text ?? '').join(''),
      inputTokens: body.usage.input_tokens,
      outputTokens: body.usage.output_tokens,
      latencyMs: response.latencyMs,
      model: this.model,
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
    };
  }
}
