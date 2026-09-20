import { z } from 'zod';
import { defineKind } from './define.ts';

const policyCheckKindSchema = z.enum([
  'cost_delta_cap',
  'rest_rule',
  'availability',
  'award_validity',
  'overtime_risk',
]);

export const policyCheckKind = defineKind(
  'policy_check',
  z.object({
    checks: z.array(policyCheckKindSchema).min(1),
    costCapCents: z.int().nonnegative().default(0),
    escalateOnFailure: z.boolean().default(true),
  }),
  {
    ports: ['passed', 'failed'],
    requiredPorts: [
      {
        port: 'passed',
        severity: 'error',
        code: 'PORT_MISSING',
        message: 'Policy check nodes must wire both the "passed" and "failed" paths.',
      },
      {
        port: 'failed',
        severity: 'error',
        code: 'PORT_MISSING',
        message: 'Policy check nodes must wire both the "passed" and "failed" paths.',
      },
    ],
    capabilities: { providesPolicy: true },
    palette: {
      label: 'Policy check',
      description: 'Deterministic guardrails: cost caps, rest rules, availability, award validity.',
      accent: 'emerald',
      icon: '⛨',
    },
    defaultLabel: 'Policy check',
    defaultConfig: { checks: ['rest_rule'], costCapCents: 0, escalateOnFailure: true },
    fields: [
      { key: 'checks', label: 'Checks', control: { kind: 'checklist', optionsFrom: 'policyChecks' } },
      { key: 'costCapCents', label: 'Cost cap (cents)', control: { kind: 'number', min: 0, integer: true } },
      { key: 'escalateOnFailure', label: 'Escalate on failure', control: { kind: 'switch' } },
    ],
    summary: (config) => config.checks.join(', ') || 'no checks configured',
  },
);
