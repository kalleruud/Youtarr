import React, { useCallback, useContext, useEffect, useState } from 'react';
import axios from 'axios';
import WebSocketContext from '../../contexts/WebSocketContext';
import { Button } from '../ui';

interface RepairItem {
  videoId: number; file?: string; status: string; reason?: string; changed?: number;
  examples?: { before: string; after: string }; refresh?: { status: string };
}
interface RepairRecord { id: string; status: string; warnings: string[]; items: RepairItem[] }
export function SubtitleRepairPanel({ token, videoId }: { token: string | null; videoId?: number }) {
  const [ids, setIds] = useState(videoId ? String(videoId) : '');
  const [confirmed, setConfirmed] = useState(false);
  const [records, setRecords] = useState<RepairRecord[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const ws = useContext(WebSocketContext);
  const load = useCallback(async () => {
    try {
      const response = await axios.get<RepairRecord[]>('/api/subtitle-repairs', { headers: { 'x-access-token': token } });
      setRecords(response.data);
    } catch { setError('Could not load subtitle repairs. Check your session and retry.'); }
  }, [token]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!ws) return;
    const callback = () => { void load(); };
    ws.subscribe((message: { type?: string }) => message.type === 'subtitleRepairUpdated' || message.type === 'connectionRestored', callback);
    return () => ws.unsubscribe(callback);
  }, [ws, load]);
  async function action(suffix: string, body = {}) {
    setBusy(true); setError('');
    try { await axios.post(`/api/subtitle-repairs/${suffix}`, body, { headers: { 'x-access-token': token } }); await load(); }
    catch (err: unknown) {
      setError(axios.isAxiosError<{ error: string }>(err) ? err.response?.data.error || 'Repair request failed' : 'Repair request failed');
    } finally { setBusy(false); }
  }
  return <section className="flex flex-col gap-3 rounded border p-4" aria-label="Repair subtitles">
    <h3>Repair subtitles</h3>
    <p>Preview existing SRT tracks without downloading media. Originals remain restorable outside the library.</p>
    {!videoId && <label>Video IDs (comma separated)<input className="border bg-background p-2" value={ids} onChange={event => setIds(event.target.value)} /></label>}
    <label><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> I verified these are automatic captions synchronized to the final media, including any cuts.</label>
    <Button disabled={busy || !ids.trim()} onClick={() => void action('preview', { videoIds: ids.split(',').map(value => Number(value.trim())), automaticFinal: confirmed })}>Preview subtitle repair</Button>
    <Button disabled={busy} onClick={() => void load()}>Refresh repair status</Button>
    {error && <p role="alert">{error}</p>}
    {records.filter(record => !videoId || record.items.some(item => item.videoId === videoId)).map(record => <article key={record.id} className="border p-3">
      <p>{record.status} · {record.id}</p>
      {(record.warnings || []).map(warning => <p key={warning}>{warning}</p>)}
      <p>{['repaired', 'unchanged', 'skipped', 'failed', 'restored'].map(status => `${status}: ${record.items.filter(item => item.status === status).length}`).join(' · ')}</p>
      {record.items.map((item, index) => <details key={index}><summary>Video {item.videoId}: {item.status}, {item.changed || 0} transitions removed {item.reason}</summary>
        <p>{item.file}</p><p>Jellyfin: {item.refresh?.status || 'not requested'}</p>
        {item.examples && <div className="grid gap-3 md:grid-cols-2"><pre className="whitespace-pre-wrap">Before: {item.examples.before}</pre><pre className="whitespace-pre-wrap">After: {item.examples.after}</pre></div>}
      </details>)}
      {record.status === 'preview' && <Button disabled={busy} onClick={() => void action(`${record.id}/start`)}>Apply reviewed preview</Button>}
      {record.status === 'running' && <Button disabled={busy} onClick={() => void action(`${record.id}/cancel`)}>Cancel unfinished tracks</Button>}
      {record.status !== 'preview' && record.status !== 'running' && <Button disabled={busy} onClick={() => void action(`${record.id}/restore`)}>Restore originals</Button>}
    </article>)}
  </section>;
}
