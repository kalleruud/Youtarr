import { useCallback, useState } from 'react';
import axios from 'axios';

export interface CaptionPreviewRequest {
  subtitleLanguage: string;
  captionSourcePolicy: string;
  captionAllowTranslated: boolean;
  captionPreferredVariants: string;
}

export interface CaptionPreviewExample {
  youtubeId: string;
  title: string;
  onDisk: { code: string; source: string }[];
  added: { code: string; source: string }[];
  removed: string[];
  missing: { language: string; reason: string }[];
}

export interface CaptionPreviewResult {
  totals: { videosChecked: number; videosChanged: number; newlyMissing: number; newlyCovered: number; upgrades: number };
  examples: CaptionPreviewExample[];
  limit: number;
}

/** Preview unsaved caption preferences against recent downloads (read-only). */
export function useCaptionPreview(token: string | null) {
  const [data, setData] = useState<CaptionPreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const preview = useCallback(async (request: CaptionPreviewRequest) => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const response = await axios.post<CaptionPreviewResult>('/api/captions/preview', request, {
        headers: { 'x-access-token': token },
      });
      setData(response.data);
    } catch (err: unknown) {
      const message = typeof err === 'object' && err !== null
        ? (err as { response?: { data?: { error?: string } } }).response?.data?.error
        : undefined;
      setError(message || 'Could not preview caption preferences');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [token]);

  return { data, loading, error, preview };
}
