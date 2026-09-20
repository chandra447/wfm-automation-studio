/**
 * A stand-in for any OpenAI-compatible provider. Tests and
 * scripts/verify-features.sh point a tenant's provider settings at it, so the
 * model path can be exercised end to end without a vendor account.
 *
 * It answers /v1/chat/completions with a payload that satisfies the engine's
 * proposal schemas, derived from the tool data embedded in the prompt, and it
 * records every request, body and all, so a check can assert what the engine
 * actually sent (model, bearer key, message count, tool declarations) and what
 * usage it reported. A request that declares tools gets a tool call back for
 * the first declared tool instead of prose, the way a vendor would answer.
 *
 * CLI:  bun run packages/testkit/src/fake-llm.ts --port 4599 --log /tmp/llm.jsonl
 * Probe: GET /_probe/requests, POST /_probe/reset
 */
import { z } from 'zod';

export interface FakeLlmRequest {
  at: string;
  model: string;
  authorization: string | null;
  messageCount: number;
  promptChars: number;
  kind: 'candidate_choice' | 'timesheet_adjustment' | 'tool_call';
  /** The request body exactly as it arrived, so a check can read tools and tool_choice. */
  body: unknown;
  promptTokens: number;
  completionTokens: number;
}

export interface FakeLlmOptions {
  port?: number;
  logPath?: string;
  promptTokens?: number;
  completionTokens?: number;
  /**
   * The raw JSON string the fake returns as the arguments of the call it makes
   * when a request declares tools. `{}` when unset.
   */
  toolCallArguments?: string;
}

export interface FakeLlmServer {
  port: number;
  url: string;
  requests: () => readonly FakeLlmRequest[];
  reset: () => void;
  stop: () => void;
}

const chatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(z.object({ role: z.string(), content: z.string() })).min(1),
  tools: z
    .array(
      z.object({
        type: z.literal('function'),
        function: z.object({ name: z.string().min(1), description: z.string().optional() }),
      }),
    )
    .optional(),
});

const candidateListSchema = z.object({
  candidates: z.array(
    z.object({
      employeeId: z.string(),
      meetsRestRule: z.boolean().optional(),
      overtimeRisk: z.string().optional(),
    }),
  ),
});

const timesheetSchema = z.object({
  timesheet: z.object({ awardRuleCode: z.string().optional() }).loose(),
});

/** The tool data the engine embeds in the prompt, or null when it is absent. */
function toolDataOf(prompt: string): Record<string, unknown> | null {
  const marker = 'Tool data:';
  const start = prompt.indexOf(marker);
  if (start < 0) return null;
  const body = prompt.slice(start + marker.length);
  const end = body.indexOf('\n\nRespond');
  const json = (end >= 0 ? body.slice(0, end) : body).trim();
  try {
    const parsed: unknown = JSON.parse(json);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function candidateChoice(toolData: Record<string, unknown> | null): unknown {
  const parsed = candidateListSchema.safeParse(toolData?.['shift.candidates']);
  const candidates = parsed.success ? parsed.data.candidates : [];
  const eligible = candidates.filter(
    (candidate) => candidate.meetsRestRule !== false && candidate.overtimeRisk !== 'high',
  );
  const picked = eligible[0] ?? candidates[0];
  const employeeId = picked?.employeeId ?? '44444444-4444-4444-8444-000000000003';
  return {
    employeeIds: [employeeId],
    topCandidateId: employeeId,
    costDeltaCents: 1600,
    rationale: `Fake provider picked ${employeeId} from the eligible candidates in the tool data.`,
    evidence: [
      { label: 'Candidates in tool data', value: String(candidates.length) },
      { label: 'Eligible after rest and overtime rules', value: String(eligible.length) },
    ],
  };
}

function timesheetAdjustment(toolData: Record<string, unknown> | null): unknown {
  const parsed = timesheetSchema.safeParse(toolData?.['timesheet.get']);
  const awardRuleCode = parsed.success ? parsed.data.timesheet.awardRuleCode ?? 'MA000034' : 'MA000034';
  return {
    unpaidBreakMinutesDelta: 30,
    overtimeMinutesDelta: 0,
    payImpactCents: 3200,
    awardRuleCode,
    rationale: 'Fake provider added the unpaid break the award requires and left overtime unchanged.',
    evidence: [{ label: 'Award rule', value: awardRuleCode }],
  };
}

export function startFakeLlmProvider(options: FakeLlmOptions = {}): FakeLlmServer {
  const promptTokens = options.promptTokens ?? 412;
  const completionTokens = options.completionTokens ?? 27;
  const recorded: FakeLlmRequest[] = [];

  const server = Bun.serve({
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === '/_probe/requests') return Response.json({ requests: recorded });
      if (url.pathname === '/_probe/reset' && request.method === 'POST') {
        recorded.length = 0;
        return Response.json({ ok: true });
      }
      if (url.pathname !== '/v1/chat/completions') {
        return Response.json(
          { error: { message: `no route ${url.pathname}`, type: 'invalid_request_error', code: 'not_found' } },
          { status: 404 },
        );
      }

      const authorization = request.headers.get('authorization');
      if (authorization === null) {
        return Response.json(
          { error: { message: 'missing api key', type: 'invalid_request_error', code: 'invalid_api_key' } },
          { status: 401 },
        );
      }

      const rawBody: unknown = await request.json().catch(() => null);
      const parsed = chatRequestSchema.safeParse(rawBody);
      if (!parsed.success) {
        return Response.json(
          { error: { message: 'invalid request body', type: 'invalid_request_error', code: 'invalid_request' } },
          { status: 400 },
        );
      }

      const prompt = parsed.data.messages.map((message) => message.content).join('\n');
      const toolData = toolDataOf(prompt);
      const isTimesheet = /timesheet/i.test(prompt);
      // A declared tool is the model's cue to call it, so the fake calls the first one.
      const declaredTool = parsed.data.tools?.at(0);
      const entry: FakeLlmRequest = {
        at: new Date().toISOString(),
        model: parsed.data.model,
        authorization,
        messageCount: parsed.data.messages.length,
        promptChars: prompt.length,
        kind: declaredTool === undefined ? (isTimesheet ? 'timesheet_adjustment' : 'candidate_choice') : 'tool_call',
        body: rawBody,
        promptTokens,
        completionTokens,
      };
      recorded.push(entry);
      if (options.logPath !== undefined && options.logPath !== '') {
        await Bun.write(options.logPath, `${JSON.stringify(entry)}\n`, { createPath: true });
      }

      const message =
        declaredTool === undefined
          ? {
              role: 'assistant',
              content: JSON.stringify(isTimesheet ? timesheetAdjustment(toolData) : candidateChoice(toolData)),
            }
          : {
              role: 'assistant',
              // The vendor sends null content when the model only calls.
              content: null,
              tool_calls: [
                {
                  id: `call_fake_${recorded.length}`,
                  type: 'function',
                  function: {
                    name: declaredTool.function.name,
                    arguments: options.toolCallArguments ?? '{}',
                  },
                },
              ],
            };
      return Response.json({
        id: `chatcmpl-fake-${recorded.length}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: parsed.data.model,
        choices: [
          { index: 0, message, finish_reason: declaredTool === undefined ? 'stop' : 'tool_calls' },
        ],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
    },
  });

  const boundPort = server.port;
  if (boundPort === undefined) throw new Error('fake provider did not bind a port');
  return {
    port: boundPort,
    url: `http://127.0.0.1:${boundPort}/v1`,
    requests: () => recorded,
    reset: () => {
      recorded.length = 0;
    },
    stop: () => {
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const argv = process.argv;
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const provider = startFakeLlmProvider({
    port: Number(flag('port') ?? process.env.FAKE_LLM_PORT ?? 4599),
    logPath: flag('log') ?? process.env.FAKE_LLM_LOG ?? '',
  });
  console.log(`fake provider listening on ${provider.url}`);
}
