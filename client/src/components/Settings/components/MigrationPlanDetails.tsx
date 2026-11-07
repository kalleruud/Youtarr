import React from 'react';
import { Alert, Typography } from '../../ui';
import type { MigrationPlan } from '../hooks/useTvLibraryMigration';

// The preview is capped so a large library does not render thousands of rows.
const MAX_LISTED = 50;

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function MoreNote({ total }: { total: number }) {
  if (total <= MAX_LISTED) return null;
  return (
    <Typography variant="caption" color="text.secondary">
      ...and {plural(total - MAX_LISTED, 'more video')}. The full list is in the plan file.
    </Typography>
  );
}

/** What a migration plan will do, what it cannot do, and why. */
export function MigrationPlanDetails({ plan }: { plan: MigrationPlan }) {
  const { summary, mediaServers } = plan;
  return (
    <div className="flex flex-col gap-3">
      <Typography variant="body2">
        {plural(summary.toMove, 'video')} to move into {plural(summary.shows.length, 'show')} ({formatBytes(summary.bytes)}
        {summary.copyBytes > 0 ? `, ${formatBytes(summary.copyBytes)} copied across drives` : ', renamed in place'}).{' '}
        {summary.skipped > 0 && `${plural(summary.skipped, 'video')} cannot be moved. `}
        {summary.alreadyMigrated > 0 && `${plural(summary.alreadyMigrated, 'video')} already in the TV layout.`}
      </Typography>

      {plan.blockers.map((issue) => (
        <Alert key={issue.code} severity="error">{issue.message}</Alert>
      ))}
      {plan.warnings.map((issue) => (
        <Alert key={issue.code} severity="warning">{issue.message}</Alert>
      ))}

      <Alert severity="info">
        <div className="flex flex-col gap-1">
          {mediaServers.jellyfin.configured && (
            <span>Jellyfin: kept per user: {mediaServers.jellyfin.supported.join(', ')}.</span>
          )}
          {mediaServers.jellyfin.unsupported.map((note) => (
            <span key={note}>Not preserved: {note}.</span>
          ))}
          {mediaServers.notes.map((note) => (
            <span key={note}>{note}</span>
          ))}
          <span>{mediaServers.youtarrData}</span>
        </div>
      </Alert>

      {plan.skipped.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">Videos that will stay where they are ({plan.skipped.length})</summary>
          <ul className="mt-2 flex flex-col gap-1 text-sm" aria-label="Videos that will not move">
            {plan.skipped.slice(0, MAX_LISTED).map((item) => (
              <li key={item.youtubeId}>
                <span className="font-medium">{item.title}</span>: {item.message}
              </li>
            ))}
          </ul>
          <MoreNote total={plan.skipped.length} />
        </details>
      )}

      {plan.items.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">Files that will move ({plan.items.length})</summary>
          <ul className="mt-2 flex flex-col gap-2 text-xs" aria-label="Files that will move">
            {plan.items.slice(0, MAX_LISTED).map((item) => (
              <li key={item.youtubeId} className="break-all">
                <div className="font-medium">
                  S{item.season}E{String(item.episode).padStart(3, '0')} {item.title}
                  {item.state.status !== 'pending' && ` (${item.state.status})`}
                </div>
                <div className="font-mono text-muted-foreground">{item.media.source}</div>
                <div className="font-mono">{'-> '}{item.media.target}</div>
                {item.files.length > 0 && <div>{plural(item.files.length, 'subtitle/thumbnail file')} renamed with it.</div>}
                {item.leftovers.length > 0 && (
                  <div>Kept with the plan, not in the library: {item.leftovers.map((file) => file.name).join(', ')}</div>
                )}
                {item.kept.length > 0 && <div>Audio file left in place: {item.kept.join(', ')}</div>}
                {item.state.error && <div className="text-destructive">{item.state.error}</div>}
              </li>
            ))}
          </ul>
          <MoreNote total={plan.items.length} />
        </details>
      )}
    </div>
  );
}

export default MigrationPlanDetails;
