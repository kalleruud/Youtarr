export type DownloadPauseReasonType = 'usage' | 'freeSpace' | 'tempFreeSpace';

export interface DownloadPauseReason {
  type: DownloadPauseReasonType;
  currentBytes: number;
  limitBytes: number;
  /** Server-written description, e.g. "downloaded videos use 512.0 GB, over the 500 GB limit" */
  text: string;
  /** Server-written instruction for bringing downloads back (older servers omit it). */
  resumeHint?: string;
}

/** Shape of GET /api/jobs/download-pause and the downloadPauseChanged broadcast. */
export interface DownloadPauseStatus {
  paused: boolean;
  pausedSince: string | null;
  reasons: DownloadPauseReason[];
  usage: {
    limit: string | null;
    limitBytes: number | null;
    downloadedBytes: number | null;
  };
  freeSpace: {
    limit: string | null;
    limitBytes: number | null;
    availableBytes: number | null;
  };
  /** Free space in the temporary download folder (older servers omit it). */
  tempFreeSpace?: {
    limit: string | null;
    limitBytes: number | null;
    availableBytes: number | null;
  };
  checkedAt: string | null;
}
