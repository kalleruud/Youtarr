import { DownloadPauseStatus } from '../../types/downloadPause';

export type HealthStage = 'acquisition' | 'captions' | 'publication' | 'library';
export type HealthStatus = 'ok' | 'warning' | 'failed' | 'pending' | 'skipped';
export type HealthCategory =
  | 'ok'
  | 'source-unavailable'
  | 'policy-excluded'
  | 'no-captions'
  | 'permission-path'
  | 'storage-limit'
  | 'scan-pending'
  | 'abandoned'
  | 'application-failure';

/** One recorded stage result (GET /api/acquisition-health/*). */
export interface HealthOutcome {
  youtubeId: string;
  stage: HealthStage;
  status: HealthStatus;
  category: HealthCategory;
  categoryLabel: string;
  reasonCode: string | null;
  message: string | null;
  retryable: boolean;
  attempts: number;
  revision: number;
  jobId: string | null;
  appVersion: string | null;
  toolVersion: string | null;
  policyRevision: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface HealthProblemCount {
  stage: HealthStage;
  status: HealthStatus;
  category: HealthCategory;
  categoryLabel: string;
  count: number;
}

export interface StaleChannel {
  channelId: string;
  title: string;
  lastCheckedAt: string | null;
}

export interface HealthSummary {
  generatedAt: string;
  storage: Pick<DownloadPauseStatus, 'paused' | 'pausedSince' | 'reasons' | 'usage' | 'freeSpace' | 'tempFreeSpace' | 'checkedAt'>;
  problems: HealthProblemCount[];
  recent: HealthOutcome[];
  unresolvedTotal: number;
  channels: {
    enabledCount: number;
    staleCount: number;
    thresholdDays: number;
    channels: StaleChannel[];
    autoDownloadEnabled: boolean;
    lastAutoDownloadRun: { status: string; finishedAt: string | null; startedAt: string | null; message: string | null } | null;
  } | null;
  leases: { activeVideos: number; inProgressDownloads: number | null };
  live: { tracked: boolean; message: string };
  versions: { appVersion: string | null; toolVersion: string | null };
}

export interface VideoHealthExplanation {
  state: 'ok' | 'in-progress' | 'pending' | 'attention' | 'excluded' | 'removed' | 'unknown';
  category: HealthCategory;
  categoryLabel: string;
  headline: string;
  nextStep: string | null;
  stage?: HealthStage;
  retryable?: boolean;
  revision?: number;
  policyRevision?: string | null;
}

export interface VideoHealth {
  youtubeId: string;
  title: string | null;
  explanation: VideoHealthExplanation;
  outcomes: HealthOutcome[];
}
