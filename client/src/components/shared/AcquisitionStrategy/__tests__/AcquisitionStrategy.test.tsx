import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import AcquisitionStrategy from '..';
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
  render(<AcquisitionStrategy endpoint="/policy" token="token" />);
  expect(await screen.findByText('Streaming is unavailable. Choose download.')).toBeInTheDocument();
  expect(screen.getByLabelText('Uploads and Shorts')).toHaveClass('w-full');
  expect(screen.getByText('Delivery: Stream on demand (from global)')).toBeInTheDocument();
});
test('saves only future policy with revision protection', async () => {
  render(<AcquisitionStrategy endpoint="/policy" token="token" />);
  fireEvent.click(await screen.findByLabelText('Uploads and Shorts'));
  fireEvent.click(await screen.findByRole('option', { name: 'Stream on demand' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save strategy' }));
  await waitFor(() => expect(axios.put).toHaveBeenCalledWith('/policy', { delivery: 'stream', live: null, expectedRevision: 2 }, expect.any(Object)));
});
test('offers recovery after load failure', async () => {
  axios.get.mockRejectedValue(new Error('offline'));
  render(<AcquisitionStrategy endpoint="/policy" token="token" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Cannot load strategy');
  expect(screen.getByRole('button', { name: 'Reload strategy' })).toBeEnabled();
});
test('shows loading and aborts when closed', () => {
  axios.get.mockReturnValue(new Promise(() => {}));
  const { unmount } = render(<AcquisitionStrategy endpoint="/policy" token="token" />);
  expect(screen.getByLabelText('Loading strategy')).toBeInTheDocument();
  const signal = axios.get.mock.calls[0][1].signal;
  unmount();
  expect(signal.aborted).toBe(true);
});
test('explains stale save and retains the existing copy', async () => {
  axios.get.mockResolvedValue({ data: { ...policy, hasLocalCopy: true } });
  axios.put.mockRejectedValue({ response: { status: 409 } });
  render(<AcquisitionStrategy endpoint="/policy" token="token" />);
  fireEvent.click(await screen.findByRole('button', { name: 'Save strategy' }));
  expect(await screen.findByText('Strategy changed elsewhere. Reload before saving again.')).toBeInTheDocument();
  expect(screen.getByText('Downloaded copy retained. This is the same video and episode.')).toBeInTheDocument();
});
test('explains a temporarily unavailable service', async () => {
  axios.get.mockRejectedValue({ response: { status: 503 } });
  render(<AcquisitionStrategy endpoint="/policy" token="token" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('temporarily unavailable');
});
