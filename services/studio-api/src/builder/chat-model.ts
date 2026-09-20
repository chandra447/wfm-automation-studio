import { BaseChatModel, type BaseChatModelCallOptions, type BindToolsInput } from '@langchain/core/language_models/chat_models';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
  type StandardMessageStructure,
  ToolMessage,
  type ToolCall,
  type ToolCallChunk,
  type UsageMetadata,
} from '@langchain/core/messages';
import { ChatGenerationChunk, type ChatResult } from '@langchain/core/outputs';
import { isStructuredTool, type StructuredToolInterface } from '@langchain/core/tools';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { z } from 'zod';
import type {
  LlmCompletion,
  LlmProvider,
  LlmRequest,
  LlmToolCallDelta,
  LlmToolSpec,
  LlmTurn,
} from '../llm/provider.ts';

/**
 * The LangChain face of our own provider boundary. Deep Agents drives its agent
 * loop through `BaseChatModel`, and this is the only thing in between: a request
 * becomes one `LlmRequest`, a completion becomes one `AIMessage`.
 *
 * Our provider speaks one system turn and one user turn, so the message list is
 * flattened rather than mapped turn for turn. The flattening labels every
 * segment, because the model has to be able to tell who said what and which
 * tool call a result answers.
 */

/** Where a tool result is reported when LangChain left the tool unnamed. */
const UNNAMED_TOOL = 'unknown tool';

/**
 * The shape `bindTools` may be handed beyond a LangChain tool: a declaration
 * this module passes straight to the provider. `parameters` is JSON Schema and
 * is not inspected here, so it is carried through as it arrived.
 */
const declaredToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  parameters: z.unknown(),
});

/**
 * LangChain's structured-output strategy binds a tool in the vendor's own
 * shape rather than wrapping it, so the declaration arrives nested under
 * `function` with a `type` discriminant.
 */
const functionToolSchema = z.object({
  type: z.literal('function'),
  function: z.object({
    name: z.string().min(1),
    description: z.string().default(''),
    parameters: z.unknown(),
  }),
});

/** Tool arguments are the model's raw JSON, which is allowed to be malformed. */
const toolArgumentsSchema = z.record(z.string(), z.unknown());

/** Tokens and call counts the vendor reported, summed over a model's life. */
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface BuilderChatModelFields {
  provider: LlmProvider;
  /** Shared with the copies `bindTools` makes, so a caller can read the total. */
  usage?: ModelUsage;
  /**
   * Declarations to offer the model from the first call on. `bindTools` adds
   * more; an agent runtime normally binds rather than constructs with tools.
   */
  tools?: readonly (LlmToolSpec | StructuredToolInterface)[];
  /** `none` forbids the call rather than merely not encouraging it. */
  toolChoice?: 'auto' | 'none';
}

export class BuilderChatModel extends BaseChatModel {
  readonly provider: LlmProvider;
  /**
   * Deliberately not named `tools`: LangChain's agent runtime reads a `tools`
   * array on a model as tools bound outside `bindTools` and refuses to start,
   * so the declarations live under a name the runtime does not police.
   */
  readonly toolSpecs: readonly LlmToolSpec[];
  /** `none` only when a caller asked for it; the provider defaults to `auto`. */
  readonly toolChoice: 'auto' | 'none';

  /**
   * What the vendor reported for every call this instance has made. Shared by
   * reference: `bindTools` returns a copy, and an agent runtime calls the copy,
   * so a caller watching this object has to be watching the one that talks.
   */
  readonly usage: ModelUsage;

  constructor(fields: BuilderChatModelFields) {
    super({});
    this.provider = fields.provider;
    this.usage = fields.usage ?? { inputTokens: 0, outputTokens: 0, calls: 0 };
    this.toolSpecs = (fields.tools ?? []).map(toolSpecOf);
    this.toolChoice = fields.toolChoice ?? 'auto';
  }

  override _llmType(): string {
    return 'wfm-llm-provider';
  }

  /**
   * Tools an agent runtime binds reach the provider as declarations. A fresh
   * instance carries them, so the bound model is the one that talks to the
   * vendor and nothing has to travel through run options.
   */
  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<BaseChatModelCallOptions>,
  ): BuilderChatModel {
    return new BuilderChatModel({
      provider: this.provider,
      usage: this.usage,
      tools: [...this.toolSpecs, ...tools.map(toolSpecOf)],
      // Binding tools asks the model to choose among them; a caller that binds
      // with `tool_choice: "none"` is the only one that says otherwise.
      toolChoice: kwargs?.tool_choice === 'none' ? 'none' : 'auto',
    });
  }

  override async _generate(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ): Promise<ChatResult> {
    const completion = await this.provider.complete(
      requestFor(messages, this.toolSpecs, this.toolChoice, options.tool_choice),
    );
    // A caller that runs a loop needs to know what the loop spent even when it
    // ends badly, and an exception carries no messages out of the graph. The
    // model is the one object that sees every vendor call.
    this.usage.inputTokens += completion.inputTokens;
    this.usage.outputTokens += completion.outputTokens;
    this.usage.calls += 1;
    return {
      generations: [
        {
          text: completion.content,
          message: messageFor(completion, this.provider.kind),
        },
      ],
    };
  }

  /**
   * The same call, as LangChain's chunked shape. Prose arrives a token at a
   * time; a tool call arrives as fragments that carry the vendor's own index,
   * which is what lets a caller watch a call start before the tool has run.
   *
   * The chunks assemble into the message `_generate` returns, usage included,
   * so the two paths differ only in when a caller sees the answer.
   */
  override async *_streamResponseChunks(
    messages: BaseMessage[],
    options: this['ParsedCallOptions'],
    runManager?: CallbackManagerForLLMRun,
  ): AsyncGenerator<ChatGenerationChunk> {
    const stream = this.provider.stream(requestFor(messages, this.toolSpecs, this.toolChoice, options.tool_choice));
    for await (const delta of stream.deltas) {
      const toolCallChunks = toolCallChunksOf(delta.toolCalls);
      if (delta.content === '' && toolCallChunks.length === 0) continue;
      yield* this.#report(
        new ChatGenerationChunk({
          text: delta.content,
          message: new AIMessageChunk({
            content: delta.content,
            ...(toolCallChunks.length === 0 ? {} : { tool_call_chunks: toolCallChunks }),
          }),
        }),
        runManager,
      );
    }

    const completion = await stream.completion;
    // Recorded once per model call, from the vendor's own report, whether the
    // call streamed or not: the accounting prices the tokens the vendor billed.
    this.usage.inputTokens += completion.inputTokens;
    this.usage.outputTokens += completion.outputTokens;
    this.usage.calls += 1;
    // The vendor reports what the call cost only once it is over, so usage
    // travels on its own chunk at the end. It is also the chunk that keeps a
    // silent completion from being a stream that yielded nothing.
    yield* this.#report(
      new ChatGenerationChunk({
        text: '',
        message: new AIMessageChunk<StandardMessageStructure>({
          content: '',
          usage_metadata: {
            input_tokens: completion.inputTokens,
            output_tokens: completion.outputTokens,
            total_tokens: completion.inputTokens + completion.outputTokens,
          },
          response_metadata: { model_name: completion.model, model_provider: this.provider.kind },
        }),
      }),
      runManager,
    );
  }

  /** A chunk handed to the caller and to the callback manager, in that order, as LangChain expects. */
  async *#report(
    chunk: ChatGenerationChunk,
    runManager: CallbackManagerForLLMRun | undefined,
  ): AsyncGenerator<ChatGenerationChunk> {
    yield chunk;
    await runManager?.handleLLMNewToken(chunk.text, { prompt: 0, completion: 0 }, undefined, undefined, undefined, {
      chunk,
    });
  }
}

/**
 * A LangChain tool declares its arguments as a Zod schema; ours are declared in
 * JSON Schema. `toJsonSchema` covers both, and returns a schema it was handed
 * unchanged, so a tool carrying JSON Schema already passes through untouched.
 */
function toolSpecOf(tool: BindToolsInput): LlmToolSpec {
  if (isStructuredTool(tool)) {
    return { name: tool.name, description: tool.description, parameters: toJsonSchema(tool.schema) };
  }
  const declared = declaredToolSchema.safeParse(tool);
  if (declared.success) {
    return { name: declared.data.name, description: declared.data.description, parameters: declared.data.parameters };
  }
  const fn = functionToolSchema.safeParse(tool);
  if (!fn.success) {
    throw new Error(
      `a bound tool is neither a LangChain tool, a {name, description, parameters} declaration, nor a ` +
        `{type: 'function', function: {name, description, parameters}} declaration: ${fn.error.message}`,
    );
  }
  return {
    name: fn.data.function.name,
    description: fn.data.function.description,
    parameters: fn.data.function.parameters,
  };
}

function requestFor(
  messages: readonly BaseMessage[],
  toolSpecs: readonly LlmToolSpec[],
  boundChoice: 'auto' | 'none',
  requestedChoice: BaseChatModelCallOptions['tool_choice'],
): LlmRequest {
  const { system, turns } = toConversation(messages);
  const user = turns.length === 0 ? '' : turns.map((turn) => turn.content).join('\n\n');
  const base: LlmRequest = { system, user, messages: turns };
  if (toolSpecs.length === 0) return base;
  return {
    ...base,
    tools: toolSpecs,
    // Our provider knows two choices, so a caller asking for a specific tool is
    // offered the same latitude as `auto` rather than a choice we cannot express.
    toolChoice: requestedChoice === 'none' ? 'none' : boundChoice,
  };
}

/**
 * The conversation as our provider carries it: a system prompt and a list of
 * turns that keeps each role, each tool call and each tool result where the
 * protocol puts them. Flattening this into prose loses the structure the model
 * uses to tell a tool result from something the user said, and a tool-using
 * agent stops calling tools when it cannot see its own results.
 */
function toConversation(messages: readonly BaseMessage[]): { system: string; turns: LlmTurn[] } {
  const system: string[] = [];
  const turns: LlmTurn[] = [];
  for (const message of messages) {
    const text = message.text;
    switch (message.getType()) {
      case 'system':
        system.push(text);
        break;
      case 'human':
        turns.push({ role: 'user', content: text });
        break;
      case 'ai': {
        const calls = toolCallsOf(message);
        turns.push({
          role: 'assistant',
          content: text,
          ...(calls.length === 0
            ? {}
            : {
                toolCalls: calls.map((toolCall) => ({
                  id: toolCall.id ?? '',
                  name: toolCall.name,
                  arguments: JSON.stringify(toolCall.args ?? {}),
                })),
              }),
        });
        break;
      }
      case 'tool':
        turns.push({
          role: 'tool',
          content: text,
          toolCallId: ToolMessage.isInstance(message) ? message.tool_call_id : '',
          name: toolNameOf(message),
        });
        break;
      default:
        if (text.length > 0) turns.push({ role: 'user', content: text });
    }
  }
  return {
    system: system.filter((part) => part.length > 0).join('\n\n'),
    turns,
  };
}

function toolCallsOf(message: BaseMessage): readonly ToolCall[] {
  return AIMessage.isInstance(message) ? message.tool_calls ?? [] : [];
}

/** The tool's name, or the call it answers when the runtime left the name off. */
function toolNameOf(message: BaseMessage): string {
  const name = message.name;
  if (name !== undefined && name.length > 0) return name;
  return ToolMessage.isInstance(message) ? message.tool_call_id : UNNAMED_TOOL;
}

/**
 * The completion as LangChain sees it. Usage is the vendor's own report, so the
 * harness prices the same tokens the provider was billed for.
 */
function messageFor(completion: LlmCompletion, providerKind: string): AIMessage {
  const usage: UsageMetadata = {
    input_tokens: completion.inputTokens,
    output_tokens: completion.outputTokens,
    total_tokens: completion.inputTokens + completion.outputTokens,
  };
  const toolCalls: ToolCall[] = (completion.toolCalls ?? []).map((call) => ({
    id: call.id,
    name: call.name,
    args: parseArguments(call.arguments),
  }));
  return new AIMessage<StandardMessageStructure>({
    content: completion.content,
    tool_calls: toolCalls,
    usage_metadata: usage,
    response_metadata: { model_name: completion.model, model_provider: providerKind },
  });
}

/**
 * The vendor's fragments as LangChain's chunk shape. The id and the name travel
 * on the first fragment only, so a fragment without them leaves the accumulated
 * call's own values alone; the arguments are a partial JSON string that the
 * runtime accumulates and parses when the call is complete.
 */
function toolCallChunksOf(fragments: readonly LlmToolCallDelta[]): ToolCallChunk[] {
  return fragments.map((fragment) => ({
    index: fragment.index,
    ...(fragment.id === '' ? {} : { id: fragment.id }),
    ...(fragment.name === '' ? {} : { name: fragment.name }),
    ...(fragment.arguments === '' ? {} : { args: fragment.arguments }),
  }));
}

/**
 * A model that emits malformed arguments has still asked for the tool, and the
 * runtime's tool node reports the parse failure better than a thrown error here
 * would, so the call survives with empty arguments.
 */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = toolArgumentsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}
