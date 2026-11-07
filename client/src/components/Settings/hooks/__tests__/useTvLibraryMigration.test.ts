import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

const axios = require('axios');

const { useTvLibraryMigration, isBusy } = require('../useTvLibraryMigration');

const HEADERS = { headers: { 'x-access-token': 'tok' } };

function plan(overrides = {}) {
  return { planId: '20261106T120000Z-0123abcd', status: 'planned', running: false, restore: null, ...overrides };
}

describe('useTvLibraryMigration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.get.mockImplementation(async (url: string) => (url === '/api/library-migration'
      ? { data: { plans: [{ planId: 'old', status: 'rolled-back' }, { planId: plan().planId, status: 'interrupted' }] } }
      : { data: plan({ status: 'interrupted' }) }));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('loads the plan the user still has to act on', async () => {
    const { result } = renderHook(() => useTvLibraryMigration('tok'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(axios.get).toHaveBeenLastCalledWith(`/api/library-migration/plans/${plan().planId}`, HEADERS);
  });

  test('does not load without a token', () => {
    renderHook(() => useTvLibraryMigration(null));
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('reports a load failure', async () => {
    axios.get.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useTvLibraryMigration('tok'));
    await waitFor(() => expect(result.current.error).toBe('Failed to load the TV library migration'));
  });

  test('preview posts the checksum choice', async () => {
    axios.post.mockResolvedValueOnce({ data: plan() });
    const { result } = renderHook(() => useTvLibraryMigration('tok'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.preview({ verifyChecksums: false });
    });
    expect(axios.post).toHaveBeenCalledWith('/api/library-migration/plans', { verifyChecksums: false }, HEADERS);
  });

  test('apply sends the confirmation for the loaded plan', async () => {
    axios.post.mockResolvedValueOnce({ data: plan({ status: 'applying' }) });
    const { result } = renderHook(() => useTvLibraryMigration('tok'));
    await waitFor(() => expect(result.current.plan).not.toBeNull());
    await act(async () => {
      await result.current.apply({ acceptUserStateLoss: false });
    });
    expect(axios.post).toHaveBeenCalledWith(`/api/library-migration/plans/${plan().planId}/apply`, { confirm: true, acceptUserStateLoss: false }, HEADERS);
  });

  test('keeps the server message and code of a refusal', async () => {
    axios.post.mockRejectedValueOnce({ response: { data: { error: 'Jellyfin unreachable', code: 'snapshot-failed' } } });
    const { result } = renderHook(() => useTvLibraryMigration('tok'));
    await waitFor(() => expect(result.current.plan).not.toBeNull());
    await act(async () => {
      await result.current.apply({ acceptUserStateLoss: false });
    });
    expect(result.current.actionError).toEqual({ message: 'Jellyfin unreachable', code: 'snapshot-failed' });
  });

  test('polls while the migration is moving files', async () => {
    jest.useFakeTimers();
    axios.get.mockImplementation(async (url: string) => (url === '/api/library-migration'
      ? { data: { plans: [{ planId: plan().planId, status: 'applying' }] } }
      : { data: plan({ status: 'applying', running: true }) }));
    const { result } = renderHook(() => useTvLibraryMigration('tok'));
    await waitFor(() => expect(result.current.plan).not.toBeNull());
    const calls = axios.get.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(3000);
    });
    expect(axios.get.mock.calls.length).toBeGreaterThan(calls);
  });

  test('isBusy is true while a restore runs', () => {
    expect(isBusy(plan({ status: 'applied', restore: { status: 'running' } }))).toBe(true);
  });
});
