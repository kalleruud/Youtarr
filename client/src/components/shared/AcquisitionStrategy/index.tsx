import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Alert, Button, CircularProgress, Select, MenuItem } from '../../ui';

interface Decision {
  contentKind?: string;
  sourceState?: string;
  effectivePolicy: { delivery: string; live: string; sources: { delivery: string; live: string } };
  plannedActions: string[];
  reasons: { code: string; message: string }[];
}
interface Policy {
  explicit: { delivery: string | null; live: string | null };
  revision: number;
  decisions?: Decision[];
  automatic?: Decision;
  hasLocalCopy?: boolean;
  autoDownloadEnabled?: boolean;
  sourceState?: string;
  note: string;
}
interface Props { endpoint: string; token: string | null }
const actionLabels: Record<string, string> = { download: 'Download', stream: 'Stream on demand', livePlayback: 'Play live', liveRecording: 'Record live' };
const labels: Record<string, string> = {
  download: 'Download automatically', stream: 'Stream on demand', ignore: 'Ignore broadcasts',
  replay: 'Wait for replay', play: 'Allow live playback', record: 'Record live', play_and_record: 'Play and record live',
};

function requestError(err: unknown, fallback: string): string {
  if (!axios.isAxiosError(err)) return fallback;
  switch (err.response?.status) {
    case 401: return 'Sign in again to manage strategies.';
    case 403: return 'You do not have permission to manage this strategy.';
    case 404: return 'This channel or video is no longer tracked. Refresh the listing.';
    case 409: return 'Strategy changed elsewhere. Reload before saving again.';
    case 503: return 'Strategy service is temporarily unavailable. Retry when service is restored.';
    default: return fallback;
  }
}

function useStrategy({ endpoint, token }: Props) {
  const [data, setData] = useState<Policy | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [delivery, setDelivery] = useState('');
  const [live, setLive] = useState('');
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (!endpoint || !token) return;
    const controller = new AbortController();
    setData(null);
    setError('');
    axios.get<Policy>(endpoint, { headers: { 'x-access-token': token }, signal: controller.signal })
      .then(({ data: policy }) => {
        if (controller.signal.aborted) return;
        setData(policy); setDelivery(policy.explicit.delivery || ''); setLive(policy.explicit.live || '');
      }).catch((err: unknown) => { if (!controller.signal.aborted) setError(requestError(err, 'Cannot load strategy. Check your connection or sign in again, then retry.')); });
    return () => controller.abort();
  }, [endpoint, token, reload]);
  const save = async () => {
    if (!data || busy) return;
    setBusy(true); setError('');
    try {
      const response = await axios.put<Policy>(endpoint,
        { delivery: delivery || null, live: live || null, expectedRevision: data.revision },
        { headers: { 'x-access-token': token } });
      setData(response.data);
    } catch (err: unknown) {
      setError(requestError(err, 'Cannot save strategy. Check your connection and permissions, then retry.'));
    } finally { setBusy(false); }
  };
  return { data, error, busy, delivery, live, setDelivery, setLive, save,
    reload: () => setReload(value => value + 1) };
}

export default function AcquisitionStrategy(props: Props) {
  const { data, error, busy, delivery, live, setDelivery, setLive, save, reload } = useStrategy(props);
  if (!props.endpoint || !props.token) return null;
  return <section aria-label="Acquisition strategy" className="space-y-3 min-w-0">
    <h3 className="font-semibold">Viewing and storage strategy</h3>
    {error && <Alert severity="error">{error}</Alert>}
    <Button onClick={reload} disabled={busy}>Reload strategy</Button>
    {!data && !error && <CircularProgress aria-label="Loading strategy" />}
    <p className="text-sm"><a className="underline" href="/downloads">Open Downloads to inspect failures, cancel work or retry acquisition.</a></p>
    {data && <>
      {data.autoDownloadEnabled === false && <Alert severity="info">Channel automation is paused. Enable the channel in Subscriptions to resume.</Alert>}
      {(['delivery', 'live'] as const).map(field => <label key={field} className="block">
        {field === 'delivery' ? 'Uploads and Shorts' : 'Livestreams'}
        <Select fullWidth inputProps={{ 'aria-label': field === 'delivery' ? 'Uploads and Shorts' : 'Livestreams' }} className="w-full" value={field === 'delivery' ? delivery : live}
          onChange={event => (field === 'delivery' ? setDelivery : setLive)(event.target.value)} disabled={busy}>
          <MenuItem value="">Inherit</MenuItem>
          {(field === 'delivery' ? ['download', 'stream'] : ['ignore', 'replay', 'play', 'record', 'play_and_record']).map(value =>
            <MenuItem key={value} value={value}>{labels[value]}</MenuItem>)}
        </Select>
      </label>)}
      <Button onClick={save} disabled={busy}>Save strategy</Button>
      <p className="text-sm text-muted-foreground">{data.note}</p>
      {data.hasLocalCopy && <p>Downloaded copy retained. This is the same video and episode.</p>}
      {(data.decisions || (data.automatic ? [data.automatic] : [])).map((decision, index) => <div key={index} className="rounded border p-3 text-sm">
        <p className="font-medium">{decision.contentKind || 'Video'} · {decision.sourceState || data.sourceState}</p>
        <p>Delivery: {labels[decision.effectivePolicy.delivery]} (from {decision.effectivePolicy.sources.delivery})</p>
        <p>Live: {labels[decision.effectivePolicy.live]} (from {decision.effectivePolicy.sources.live})</p>
        <p>Next action: {decision.plannedActions.map(action => actionLabels[action] || action).join(', ') || 'No automatic action'}</p>
        {decision.reasons.map(reason => <p key={reason.code}>{reason.message}</p>)}
      </div>)}
      {data.automatic && <p>Use the video’s Download action for a manual download, including in stream mode.</p>}
    </>}
  </section>;
}
