import React from 'react';
import { Alert, Chip, CircularProgress, Typography } from '../ui';
import { ConfigurationCard } from '../Configuration/common/ConfigurationCard';
import { formatDateTime } from '../../utils/formatters';
import { useAcquisitionHealth } from './hooks/useAcquisitionHealth';
import { STAGE_LABELS, categoryColor } from './healthLabels';
import OutcomeList from './components/OutcomeList';
import StorageHealthCard from './components/StorageHealthCard';
import VideoHealthLookup from './components/VideoHealthLookup';

interface AcquisitionHealthSectionProps {
  token: string | null;
}

/**
 * Settings > Acquisition Health (issue #18): why a video is missing, why its
 * captions or library listing are pending, stale channels, storage pause and
 * how to resume, with per-step retry.
 */
export const AcquisitionHealthSection: React.FC<AcquisitionHealthSectionProps> = ({ token }) => {
  const { summary, loading, error, retry, retryPendingKey, retryError, explain } = useAcquisitionHealth(token);

  if (loading) {
    return (
      <div className="flex items-center gap-2" role="status">
        <CircularProgress size={16} />
        <Typography variant="body2">Loading acquisition health...</Typography>
      </div>
    );
  }
  if (error || !summary) {
    return <Alert severity="error">{error || 'Failed to load acquisition health'}</Alert>;
  }

  const channels = summary.channels;
  return (
    <div className="flex flex-col gap-2">
      <ConfigurationCard title="Storage" subtitle="Downloads pause before the disk or the temporary download folder fills up.">
        <StorageHealthCard storage={summary.storage} />
      </ConfigurationCard>

      <ConfigurationCard
        title="Needs attention"
        subtitle="The latest unresolved result of each step. A caption or Jellyfin problem never marks the download itself failed."
      >
        {summary.problems.length > 0 && (
          <div className="flex flex-wrap gap-2 mb-3" aria-label="Problem counts">
            {summary.problems.map((problem) => (
              <Chip
                key={`${problem.stage}:${problem.status}:${problem.category}`}
                size="small"
                variant="outlined"
                color={categoryColor(problem.category)}
                label={`${STAGE_LABELS[problem.stage]} · ${problem.categoryLabel} (${problem.status}): ${problem.count}`}
              />
            ))}
          </div>
        )}
        {retryError && <Alert severity="error" className="mb-3">{retryError}</Alert>}
        <OutcomeList outcomes={summary.recent} onRetry={retry} retryPendingKey={retryPendingKey} />
        {summary.unresolvedTotal > summary.recent.length && (
          <Typography variant="caption" color="text.secondary" className="block mt-2">
            Showing the {summary.recent.length} most recent of {summary.unresolvedTotal}.
          </Typography>
        )}
      </ConfigurationCard>

      <ConfigurationCard title="Explain a video" subtitle="Why a video is missing, excluded, or still being processed.">
        <VideoHealthLookup explain={explain} onRetry={retry} retryPendingKey={retryPendingKey} />
      </ConfigurationCard>

      {channels && (
        <ConfigurationCard title="Channel checks">
          <Typography variant="body2">
            {channels.staleCount === 0
              ? `All ${channels.enabledCount} subscribed channels were checked in the last ${channels.thresholdDays} days.`
              : `${channels.staleCount} of ${channels.enabledCount} subscribed channels were not checked in the last ${channels.thresholdDays} days.`}
            {!channels.autoDownloadEnabled && ' Automatic downloads are turned off, so channels are only checked when you open them.'}
          </Typography>
          {channels.lastAutoDownloadRun && (
            <Typography variant="body2" color="text.secondary">
              Last automatic download run: {formatDateTime(channels.lastAutoDownloadRun.finishedAt || channels.lastAutoDownloadRun.startedAt)} ({channels.lastAutoDownloadRun.status}).
            </Typography>
          )}
          {channels.channels.length > 0 && (
            <ul className="mt-2 list-disc pl-5" aria-label="Stale channels">
              {channels.channels.map((channel) => (
                <li key={channel.channelId}>
                  <Typography variant="body2">
                    {channel.title}: {channel.lastCheckedAt ? `last checked ${formatDateTime(channel.lastCheckedAt)}` : 'never checked'}
                  </Typography>
                </li>
              ))}
            </ul>
          )}
        </ConfigurationCard>
      )}

      <ConfigurationCard title="Workers and versions">
        <Typography variant="body2">
          Videos queued or downloading: {summary.leases.activeVideos}
          {summary.leases.inProgressDownloads !== null && ` · downloads in progress: ${summary.leases.inProgressDownloads}`}
        </Typography>
        <Typography variant="body2">
          Youtarr {summary.versions.appVersion || 'unknown'} · yt-dlp {summary.versions.toolVersion || 'unknown'}
        </Typography>
        <Typography variant="body2" color="text.secondary">{summary.live.message}</Typography>
      </ConfigurationCard>
    </div>
  );
};

export default AcquisitionHealthSection;
