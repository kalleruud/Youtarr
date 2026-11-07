import React from 'react';
import { Button, Chip, Typography } from '../../ui';
import { formatDateTime } from '../../../utils/formatters';
import { HealthOutcome } from '../types';
import { RetryRequest, retryKey } from '../hooks/useAcquisitionHealth';
import { RETRYABLE_STAGES, STAGE_LABELS, categoryColor, statusColor } from '../healthLabels';

interface OutcomeListProps {
  outcomes: HealthOutcome[];
  onRetry: (request: RetryRequest) => void;
  retryPendingKey: string | null;
  /** Hide the video id column, e.g. when every row belongs to one video. */
  hideVideoId?: boolean;
  emptyText?: string;
}

function versionsLine(outcome: HealthOutcome): string | null {
  const parts = [
    outcome.appVersion && `Youtarr ${outcome.appVersion}`,
    outcome.toolVersion && `yt-dlp ${outcome.toolVersion}`,
    outcome.policyRevision && `policy rev ${outcome.policyRevision}`,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

export const OutcomeList: React.FC<OutcomeListProps> = ({ outcomes, onRetry, retryPendingKey, hideVideoId = false, emptyText }) => {
  if (!outcomes.length) {
    return (
      <Typography variant="body2" color="text.secondary">
        {emptyText || 'Nothing needs attention.'}
      </Typography>
    );
  }
  return (
    <ul className="flex flex-col gap-3" aria-label="Recorded steps">
      {outcomes.map((outcome) => {
        const key = retryKey(outcome);
        const canRetry = outcome.retryable && RETRYABLE_STAGES.includes(outcome.stage) && outcome.status !== 'ok';
        const versions = versionsLine(outcome);
        return (
          <li key={key} className="rounded-lg border border-border p-3" data-testid="health-outcome">
            <div className="flex flex-wrap items-center gap-2">
              <Typography variant="subtitle2">{STAGE_LABELS[outcome.stage]}</Typography>
              <Chip size="small" color={statusColor(outcome.status)} label={outcome.status} />
              <Chip size="small" variant="outlined" color={categoryColor(outcome.category)} label={outcome.categoryLabel} />
              {!hideVideoId && (
                <a
                  className="font-mono text-sm underline"
                  href={`https://www.youtube.com/watch?v=${encodeURIComponent(outcome.youtubeId)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {outcome.youtubeId}
                </a>
              )}
              {canRetry && (
                <Button
                  size="small"
                  variant="outlined"
                  className="ml-auto"
                  disabled={retryPendingKey !== null}
                  onClick={() => onRetry({ youtubeId: outcome.youtubeId, stage: outcome.stage, revision: outcome.revision })}
                >
                  {retryPendingKey === key ? 'Retrying...' : `Retry ${STAGE_LABELS[outcome.stage].toLowerCase()}`}
                </Button>
              )}
            </div>
            {outcome.message && (
              <Typography variant="body2" className="mt-1 break-words">
                {outcome.message}
              </Typography>
            )}
            <Typography variant="caption" color="text.secondary" className="block mt-1">
              {formatDateTime(outcome.updatedAt)}
              {outcome.attempts > 1 && ` · ${outcome.attempts} attempts in a row`}
              {versions && ` · ${versions}`}
            </Typography>
          </li>
        );
      })}
    </ul>
  );
};

export default OutcomeList;
