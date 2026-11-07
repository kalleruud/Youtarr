import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axios from 'axios';
import { CaptionPreferences } from '../CaptionPreferences';
import { DEFAULT_CONFIG } from '../../../../../config/configSchema';
import { ConfigState } from '../../../types';

jest.mock('axios', () => ({ post: jest.fn(), isAxiosError: jest.fn(() => false) }));
const post = axios.post as jest.Mock;

const config = { ...DEFAULT_CONFIG, subtitlesEnabled: true, subtitleLanguage: 'en,nb' } as ConfigState;

beforeEach(() => jest.clearAllMocks());

test('previews the unsaved caption preferences', async () => {
  post.mockResolvedValue({ data: { totals: { videosChecked: 4, videosChanged: 1, newlyMissing: 1, newlyCovered: 0, upgrades: 0 }, examples: [], limit: 200 } });
  render(<CaptionPreferences config={{ ...config, captionSourcePolicy: 'uploaded-only' }} onConfigChange={jest.fn()} token="token" />);
  await userEvent.click(screen.getByRole('button', { name: 'Preview caption changes' }));
  expect(post).toHaveBeenCalledWith('/api/captions/preview', {
    subtitleLanguage: 'en,nb', captionSourcePolicy: 'uploaded-only', captionAllowTranslated: false, captionPreferredVariants: '',
  }, { headers: { 'x-access-token': 'token' } });
});

test('shows the preview totals', async () => {
  post.mockResolvedValue({ data: { totals: { videosChecked: 4, videosChanged: 1, newlyMissing: 1, newlyCovered: 0, upgrades: 0 }, examples: [], limit: 200 } });
  render(<CaptionPreferences config={config} onConfigChange={jest.fn()} token="token" />);
  await userEvent.click(screen.getByRole('button', { name: 'Preview caption changes' }));
  expect(await screen.findByText(/1 of 4 recent downloads would change/)).toBeInTheDocument();
});

test('turning on delayed checks updates the config', async () => {
  const onConfigChange = jest.fn();
  render(<CaptionPreferences config={config} onConfigChange={onConfigChange} token="token" />);
  await userEvent.click(screen.getByRole('checkbox', { name: /Check again for captions/ }));
  expect(onConfigChange).toHaveBeenCalledWith({ captionEnrichmentEnabled: true });
});

test('the schedule fields appear only while delayed checks are on', () => {
  render(<CaptionPreferences config={{ ...config, captionEnrichmentEnabled: true }} onConfigChange={jest.fn()} token="token" />);
  expect(screen.getByLabelText('Check Schedule')).toHaveValue('1h,24h,7d');
});

test('a preview error is shown', async () => {
  post.mockRejectedValue(new Error('boom'));
  render(<CaptionPreferences config={config} onConfigChange={jest.fn()} token="token" />);
  await userEvent.click(screen.getByRole('button', { name: 'Preview caption changes' }));
  expect(await screen.findByText('Could not preview caption preferences')).toBeInTheDocument();
});
