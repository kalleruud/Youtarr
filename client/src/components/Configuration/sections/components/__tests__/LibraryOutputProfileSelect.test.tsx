import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { LibraryOutputProfileSelect } from '../LibraryOutputProfileSelect';

describe('LibraryOutputProfileSelect', () => {
  it('shows the movie profile as the current value', () => {
    render(<LibraryOutputProfileSelect value="movie" onChange={() => {}} />);
    expect(screen.getByRole('button', { name: 'Movies / Other Videos (per-video folders)' })).toBeInTheDocument();
  });

  it('reports the Jellyfin TV profile when it is chosen', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<LibraryOutputProfileSelect value="movie" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: 'Movies / Other Videos (per-video folders)' }));
    await user.click(await screen.findByRole('option', { name: 'Jellyfin TV (channel = show, year = season)' }));
    expect(onChange).toHaveBeenCalledWith('jellyfinTv');
  });

  it('explains the TV folder layout and Jellyfin library setup when TV is selected', () => {
    render(<LibraryOutputProfileSelect value="jellyfinTv" onChange={() => {}} />);
    expect(screen.getByTestId('tv-profile-hint')).toHaveTextContent('Season 2026/Channel - S2026E001 - Title [video-id].mp4');
  });

  it('hides the TV hint for the movie profile', () => {
    render(<LibraryOutputProfileSelect value="movie" onChange={() => {}} />);
    expect(screen.queryByTestId('tv-profile-hint')).not.toBeInTheDocument();
  });
});
