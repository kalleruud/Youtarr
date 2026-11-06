import { captionMissingReasonLabel, captionSourceLabel, isMachineCaption } from '../captionLabels';

test('labels a locally generated track', () => {
  expect(captionSourceLabel('generated')).toBe('Generated locally');
});

test('an unknown source falls back to source unknown', () => {
  expect(captionSourceLabel('something')).toBe('Source unknown');
});

test('describes a translation-only language', () => {
  expect(captionMissingReasonLabel('translation-only')).toContain('machine translations');
});

test('uploaded captions are not machine-made', () => {
  expect(isMachineCaption('uploaded')).toBe(false);
});
