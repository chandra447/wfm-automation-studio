import { z } from 'zod';
import { aiOutputSchema } from '../primitives.ts';
import { defineKind } from './define.ts';
import type { Diagnostic } from '../diagnostics.ts';

/**
 * The agent node: the same declared read-only tools and the same structured
 * output as an AI decision, but the model chooses which tools to call and how
 * often, up to `maxSteps`, before it answers.
 *
 * The difference matters where the cost contract matters. An AI decision node
 * is exactly one model call over evidence the engine fetched for it, so a run's
 * cost and prompt are derivable from the saved definition. An agent node is a
 * loop, so its cost depends on what the model decides to look at. Both are
 * offered because both are honest answers to different problems.
 */
export const agentKind = defineKind(
  'agent',
  z.object({
    goal: z.string().min(10).max(600),
    tools: z.array(z.string().min(1)).min(1),
    output: aiOutputSchema,
    mustCiteEvidence: z.boolean().default(true),
    /** The loop's budget. A turn is one or more model calls per step. */
    maxSteps: z.int().positive().max(12).default(6),
    /** Optional override; only models listed in config/models.jsonl are accepted. */
    model: z.string().min(1).max(200).optional(),
  }),
  {
    ports: ['always'],
    inputs: [{ id: 'in', label: 'Input' }],
    capabilities: { producesOutput: true },
    palette: {
      label: 'AI agent',
      description: 'Works in a loop, choosing which read-only tools to call, then answers with the same structured proposal.',
      accent: 'violet',
    },
    defaultLabel: 'AI agent',
    defaultConfig: {
      goal: 'Decide who to offer this shift to, looking up what you need before answering.',
      tools: ['shift.get', 'shift.candidates'],
      output: 'candidate_choice',
      mustCiteEvidence: true,
      maxSteps: 6,
    },
    fields: [
      {
        key: 'goal',
        label: 'Goal',
        control: { kind: 'textarea', maxLength: 600, rows: 4, placeholder: 'What should the agent work out?' },
        template: true,
      },
      { key: 'tools', label: 'Read-only tools it may call', control: { kind: 'checklist', optionsFrom: 'tools' } },
      { key: 'maxSteps', label: 'Step budget', control: { kind: 'number', min: 1, max: 12, integer: true } },
      { key: 'output', label: 'Output shape', control: { kind: 'select', optionsFrom: 'aiOutputs' } },
      { key: 'model', label: 'Model', control: { kind: 'select', optionsFrom: 'models' }, hint: 'Leave unset to use the provider default.' },
      { key: 'mustCiteEvidence', label: 'Must cite evidence', control: { kind: 'switch' } },
    ],
    summary: (config) => `${config.maxSteps} steps · ${config.goal.slice(0, 40)}${config.goal.length > 40 ? '…' : ''}`,
    configRules: [
      (node, context) => {
        const diagnostics: Diagnostic[] = [];
        for (const tool of node.config.tools) {
          if (!context.tools.some((candidate) => candidate.id === tool)) {
            diagnostics.push({
              severity: 'error' as const,
              code: 'UNKNOWN_TOOL',
              message: `Unknown tool "${tool}" on the agent node.`,
              nodeId: node.id,
            });
          }
        }
        return diagnostics;
      },
    ],
    templates: (config) => [{ origin: 'goal', template: config.goal, mode: 'inline' }],
  },
);
