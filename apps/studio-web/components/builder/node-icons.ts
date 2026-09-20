import type { Icon } from '@phosphor-icons/react';
import {
  FileText,
  GitBranch,
  Lightning,
  PaperPlaneTilt,
  ShieldCheck,
  Sparkle,
  StopCircle,
  UserCheck,
} from '@phosphor-icons/react';
import type { WorkflowNodeType } from '@wfm/workflows';

/**
 * One icon per node kind, shared by the palette, the node card, and anything
 * else that names a kind. Kept in its own module so a component that only needs
 * the icon does not pull in the canvas state.
 */
export const nodeIconByType: Record<WorkflowNodeType, Icon> = {
  trigger: Lightning,
  condition: GitBranch,
  ai_decision: Sparkle,
  policy_check: ShieldCheck,
  human_approval: UserCheck,
  action: PaperPlaneTilt,
  artifact: FileText,
  end: StopCircle,
};
