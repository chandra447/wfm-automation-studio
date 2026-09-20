import { z } from 'zod';
import { triggerCatalog, type ModelDescriptor } from '@wfm/contracts';
import {
  commandCatalog,
  defaultNodeOf,
  fieldsOf,
  kindFor,
  legalPortsByNodeType,
  nodePalette,
  toolCatalog,
  type ControlSource,
  type FieldSpec,
} from '@wfm/workflows';

/**
 * The node kinds as prose, derived from the same declarations the canvas and
 * the validator read rather than written out by hand. A kind added tomorrow
 * reaches the agent with no edit here: its ports, its config keys, the values
 * those keys accept, and its default config all come from the kind's own
 * schema and the platform's catalogues.
 */

/** The id a kind's defaults are read under; it never reaches a prompt. */
const CATALOGUE_PLACEHOLDER_ID = 'example';

/** One line per kind, indented as a list under a `Node kinds:` heading. */
export function kindLines(models: readonly ModelDescriptor[]): string[] {
  const sources: Partial<Record<ControlSource, readonly string[]>> = {
    triggerEvents: triggerCatalog().map((trigger) => trigger.eventType),
    // A command's input fields are the config the model must write for it, so the
    // id is offered together with the fields the chosen command requires.
    commands: commandCatalog.map(
      (command) => `${command.id} (input fields: ${command.inputs.map((input) => input.field).join(', ')})`,
    ),
    tools: toolCatalog.map((tool) => tool.id),
    models: models.map((model) => model.id),
  };

  return nodePalette.flatMap((entry) => {
    const shape: z.ZodRawShape = kindFor(entry.type).schema.shape;
    const defaults = defaultNodeOf(entry.type, CATALOGUE_PLACEHOLDER_ID).config;
    return [
      `- ${entry.type} — "${entry.label}": ${entry.description}`,
      `  ports: ${legalPortsByNodeType[entry.type].join(', ') || 'none (terminal)'}`,
      '  config keys:',
      ...fieldsOf(entry.type).map((field) => {
        const declared = shape[field.key];
        // A key wrapped in `.optional()` or `.default()` may be left out, and the
        // applier merges what is left with the kind's own defaults.
        const optional = declared instanceof z.ZodOptional || declared instanceof z.ZodDefault;
        const template = field.template === true ? ', {{...}} allowed' : '';
        const allowed = allowedValuesFor(shape, field, sources);
        const values = allowed.length === 0 ? '' : ` — one of: ${allowed.join(', ')}`;
        return `    ${field.key} (${field.control.kind}, ${optional ? 'optional' : 'required'}${template}): ${field.label}${values}`;
      }),
      `  default config: ${JSON.stringify(defaults)}`,
    ];
  });
}

/**
 * The values a config key accepts: the kind's own enum when the key has one,
 * otherwise the catalogue its control names. The applier refuses anything else,
 * so the caller is told exactly what will be taken.
 */
function allowedValuesFor(
  shape: z.ZodRawShape,
  field: FieldSpec,
  sources: Partial<Record<ControlSource, readonly string[]>>,
): readonly string[] {
  const declared = enumValuesOf(shape, field.key);
  if (declared.length > 0) return declared;
  if (field.control.kind !== 'select' && field.control.kind !== 'checklist') return [];
  const { options, optionsFrom } = field.control;
  if (options !== undefined) return options.map((option) => option.value);
  return optionsFrom === undefined ? [] : (sources[optionsFrom] ?? []);
}

/** An enum config key's legal values, unwrapped from the array or default around it. */
function enumValuesOf(shape: z.ZodRawShape, key: string): readonly string[] {
  let declared = shape[key];
  while (declared instanceof z.ZodArray || declared instanceof z.ZodOptional || declared instanceof z.ZodDefault) {
    declared = declared.unwrap();
  }
  return declared instanceof z.ZodEnum
    ? declared.options.filter((value): value is string => typeof value === 'string')
    : [];
}

/** One kind's contract on its own, for an agent that asks about a single kind. */
export function kindDetail(type: string, models: readonly ModelDescriptor[]): string | null {
  const lines = kindLines(models);
  const start = lines.findIndex((line) => line.startsWith(`- ${type} — `));
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  // The next kind header ends this one; the block itself is the header plus its body.
  const next = rest.findIndex((line) => line.startsWith('- '));
  return [lines[start], ...(next === -1 ? rest : rest.slice(0, next))].join('\n');
}
