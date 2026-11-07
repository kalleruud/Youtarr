import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DownloadAllVideosDialog from '../DownloadAllVideosDialog';
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), isAxiosError: jest.fn(() => true) }));
const axios = require('axios');
jest.mock('../../DownloadManager/ManualDownload/DownloadSettingsDialog', () => ({
  __esModule: true,
  default: ({ open, onConfirm }: { open: boolean; onConfirm: (settings: null) => void }) =>
    open ? require('react').createElement('button', { onClick: () => onConfirm(null) }, 'Confirm download') : null,
}));
test('stale confirmation requires a new preview and confirms its version', async () => {
  axios.isAxiosError.mockReturnValue(true);
  const user = userEvent.setup();
  const preview = { count: 2, totalDurationSeconds: 60, missingDurations: 0, selectionVersion: 'old' };
  axios.get.mockResolvedValueOnce({ data: preview });
  axios.post.mockRejectedValueOnce({ response: { status: 409, data: { error: 'Preview is stale. Refresh preview.' } } })
    .mockResolvedValueOnce({ data: { queued: 2 } });
  const onStarted = jest.fn();
  render(<DownloadAllVideosDialog open onClose={jest.fn()} channelId="UC1" token="token" tabType="videos"
    tabLabel="Videos" defaultResolution="1080" defaultResolutionSource="global"
    runMetadataFetch={jest.fn().mockResolvedValue(true)} onStarted={onStarted} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Confirm download' }));
  expect(await screen.findByText('Preview is stale. Refresh preview.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  let resolvePreview!: (value: unknown) => void;
  axios.get.mockReturnValueOnce(new Promise(resolve => { resolvePreview = resolve; }));
  await user.click(screen.getByRole('button', { name: 'Refresh preview' }));
  expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
  expect(screen.getByRole('progressbar')).toBeInTheDocument();
  resolvePreview({ data: { ...preview, selectionVersion: 'fresh' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled());
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  await user.click(screen.getByRole('button', { name: 'Confirm download' }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(2));
  expect(axios.post).toHaveBeenLastCalledWith('/api/channels/UC1/download-all',
    expect.objectContaining({ selectionVersion: 'fresh' }), expect.any(Object));
});
