import React from 'react';
import { Link } from 'react-router-dom';
import { Alert, Typography } from '../../ui';
import { DownloadPauseAlert, STORAGE_LIMITS_SETTINGS_PATH } from '../../shared/DownloadPauseAlert';
import { formatBytes } from '../../Configuration/helpers';
import { HealthSummary } from '../types';

interface StorageHealthCardProps {
  storage: HealthSummary['storage'];
}

function describeFree(label: string, available: number | null | undefined, limit: string | null | undefined): string | null {
  if (available === null || available === undefined) return null;
  return `${label}: ${formatBytes(available)} free${limit ? ` (pauses below ${limit})` : ''}`;
}

export const StorageHealthCard: React.FC<StorageHealthCardProps> = ({ storage }) => {
  if (storage.paused) {
    return <DownloadPauseAlert status={{ ...storage }} />;
  }
  const lines = [
    describeFree('Downloads disk', storage.freeSpace?.availableBytes, storage.freeSpace?.limit),
    describeFree('Temporary download folder', storage.tempFreeSpace?.availableBytes, storage.tempFreeSpace?.limit),
    storage.usage?.downloadedBytes != null
      ? `Downloaded videos: ${formatBytes(storage.usage.downloadedBytes)}${storage.usage.limit ? ` (pauses above ${storage.usage.limit})` : ''}`
      : null,
  ].filter((line): line is string => Boolean(line));
  return (
    <Alert severity="success">
      <Typography variant="body2">Downloads are running; storage is within your limits.</Typography>
      {lines.map((line) => (
        <Typography key={line} variant="body2">{line}</Typography>
      ))}
      {!lines.length && (
        <Typography variant="body2">
          No storage limit is set.{' '}
          <Link className="underline font-medium" to={STORAGE_LIMITS_SETTINGS_PATH}>
            Set limits
          </Link>{' '}
          so downloads pause safely before the disk or the temporary folder fills up.
        </Typography>
      )}
    </Alert>
  );
};

export default StorageHealthCard;
