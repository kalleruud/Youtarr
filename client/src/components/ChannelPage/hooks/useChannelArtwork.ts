import { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';

export type PosterSource = 'auto' | 'manual';
export type PosterOrigin = 'manual' | 'upstream' | 'generated';
export type ArtworkRefreshStatus = 'refreshed' | 'not-found' | 'failed' | 'not-configured';

export interface ChannelArtworkStatus {
  enabled: boolean;
  source: PosterSource;
  protected: boolean;
  origin: PosterOrigin | null;
  width: number | null;
  height: number | null;
  revision: number;
  manualAvailable: boolean;
  posterUrl: string | null;
  publishedAt: string | null;
  publishNote: string | null;
  refresh: { status: ArtworkRefreshStatus; message: string | null; attemptedAt: string | null } | null;
  episodes?: { written: number; existing: number; missing: number; failed: number };
}

export type ArtworkAction = 'upload' | 'select' | 'pin' | 'reset' | 'regenerate' | 'refresh';

interface UseChannelArtworkResult {
  data: ChannelArtworkStatus | null;
  loading: boolean;
  error: string | null;
  pending: ArtworkAction | null;
  upload: (file: File) => Promise<void>;
  select: (source: PosterSource) => Promise<void>;
  setPinned: (pinned: boolean) => Promise<void>;
  reset: () => Promise<void>;
  regenerate: () => Promise<void>;
  retryRefresh: () => Promise<void>;
}

function describeError(err: unknown, fallback: string): string {
  if (axios.isAxiosError(err)) {
    const serverError = (err.response?.data as { error?: unknown } | undefined)?.error;
    if (typeof serverError === 'string' && serverError.length > 0) return serverError;
    if (err.response?.status === 404) return 'Channel not found.';
  }
  return fallback;
}

export function useChannelArtwork(channelId: string | undefined, token: string | null, enabled = true): UseChannelArtworkResult {
  const [data, setData] = useState<ChannelArtworkStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<ArtworkAction | null>(null);

  const base = channelId ? `/api/channels/${encodeURIComponent(channelId)}/artwork` : null;
  const headers = useMemo(() => ({ 'x-access-token': token || '' }), [token]);

  useEffect(() => {
    if (!base || !enabled) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    axios.get<ChannelArtworkStatus>(base, { headers })
      .then((res) => { if (!cancelled) setData(res.data); })
      .catch((err: unknown) => { if (!cancelled) setError(describeError(err, 'Could not load the channel artwork.')); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [base, headers, enabled]);

  const run = useCallback(async (action: ArtworkAction, request: () => Promise<{ data: ChannelArtworkStatus }>, fallback: string) => {
    setPending(action);
    setError(null);
    try {
      const res = await request();
      setData(res.data);
    } catch (err: unknown) {
      setError(describeError(err, fallback));
    } finally {
      setPending(null);
    }
  }, []);

  const upload = useCallback((file: File) => {
    const form = new FormData();
    form.append('poster', file);
    return run('upload', () => axios.post<ChannelArtworkStatus>(`${base}/poster`, form, { headers }), 'The poster could not be uploaded.');
  }, [base, headers, run]);

  const select = useCallback((source: PosterSource) => (
    run('select', () => axios.put<ChannelArtworkStatus>(base as string, { source }, { headers }), 'The poster selection could not be saved.')
  ), [base, headers, run]);

  const setPinned = useCallback((pinned: boolean) => (
    run('pin', () => axios.put<ChannelArtworkStatus>(base as string, { protected: pinned }, { headers }), 'The pin could not be saved.')
  ), [base, headers, run]);

  const reset = useCallback(() => (
    run('reset', () => axios.delete<ChannelArtworkStatus>(`${base}/poster`, { headers }), 'The poster could not be reset.')
  ), [base, headers, run]);

  const regenerate = useCallback(() => (
    run('regenerate', () => axios.post<ChannelArtworkStatus>(`${base}/regenerate`, null, { headers }), 'The artwork could not be regenerated.')
  ), [base, headers, run]);

  const retryRefresh = useCallback(() => (
    run('refresh', () => axios.post<ChannelArtworkStatus>(`${base}/refresh`, null, { headers }), 'The Jellyfin refresh could not be requested.')
  ), [base, headers, run]);

  return { data, loading, error, pending, upload, select, setPinned, reset, regenerate, retryRefresh };
}

export default useChannelArtwork;
