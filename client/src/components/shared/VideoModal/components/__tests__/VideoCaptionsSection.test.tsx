import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import VideoCaptionsSection from '../VideoCaptionsSection';

jest.mock('axios', () => ({
  get: jest.fn(),
  put: jest.fn(),
  post: jest.fn(),
  isAxiosError: jest.fn(() => false),
  isCancel: jest.fn(() => false),
}));
const get = axios.get as jest.Mock;
const put = axios.put as jest.Mock;
const post = axios.post as jest.Mock;

const ID = 'abcdefghijk';

function summary(overrides = {}) {
  return {
    youtubeId: ID,
    subtitlesEnabled: true,
    enrichmentEnabled: true,
    mediaAvailable: true,
    tracks: [{ code: 'en', language: 'en', source: 'automatic', origin: 'download', protected: false, normalizerVersion: 2, retrievedAt: null, mediaRevisionCurrent: true }],
    missing: [],
    upgrades: [],
    unsupported: [],
    enrichment: null,
    ...overrides,
  };
}

beforeEach(() => jest.clearAllMocks());

test('labels an automatic track as auto-generated', async () => {
  get.mockResolvedValue({ data: summary() });
  render(<VideoCaptionsSection youtubeId={ID} token="token" />);
  expect(await screen.findByText('Auto-generated (YouTube)')).toBeInTheDocument();
});

test('shows a pending language with its reason', async () => {
  get.mockResolvedValue({ data: summary({ missing: [{ language: 'nb', reason: 'not-offered', state: 'pending' }] }) });
  render(<VideoCaptionsSection youtubeId={ID} token="token" />);
  expect(await screen.findByText('YouTube offers no captions in this language')).toBeInTheDocument();
});

test('shows the actionable reason when checks stopped', async () => {
  get.mockResolvedValue({ data: summary({
    missing: [{ language: 'nb', reason: 'not-offered', state: 'exhausted' }],
    enrichment: { status: 'exhausted', attempts: 3, maxAttempts: 3, nextAttemptAt: null, lastAttemptAt: null, reason: 'Stopped after 3 checks: use "Check again".', languages: ['nb'] },
  }) });
  render(<VideoCaptionsSection youtubeId={ID} token="token" />);
  expect(await screen.findByText('Stopped after 3 checks: use "Check again".')).toBeInTheDocument();
});

test('check again schedules a check', async () => {
  get.mockResolvedValue({ data: summary({ missing: [{ language: 'nb', reason: 'not-offered', state: 'exhausted' }] }) });
  post.mockResolvedValue({ data: {} });
  render(<VideoCaptionsSection youtubeId={ID} token="token" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Check again' }));
  expect(post).toHaveBeenCalledWith(`/api/videos/${ID}/captions/check`, {}, { headers: { 'x-access-token': 'token' } });
});

test('protecting a track saves the protection', async () => {
  get.mockResolvedValue({ data: summary() });
  put.mockResolvedValue({ data: {} });
  render(<VideoCaptionsSection youtubeId={ID} token="token" />);
  await userEvent.click(await screen.findByRole('button', { name: 'Protect en captions' }));
  await waitFor(() => expect(put).toHaveBeenCalledWith(`/api/videos/${ID}/captions/en/protection`, { protected: true }, { headers: { 'x-access-token': 'token' } }));
});

test('renders nothing without a downloaded video', () => {
  render(<VideoCaptionsSection youtubeId="" token="token" />);
  expect(get).not.toHaveBeenCalled();
});
