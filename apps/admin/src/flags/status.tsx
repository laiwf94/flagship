import { describeReason, type Lifecycle, type LifecycleStage } from '@flagship/core';
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

const STAGE: Record<LifecycleStage, { tone: Tone; label: string }> = {
  new: { tone: 'info', label: 'New' },
  active: { tone: 'success', label: 'Active' },
  launched: { tone: 'warning', label: 'Launched' },
  inactive: { tone: 'warning', label: 'Inactive' },
  archived: { tone: 'neutral', label: 'Archived' },
};

export function StageBadge({ stage }: { stage: LifecycleStage }) {
  return <Badge tone={STAGE[stage].tone}>{STAGE[stage].label}</Badge>;
}

/**
 * The lifecycle chip next to a flag's status: shown only when there is
 * something to act on (stale) or to know (new), with the reasons spelled out
 * for screen readers and in the tooltip.
 */
export function LifecycleChip({ lifecycle }: { lifecycle: Lifecycle }) {
  if (lifecycle.stage !== 'new' && !lifecycle.stale) return null;
  const why = lifecycle.reasons.map(describeReason).join('. ');
  return (
    <span className="lifecycle-chip" title={why === '' ? undefined : why}>
      <StageBadge stage={lifecycle.stage} />
      {why !== '' && <span className="visually-hidden">{`: ${why}`}</span>}
    </span>
  );
}

export const TYPE_LABEL = {
  boolean: 'Boolean',
  string: 'String',
  number: 'Number',
  json: 'JSON',
} as const;
