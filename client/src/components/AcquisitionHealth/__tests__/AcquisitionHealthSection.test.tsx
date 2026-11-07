import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { summary, outcome } from './fixtures';

jest.mock('../hooks/useAcquisitionHealth', () => ({
  ...jest.requireActual('../hooks/useAcquisitionHealth'),
  useAcquisitionHealth: jest.fn(),
}));

const { useAcquisitionHealth } = require('../hooks/useAcquisitionHealth');
const { AcquisitionHealthSection } = require('..');

const hookValue = (overrides = {}) => ({
  summary: summary(),
  loading: false,
  error: null,
  refetch: jest.fn(),
  retry: jest.fn().mockResolvedValue(true),
  retryPendingKey: null,
  retryError: null,
  explain: jest.fn(),
  ...overrides,
});

const renderSection = () => render(
  <MemoryRouter>
    <AcquisitionHealthSection token="tok" />
  </MemoryRouter>
);

describe('AcquisitionHealthSection', () => {
  test('shows a loading state', () => {
    useAcquisitionHealth.mockReturnValue(hookValue({ loading: true, summary: null }));
    renderSection();
    expect(screen.getByRole('status')).toHaveTextContent('Loading acquisition health');
  });

  test('shows a load error', () => {
    useAcquisitionHealth.mockReturnValue(hookValue({ summary: null, error: 'Failed to read acquisition health' }));
    renderSection();
    expect(screen.getByText('Failed to read acquisition health')).toBeInTheDocument();
  });

  test('lists unresolved steps with their category', () => {
    useAcquisitionHealth.mockReturnValue(hookValue());
    renderSection();
    const item = screen.getByTestId('health-outcome');
    expect(within(item).getByText('Library scan pending')).toBeInTheDocument();
  });

  test('retrying a step sends its revision', async () => {
    const value = hookValue();
    useAcquisitionHealth.mockReturnValue(value);
    renderSection();
    await userEvent.click(screen.getByRole('button', { name: 'Retry jellyfin listing' }));
    expect(value.retry).toHaveBeenCalledWith({ youtubeId: 'abcdefghijk', stage: 'library', revision: 3 });
  });

  test('steps that cannot be retried on their own have no retry button', () => {
    useAcquisitionHealth.mockReturnValue(hookValue({
      summary: summary({ recent: [outcome({ stage: 'captions', status: 'warning', category: 'policy-excluded', categoryLabel: 'Excluded', retryable: false })] }),
    }));
    renderSection();
    expect(screen.queryByRole('button', { name: /Retry/ })).not.toBeInTheDocument();
  });

  test('shows a refused retry reason', () => {
    useAcquisitionHealth.mockReturnValue(hookValue({ retryError: 'A retry was already requested.' }));
    renderSection();
    expect(screen.getByText('A retry was already requested.')).toBeInTheDocument();
  });

  test('names stale channels', () => {
    useAcquisitionHealth.mockReturnValue(hookValue());
    renderSection();
    expect(within(screen.getByRole('list', { name: 'Stale channels' })).getByText(/Old Channel: never checked/)).toBeInTheDocument();
  });

  test('says live capture is not tracked yet', () => {
    useAcquisitionHealth.mockReturnValue(hookValue());
    renderSection();
    expect(screen.getByText(/once live recording is available/)).toBeInTheDocument();
  });

  test('a paused download explains how to resume', () => {
    useAcquisitionHealth.mockReturnValue(hookValue({
      summary: summary({
        storage: {
          ...summary().storage,
          paused: true,
          reasons: [{ type: 'tempFreeSpace', currentBytes: 1, limitBytes: 2, text: 'only 1 GB is free in the temporary download folder', resumeHint: 'Free up at least 4.0 GB.' }],
        },
      }),
    }));
    renderSection();
    expect(screen.getByTestId('download-pause-alert')).toHaveTextContent('To resume: Free up at least 4.0 GB.');
  });
});
