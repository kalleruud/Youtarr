import React, { useRef } from 'react';
import { Alert, Button, Chip, CircularProgress, FormControlLabel, Switch, Typography } from '../../ui';
import { useChannelArtwork, ChannelArtworkStatus, PosterOrigin } from '../hooks/useChannelArtwork';

const ORIGIN_LABELS: Record<PosterOrigin, string> = {
  manual: 'Uploaded poster',
  upstream: 'YouTube portrait image',
  generated: 'Generated from avatar and title',
};

const ACCEPTED_TYPES = 'image/jpeg,image/png,image/webp';

interface ChannelArtworkSectionProps {
  channelId: string;
  token: string | null;
}

function RefreshStatus({ refresh }: { refresh: ChannelArtworkStatus['refresh'] }) {
  if (!refresh) return null;
  const severity = refresh.status === 'failed' ? 'error' : refresh.status === 'refreshed' ? 'success' : 'info';
  return (
    <Alert severity={severity}>
      <Typography variant="body2">{refresh.message}</Typography>
    </Alert>
  );
}

function ChannelArtworkSection({ channelId, token }: ChannelArtworkSectionProps) {
  const { data, loading, error, pending, upload, select, setPinned, reset, regenerate, retryRefresh } = useChannelArtwork(channelId, token);
  const fileInput = useRef<HTMLInputElement>(null);
  const busy = pending !== null;

  if (loading && !data) {
    return (
      <div className="flex justify-center py-8">
        <CircularProgress />
      </div>
    );
  }

  const onFileChosen = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void upload(file);
  };

  const canRetryRefresh = data?.refresh && (data.refresh.status === 'failed' || data.refresh.status === 'not-found');

  return (
    <div className="flex flex-col gap-4">
      <div>
        <Typography variant="subtitle2" gutterBottom style={{ fontWeight: 600 }}>
          Show poster
        </Typography>
        <Typography variant="body2" color="text.secondary">
          The 2:3 poster Jellyfin shows for this channel. Episodes keep their original 16:9 thumbnails.
        </Typography>
      </div>

      {data && !data.enabled && (
        <Alert severity="info">
          <Typography variant="body2">
            Portrait show posters are off, so channel folders keep the square avatar. Turn on &quot;Portrait show posters for Jellyfin TV&quot; in Settings to publish this poster.
          </Typography>
        </Alert>
      )}

      {error && <Alert severity="error">{error}</Alert>}

      {data && (
        <div className="flex flex-col gap-4 sm:flex-row">
          <div className="w-40 shrink-0">
            {data.posterUrl ? (
              <img
                src={data.posterUrl}
                alt="Show poster preview"
                className="aspect-[2/3] w-full rounded-md border border-border object-contain bg-muted"
              />
            ) : (
              <div className="flex aspect-[2/3] w-full items-center justify-center rounded-md border border-dashed border-border bg-muted p-2 text-center">
                <Typography variant="caption" color="text.secondary">No poster prepared yet</Typography>
              </div>
            )}
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              {data.origin && <Chip size="small" label={ORIGIN_LABELS[data.origin]} />}
              {data.width && data.height && (
                <Chip size="small" variant="outlined" label={`${data.width}x${data.height}`} />
              )}
              {data.revision > 0 && <Chip size="small" variant="outlined" label={`Revision ${data.revision}`} />}
            </div>

            <div className="flex flex-wrap gap-2">
              <Button
                size="small"
                variant={data.source === 'auto' ? 'contained' : 'outlined'}
                disabled={busy || data.source === 'auto'}
                onClick={() => void select('auto')}
              >
                Use automatic poster
              </Button>
              <Button
                size="small"
                variant={data.source === 'manual' ? 'contained' : 'outlined'}
                disabled={busy || data.source === 'manual' || !data.manualAvailable}
                onClick={() => void select('manual')}
              >
                Use uploaded poster
              </Button>
            </div>

            <FormControlLabel
              control={(
                <Switch
                  checked={data.protected}
                  disabled={busy}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) => void setPinned(event.target.checked)}
                />
              )}
              label="Pin this poster (keep it through channel refreshes and avatar changes)"
            />

            <div className="flex flex-wrap gap-2">
              <input
                ref={fileInput}
                type="file"
                accept={ACCEPTED_TYPES}
                aria-label="Poster image file"
                className="hidden"
                onChange={onFileChosen}
              />
              <Button size="small" variant="outlined" disabled={busy} onClick={() => fileInput.current?.click()}>
                {pending === 'upload' ? 'Uploading...' : 'Upload poster'}
              </Button>
              <Button size="small" variant="outlined" disabled={busy} onClick={() => void regenerate()}>
                {pending === 'regenerate' ? 'Regenerating...' : 'Regenerate & republish'}
              </Button>
              <Button size="small" variant="outlined" disabled={busy || (data.source === 'auto' && !data.protected && !data.manualAvailable)} onClick={() => void reset()}>
                Reset to automatic
              </Button>
            </div>
            <Typography variant="caption" color="text.secondary">
              JPEG, PNG or WebP, portrait (about 2:3), at least 200x300 and at most 10 MB. Regenerating rewrites artwork only; no video is downloaded again.
            </Typography>
          </div>
        </div>
      )}

      {data?.publishNote && <Alert severity="warning">{data.publishNote}</Alert>}

      {data?.episodes && (
        <Alert severity={data.episodes.failed > 0 ? 'warning' : 'success'}>
          <Typography variant="body2">
            Episode thumbnails: {data.episodes.written} written, {data.episodes.existing} already present, {data.episodes.missing} without a source thumbnail
            {data.episodes.failed > 0 ? `, ${data.episodes.failed} failed` : ''}.
          </Typography>
        </Alert>
      )}

      {data?.refresh && (
        <div className="flex flex-col gap-2">
          <RefreshStatus refresh={data.refresh} />
          {canRetryRefresh && (
            <div>
              <Button size="small" variant="outlined" disabled={busy} onClick={() => void retryRefresh()}>
                {pending === 'refresh' ? 'Retrying...' : 'Retry Jellyfin refresh'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ChannelArtworkSection;
