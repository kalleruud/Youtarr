import React from 'react';
import { Box, FormControl, InputLabel, MenuItem, Select, SelectChangeEvent, Typography } from '../../../ui';
import { InfoTooltip } from '../../common/InfoTooltip';
import type { LibraryOutputProfile } from '../../../../config/configSchema';

interface LibraryOutputProfileSelectProps {
  value: LibraryOutputProfile;
  onChange: (value: LibraryOutputProfile) => void;
  onMobileTooltipClick?: (text: string) => void;
}

const TV_EXAMPLE = 'Channel [channel-id]/Season 2026/Channel - S2026E001 - Title [video-id].mp4';

export const LibraryOutputProfileSelect: React.FC<LibraryOutputProfileSelectProps> = ({
  value,
  onChange,
  onMobileTooltipClick,
}) => (
  <FormControl fullWidth>
    <InputLabel>Library Output Profile</InputLabel>
    <Box className="flex items-center gap-1">
      <Select
        value={value}
        onChange={(e: SelectChangeEvent<string>) => onChange(e.target.value as LibraryOutputProfile)}
        label="Library Output Profile"
        className="flex-1 min-w-0"
      >
        <MenuItem value="movie">Movies / Other Videos (per-video folders)</MenuItem>
        <MenuItem value="jellyfinTv">Jellyfin TV (channel = show, year = season)</MenuItem>
      </Select>
      <InfoTooltip
        text="Jellyfin TV publishes new video downloads as episodes: each channel becomes a show with tvshow.nfo, each publication year a season, and each video a stable episode with its own NFO, language-tagged subtitles and thumbnail. Existing downloads are not moved. MP3 downloads and videos without a known publication date keep the regular layout."
        onMobileClick={onMobileTooltipClick}
      />
    </Box>
    {value === 'jellyfinTv' && (
      <Typography variant="caption" color="text.secondary" className="block mt-1" data-testid="tv-profile-hint">
        New episodes are written as <code className="font-mono break-all">{TV_EXAMPLE}</code>. Add this folder to a
        Jellyfin <strong>Shows</strong> library with the Nfo metadata reader enabled, the Nfo saver and remote
        metadata downloaders off. Existing downloads are not moved.
      </Typography>
    )}
  </FormControl>
);
