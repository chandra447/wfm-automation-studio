import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { createAgent } from 'langchain';
import { z } from 'zod';
import type { AnyWfmEvent } from '@wfm/contracts';
import type { AiDecisionNode } from '@wfm/workflows';
import { EnginePermanentError } from '../errors.ts';
import { LlmAccounting } from '../../llm/accounting.ts';
import type { LlmProvider } from '../../llm/provider.ts';
import type { RunMessage } from '../state.ts';
import { BuilderChatModel } from '../../builder/chat-model.ts';
import { ProposerError, parseJsonObject, steeringSection, type ProposalOutputShape } from './proposers.ts';

/**
 * The agent node's loop, behind a port. `ResolvingAgentRunner` resolves the
 * tenant's provider on every invocation, exactly as `ResolvingProposer` does,
 * and records the loop's spend as ONE row.
 *
 * There is deliberately no rules fallback here. A deterministic proposer can
 * stand in for one model call over evidence the engine fetched; it cannot stand
 * in for a loop whose tool choices the model makes, so a tenant with no
 * provider fails the node instead.
 */

/** One step is one tool-calling round; a round costs two graph super-steps. */
const SUPER_STEPS_PER_ROUND = 2;
/** The answering call after the last round, plus the entry/exit nodes. */
const SUPER_STEP_ALLOWANCE = 2;
/** The loop prompt's version, recorded so an audit row names what produced it. */
const PROMPT_VERSION = 'v1';

export interface AgentLoopInput {
  runId: string;
  nodeId: string;
  label: string;
  tenantId: string;
  /** The goal with its {{...}} references already resolved. */
  goal: string;
  /** The node's model override, when it named one. */
  model?: string;
  maxSteps: number;
  /** Which of the three structured outputs the node declared. */
  output: AiDecisionNode['config']['output'];
  mustCiteEvidence: boolean;
  schema: z.ZodObject;
  event: AnyWfmEvent;
  steering: readonly RunMessage[];
  /** The declared read-only tools, already bound to this run's data. */
  tools: readonly StructuredToolInterface[];
}

export interface AgentLoopUsage {
  inputTokens: number;
  outputTokens: number;
  calls: number;
  latencyMs: number;
}

export interface AgentLoopResult {
  /** Validated against the node's output schema; never a raw model reply. */
  output: ProposalOutputShape;
  /** The domain tools the agent called, in the order it called them. */
  toolTrail: readonly string[];
  model: string;
  promptVersion: string;
  usage: AgentLoopUsage;
}

export interface AgentRunner {
  run: (input: AgentLoopInput) => Promise<AgentLoopResult>;
}

/**
 * The slice of `LlmSettings` the runner needs. Narrow on purpose: it is the
 * seam a test scripts the provider through, and it keeps the runner from
 * reaching for any other tenant setting.
 */
export interface ProviderResolver {
  resolveProvider: (tenantId: string, model?: string) => Promise<LlmProvider | null>;
}

export class AgentUnavailableError extends EnginePermanentError {
  override readonly name = 'AgentUnavailableError';
}

/** The one wording for "this node needs a provider", wherever it is raised. */
export function agentUnavailableMessage(input: { nodeId: string; label: string; tenantId: string }): string {
  return (
    `The agent node "${input.label}" (${input.nodeId}) cannot run: tenant ${input.tenantId} has no model provider ` +
    `configured. Configure a provider for this tenant — an agent loop has no deterministic fallback.`
  );
}

export class ResolvingAgentRunner implements AgentRunner {
  readonly #settings: ProviderResolver;
  readonly #accounting: LlmAccounting;

  constructor(deps: { settings: ProviderResolver; accounting: LlmAccounting }) {
    this.#settings = deps.settings;
    this.#accounting = deps.accounting;
  }

  async run(input: AgentLoopInput): Promise<AgentLoopResult> {
    const provider = await this.#settings.resolveProvider(input.tenantId, input.model);
    if (provider === null) throw new AgentUnavailableError(agentUnavailableMessage(input));

    const model = new BuilderChatModel({ provider });
    const agent = createAgent({
      model,
      tools: [...input.tools],
      systemPrompt: systemPromptFor(input),
      responseFormat: input.schema,
    });
    const declaredNames = new Set(input.tools.map((bound) => bound.name));
    const started = Date.now();

    let messages: BaseMessage[] = [new HumanMessage(userContent(input))];
    let seen: readonly BaseMessage[] = [];
    let output: ProposalOutputShape | null = null;
    let lastError: unknown = null;

    for (let attempt = 0; attempt < 2 && output === null; attempt += 1) {
      let result: { messages: BaseMessage[] };
      try {
        result = await agent.invoke({ messages }, { recursionLimit: recursionLimitFor(input.maxSteps) });
      } catch (error) {
        lastError = isRecursionLimit(error)
          ? new ProposerError(
              `the agent node "${input.label}" (${input.nodeId}) used its ${input.maxSteps}-step budget without answering; ` +
                'raise maxSteps or narrow the goal',
            )
          : error;
        break;
      }
      seen = result.messages;
      const validated = input.schema.safeParse(structuredAnswer(result));
      if (validated.success) {
        // The schema parse is the validation boundary; the output shape is the
        // union the three output schemas were declared against.
        output = validated.data as ProposalOutputShape;
        break;
      }
      lastError = new ProposerError(
        `the agent node "${input.label}" (${input.nodeId}) answered with an unusable ${input.output}: ` +
          validated.error.issues.map((issue) => issue.path.join('.') || 'body').join(', '),
      );
      messages = [...result.messages, new HumanMessage(retryInstruction(validated.error))];
    }

    const usage: AgentLoopUsage = { ...model.usage, latencyMs: Date.now() - started };
    if (output === null) {
      await this.#record(provider, input, usage, 'error');
      throw lastError instanceof ProposerError
        ? lastError
        : new ProposerError(
            `the agent node "${input.label}" (${input.nodeId}) failed after a retry: ${String(lastError)}`,
          );
    }
    await this.#record(provider, input, usage, 'ok');
    return { output, toolTrail: toolTrailOf(seen, declaredNames), model: provider.model, promptVersion: PROMPT_VERSION, usage };
  }

  /** A loop is many calls but one node execution, so it is filed as one row. */
  async #record(
    provider: LlmProvider,
    input: AgentLoopInput,
    usage: AgentLoopUsage,
    status: 'ok' | 'error',
  ): Promise<void> {
    await this.#accounting.recordCall({
      tenantId: input.tenantId,
      runId: input.runId,
      nodeId: input.nodeId,
      providerKind: provider.kind,
      model: provider.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      latencyMs: usage.latencyMs,
      status,
    });
  }
}

/** LangGraph says "recursion limit" when a loop has spent its steps. */
function isRecursionLimit(error: unknown): boolean {
  return error instanceof Error && /recursion limit|GRAPH_RECURSION_LIMIT/i.test(`${error.name} ${error.message}`);
}

function recursionLimitFor(maxSteps: number): number {
  return maxSteps * SUPER_STEPS_PER_ROUND + SUPER_STEP_ALLOWANCE;
}

function systemPromptFor(input: AgentLoopInput): string {
  return [
    'You are a workforce planner working in a loop. You may call the read-only tools you have been given, as many times as you need, before you answer.',
    'Read what you need first: the tool data is the only source of truth about the shift, the employees and the timesheet.',
    // Measured: without this the model re-read the same tool with the same
    // arguments three times in one loop, which spends the step budget on
    // nothing and can end the run at the limit before it ever answers.
    'These are reads, not searches: calling one twice with the same arguments returns the same data, so call each one once unless you have a reason to expect it changed.',
    'You have a limited number of steps. When you have enough to answer, answer.',
    `Reply with the structured output. Keys required: ${JSON.stringify(Object.keys(input.schema.shape))}.`,
    input.mustCiteEvidence ? 'Include at least one evidence entry with a label and a value.' : '',
    'Justify the decision with rationale and evidence entries.',
  ]
    .filter((line) => line !== '')
    .join(' ');
}

function userContent(input: AgentLoopInput): string {
  return [
    `Goal: ${input.goal}`,
    `Trigger event: ${JSON.stringify(input.event)}`,
    'Call the tools you need, then reply with the structured output.',
    steeringSection(input.steering),
  ]
    .filter((part) => part !== '')
    .join('\n\n');
}

/**
 * The agent's answer: the structured-output tool call when it made one, or the
 * parsed final reply when it answered in prose. A model that answers in prose
 * is still usable; a model that answered with neither yields null, which fails
 * validation and triggers the one retry.
 */
function structuredAnswer(result: unknown): unknown {
  if (typeof result !== 'object' || result === null) return null;
  if ('structuredResponse' in result) {
    const structured = result.structuredResponse;
    if (structured !== undefined) return structured;
  }
  const messages = 'messages' in result ? result.messages : undefined;
  if (!Array.isArray(messages)) return null;
  return parseJsonObject(lastText(messages));
}

function lastText(messages: readonly unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!(message instanceof AIMessage)) continue;
    const text = typeof message.content === 'string' ? message.content : '';
    if (text.trim() !== '') return text;
  }
  return '';
}

/** The domain tools the agent chose, in order; the output tool is not a choice. */
function toolTrailOf(messages: readonly BaseMessage[], declaredNames: ReadonlySet<string>): string[] {
  const trail: string[] = [];
  for (const message of messages) {
    if (!(message instanceof AIMessage)) continue;
    for (const call of message.tool_calls ?? []) {
      if (declaredNames.has(call.name)) trail.push(call.name);
    }
  }
  return trail;
}

function retryInstruction(error: z.ZodError): string {
  const fields = error.issues.map((issue) => issue.path.join('.') || 'body').join(', ');
  return `Your previous reply did not match the required output (${fields}). Reply again with the structured output only.`;
}
