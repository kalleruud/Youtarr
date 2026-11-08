import { renderHook, waitFor, act } from '@testing-library/react';
import axios from 'axios';
import { useVideoCaptions } from '../useVideoCaptions';

jest.mock('axios', () => ({ get: jest.fn(), put: jest.fn(), post: jest.fn() }));
const get = axios.get as jest.Mock;
const post = axios.post as jest.Mock;

beforeEach(() => jest.clearAllMocks());

test('loads the caption summary', async () => {
  get.mockResolvedValue({ data: { youtubeId: 'abcdefghijk', tracks: [] } });
  const { result } = renderHook(({ id }: { id: string }) => useVideoCaptions(id, 'token'), { initialProps: { id: 'abcdefghijk' } });
  await waitFor(() => expect(result.current.data).toEqual({ youtubeId: 'abcdefghijk', tracks: [] }));
});

test('does not fetch without a video', () => {
  renderHook(() => useVideoCaptions('', 'token'));
  expect(get).not.toHaveBeenCalled();
});

test('a 404 leaves no data and no error', async () => {
  get.mockRejectedValue({ response: { status: 404 } });
  const { result } = renderHook(() => useVideoCaptions('abcdefghijk', 'token'));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect([result.current.data, result.current.error]).toEqual([null, null]);
});

test('check again surfaces the server refusal', async () => {
  get.mockResolvedValue({ data: { tracks: [] } });
  post.mockRejectedValue({ response: { status: 409, data: { error: 'Delayed caption checks are turned off in Settings' } } });
  const { result } = renderHook(() => useVideoCaptions('abcdefghijk', 'token'));
  await act(async () => { await result.current.checkAgain(); });
  expect(result.current.error).toBe('Delayed caption checks are turned off in Settings');
});
