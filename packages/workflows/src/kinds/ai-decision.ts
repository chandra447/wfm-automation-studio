import { z } from 'zod';
import type { Diagnostic } from '../diagnostics.ts';
import { aiOutputSchema } from '../primitives.ts';
import { defineKind } from './define.ts';


export const aiDecisionKind = defineKind(
  'ai_decision',
  z.object({
    goal: z.string().min(10).max(600),
    tools: z.array(z.string().min(1)).min(1),
    output: aiOutputSchema,
    mustCiteEvidence: z.boolean().default(true),
    /** Optional override; only models listed in config/models.jsonl are accepted. */
    model: z.string().min(1).max(200).optional(),
  }),
  {
    ports: ['always'],
    inputs: [{ id: 'in', label: 'Input' }],
    capabilities: { producesOutput: true },
    palette: {
      label: 'AI decision',
      description: 'Reasons over read-only tools and produces a proposal it must justify with evidence.',
      accent: 'violet',
    },
    defaultLabel: 'AI decision',
    defaultConfig: {
      goal: 'Choose who to offer this shift to, using eligibility, rest, and cost.',
      tools: ['shift.get', 'shift.candidates'],
      output: 'candidate_choice',
      mustCiteEvidence: true,
    },
    fields: [
      { key: 'goal', label: 'Goal', control: { kind: 'textarea', maxLength: 600, rows: 4, placeholder: 'What should the model decide?' }, template: true },
      { key: 'tools', label: 'Read-only tools', control: { kind: 'checklist', optionsFrom: 'tools' } },
      { key: 'output', label: 'Output shape', control: { kind: 'select', optionsFrom: 'aiOutputs' } },
      { key: 'model', label: 'Model', control: { kind: 'select', optionsFrom: 'models' }, hint: 'Leave unset to use the provider default.' },
      { key: 'mustCiteEvidence', label: 'Must cite evidence', control: { kind: 'switch' } },
    ],
    summary: (config) => `${config.goal.slice(0, 60)}${config.goal.length > 60 ? '…' : ''}`,
    configRules: [
      (node, context) => {
        const diagnostics: Diagnostic[] = [];
        for (const tool of node.config.tools) {
          if (!context.tools.some((candidate) => candidate.id === tool)) {
            diagnostics.push({
              severity: 'error' as const,
              code: 'UNKNOWN_TOOL',
              message: `Unknown tool "${tool}" on the AI decision node.`,
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
