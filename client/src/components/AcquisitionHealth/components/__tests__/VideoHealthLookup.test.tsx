import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VideoHealthLookup, parseVideoId } from '../VideoHealthLookup';
import { outcome } from '../../__tests__/fixtures';

const video = {
  youtubeId: 'abcdefghijk',
  title: 'A video',
  explanation: {
    state: 'attention' as const,
    category: 'policy-excluded' as const,
    categoryLabel: 'Excluded by policy or settings',
    headline: 'The downloaded caption was published unchanged, so rolling captions may repeat lines.',
    nextStep: 'Turn on accurate cuts.',
  },
  outcomes: [outcome()],
};

describe('parseVideoId', () => {
  test.each([
    ['abcdefghijk', 'abcdefghijk'],
    ['https://www.youtube.com/watch?v=abcdefghijk&t=1', 'abcdefghijk'],
    ['https://youtu.be/abcdefghijk', 'abcdefghijk'],
    ['https://www.youtube.com/shorts/abcdefghijk', 'abcdefghijk'],
    ['not a video', null],
  ])('%s -> %s', (input, expected) => {
    expect(parseVideoId(input)).toBe(expected);
  });
});

describe('VideoHealthLookup', () => {
  const renderLookup = (explain = jest.fn().mockResolvedValue(video), onRetry = jest.fn().mockResolvedValue(true)) => {
    render(<VideoHealthLookup explain={explain} onRetry={onRetry} retryPendingKey={null} />);
    return { explain, onRetry };
  };

  test('explains a video from its URL', async () => {
    const { explain } = renderLookup();
    await userEvent.type(screen.getByLabelText('Video URL or id'), 'https://youtu.be/abcdefghijk');
    await userEvent.click(screen.getByRole('button', { name: 'Explain' }));
    expect(explain).toHaveBeenCalledWith('abcdefghijk');
    expect(await screen.findByText(/rolling captions may repeat lines/)).toBeInTheDocument();
  });

  test('rejects input that is not a video', async () => {
    const { explain } = renderLookup();
    await userEvent.type(screen.getByLabelText('Video URL or id'), 'hello');
    await userEvent.click(screen.getByRole('button', { name: 'Explain' }));
    expect(screen.getByText(/11-character id/)).toBeInTheDocument();
    expect(explain).not.toHaveBeenCalled();
  });

  test('shows a lookup error from the server', async () => {
    renderLookup(jest.fn().mockRejectedValue({ response: { status: 400, data: { error: 'Invalid YouTube ID' } } }));
    await userEvent.type(screen.getByLabelText('Video URL or id'), 'abcdefghijk');
    await userEvent.click(screen.getByRole('button', { name: 'Explain' }));
    expect(await screen.findByText('Invalid YouTube ID')).toBeInTheDocument();
  });

  test('retrying a step refreshes the explanation', async () => {
    const { explain, onRetry } = renderLookup();
    await userEvent.type(screen.getByLabelText('Video URL or id'), 'abcdefghijk');
    await userEvent.click(screen.getByRole('button', { name: 'Explain' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Retry jellyfin listing' }));
    expect([onRetry.mock.calls.length, explain.mock.calls.length]).toEqual([1, 2]);
  });
});
