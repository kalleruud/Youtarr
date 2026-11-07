import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AcquisitionStrategy from '..';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
const Strategy = (props: React.ComponentProps<typeof AcquisitionStrategy>) => <MemoryRouter><AcquisitionStrategy {...props} /></MemoryRouter>;
jest.mock('axios', () => ({ get: jest.fn(), put: jest.fn(), isAxiosError: jest.fn(() => true) }));
const axios = require('axios');
const policy = {
  explicit: { delivery: null, live: null }, revision: 2, note: 'Existing downloads are kept.',
  decisions: [{ contentKind: 'video', sourceState: 'available',
    effectivePolicy: { delivery: 'stream', live: 'replay', sources: { delivery: 'global', live: 'default' } },
    plannedActions: [], reasons: [{ code: 'capability_unavailable', message: 'Streaming is unavailable. Choose download.' }] }],
};
beforeEach(() => { jest.clearAllMocks(); axios.isAxiosError.mockReturnValue(true); axios.get.mockResolvedValue({ data: policy }); axios.put.mockResolvedValue({ data: policy }); });
test('shows inherited decisions and unavailable reasons in a responsive control', async () => {
  render(<Strategy endpoint="/policy" token="token" />);
  expect(await screen.findByText('Streaming is unavailable. Choose download.')).toBeInTheDocument();
  expect(screen.getByLabelText('Uploads and Shorts')).toHaveClass('w-full');
  expect(screen.getByText('Delivery: Stream on demand (from Global default)')).toBeInTheDocument();
});
test('saves only future policy with revision protection', async () => {
  render(<Strategy endpoint="/policy" token="token" />);
  fireEvent.click(await screen.findByLabelText('Uploads and Shorts'));
  fireEvent.click(await screen.findByRole('option', { name: 'Stream on demand' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save strategy' }));
  await waitFor(() => expect(axios.put).toHaveBeenCalledWith('/policy', { delivery: 'stream', live: null, expectedRevision: 2 }, expect.any(Object)));
});
test('offers recovery after load failure', async () => {
  axios.get.mockRejectedValue(new Error('offline'));
  render(<Strategy endpoint="/policy" token="token" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Cannot load strategy');
  expect(screen.getByRole('button', { name: 'Reload strategy' })).toBeEnabled();
});
test('shows loading and aborts when closed', () => {
  axios.get.mockReturnValue(new Promise(() => {}));
  const { unmount } = render(<Strategy endpoint="/policy" token="token" />);
  expect(screen.getByLabelText('Loading strategy')).toBeInTheDocument();
  const signal = axios.get.mock.calls[0][1].signal;
  unmount();
  expect(signal.aborted).toBe(true);
});
test('explains stale save and retains the existing copy', async () => {
  axios.get.mockResolvedValue({ data: { ...policy, hasLocalCopy: true } });
  axios.put.mockRejectedValue({ response: { status: 409, data: { code: 'revision-conflict', error: 'Strategy changed elsewhere.' } } });
  render(<Strategy endpoint="/policy" token="token" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Save strategy' }));
  expect(await screen.findByText('Strategy changed elsewhere. Reload before saving again.')).toBeInTheDocument();
  expect(screen.getByText('Downloaded copy retained. This is the same video and episode.')).toBeInTheDocument();
});
test('explains a temporarily unavailable service', async () => {
  axios.get.mockRejectedValue({ response: { status: 503 } });
  render(<Strategy endpoint="/policy" token="token" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');
});

test('untracked search videos explain availability without an error', async () => {
  axios.get.mockRejectedValue({ response: { status: 404 } });
  render(<Strategy endpoint="/api/videos/search-id/acquisition-policy" token="token" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Manual download still works');
  expect(screen.queryByLabelText('Loading strategy')).not.toBeInTheDocument();
});
test.each([[409, 'override-limit', 'Maximum 2000 overrides reached.'], [400, 'invalid-policy', 'Choose a valid delivery strategy.']])('preserves actionable server error %s', async (status, code, error) => {
  axios.put.mockRejectedValue({ response: { status, data: { code, error } } });
  render(<Strategy endpoint="/policy" token="token" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Save strategy' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(error);
  expect(screen.getByRole('alert')).not.toHaveTextContent('Reload before');
});
test('both live capability reasons survive a reload without key warnings', async () => {
  const error = jest.spyOn(console, 'error').mockImplementation(() => {});
  const data = { ...policy, decisions: [{ ...policy.decisions[0], contentKind: 'live', sourceState: 'live',
    reasons: [{ code: 'capability_unavailable', action: 'livePlayback', message: 'Playback unavailable' },
      { code: 'capability_unavailable', action: 'liveRecording', message: 'Recording unavailable' }] }] };
  axios.get.mockResolvedValue({ data });
  render(<Strategy endpoint="/policy" token="token" />);
  expect(await screen.findByText('Playback unavailable')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Reload strategy' }));
  expect(await screen.findByText('Recording unavailable')).toBeInTheDocument();
  expect(screen.getByText('Playback unavailable')).toBeInTheDocument();
  expect(error).not.toHaveBeenCalled();
  error.mockRestore();
});
test('unknown policy values have a useful explanation', async () => {
  axios.get.mockResolvedValue({ data: { ...policy, decisions: [{ ...policy.decisions[0], effectivePolicy: {
    delivery: null, live: 'replay', sources: { delivery: 'video', live: 'default' } } }] } });
  render(<Strategy endpoint="/policy" token="token" />);
  expect(await screen.findByText(/Delivery: Unknown strategy; review the explanation below/)).toBeInTheDocument();
});

test('strategy controls support keyboard selection with accessible names', async () => {
  const user = userEvent.setup();
  render(<Strategy endpoint="/api/acquisition-policy" token="token" />);
  const delivery = await screen.findByLabelText('Uploads and Shorts');
  delivery.focus();
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('option', { name: 'Inherit built-in default' })).toBeInTheDocument();
  await user.keyboard('{Escape}');
  expect(delivery).toHaveFocus();
});
test.each([['video', 'available', 'New upload'], ['short', 'available', 'Short'],
  ['livestream', 'upcoming', 'Scheduled broadcast'], ['livestream', 'live', 'While live'],
  ['livestream', 'replay', 'Replay']])('labels scenario %s %s', async (contentKind, sourceState, label) => {
  axios.get.mockResolvedValue({ data: { ...policy, decisions: [{ ...policy.decisions[0], contentKind, sourceState }] } });
  render(<Strategy endpoint="/policy" token="token" />);
  expect(await screen.findByText(label)).toBeInTheDocument();
});
