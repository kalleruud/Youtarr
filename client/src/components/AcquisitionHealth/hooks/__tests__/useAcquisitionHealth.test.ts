import { renderHook, act, waitFor } from '@testing-library/react';

jest.mock('axios', () => ({
  get: jest.fn(),
  post: jest.fn(),
}));

const axios = require('axios');

const { useAcquisitionHealth } = require('../useAcquisitionHealth');

const SUMMARY = { problems: [], recent: [], unresolvedTotal: 0 };

describe('useAcquisitionHealth', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    axios.get.mockResolvedValue({ data: SUMMARY });
    axios.post.mockResolvedValue({ data: { queued: true } });
  });

  test('loads the summary with the token', async () => {
    const { result } = renderHook(() => useAcquisitionHealth('tok'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(axios.get).toHaveBeenCalledWith('/api/acquisition-health/summary', { headers: { 'x-access-token': 'tok' } });
  });

  test('stops loading without a token and fetches nothing', async () => {
    const { result } = renderHook(() => useAcquisitionHealth(null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('exposes the server error message', async () => {
    axios.get.mockRejectedValueOnce({ response: { status: 500, data: { error: 'Failed to read acquisition health' } } });
    const { result } = renderHook(() => useAcquisitionHealth('tok'));
    await waitFor(() => expect(result.current.error).toBe('Failed to read acquisition health'));
  });

  test('retry posts the stage and revision', async () => {
    const { result } = renderHook(() => useAcquisitionHealth('tok'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.retry({ youtubeId: 'abcdefghijk', stage: 'library', revision: 3 });
    });
    expect(axios.post).toHaveBeenCalledWith(
      '/api/acquisition-health/videos/abcdefghijk/retry',
      { stage: 'library', revision: 3 },
      { headers: { 'x-access-token': 'tok' } }
    );
  });

  test('a refused retry exposes the reason', async () => {
    axios.post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'A retry was already requested.' } } });
    const { result } = renderHook(() => useAcquisitionHealth('tok'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let queued = true;
    await act(async () => {
      queued = await result.current.retry({ youtubeId: 'abcdefghijk', stage: 'acquisition', revision: 1 });
    });
    expect([queued, result.current.retryError]).toEqual([false, 'A retry was already requested.']);
  });

  test('a rate-limited retry says to wait', async () => {
    axios.post.mockRejectedValueOnce({ response: { status: 429, data: {} } });
    const { result } = renderHook(() => useAcquisitionHealth('tok'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      await result.current.retry({ youtubeId: 'abcdefghijk', stage: 'acquisition', revision: 1 });
    });
    expect(result.current.retryError).toContain('Wait a minute');
  });

  test('explain fetches one video', async () => {
    axios.get.mockResolvedValueOnce({ data: SUMMARY }).mockResolvedValueOnce({ data: { youtubeId: 'abcdefghijk' } });
    const { result } = renderHook(() => useAcquisitionHealth('tok'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    let video = null;
    await act(async () => {
      video = await result.current.explain('abcdefghijk');
    });
    expect(video).toEqual({ youtubeId: 'abcdefghijk' });
  });
});
