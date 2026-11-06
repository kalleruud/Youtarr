import React, { useEffect, useState } from 'react';
import axios from 'axios';

interface Identity {
  status: 'assigned' | 'not-assigned' | 'date-required' | 'date-correction-review';
  season?: number;
  episode?: number;
  publishedAt?: string;
  observedPublishedAt?: string;
}

export default function EpisodeIdentity({ youtubeId, token }: { youtubeId: string; token: string | null }) {
  const [identity, setIdentity] = useState<Identity | null>(null);
  useEffect(() => {
    setIdentity(null);
    if (!youtubeId || !token) return;
    const controller = new AbortController();
    axios.get<Identity>(`/api/videos/${youtubeId}/episode-identity`, {
      headers: { 'x-access-token': token }, signal: controller.signal,
    }).then(response => { if (!controller.signal.aborted) setIdentity(response.data); }).catch(() => {});
    return () => controller.abort();
  }, [youtubeId, token]);
  if (!identity) return null;
  if (identity.status === 'date-required') return <p>TV episode awaiting a reliable publication date.</p>;
  if (identity.status === 'not-assigned') return <p>TV episode number has not yet been assigned.</p>;
  return <p>TV episode: Season {identity.season}, episode {identity.episode}.
    {identity.status === 'date-correction-review' && ` Publication date changed from ${identity.publishedAt} to ${identity.observedPublishedAt}; review required before reassignment.`}
  </p>;
}
