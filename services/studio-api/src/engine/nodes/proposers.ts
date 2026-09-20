import {
  awardRuleSchema,
  candidateListSchema,
  shiftSchema,
  timesheetSchema,
} from '@wfm/contracts';
import type { AnyWfmEvent } from '@wfm/contracts';
import {
  candidateChoiceOutputSchema,
  timesheetAdjustmentOutputSchema,
  type AiDecisionNode,
  type CandidateChoiceOutput,
  type TimesheetAdjustmentOutput,
} from '@wfm/workflows';
import { z } from 'zod';
import { EnginePermanentError } from '../errors.ts';
import { LlmAccounting } from '../../llm/accounting.ts';
import { LlmSettings } from '../../llm/settings.ts';
import type { LlmCompletion, LlmProvider } from '../../llm/provider.ts';
import type { RunMessage } from '../state.ts';

/**
 * The proposer port (ADR-0006): the model proposes, policy constrains, and a
 * human decides. Two implementations share one output shape per `output` kind:
 * `LlmProposer` when OPENAI_API_KEY is configured, `RulesProposer` always
 * (deterministic; the CI default).
 */

export const coveragePlanOutputSchema = z.object({
  employeeIds: z.array(z.uuid()).min(1),
  topCandidateId: z.uuid(),
  expiresAt: z.iso.datetime({ offset: true }),
  costDeltaCents: z.int(),
  rationale: z.string().min(1),
  evidence: z.array(z.object({ label: z.string().min(1), value: z.string().min(1) })).min(1),
});

export type CoveragePlanOutput = z.infer<typeof coveragePlanOutputSchema>;

export type ProposalOutputShape = CandidateChoiceOutput | TimesheetAdjustmentOutput | CoveragePlanOutput;

export interface ProposerInput {
  /** Which run and node this proposal is for, so a model call can be attributed. */
  runId: string;
  node: AiDecisionNode;
  event: AnyWfmEvent;
  /** Tool outputs keyed by tool id; only the node's declared tools are present. */
  data: Record<string, unknown>;
  /** What human approvers told this run so far, oldest first. */
  steering: readonly RunMessage[];
}

export interface ProposerResult {
  output: ProposalOutputShape;
  rationale: string;
  evidence: Array<{ label: string; value: string }>;
  proposer: 'llm' | 'rules';
  model?: string;
  promptVersion?: string;
}

export interface Proposer {
  propose: (input: ProposerInput) => Promise<ProposerResult>;
}

export class ProposerError extends EnginePermanentError {
  override readonly name = 'ProposerError';
}

const PROMPT_VERSION = 'v1';

/**
 * Deterministic ranking/adjustment over the fetched tool data. No model, no
 * randomness; the same inputs always yield the same proposal.
 */
export class RulesProposer implements Proposer {
  async propose(input: ProposerInput): Promise<ProposerResult> {
    // `steering` is ignored on purpose: this proposer is the deterministic
    // fallback, and a ranking that moved with a reviewer's note would stop
    // being reproducible.
    const { node, event, data } = input;
    switch (node.config.output) {
      case 'candidate_choice':
        return this.proposeCandidateChoice(node, event, data);
      case 'timesheet_adjustment':
        return this.proposeTimesheetAdjustment(node, event, data);
      case 'coverage_plan':
        return this.proposeCoveragePlan(node, event, data);
    }
  }

  #eligibleFrom(candidates: z.infer<typeof candidateListSchema>['candidates']): typeof candidates {
    return candidates.filter((candidate) => candidate.meetsRestRule && candidate.overtimeRisk !== 'high');
  }

  async #candidatesData(data: Record<string, unknown>): Promise<z.infer<typeof candidateListSchema>> {
    const candidates = candidateListSchema.safeParse(data['shift.candidates']);
    if (!candidates.success || candidates.data.candidates.length === 0) {
      throw new ProposerError('rules proposer needs a non-empty candidate list from the shift.candidates tool');
    }
    return candidates.data;
  }

  async #shiftData(data: Record<string, unknown>): Promise<z.infer<typeof shiftSchema>> {
    const shift = shiftSchema.safeParse(data['shift.get']);
    if (!shift.success) throw new ProposerError('rules proposer requires the shift.get tool data');
    return shift.data;
  }

  async proposeCandidateChoice(
    _node: AiDecisionNode,
    event: AnyWfmEvent,
    data: Record<string, unknown>,
  ): Promise<ProposerResult> {
    const shift = await this.#shiftData(data);
    const candidates = await this.#candidatesData(data);
    const eligible = this.#eligibleFrom(candidates.candidates);
    if (eligible.length === 0) {
      throw new ProposerError(
        `no eligible candidate for shift ${shift.shiftId}: everyone on the list fails the rest rule or the overtime policy`,
      );
    }
    const ranked = [...eligible].sort(
      (a, b) => a.costDeltaVsBaselineCents - b.costDeltaVsBaselineCents || b.score - a.score,
    );
    const chosen = ranked.slice(0, Math.min(3, ranked.length));
    const top = chosen[0];
    if (!top) throw new ProposerError('candidate ranking produced no top candidate');

    const output: CandidateChoiceOutput = {
      employeeIds: chosen.map((candidate) => candidate.employeeId),
      topCandidateId: top.employeeId,
      costDeltaCents: top.costDeltaVsBaselineCents,
      rationale:
        `Ranked by lowest cost delta against baseline, then service score; ` +
        `${top.employeeName} is the top pick at ${top.hourlyRateCents}c/h ` +
        `(rest ${top.restHoursBeforeShift}h before shift, overtime risk ${top.overtimeRisk}).`,
      evidence: [
        { label: 'Shift', value: `${shift.roleName} at ${shift.locationName}` },
        { label: 'Trigger', value: event.eventType },
        {
          label: 'Eligible candidates',
          value: `${eligible.length} of ${candidates.candidates.length} pass rest rule and overtime policy`,
        },
        {
          label: 'Top candidate',
          value: `${top.employeeName} — cost delta ${top.costDeltaVsBaselineCents}c, score ${top.score}`,
        },
        ...top.reasons.map((reason, index) => ({ label: `Reason ${index + 1}`, value: reason })),
      ],
    };
    return {
      output,
      rationale: output.rationale,
      evidence: output.evidence,
      proposer: 'rules',
      promptVersion: PROMPT_VERSION,
    };
  }

  async proposeTimesheetAdjustment(
    _node: AiDecisionNode,
    _event: AnyWfmEvent,
    data: Record<string, unknown>,
  ): Promise<ProposerResult> {
    const detail = z.object({ timesheet: timesheetSchema, awardRule: awardRuleSchema }).safeParse(data['timesheet.get']);
    if (!detail.success) throw new ProposerError('rules proposer requires the timesheet.get tool data');
    const { timesheet, awardRule } = detail.data;

    const unpaidBreakTaken = timesheet.breaks
      .filter((breakRecord) => breakRecord.type === 'unpaid')
      .reduce((total, breakRecord) => total + breakRecord.minutes, 0);
    const shortfall = Math.max(0, awardRule.unpaidBreakMinutes - unpaidBreakTaken);

    const exception = timesheet.exceptions.find((candidate) => candidate.status === 'open');
    const overtimeMinutes = exception?.overtimeMinutes ?? 0;
    // A missed break means the unpaid break was never recorded; adding it back
    // removes the matching overstatement from the overtime the raw clock data
    // implied.
    const overtimeMinutesDelta = exception?.type === 'missed_break' ? -overtimeMinutes : 0;

    const ordinaryLine = timesheet.payLines.find((line) => line.multiplier === 1);
    const rateCents = ordinaryLine?.rateCents ?? (timesheet.paidMinutes > 0
      ? Math.round(timesheet.totalPayCents / timesheet.paidMinutes)
      : 0);
    const ratePerMinute = rateCents / 60;
    const payImpactCents = -(
      Math.round(shortfall * ratePerMinute) +
      Math.round(Math.abs(overtimeMinutesDelta) * ratePerMinute * (awardRule.overtimeMultiplier - 1))
    );

    const output: TimesheetAdjustmentOutput = {
      unpaidBreakMinutesDelta: shortfall,
      overtimeMinutesDelta: overtimeMinutesDelta,
      payImpactCents,
      awardRuleCode: awardRule.ruleCode,
      rationale:
        `Award ${awardRule.ruleCode} requires a ${awardRule.unpaidBreakMinutes} minute unpaid break after ` +
        `${awardRule.breakRequiredAfterMinutes} minutes of work; ${unpaidBreakTaken} recorded. Restoring the ` +
        `${shortfall} minute break and removing ${Math.abs(overtimeMinutesDelta)} overstated overtime minutes.`,
      evidence: [
        { label: 'Award rule', value: awardRule.ruleCode },
        { label: 'Required unpaid break', value: `${awardRule.unpaidBreakMinutes} minutes` },
        { label: 'Unpaid break taken', value: `${unpaidBreakTaken} minutes` },
        { label: 'Recorded overtime', value: `${timesheet.overtimeMinutes} minutes` },
        { label: 'Estimated pay impact', value: `${payImpactCents} cents` },
      ],
    };
    return {
      output,
      rationale: output.rationale,
      evidence: output.evidence,
      proposer: 'rules',
      promptVersion: PROMPT_VERSION,
    };
  }

  async proposeCoveragePlan(
    _node: AiDecisionNode,
    event: AnyWfmEvent,
    data: Record<string, unknown>,
  ): Promise<ProposerResult> {
    const candidates = await this.#candidatesData(data);
    const eligible = this.#eligibleFrom(candidates.candidates);
    if (eligible.length === 0) throw new ProposerError('no eligible candidate for a coverage plan');
    const ranked = [...eligible].sort(
      (a, b) => a.costDeltaVsBaselineCents - b.costDeltaVsBaselineCents || b.score - a.score,
    );
    const chosen = ranked.slice(0, Math.min(3, ranked.length));
    const top = chosen[0];
    if (!top) throw new ProposerError('coverage plan ranking produced no top candidate');
    const output: CoveragePlanOutput = {
      employeeIds: chosen.map((candidate) => candidate.employeeId),
      topCandidateId: top.employeeId,
      expiresAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
      costDeltaCents: top.costDeltaVsBaselineCents,
      rationale: `Coverage plan offering to ${chosen.length} ranked employees, ${top.employeeName} first.`,
      evidence: [
        { label: 'Top candidate', value: `${top.employeeName} (cost delta ${top.costDeltaVsBaselineCents} cents)` },
        { label: 'Trigger', value: event.eventType },
      ],
    };
    return { output, rationale: output.rationale, evidence: output.evidence, proposer: 'rules', promptVersion: PROMPT_VERSION };
  }
}

const OUTPUT_SCHEMAS: Record<AiDecisionNode['config']['output'], z.ZodType> = {
  candidate_choice: candidateChoiceOutputSchema,
  timesheet_adjustment: timesheetAdjustmentOutputSchema,
  coverage_plan: coveragePlanOutputSchema,
};

/**
 * Structured-output proposer over the configured provider. Its output is
 * validated against the same schemas as the rules proposer and ineligible
 * employees are dropped afterwards, so the model is never authoritative.
 */
export class LlmProposer implements Proposer {
  readonly #provider: LlmProvider;
  readonly #accounting: LlmAccounting | undefined;
  readonly #provenance: { tenantId: string; runId: string; nodeId: string } | undefined;

  constructor(
    provider: LlmProvider,
    options: { accounting?: LlmAccounting; provenance?: { tenantId: string; runId: string; nodeId: string } } = {},
  ) {
    this.#provider = provider;
    this.#accounting = options.accounting;
    this.#provenance = options.provenance;
  }

  async propose(input: ProposerInput): Promise<ProposerResult> {
    const { node, event, data } = input;
    const schema = OUTPUT_SCHEMAS[node.config.output];
    const system = [
      'You are a workforce planner. Reply with a single JSON object and nothing else.',
      'A deterministic policy check will reject a draft that breaks the award rule or the cost cap in the tool data, so satisfy them.',
      `Keys required: ${JSON.stringify(outputKeysFor(node.config.output))}.`,
      node.config.mustCiteEvidence ? 'Include at least one evidence entry with a label and a value.' : '',
    ]
      .filter((line) => line !== '')
      .join(' ');
    const user = [
      `Goal: ${node.config.goal}`,
      `Trigger event: ${JSON.stringify(event)}`,
      `Tool data: ${JSON.stringify(data)}`,
      'Respond with the structured output. Justify the decision with rationale and evidence entries.',
      steeringSection(input.steering),
    ]
      .filter((part) => part !== '')
      .join('\n\n');

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const completion = await this.#provider.complete({ system, user });
        await this.#record(completion, 'ok');
        const validated = schema.safeParse(parseJsonObject(completion.content));
        if (!validated.success) {
          throw new ProposerError(
            `llm proposal failed schema validation: ${validated.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
          );
        }
        const result = this.#withoutIneligible(validated.data as ProposalOutputShape, input);
        return {
          output: result,
          rationale: result.rationale,
          evidence: result.evidence,
          proposer: 'llm',
          model: completion.model,
          promptVersion: PROMPT_VERSION,
        };
      } catch (error) {
        lastError = error;
        await this.#record(undefined, 'error');
      }
    }
    throw lastError instanceof ProposerError
      ? lastError
      : new ProposerError(`llm proposer failed after retry: ${String(lastError)}`);
  }

  async #record(completion: LlmCompletion | undefined, status: 'ok' | 'error'): Promise<void> {
    if (this.#accounting === undefined || this.#provenance === undefined) return;
    await this.#accounting.recordCall({
      tenantId: this.#provenance.tenantId,
      runId: this.#provenance.runId,
      nodeId: this.#provenance.nodeId,
      providerKind: this.#provider.kind,
      model: this.#provider.model,
      inputTokens: completion?.inputTokens ?? 0,
      outputTokens: completion?.outputTokens ?? 0,
      latencyMs: completion?.latencyMs ?? 0,
      status,
    });
  }

  #withoutIneligible(result: ProposalOutputShape, input: ProposerInput): ProposalOutputShape {
    if (!('employeeIds' in result)) return result;
    const candidates = candidateListSchema.safeParse(input.data['shift.candidates']);
    if (!candidates.success) return result;
    const eligible = new Set(
      candidates.data.candidates
        .filter((candidate) => candidate.meetsRestRule && candidate.overtimeRisk !== 'high')
        .map((candidate) => candidate.employeeId),
    );
    const filtered = result.employeeIds.filter((employeeId) => eligible.has(employeeId));
    const firstEligible = filtered[0];
    if (!firstEligible) {
      throw new ProposerError('llm proposal contained no eligible employee after policy filtering');
    }
    const topCandidateId = eligible.has(result.topCandidateId) ? result.topCandidateId : firstEligible;
    return { ...result, employeeIds: filtered, topCandidateId };
  }
}

/**
 * The reviewer's steering as a prompt block, appended last so it is the final
 * thing the model reads. Every line is quoted so a note cannot be read as
 * prompt structure or tool data, and the header states the precedence it has:
 * above the default ranking, below the policy data.
 */
function steeringSection(messages: readonly RunMessage[]): string {
  if (messages.length === 0) return '';
  const quoted = messages
    .flatMap((message) => message.content.split('\n').map((line) => `> ${line}`))
    .join('\n');
  return [
    'A human reviewer has instructed this run. Their instruction takes precedence over your default ranking; keep satisfying the policy data above where the two disagree.',
    '--- BEGIN HUMAN REVIEWER INSTRUCTION ---',
    quoted,
    '--- END HUMAN REVIEWER INSTRUCTION ---',
  ].join('\n');
}

/** The keys the model must return, listed for the prompt. */
function outputKeysFor(output: AiDecisionNode['config']['output']): string[] {
  const shape = OUTPUT_SCHEMAS[output];
  return shape instanceof z.ZodObject ? Object.keys(shape.shape) : [];
}

/** A model that wrapped its JSON in prose or fences is still usable. */
function parseJsonObject(content: string): unknown {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/**
 * The proposer the engine runs with. It resolves the tenant's provider on every
 * call, because the setting can change between runs, and falls back to the
 * deterministic rules proposer when the tenant has no model configured.
 */
export class ResolvingProposer implements Proposer {
  readonly #settings: LlmSettings;
  readonly #accounting: LlmAccounting;
  readonly #rules: Proposer;

  constructor(deps: { settings: LlmSettings; accounting: LlmAccounting; rules?: Proposer }) {
    this.#settings = deps.settings;
    this.#accounting = deps.accounting;
    this.#rules = deps.rules ?? new RulesProposer();
  }

  async propose(input: ProposerInput): Promise<ProposerResult> {
    const provider = await this.#settings.resolveProvider(input.event.tenantId);
    if (provider === null) return this.#rules.propose(input);
    const proposer = new LlmProposer(provider, {
      accounting: this.#accounting,
      provenance: {
        tenantId: input.event.tenantId,
        runId: input.runId,
        nodeId: input.node.id,
      },
    });
    return proposer.propose(input);
  }
}

