import {
  aiOutputLabels,
  approvalDisplaySchema,
  commandCatalog,
  policyCheckLabels,
  toolCatalog,
  type ControlSource,
} from '@wfm/workflows';

/** One choice in a select or checklist, in the order the catalogue lists it. */
export interface ControlOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Radix select items cannot carry an empty value, so "leave this unset" needs a
 * sentinel; the field renderer maps it back to an absent config key.
 */
export const UNSET_OPTION_VALUE = '__unset__';

/** Options the page resolves itself: the trigger catalogue and the model list. */
export interface OptionSources {
  readonly triggerEvents: readonly ControlOption[];
  readonly models: readonly ControlOption[];
}

const artifactFormats: readonly ControlOption[] = [
  { value: 'markdown', label: 'Markdown' },
  { value: 'json', label: 'JSON' },
];

const endOutcomes: readonly ControlOption[] = [
  { value: 'completed', label: 'Run completed' },
  { value: 'stopped', label: 'Stopped by decision' },
  { value: 'needs_attention', label: 'Needs attention' },
];

const approvalDisplayLabels: Record<(typeof approvalDisplaySchema.options)[number], string> = {
  rationale: 'Rationale',
  evidence: 'Evidence',
  payImpact: 'Pay impact',
  candidateComparison: 'Candidate comparison',
};

function labelled(record: Readonly<Record<string, string>>): readonly ControlOption[] {
  return Object.entries(record).map(([value, label]) => ({ value, label }));
}

/** Resolves one control's options; every source a kind may point at lives here. */
export function optionsFor(source: ControlSource, sources: OptionSources): readonly ControlOption[] {
  switch (source) {
    case 'triggerEvents':
      return sources.triggerEvents;
    case 'models':
      return [{ value: UNSET_OPTION_VALUE, label: 'Provider default' }, ...sources.models];
    case 'aiOutputs':
      return labelled(aiOutputLabels);
    case 'policyChecks':
      return labelled(policyCheckLabels);
    case 'approvalDisplay':
      return approvalDisplaySchema.options.map((value) => ({ value, label: approvalDisplayLabels[value] }));
    case 'commands':
      return commandCatalog.map((command) => ({
        value: command.id,
        label: command.payAffecting ? `${command.label} · pay-affecting` : command.label,
      }));
    case 'tools':
      return toolCatalog.map((tool) => ({ value: tool.id, label: `${tool.label} — ${tool.description}` }));
    case 'artifactFormats':
      return artifactFormats;
    case 'endOutcomes':
      return endOutcomes;
  }
}
