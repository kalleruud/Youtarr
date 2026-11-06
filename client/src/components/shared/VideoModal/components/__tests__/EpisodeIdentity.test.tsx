import React from 'react';
import { render, screen } from '@testing-library/react';
import axios from 'axios';
import EpisodeIdentity from '../EpisodeIdentity';

jest.mock('axios', () => ({ get: jest.fn() }));
const get = axios.get as jest.Mock;

test('shows a correction without changing the assigned episode', async () => {
  get.mockResolvedValue({ data: { status: 'date-correction-review', season: 2021, episode: 2, publishedAt: '2021-01-01', observedPublishedAt: '2022-01-01' } });
  render(<EpisodeIdentity youtubeId="abcdefghijk" token="token" />);
  expect(await screen.findByText(/review required before reassignment/)).toHaveTextContent('Season 2021, episode 2');
});

test('shows when a reliable date is missing', async () => {
  get.mockResolvedValue({ data: { status: 'date-required' } });
  render(<EpisodeIdentity youtubeId="abcdefghijk" token="token" />);
  expect(await screen.findByText(/awaiting a reliable publication date/)).toBeInTheDocument();
});
