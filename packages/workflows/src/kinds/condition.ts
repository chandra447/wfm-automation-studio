import { z } from 'zod';
import { conditionSchema } from '@wfm/contracts';
import { defineKind } from './define.ts';

export const conditionKind = defineKind(
  'condition',
  z.object({
    description: z.string().max(200).default(''),
    conditions: z.array(conditionSchema).min(1),
  }),
  {
    ports: ['true', 'false'],
    requiredPorts: [
      {
        port: 'true',
        severity: 'error',
        code: 'PORT_MISSING',
        message: 'Condition nodes must wire both the "yes" and "no" paths.',
      },
      {
        port: 'false',
        severity: 'error',
        code: 'PORT_MISSING',
        message: 'Condition nodes must wire both the "yes" and "no" paths.',
      },
    ],
    capabilities: {},
    palette: {
      label: 'If / else',
      description: 'Branches on event fields, resolved context, or earlier node outputs.',
      accent: 'sky',
      icon: '⑂',
    },
    defaultLabel: 'If / else',
    defaultConfig: { description: '', conditions: [{ field: 'input.payload.shiftId', op: 'exists' }] },
    fields: [
      { key: 'description', label: 'Description', control: { kind: 'textarea', maxLength: 200, rows: 2 } },
      { key: 'conditions', label: 'Conditions', control: { kind: 'conditions' } },
    ],
    summary: (config) => (config.description === '' ? 'Branches on conditions' : config.description),
  },
);
