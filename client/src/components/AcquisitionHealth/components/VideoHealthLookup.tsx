import React, { useState } from 'react';
import { Alert, Button, Chip, TextField, Typography } from '../../ui';
import { VideoHealth } from '../types';
import { RetryRequest, serverMessage } from '../hooks/useAcquisitionHealth';
import { categoryColor } from '../healthLabels';
import OutcomeList from './OutcomeList';

const ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const URL_ID_PATTERN = /(?:[?&]v=|youtu\.be\/|\/shorts\/|\/live\/|\/embed\/)([A-Za-z0-9_-]{11})/;

/** A bare 11-character id or the id inside a YouTube URL; null otherwise. */
export function parseVideoId(input: string): string | null {
  const value = input.trim();
  if (ID_PATTERN.test(value)) return value;
  const match = URL_ID_PATTERN.exec(value);
  return match ? match[1] : null;
}

interface VideoHealthLookupProps {
  explain: (youtubeId: string) => Promise<VideoHealth | null>;
  onRetry: (request: RetryRequest) => Promise<boolean>;
  retryPendingKey: string | null;
}

export const VideoHealthLookup: React.FC<VideoHealthLookupProps> = ({ explain, onRetry, retryPendingKey }) => {
  const [input, setInput] = useState('');
  const [result, setResult] = useState<VideoHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const lookup = async (youtubeId: string) => {
    setLoading(true);
    setError(null);
    try {
      setResult(await explain(youtubeId));
    } catch (err: unknown) {
      setResult(null);
      setError(serverMessage(err, 'Could not look up this video'));
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const youtubeId = parseVideoId(input);
    if (!youtubeId) {
      setError('Enter a YouTube video URL or its 11-character id.');
      return;
    }
    lookup(youtubeId);
  };

  const handleRetry = async (request: RetryRequest) => {
    await onRetry(request);
    await lookup(request.youtubeId);
  };

  const explanation = result?.explanation;
  return (
    <div className="flex flex-col gap-3">
      <form className="flex flex-wrap items-start gap-2" onSubmit={handleSubmit}>
        <TextField
          label="Video URL or id"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          size="small"
          className="min-w-[16rem] flex-1"
        />
        <Button type="submit" variant="contained" disabled={loading}>
          {loading ? 'Checking...' : 'Explain'}
        </Button>
      </form>
      {error && <Alert severity="error">{error}</Alert>}
      {result && explanation && (
        <div className="flex flex-col gap-2" data-testid="video-health-result">
          <div className="flex flex-wrap items-center gap-2">
            <Typography variant="subtitle2">{result.title || result.youtubeId}</Typography>
            <Chip size="small" variant="outlined" color={categoryColor(explanation.category)} label={explanation.categoryLabel} />
          </div>
          <Typography variant="body2">{explanation.headline}</Typography>
          {explanation.nextStep && (
            <Typography variant="body2" color="text.secondary">
              <strong>Next step:</strong> {explanation.nextStep}
            </Typography>
          )}
          <OutcomeList
            outcomes={result.outcomes}
            onRetry={handleRetry}
            retryPendingKey={retryPendingKey}
            hideVideoId
            emptyText="No processing steps have been recorded for this video yet."
          />
        </div>
      )}
    </div>
  );
};

export default VideoHealthLookup;
