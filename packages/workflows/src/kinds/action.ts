import { z } from 'zod';
import { commandById } from '../catalogue.ts';
import type { Diagnostic } from '../diagnostics.ts';
import { isWholeReference } from '../references/grammar.ts';
import { defineKind } from './define.ts';

export const actionKind = defineKind(
  'action',
  z.object({
    command: z.string().min(1),
    input: z.record(z.string().min(1), z.string().min(1)),
  }),
  {
    ports: ['always'],
    capabilities: { mutatesDomain: true },
    /** Pay impact depends on which command this node runs, not on the kind. */
    capabilitiesOf: (node) => ({
      mutatesDomain: true,
      payImpact: commandById(node.config.command)?.payAffecting === true,
    }),
    palette: {
      label: 'Action',
      description: 'Issues a typed command to a domain service. Idempotent and fully audited.',
      accent: 'orange',
      icon: '➤',
    },
    defaultLabel: 'Action',
    defaultConfig: { command: 'rostering.send_offers', input: {} },
    fields: [
      { key: 'command', label: 'Command', control: { kind: 'select', optionsFrom: 'commands' } },
      {
        key: 'input',
        label: 'Inputs',
        hint: 'Each field is a template; {{...}} reads the trigger event or an earlier node.',
        control: {
          kind: 'templateMap',
          rows: (config) => (commandById(String(config['command'] ?? ''))?.inputs ?? []).map((input) => ({ ...input })),
        },
      },
    ],
    summary: (config) => commandById(config.command)?.label ?? config.command,
    configRules: [
      (node, context) => {
        const diagnostics: Diagnostic[] = [];
        const command = context.commands.find((candidate) => candidate.id === node.config.command);
        if (command === undefined) {
          return [
            {
              severity: 'error' as const,
              code: 'UNKNOWN_COMMAND',
              message: `Unknown action command "${node.config.command}".`,
              nodeId: node.id,
            },
          ];
        }
        for (const input of command.inputs) {
          if (input.required && !(input.field in node.config.input)) {
            diagnostics.push({
              severity: 'error',
              code: 'MISSING_INPUT',
              message: `"${node.label}" is missing the required input "${input.field}".`,
              nodeId: node.id,
            });
          }
        }
        return diagnostics;
      },
    ],
    templates: (config) =>
      Object.entries(config.input).map(([field, template]) => ({
        origin: field,
        template,
        mode: isWholeReference(template) ? ('whole' as const) : ('inline' as const),
      })),
  },
);
