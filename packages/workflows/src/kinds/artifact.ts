import { z } from 'zod';
import { defineKind } from './define.ts';

/**
 * Renders a document from the run's own data and attaches it to the run. It
 * reads references exactly like an action's inputs do, which is the whole point
 * of single-sourcing the {{...}} mechanism: this kind declares its template
 * slots and inherits parsing, resolution, and save-time checking.
 */
export const artifactKind = defineKind(
  'artifact',
  z.object({
    name: z.string().min(1).max(120),
    format: z.enum(['markdown', 'json']),
    body: z.string().min(1).max(4000),
  }),
  {
    ports: ['always'],
    inputs: [{ id: 'in', label: 'Input' }],
    capabilities: { producesArtifact: true },
    palette: {
      label: 'Artifact',
      description: 'Renders a document from run data and attaches it to the run.',
      accent: 'teal',
      icon: '📄',
    },
    defaultLabel: 'Artifact',
    defaultConfig: {
      name: 'Run summary',
      format: 'markdown',
      body: '# {{run.workflowName}}\n\nShift {{input.payload.shiftId}} was covered.',
    },
    fields: [
      { key: 'name', label: 'Name', control: { kind: 'text', maxLength: 120 } },
      { key: 'format', label: 'Format', control: { kind: 'select', optionsFrom: 'artifactFormats' } },
      {
        key: 'body',
        label: 'Body',
        hint: 'Markdown. {{...}} reads the trigger event, run metadata, or an earlier node.',
        control: { kind: 'textarea', maxLength: 4000, rows: 10 },
        template: true,
      },
    ],
    summary: (config) => `Renders ${config.name}`,
    templates: (config) => [{ origin: 'body', template: config.body, mode: 'inline' }],
  },
);
