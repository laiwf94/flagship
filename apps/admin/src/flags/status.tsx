import type { FlagStatus } from '../api';
import { Badge, type Tone } from '../components/ui';

const STATUS: Record<FlagStatus, { tone: Tone; label: string }> = {
  on: { tone: 'success', label: 'On' },
  rollout: { tone: 'info', label: 'Rolling out' },
  off: { tone: 'neutral', label: 'Off' },
  archived: { tone: 'warning', label: 'Archived' },
};

export function StatusBadge({ status }: { status: FlagStatus }) {
  return <Badge tone={STATUS[status].tone}>{STATUS[status].label}</Badge>;
}

export const TYPE_LABEL = {
  boolean: 'Boolean',
  string: 'String',
  number: 'Number',
  json: 'JSON',
} as const;
