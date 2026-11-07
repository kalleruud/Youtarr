import React from 'react';
import { Accordion, AccordionSummary, AccordionDetails, Box, Button, Chip, Typography } from '../../../ui';
import { formatDateTime } from '../../../../utils/formatters';
import { captionMissingReasonLabel, captionSourceLabel, isMachineCaption } from '../../../../utils/captionLabels';
import { MissingCaption, useVideoCaptions } from '../hooks/useVideoCaptions';

interface VideoCaptionsSectionProps {
  /** Empty while the modal is closed or the video is not downloaded. */
  youtubeId: string;
  token: string | null;
}

const STATE_LABELS: Record<MissingCaption['state'], string> = {
  pending: 'Pending',
  exhausted: 'Checks stopped',
  blocked: 'Cannot add',
  unavailable: 'Unavailable',
};

function VideoCaptionsSection({ youtubeId, token }: VideoCaptionsSectionProps) {
  const { data, error, pending, setProtection, checkAgain } = useVideoCaptions(youtubeId, token);
  if (!youtubeId || !data || !data.mediaAvailable || !data.subtitlesEnabled) return null;

  const check = data.enrichment;
  const canCheckAgain = data.enrichmentEnabled && data.missing.length > 0 && check?.status !== 'running';

  return (
    <Accordion defaultExpanded={data.missing.length > 0} className="w-full">
      <AccordionSummary>Captions</AccordionSummary>
      <AccordionDetails>
        <Box className="flex flex-col gap-2">
          {data.tracks.length === 0 && (
            <Typography variant="body2" color="text.secondary">No caption files are stored with this video.</Typography>
          )}
          {data.tracks.map((track) => (
            <Box key={track.code} className="flex flex-wrap items-center gap-2 justify-between">
              <Box className="flex flex-wrap items-center gap-2">
                <Typography variant="body2" className="font-medium">{track.code}</Typography>
                <Chip
                  size="small"
                  variant="outlined"
                  color={isMachineCaption(track.source) ? 'warning' : 'success'}
                  label={captionSourceLabel(track.source)}
                />
                {track.origin === 'enrichment' && <Chip size="small" variant="outlined" label="Added later" />}
                {track.normalizerVersion != null && <Chip size="small" variant="outlined" label="Normalized" />}
                {track.mediaRevisionCurrent === false && (
                  <Chip size="small" variant="outlined" color="warning" label="Recorded for an earlier file" />
                )}
              </Box>
              <Button
                size="small"
                variant={track.protected ? 'contained' : 'outlined'}
                disabled={pending}
                onClick={() => { void setProtection(track.code, !track.protected); }}
                aria-label={`${track.protected ? 'Unprotect' : 'Protect'} ${track.code} captions`}
              >
                {track.protected ? 'Protected' : 'Protect'}
              </Button>
            </Box>
          ))}
          {data.missing.map((item) => (
            <Box key={item.language} className="flex flex-col">
              <Box className="flex flex-wrap items-center gap-2">
                <Typography variant="body2" className="font-medium">{item.language}</Typography>
                <Chip size="small" variant="outlined" color={item.state === 'pending' ? 'info' : 'default'} label={STATE_LABELS[item.state]} />
              </Box>
              <Typography variant="caption" color="text.secondary">{captionMissingReasonLabel(item.reason)}</Typography>
            </Box>
          ))}
          {data.upgrades.map((upgrade) => (
            <Typography key={upgrade.language} variant="caption" color="text.secondary">
              {`${captionSourceLabel(upgrade.source)} ${upgrade.code} captions were listed for ${upgrade.language}; a caption check can replace the machine-made track.`}
            </Typography>
          ))}
          {check && (check.status === 'pending' || check.status === 'running') && check.nextAttemptAt && (
            <Typography variant="caption" color="text.secondary">
              {`Next check ${formatDateTime(check.nextAttemptAt) ?? ''} (check ${check.attempts + 1} of ${check.maxAttempts}).`}
            </Typography>
          )}
          {check?.reason && (
            <Typography variant="caption" color={check.status === 'exhausted' || check.status === 'blocked' ? 'error' : 'text.secondary'}>
              {check.reason}
            </Typography>
          )}
          {!data.enrichmentEnabled && data.missing.length > 0 && (
            <Typography variant="caption" color="text.secondary">
              Delayed caption checks are off. Turn them on in Settings to look for captions YouTube adds later.
            </Typography>
          )}
          {canCheckAgain && (
            <Box>
              <Button size="small" variant="outlined" disabled={pending} onClick={() => { void checkAgain(); }}>
                Check again
              </Button>
            </Box>
          )}
          {error && <Typography variant="caption" color="error">{error}</Typography>}
        </Box>
      </AccordionDetails>
    </Accordion>
  );
}

export default VideoCaptionsSection;
