import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { SubtitleRepairPanel } from '../SubtitleRepairPanel';
jest.mock('axios', () => ({ get: jest.fn(), post: jest.fn(), isAxiosError: jest.fn() }));
const axios = require('axios');
beforeEach(() => {
  jest.clearAllMocks();
  axios.get.mockResolvedValue({ data: [] });
  axios.post.mockResolvedValue({ data: {} });
});
test('requires preview and sends explicit provenance confirmation', async () => {
  render(<SubtitleRepairPanel token="test" videoId={12} />);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Preview subtitle repair' }));
  await waitFor(() => expect(axios.post).toHaveBeenCalledWith('/api/subtitle-repairs/preview', { videoIds: [12], automaticFinal: true }, expect.anything()));
});
test('reports load failures', async () => {
  axios.get.mockRejectedValue(new Error('offline'));
  render(<SubtitleRepairPanel token="test" />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load subtitle repairs');
});
test('displays examples and offers apply only for preview', async () => {
  axios.get.mockResolvedValue({ data: [{ id: 'preview', status: 'preview', warnings: ['Verify timing'], items: [{ videoId: 12, status: 'pending', changed: 1, examples: { before: 'rolling', after: 'readable' } }] }] });
  render(<SubtitleRepairPanel token="test" />);
  expect(await screen.findByText('Verify timing')).toBeInTheDocument();
  expect(screen.getByText('Before: rolling')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Apply reviewed preview' })).toBeInTheDocument();
});
