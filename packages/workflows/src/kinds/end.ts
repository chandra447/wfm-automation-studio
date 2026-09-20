import { z } from 'zod';
import { defineKind } from './define.ts';

export const endKind = defineKind(
  'end',
  z.object({ outcome: z.enum(['completed', 'stopped', 'needs_attention']).default('completed') }),
  {
    ports: [],
    inputs: [{ id: 'in', label: 'Input' }],
    capabilities: { terminal: true },
    palette: {
      label: 'End',
      description: 'Terminates the path with an outcome.',
      accent: 'slate',
      icon: '⏹',
    },
    defaultLabel: 'End',
    defaultConfig: { outcome: 'completed' },
    fields: [{ key: 'outcome', label: 'Outcome', control: { kind: 'select', optionsFrom: 'endOutcomes' } }],
    summary: (config) => config.outcome,
  },
);
