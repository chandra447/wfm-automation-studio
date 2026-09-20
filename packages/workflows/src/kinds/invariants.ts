import type { NodeCapabilities } from './types.ts';

/**
 * The platform invariants, written once against capabilities rather than
 * against kinds. A rule names a subject capability and a capability that must
 * appear on every path to the subject. A kind that claims the subject inherits
 * every rule, including kinds added later, with no change here.
 *
 * `when` reads the node's resolved capabilities only, never its config, so the
 * rule table stays kind-agnostic. A kind whose capability depends on its config
 * resolves it in `capabilitiesOf`, which the validator calls first.
 */

export interface AuthorityRule {
  readonly code: string;
  readonly subject: keyof NodeCapabilities;
  readonly requires: keyof NodeCapabilities;
  readonly when?: (capabilities: NodeCapabilities) => boolean;
  readonly message: (label: string) => string;
}

export const authorityRules: readonly AuthorityRule[] = [
  {
    code: 'ACTION_WITHOUT_POLICY',
    subject: 'mutatesDomain',
    requires: 'providesPolicy',
    message: (label) =>
      `"${label}" can be reached without a policy check. Every action needs deterministic guardrails on its path.`,
  },
  {
    code: 'PAY_ACTION_WITHOUT_APPROVAL',
    subject: 'mutatesDomain',
    requires: 'providesApproval',
    when: (capabilities) => capabilities.payImpact === true,
    message: (label) =>
      `"${label}" can move pay without a human approval on every path. Add an approval node before it.`,
  },
];
