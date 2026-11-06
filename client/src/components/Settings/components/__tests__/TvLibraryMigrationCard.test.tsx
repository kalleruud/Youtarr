import React from 'react';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../../../test-utils';
import { TvLibraryMigrationCard } from '../TvLibraryMigrationCard';
import type { MigrationPlan, UseTvLibraryMigrationReturn } from '../../hooks/useTvLibraryMigration';

jest.mock('../../hooks/useTvLibraryMigration', () => ({
  ...jest.requireActual('../../hooks/useTvLibraryMigration'),
  useTvLibraryMigration: jest.fn(),
}));

const { useTvLibraryMigration } = require('../../hooks/useTvLibraryMigration') as { useTvLibraryMigration: jest.Mock };

function makePlan(overrides: Partial<MigrationPlan> = {}): MigrationPlan {
  return {
    planId: '20261106T120000Z-0123abcd',
    createdAt: '2026-11-06T12:00:00.000Z',
    status: 'planned',
    error: null,
    interruptedFrom: null,
    running: false,
    options: { verifyChecksums: true },
    summary: { toMove: 1, skipped: 1, alreadyMigrated: 0, channels: 1, shows: ['/lib/Show [UC1]'], bytes: 2048, copyBytes: 0 },
    items: [{
      youtubeId: 'vid', channelId: 'UC1', title: 'First', season: 2025, episode: 1,
      media: { source: '/lib/Show/First [vid].mp4', target: '/lib/Show [UC1]/Season 2025/Show - S2025E001 - First [vid].mp4' },
      files: [{ source: '/lib/Show/First [vid].en.srt', target: '/x.en.srt' }],
      leftovers: [{ name: 'First [vid].nfo', source: '/lib/Show/First [vid].nfo' }],
      kept: [],
      state: { status: 'pending' },
    }],
    skipped: [{ youtubeId: 'nodate', title: 'Undated', filePath: '/lib/x.mp4', code: 'date-required', message: 'The publication date is unknown.' }],
    blockers: [],
    warnings: [],
    progress: { pending: 1 },
    mediaServers: {
      jellyfin: { configured: true, supported: ['played flag', 'resume position'], unsupported: ['favorites are not carried over'] },
      notes: [],
      youtarrData: 'Youtarr records are kept.',
    },
    followUps: [],
    userState: null,
    userStateSkipped: null,
    restore: null,
    ...overrides,
  };
}

function setup(state: Partial<UseTvLibraryMigrationReturn> = {}) {
  const hook: UseTvLibraryMigrationReturn = {
    plan: null, loading: false, error: null, actionPending: false, actionError: null,
    preview: jest.fn(), apply: jest.fn(), resume: jest.fn(), rollback: jest.fn(), restoreUserState: jest.fn(),
    ...state,
  };
  useTvLibraryMigration.mockReturnValue(hook);
  renderWithProviders(<TvLibraryMigrationCard token="tok" />);
  return hook;
}

describe('TvLibraryMigrationCard', () => {
  test('previews with checksum verification on by default', async () => {
    const hook = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Preview migration' }));
    expect(hook.preview).toHaveBeenCalledWith({ verifyChecksums: true });
  });

  test('explains why a video cannot move', () => {
    setup({ plan: makePlan() });
    expect(screen.getByText(/The publication date is unknown/)).toBeInTheDocument();
  });

  test('says which Jellyfin state is not preserved', () => {
    setup({ plan: makePlan() });
    expect(screen.getByText('Not preserved: favorites are not carried over.')).toBeInTheDocument();
  });

  test('applies only after the backup acknowledgement', async () => {
    const hook = setup({ plan: makePlan() });
    await userEvent.click(screen.getByRole('button', { name: 'Apply migration' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'I have a backup of my config folder and database' }));
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(hook.apply).toHaveBeenCalledWith({ acceptUserStateLoss: false });
  });

  test('cannot apply a plan with blockers', () => {
    setup({ plan: makePlan({ blockers: [{ code: 'insufficient-space', message: 'Not enough space.' }] }) });
    expect(screen.getByRole('button', { name: 'Apply migration' })).toBeDisabled();
  });

  test('offers resume and roll back for an interrupted migration', () => {
    setup({ plan: makePlan({ status: 'interrupted', interruptedFrom: 'applying', error: 'Stopped at vid: target exists' }) });
    expect([screen.getByRole('button', { name: 'Resume' }), screen.getByRole('button', { name: 'Roll back' })]).toHaveLength(2);
  });

  test('offers only roll back when a rollback was interrupted', () => {
    setup({ plan: makePlan({ status: 'interrupted', interruptedFrom: 'rolling-back', error: 'Rollback stopped' }) });
    expect(screen.queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
  });

  test('offers to continue without Jellyfin state when the snapshot failed', async () => {
    const hook = setup({ plan: makePlan(), actionError: { message: 'Could not read Jellyfin', code: 'snapshot-failed' } });
    await userEvent.click(screen.getByRole('button', { name: 'Apply without Jellyfin viewing state' }));
    expect(hook.apply).toHaveBeenCalledWith({ acceptUserStateLoss: true });
  });

  const applied = () => makePlan({
    status: 'applied', userState: { takenAt: 'x', counts: { videosWithState: 1, userEntries: 1, playlists: 0 } },
  });

  test('lists the manual Jellyfin steps after applying', () => {
    setup({ plan: applied() });
    expect(screen.getByText(/Add a Shows library on the same folder/)).toBeInTheDocument();
  });

  test('restores viewing state after applying', async () => {
    const hook = setup({ plan: applied() });
    await userEvent.click(screen.getByRole('button', { name: 'Restore Jellyfin viewing state' }));
    expect(hook.restoreUserState).toHaveBeenCalled();
  });

  test('reports episodes Jellyfin has not found yet', () => {
    setup({
      plan: makePlan({
        status: 'applied',
        restore: { status: 'partial', report: { restored: 2, pending: ['vid'], failed: [], playlistsUpdated: 0, playlistsPending: 0 } },
      }),
    });
    expect(screen.getByText(/1 episode\(s\) not found in Jellyfin yet/)).toBeInTheDocument();
  });
});
