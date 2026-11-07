import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { HealthStage, HealthSummary, VideoHealth } from '../types';

const SUMMARY_URL = '/api/acquisition-health/summary';
const LOAD_ERROR = 'Failed to load acquisition health';

export function serverMessage(err: unknown, fallback: string): string {
  const response = (err as { response?: { status?: number; data?: { error?: unknown } } })?.response;
  if (response?.status === 429) return 'Too many retry requests. Wait a minute and try again.';
  const message = response?.data?.error;
  return typeof message === 'string' ? message : fallback;
}

export interface RetryRequest {
  youtubeId: string;
  stage: HealthStage;
  revision: number;
}

export interface UseAcquisitionHealthReturn {
  summary: HealthSummary | null;
  loading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
  /** Resolves true when the retry was queued; the server's reason is in retryError otherwise. */
  retry: (request: RetryRequest) => Promise<boolean>;
  retryPendingKey: string | null;
  retryError: string | null;
  explain: (youtubeId: string) => Promise<VideoHealth | null>;
}

export const retryKey = ({ youtubeId, stage }: Pick<RetryRequest, 'youtubeId' | 'stage'>) => `${youtubeId}:${stage}`;

export function useAcquisitionHealth(token: string | null): UseAcquisitionHealthReturn {
  const [summary, setSummary] = useState<HealthSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [retryPendingKey, setRetryPendingKey] = useState<string | null>(null);
  const [retryError, setRetryError] = useState<string | null>(null);

  const refetch = useCallback(async () => {
    if (!token) {
      setLoading(false);
      return;
    }
    try {
      const response = await axios.get<HealthSummary>(SUMMARY_URL, { headers: { 'x-access-token': token } });
      setSummary(response.data);
      setError(null);
    } catch (err: unknown) {
      setError(serverMessage(err, LOAD_ERROR));
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const retry = useCallback(async (request: RetryRequest) => {
    if (!token) return false;
    setRetryPendingKey(retryKey(request));
    setRetryError(null);
    try {
      await axios.post(
        `/api/acquisition-health/videos/${encodeURIComponent(request.youtubeId)}/retry`,
        { stage: request.stage, revision: request.revision },
        { headers: { 'x-access-token': token } }
      );
      await refetch();
      return true;
    } catch (err: unknown) {
      setRetryError(serverMessage(err, 'The retry could not be started'));
      await refetch();
      return false;
    } finally {
      setRetryPendingKey(null);
    }
  }, [token, refetch]);

  const explain = useCallback(async (youtubeId: string) => {
    if (!token) return null;
    const response = await axios.get<VideoHealth>(
      `/api/acquisition-health/videos/${encodeURIComponent(youtubeId)}`,
      { headers: { 'x-access-token': token } }
    );
    return response.data;
  }, [token]);

  return { summary, loading, error, refetch, retry, retryPendingKey, retryError, explain };
}
