import { z } from 'zod';
import { conditionSchema } from '@wfm/contracts';
import { defineKind } from './define.ts';

export const triggerKind = defineKind(
  'trigger',
  z.object({
    eventType: z.string().min(1),
    conditions: z.array(conditionSchema).default([]),
  }),
  {
    ports: ['always'],
    inputs: [],
    capabilities: { isTrigger: true },
    palette: {
      label: 'When event happens',
      description: 'Starts the workflow from a platform event, optionally filtered by conditions.',
      accent: 'amber',
      icon: '⚡',
    },
    defaultLabel: 'When event happens',
    defaultConfig: { eventType: 'shift.cancelled', conditions: [] },
    fields: [
      { key: 'eventType', label: 'Event', control: { kind: 'select', optionsFrom: 'triggerEvents' } },
      {
        key: 'conditions',
        label: 'Conditions',
        hint: 'The run starts only when these hold.',
        control: { kind: 'conditions' },
      },
    ],
    summary: (config) => `When ${config.eventType}`,
    configRules: [
      (node, context) => {
        if (context.eventTypes.includes(node.config.eventType)) return [];
        return [
          {
            severity: 'error',
            code: 'UNKNOWN_EVENT',
            message: `Unknown trigger event "${node.config.eventType}".`,
            nodeId: node.id,
          },
        ];
      },
    ],
  },
);
