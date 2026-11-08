import { renderHook, act } from '@testing-library/react';
import axios from 'axios';
import { useCaptionPreview } from '../useCaptionPreview';

jest.mock('axios', () => ({ post: jest.fn() }));
const post = axios.post as jest.Mock;

const request = { subtitleLanguage: 'en', captionSourcePolicy: 'uploaded-only', captionAllowTranslated: false, captionPreferredVariants: '' };

beforeEach(() => jest.clearAllMocks());

test('stores the preview result', async () => {
  post.mockResolvedValue({ data: { totals: { videosChecked: 1 }, examples: [], limit: 200 } });
  const { result } = renderHook(() => useCaptionPreview('token'));
  await act(async () => { await result.current.preview(request); });
  expect(result.current.data?.limit).toBe(200);
});

test('shows the server error message', async () => {
  post.mockRejectedValue({ response: { data: { error: 'Invalid captionSourcePolicy' } } });
  const { result } = renderHook(() => useCaptionPreview('token'));
  await act(async () => { await result.current.preview(request); });
  expect(result.current.error).toBe('Invalid captionSourcePolicy');
});

test('does nothing without a token', async () => {
  const { result } = renderHook(() => useCaptionPreview(null));
  await act(async () => { await result.current.preview(request); });
  expect(post).not.toHaveBeenCalled();
});
