import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';

export interface CaptionTrack {
  code: string;
  language: string;
  source: string;
  origin: string;
  protected: boolean;
  normalizerVersion: number | null;
  retrievedAt: string | null;
  mediaRevisionCurrent: boolean | null;
}

export interface MissingCaption {
  language: string;
  reason: string;
  state: 'pending' | 'exhausted' | 'blocked' | 'unavailable';
}

export interface CaptionCheck {
  status: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  reason: string | null;
  languages: string[];
}

export interface VideoCaptions {
  youtubeId: string;
  subtitlesEnabled: boolean;
  enrichmentEnabled: boolean;
  mediaAvailable: boolean;
  tracks: CaptionTrack[];
  missing: MissingCaption[];
  upgrades: { language: string; code: string; source: string }[];
  unsupported: string[];
  enrichment: CaptionCheck | null;
}

interface HttpErrorShape {
  response?: { status?: number; data?: { error?: string } };
}

function responseOf(err: unknown): HttpErrorShape['response'] {
  return typeof err === 'object' && err !== null ? (err as HttpErrorShape).response : undefined;
}

function errorMessage(err: unknown, fallback: string): string {
  return responseOf(err)?.data?.error || fallback;
}

/**
 * Caption tracks of one downloaded video, with protection and "Check again".
 * Fetches only while `youtubeId` is set (the modal is open on a downloaded video).
 */
export function useVideoCaptions(youtubeId: string, token: string | null) {
  const [data, setData] = useState<VideoCaptions | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!youtubeId || !token) return;
    setLoading(true);
    try {
      const response = await axios.get<VideoCaptions>(`/api/videos/${youtubeId}/captions`, {
        headers: { 'x-access-token': token },
        signal,
      });
      if (!signal?.aborted) {
        setData(response.data);
        setError(null);
      }
    } catch (err: unknown) {
      if (signal?.aborted) return;
      if (responseOf(err)?.status === 404) setData(null);
      else setError(errorMessage(err, 'Could not load captions'));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [youtubeId, token]);

  useEffect(() => {
    setData(null);
    setError(null);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const setProtection = useCallback(async (code: string, value: boolean) => {
    if (!token) return;
    setPending(true);
    try {
      await axios.put(`/api/videos/${youtubeId}/captions/${encodeURIComponent(code)}/protection`, { protected: value }, {
        headers: { 'x-access-token': token },
      });
      await load();
    } catch (err: unknown) {
      setError(errorMessage(err, 'Could not change caption protection'));
    } finally {
      setPending(false);
    }
  }, [youtubeId, token, load]);

  const checkAgain = useCallback(async () => {
    if (!token) return;
    setPending(true);
    try {
      await axios.post(`/api/videos/${youtubeId}/captions/check`, {}, { headers: { 'x-access-token': token } });
      await load();
    } catch (err: unknown) {
      setError(errorMessage(err, 'Could not schedule a caption check'));
    } finally {
      setPending(false);
    }
  }, [youtubeId, token, load]);

  return { data, loading, error, pending, setProtection, checkAgain };
}
