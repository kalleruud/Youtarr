// Plain-language labels for caption provenance (issue #5), shared by the video
// modal's Captions section and the caption preference preview in Settings.

export type CaptionSource = 'uploaded' | 'automatic' | 'translated' | 'generated' | 'unknown';

export type CaptionMissingReason =
  | 'not-offered'
  | 'automatic-not-allowed'
  | 'translation-only'
  | 'not-downloaded'
  | 'awaiting-uploaded';

const SOURCE_LABELS: Record<CaptionSource, string> = {
  uploaded: 'Uploaded by creator',
  automatic: 'Auto-generated (YouTube)',
  translated: 'Machine-translated (YouTube)',
  generated: 'Generated locally',
  unknown: 'Source unknown',
};

const MISSING_REASON_LABELS: Record<CaptionMissingReason, string> = {
  'not-offered': 'YouTube offers no captions in this language',
  'automatic-not-allowed': 'Only automatic captions exist; the caption source setting allows uploaded captions only',
  'translation-only': 'Only machine translations exist; machine translations are not allowed',
  'not-downloaded': 'YouTube listed captions, but they were not downloaded',
  'awaiting-uploaded': 'Waiting for uploaded captions; automatic captions are in use',
};

export function captionSourceLabel(source: string): string {
  return SOURCE_LABELS[source as CaptionSource] ?? SOURCE_LABELS.unknown;
}

export function captionMissingReasonLabel(reason: string): string {
  return MISSING_REASON_LABELS[reason as CaptionMissingReason] ?? 'Captions are unavailable';
}

/** Generated, translated and automatic tracks are machine-made and labeled as such. */
export function isMachineCaption(source: string): boolean {
  return source === 'automatic' || source === 'translated' || source === 'generated';
}
