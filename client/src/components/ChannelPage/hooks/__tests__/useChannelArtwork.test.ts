import { renderHook, waitFor, act } from '@testing-library/react';
import { useChannelArtwork, ChannelArtworkStatus } from '../useChannelArtwork';

jest.mock('axios', () => ({
  get: jest.fn(),
  put: jest.fn(),
  post: jest.fn(),
  delete: jest.fn(),
  isAxiosError: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require('axios');

const status: ChannelArtworkStatus = {
  enabled: true,
  source: 'auto',
  protected: false,
  origin: 'generated',
  width: 1000,
  height: 1500,
  revision: 1,
  manualAvailable: false,
  posterUrl: '/images/channelposter-UC1.jpg?rev=1',
  publishedAt: null,
  publishNote: null,
  refresh: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  axios.get.mockResolvedValue({ data: status });
  axios.isAxiosError.mockImplementation((err: { isAxiosError?: boolean }) => Boolean(err?.isAxiosError));
});

describe('useChannelArtwork', () => {
  test('loads the artwork status with the auth header', async () => {
    const { result } = renderHook(() => useChannelArtwork('UC1', 'tok'));
    await waitFor(() => expect(result.current.data).toEqual(status));
    expect(axios.get).toHaveBeenCalledWith('/api/channels/UC1/artwork', { headers: { 'x-access-token': 'tok' } });
  });

  test('does not load while disabled', () => {
    renderHook(() => useChannelArtwork('UC1', 'tok', false));
    expect(axios.get).not.toHaveBeenCalled();
  });

  test('uploads the poster as multipart form data', async () => {
    axios.post.mockResolvedValue({ data: { ...status, source: 'manual' } });
    const { result } = renderHook(() => useChannelArtwork('UC1', 'tok'));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    await act(async () => { await result.current.upload(new File(['x'], 'p.jpg', { type: 'image/jpeg' })); });
    expect(axios.post.mock.calls[0][1]).toBeInstanceOf(FormData);
  });

  test('shows the server message when an upload is rejected', async () => {
    axios.post.mockRejectedValue({ isAxiosError: true, response: { status: 400, data: { error: 'The poster must be portrait.' } } });
    const { result } = renderHook(() => useChannelArtwork('UC1', 'tok'));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    await act(async () => { await result.current.upload(new File(['x'], 'p.png')); });
    expect(result.current.error).toBe('The poster must be portrait.');
  });

  test('keeps the previous status when an action fails', async () => {
    axios.put.mockRejectedValue(new Error('network'));
    const { result } = renderHook(() => useChannelArtwork('UC1', 'tok'));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    await act(async () => { await result.current.setPinned(true); });
    expect(result.current.data).toEqual(status);
  });

  test('sends the pin as protected', async () => {
    axios.put.mockResolvedValue({ data: { ...status, protected: true } });
    const { result } = renderHook(() => useChannelArtwork('UC1', 'tok'));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    await act(async () => { await result.current.setPinned(true); });
    expect(axios.put).toHaveBeenCalledWith('/api/channels/UC1/artwork', { protected: true }, expect.anything());
  });

  test('retries the Jellyfin refresh', async () => {
    axios.post.mockResolvedValue({ data: status });
    const { result } = renderHook(() => useChannelArtwork('UC1', 'tok'));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    await act(async () => { await result.current.retryRefresh(); });
    expect(axios.post).toHaveBeenCalledWith('/api/channels/UC1/artwork/refresh', null, expect.anything());
  });
});
