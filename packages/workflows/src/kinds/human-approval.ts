import { z } from 'zod';
import { approvalDisplaySchema } from '../primitives.ts';
import { defineKind } from './define.ts';


export const humanApprovalKind = defineKind(
  'human_approval',
  z.object({
    role: z.string().min(1).max(60),
    timeoutMinutes: z.int().positive().max(10_080),
    escalateTo: z.string().min(1).max(60),
    show: z.array(approvalDisplaySchema).min(1),
  }),
  {
    ports: ['approved', 'rejected'],
    inputs: [{ id: 'in', label: 'Input' }],
    requiredPorts: [
      {
        port: 'approved',
        severity: 'error',
        code: 'PORT_MISSING',
        message: 'Approval nodes must wire the "approved" path.',
      },
      {
        port: 'rejected',
        severity: 'warning',
        code: 'PORT_MISSING_REJECTED',
        message: 'No "rejected" path wired: a rejection will end the run immediately.',
      },
    ],
    capabilities: { providesApproval: true },
    palette: {
      label: 'Human approval',
      description: 'Pauses the run, asks a role to decide, resumes on their answer or escalates.',
      accent: 'rose',
    },
    defaultLabel: 'Human approval',
    defaultConfig: { role: 'roster_manager', timeoutMinutes: 240, escalateTo: 'operations_lead', show: ['rationale', 'evidence'] },
    fields: [
      { key: 'role', label: 'Deciding role', control: { kind: 'text', maxLength: 60 } },
      { key: 'timeoutMinutes', label: 'Timeout (minutes)', control: { kind: 'number', min: 1, max: 10_080, integer: true } },
      { key: 'escalateTo', label: 'Escalate to', control: { kind: 'text', maxLength: 60 } },
      { key: 'show', label: 'Show the approver', control: { kind: 'checklist', optionsFrom: 'approvalDisplay' } },
    ],
    summary: (config) => `${config.role} · ${config.timeoutMinutes} min`,
    configRules: [
      (node) =>
        node.config.timeoutMinutes > 1440
          ? [
              {
                severity: 'warning' as const,
                code: 'LONG_APPROVAL_TIMEOUT',
                message: `Approvals waiting longer than 24h will escalate slowly; ${node.config.timeoutMinutes} minutes configured.`,
                nodeId: node.id,
              },
            ]
          : [],
    ],
  },
);
