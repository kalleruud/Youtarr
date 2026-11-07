import { HealthCategory, HealthStage, HealthStatus } from './types';

export type ChipColor = 'default' | 'error' | 'warning' | 'success' | 'info';

export const STAGE_LABELS: Record<HealthStage, string> = {
  acquisition: 'Download',
  captions: 'Captions',
  publication: 'Publication',
  library: 'Jellyfin listing',
};

// Steps the server can retry on their own (captions and publication cannot).
export const RETRYABLE_STAGES: HealthStage[] = ['acquisition', 'library'];

export function statusColor(status: HealthStatus): ChipColor {
  if (status === 'failed') return 'error';
  if (status === 'warning') return 'warning';
  if (status === 'pending') return 'info';
  if (status === 'ok') return 'success';
  return 'default';
}

export function categoryColor(category: HealthCategory): ChipColor {
  if (category === 'ok') return 'success';
  if (category === 'application-failure' || category === 'permission-path' || category === 'storage-limit') return 'error';
  if (category === 'scan-pending' || category === 'abandoned') return 'info';
  if (category === 'source-unavailable') return 'warning';
  return 'default';
}
