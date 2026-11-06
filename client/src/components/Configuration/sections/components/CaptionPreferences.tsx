import React from 'react';
import {
  Box,
  Button,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  SelectChangeEvent,
  Switch,
  TextField,
  Typography,
} from '../../../ui';
import { InfoTooltip } from '../../common/InfoTooltip';
import { ConfigState } from '../../types';
import type { CaptionSourcePolicy } from '../../../../config/configSchema';
import { useCaptionPreview } from '../../hooks/useCaptionPreview';
import { captionMissingReasonLabel, captionSourceLabel } from '../../../../utils/captionLabels';

interface CaptionPreferencesProps {
  config: ConfigState;
  onConfigChange: (updates: Partial<ConfigState>) => void;
  onMobileTooltipClick?: (text: string) => void;
  token: string | null;
}

/**
 * Caption source preference, regional variants, machine translations and
 * delayed caption checks (issue #5), with a read-only preview of the change.
 */
export const CaptionPreferences: React.FC<CaptionPreferencesProps> = ({ config, onConfigChange, onMobileTooltipClick, token }) => {
  const { data, loading, error, preview } = useCaptionPreview(token);

  const runPreview = () => {
    void preview({
      subtitleLanguage: config.subtitleLanguage,
      captionSourcePolicy: config.captionSourcePolicy,
      captionAllowTranslated: config.captionAllowTranslated,
      captionPreferredVariants: config.captionPreferredVariants,
    });
  };

  return (
    <Box className="flex flex-col gap-3" data-testid="caption-preferences">
      <FormControl fullWidth>
        <InputLabel>Caption Source</InputLabel>
        <Box className="flex items-center gap-1">
          <Select
            value={config.captionSourcePolicy}
            onChange={(e: SelectChangeEvent<string>) => onConfigChange({ captionSourcePolicy: e.target.value as CaptionSourcePolicy })}
            label="Caption Source"
            className="flex-1 min-w-0"
          >
            <MenuItem value="uploaded-then-automatic">Uploaded captions, then automatic captions</MenuItem>
            <MenuItem value="uploaded-only">Uploaded captions only</MenuItem>
          </Select>
          <InfoTooltip
            text="Which captions count as available for a language. Uploaded captions are written by the creator; automatic captions are YouTube's speech recognition. Downloads still save what yt-dlp fetches; this setting decides what delayed caption checks add and what is reported as missing."
            onMobileClick={onMobileTooltipClick}
          />
        </Box>
      </FormControl>

      <Box className="flex items-center gap-1">
        <TextField
          fullWidth
          label="Preferred Regional Variants"
          placeholder="en-GB, nb"
          value={config.captionPreferredVariants}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => onConfigChange({ captionPreferredVariants: e.target.value })}
          helperText="Listed first when a language has several uploaded variants. Norwegian (no) also matches Bokmal (nb); Nynorsk (nn) is separate."
        />
        <InfoTooltip
          text="Every uploaded regional variant is kept (for example en-GB and en-US); this only sets which one is listed as preferred."
          onMobileClick={onMobileTooltipClick}
        />
      </Box>

      <FormControlLabel
        control={
          <Switch
            name="captionAllowTranslated"
            checked={config.captionAllowTranslated}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => onConfigChange({ captionAllowTranslated: e.target.checked })}
          />
        }
        label="Use YouTube machine translations when nothing else exists"
      />

      <Box className="flex items-center">
        <FormControlLabel
          control={
            <Switch
              name="captionEnrichmentEnabled"
              checked={config.captionEnrichmentEnabled}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => onConfigChange({ captionEnrichmentEnabled: e.target.checked })}
            />
          }
          label="Check again for captions YouTube adds later"
        />
        <InfoTooltip
          text="After a download without a configured language (common right after a livestream), Youtarr asks YouTube again for captions only, never the video, and adds them next to the existing file. Checks run one at a time, not during downloads, and stop after the last retry."
          onMobileClick={onMobileTooltipClick}
        />
      </Box>

      {config.captionEnrichmentEnabled && (
        <Box className="flex flex-col gap-3 md:flex-row">
          <TextField
            fullWidth
            label="Check Schedule"
            value={config.captionEnrichmentRetrySchedule}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => onConfigChange({ captionEnrichmentRetrySchedule: e.target.value })}
            helperText="Times after the download, comma-separated (m, h, d). One check each."
          />
          <TextField
            fullWidth
            type="number"
            label="Seconds Between Checks"
            value={String(config.captionEnrichmentMinIntervalSeconds)}
            inputProps={{ min: 10, max: 3600 }}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => onConfigChange({ captionEnrichmentMinIntervalSeconds: Number(e.target.value) })}
            helperText="Minimum spacing of caption requests to YouTube (10-3600)."
          />
        </Box>
      )}

      <Box>
        <Button size="small" variant="outlined" onClick={runPreview} disabled={loading || !token}>
          {loading ? 'Previewing...' : 'Preview caption changes'}
        </Button>
      </Box>
      {error && <Typography variant="caption" color="error">{error}</Typography>}
      {data && (
        <Box className="flex flex-col gap-1" data-testid="caption-preview">
          <Typography variant="body2">
            {`${data.totals.videosChanged} of ${data.totals.videosChecked} recent downloads would change: `
              + `${data.totals.newlyMissing} language(s) newly missing, ${data.totals.newlyCovered} newly covered, ${data.totals.upgrades} upgrade(s).`}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Existing caption files are not changed by saving; the preferences apply to new downloads and caption checks.
          </Typography>
          {data.examples.map((example) => (
            <Typography key={example.youtubeId} variant="caption" className="block">
              {`${example.title}: `}
              {example.added.length > 0 && `adds ${example.added.map((track) => `${track.code} (${captionSourceLabel(track.source)})`).join(', ')}. `}
              {example.removed.length > 0 && `no longer selects ${example.removed.join(', ')}. `}
              {example.missing.length > 0 && `missing ${example.missing.map((item) => `${item.language}: ${captionMissingReasonLabel(item.reason)}`).join('; ')}.`}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );
};
