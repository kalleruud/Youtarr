import { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';

export type MigrationStatus = 'planned' | 'applying' | 'applied' | 'interrupted' | 'rolling-back' | 'rolled-back';

export interface MigrationIssue {
  code: string;
  message: string;
}

export interface MigrationFile {
  source: string;
  target: string;
}

export interface MigrationItem {
  youtubeId: string;
  channelId: string;
  title: string;
  season: number;
  episode: number;
  media: MigrationFile;
  files: MigrationFile[];
  leftovers: { name: string; source: string }[];
  kept: string[];
  state: { status: string; error?: string | null; note?: string };
}

export interface MigrationSkipped {
  youtubeId: string;
  title: string;
  filePath: string;
  code: string;
  message: string;
}

export interface RestoreReport {
  restored: number;
  pending: string[];
  failed: { youtubeId?: string; playlistId?: string; error: string }[];
  playlistsUpdated: number;
  playlistsPending: number;
}

export interface MigrationPlan {
  planId: string;
  createdAt: string;
  status: MigrationStatus;
  error: string | null;
  interruptedFrom: 'applying' | 'rolling-back' | null;
  running: boolean;
  options: { verifyChecksums: boolean };
  summary: { toMove: number; skipped: number; alreadyMigrated: number; channels: number; shows: string[]; bytes: number; copyBytes: number };
  items: MigrationItem[];
  skipped: MigrationSkipped[];
  blockers: MigrationIssue[];
  warnings: MigrationIssue[];
  progress: Record<string, number>;
  mediaServers: {
    jellyfin: { configured: boolean; supported: string[]; unsupported: string[] };
    notes: string[];
    youtarrData: string;
  };
  followUps: string[];
  userState: { takenAt: string; counts: { videosWithState: number; userEntries: number; playlists: number } } | null;
  userStateSkipped: string | null;
  restore: { status: 'running' | 'complete' | 'partial' | 'error'; report?: RestoreReport; error?: string } | null;
}

interface PlanListResponse {
  plans: { planId: string; status: MigrationStatus }[];
}

export interface MigrationActionError {
  message: string;
  code: string | null;
}

export interface UseTvLibraryMigrationReturn {
  plan: MigrationPlan | null;
  loading: boolean;
  error: string | null;
  actionPending: boolean;
  actionError: MigrationActionError | null;
  preview: (options: { verifyChecksums: boolean }) => Promise<void>;
  apply: (options: { acceptUserStateLoss: boolean }) => Promise<void>;
  resume: () => Promise<void>;
  rollback: () => Promise<void>;
  restoreUserState: () => Promise<void>;
}

const POLL_INTERVAL_MS = 3000;
const BUSY_STATUSES: MigrationStatus[] = ['applying', 'rolling-back'];
// A plan the user still has to act on comes first, then the newest.
const OPEN_STATUSES: MigrationStatus[] = ['applying', 'rolling-back', 'interrupted', 'planned', 'applied'];

function toActionError(err: unknown, fallback: string): MigrationActionError {
  const data = (err as { response?: { data?: { error?: unknown; code?: unknown } } })?.response?.data;
  return {
    message: typeof data?.error === 'string' ? data.error : fallback,
    code: typeof data?.code === 'string' ? data.code : null,
  };
}

export function isBusy(plan: MigrationPlan | null): boolean {
  return Boolean(plan && (plan.running || BUSY_STATUSES.includes(plan.status) || plan.restore?.status === 'running'));
}

export function useTvLibraryMigration(token: string | null): UseTvLibraryMigrationReturn {
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<MigrationActionError | null>(null);
  const planIdRef = useRef<string | null>(null);

  const config = useCallback(() => ({ headers: { 'x-access-token': token ?? '' } }), [token]);

  const loadPlan = useCallback(async (planId: string) => {
    const response = await axios.get<MigrationPlan>(`/api/library-migration/plans/${planId}`, config());
    planIdRef.current = planId;
    setPlan(response.data);
  }, [config]);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      if (planIdRef.current) {
        await loadPlan(planIdRef.current);
      } else {
        const response = await axios.get<PlanListResponse>('/api/library-migration', config());
        const open = OPEN_STATUSES.map((status) => response.data.plans.find((p) => p.status === status)).find(Boolean);
        if (open) await loadPlan(open.planId);
      }
      setError(null);
    } catch {
      setError('Failed to load the TV library migration');
    } finally {
      setLoading(false);
    }
  }, [token, config, loadPlan]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const busy = isBusy(plan);
  useEffect(() => {
    if (!busy) return undefined;
    const timer = setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  const run = useCallback(async (request: () => Promise<{ data: MigrationPlan }>, fallback: string) => {
    setActionPending(true);
    setActionError(null);
    try {
      const response = await request();
      planIdRef.current = response.data.planId;
      setPlan(response.data);
    } catch (err: unknown) {
      setActionError(toActionError(err, fallback));
    } finally {
      setActionPending(false);
    }
  }, []);

  const planUrl = (suffix: string) => `/api/library-migration/plans/${planIdRef.current}/${suffix}`;

  return {
    plan,
    loading,
    error,
    actionPending,
    actionError,
    preview: ({ verifyChecksums }) => run(
      () => axios.post<MigrationPlan>('/api/library-migration/plans', { verifyChecksums }, config()),
      'Could not preview the migration'
    ),
    apply: ({ acceptUserStateLoss }) => run(
      () => axios.post<MigrationPlan>(planUrl('apply'), { confirm: true, acceptUserStateLoss }, config()),
      'Could not start the migration'
    ),
    resume: () => run(() => axios.post<MigrationPlan>(planUrl('resume'), {}, config()), 'Could not resume the migration'),
    rollback: () => run(
      () => axios.post<MigrationPlan>(planUrl('rollback'), { confirm: true }, config()),
      'Could not roll back the migration'
    ),
    restoreUserState: () => run(
      () => axios.post<MigrationPlan>(planUrl('restore-user-state'), {}, config()),
      'Could not restore Jellyfin viewing state'
    ),
  };
}
