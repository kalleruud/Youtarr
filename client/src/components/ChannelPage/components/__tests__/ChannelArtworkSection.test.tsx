import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import ChannelArtworkSection from '../ChannelArtworkSection';
import { renderWithProviders } from '../../../../test-utils';
import type { ChannelArtworkStatus } from '../../hooks/useChannelArtwork';

const mockHook = {
  data: null as ChannelArtworkStatus | null,
  loading: false,
  error: null as string | null,
  pending: null,
  upload: jest.fn(),
  select: jest.fn(),
  setPinned: jest.fn(),
  reset: jest.fn(),
  regenerate: jest.fn(),
  retryRefresh: jest.fn(),
};

jest.mock('../../hooks/useChannelArtwork', () => ({
  useChannelArtwork: () => mockHook,
}));

const baseStatus: ChannelArtworkStatus = {
  enabled: true,
  source: 'auto',
  protected: false,
  origin: 'generated',
  width: 1000,
  height: 1500,
  revision: 2,
  manualAvailable: false,
  posterUrl: '/images/channelposter-UC1.jpg?rev=2',
  publishedAt: null,
  publishNote: null,
  refresh: null,
};

const renderSection = (data: Partial<ChannelArtworkStatus> = {}, extra: Partial<typeof mockHook> = {}) => {
  Object.assign(mockHook, { data: { ...baseStatus, ...data }, error: null, loading: false }, extra);
  return renderWithProviders(<ChannelArtworkSection channelId="UC1" token="tok" />);
};

beforeEach(() => jest.clearAllMocks());

describe('ChannelArtworkSection', () => {
  test('shows the poster preview', () => {
    renderSection();
    expect(screen.getByAltText('Show poster preview')).toHaveAttribute('src', '/images/channelposter-UC1.jpg?rev=2');
  });

  test('describes where the poster came from', () => {
    renderSection();
    expect(screen.getByText('Generated from avatar and title')).toBeInTheDocument();
  });

  test('explains that publication is off', () => {
    renderSection({ enabled: false });
    expect(screen.getByText(/Portrait show posters are off/)).toBeInTheDocument();
  });

  test('disables selecting an upload that does not exist', () => {
    renderSection();
    expect(screen.getByRole('button', { name: 'Use uploaded poster' })).toBeDisabled();
  });

  test('uploads the chosen file', async () => {
    renderSection();
    const file = new File(['img'], 'poster.png', { type: 'image/png' });
    await userEvent.upload(screen.getByLabelText('Poster image file'), file);
    expect(mockHook.upload).toHaveBeenCalledWith(file);
  });

  test('pins the poster', async () => {
    renderSection();
    await userEvent.click(screen.getByRole('checkbox', { name: /Pin this poster/ }));
    expect(mockHook.setPinned).toHaveBeenCalledWith(true);
  });

  test('regenerates on request', async () => {
    renderSection();
    await userEvent.click(screen.getByRole('button', { name: 'Regenerate & republish' }));
    expect(mockHook.regenerate).toHaveBeenCalled();
  });

  test('shows a failed Jellyfin refresh with a retry button', async () => {
    renderSection({ refresh: { status: 'failed', message: 'Jellyfin artwork refresh failed: timeout', attemptedAt: null } });
    await userEvent.click(screen.getByRole('button', { name: 'Retry Jellyfin refresh' }));
    expect(mockHook.retryRefresh).toHaveBeenCalled();
  });

  test('offers no retry after a successful refresh', () => {
    renderSection({ refresh: { status: 'refreshed', message: 'ok', attemptedAt: null } });
    expect(screen.queryByRole('button', { name: 'Retry Jellyfin refresh' })).not.toBeInTheDocument();
  });

  test('shows the folder publication note', () => {
    renderSection({ publishNote: 'The channel folder has a poster.jpg that Youtarr did not write; it was kept.' });
    expect(screen.getByText(/did not write/)).toBeInTheDocument();
  });

  test('reports episode thumbnail counts after regeneration', () => {
    renderSection({ episodes: { written: 3, existing: 1, missing: 0, failed: 0 } });
    expect(screen.getByText(/3 written, 1 already present/)).toBeInTheDocument();
  });

  test('shows errors from the hook', () => {
    renderSection({}, { error: 'The poster must be portrait.' });
    expect(screen.getByText('The poster must be portrait.')).toBeInTheDocument();
  });
});
