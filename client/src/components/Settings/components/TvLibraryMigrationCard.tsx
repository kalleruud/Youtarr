import React, { useState } from 'react';
import {
  Alert,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Typography,
} from '../../ui';
import { Checkbox, FormControlLabel } from '../../ui/form';
import { ConfigurationCard } from '../../Configuration/common/ConfigurationCard';
import { isBusy, MigrationPlan, useTvLibraryMigration } from '../hooks/useTvLibraryMigration';
import MigrationPlanDetails from './MigrationPlanDetails';

type Confirming = 'apply' | 'rollback' | null;

const STATUS_TEXT: Record<MigrationPlan['status'], string> = {
  planned: 'Previewed. Nothing has moved yet.',
  applying: 'Moving files. Downloads, cleanup and rescans are paused.',
  applied: 'Applied.',
  interrupted: 'Interrupted. Downloads, cleanup and rescans stay paused until you resume or roll back.',
  'rolling-back': 'Rolling back. Downloads, cleanup and rescans are paused.',
  'rolled-back': 'Rolled back. Every moved file is back where it was.',
};

function NextSteps({ plan }: { plan: MigrationPlan }) {
  return (
    <Alert severity="info">
      <div className="flex flex-col gap-1">
        <span className="font-medium">Next steps in Jellyfin (by hand):</span>
        <span>1. Remove the Movies or Home Videos library that scans the Youtarr folder. Never keep both library types on the same folder.</span>
        <span>2. Add a Shows library on the same folder (NFO reader on, NFO saver off), and let it scan.</span>
        <span>3. Come back here and restore viewing state. Repeat it if some episodes were not found yet.</span>
        <span>4. If you set Jellyfin Video Library IDs in Youtarr, replace them with the new library&apos;s ID.</span>
        {plan.followUps.map((note) => <span key={note}>{note}</span>)}
      </div>
    </Alert>
  );
}

function RestoreStatus({ plan }: { plan: MigrationPlan }) {
  const { restore } = plan;
  if (!restore) return null;
  if (restore.status === 'running') return <Typography variant="body2">Restoring viewing state...</Typography>;
  if (restore.status === 'error') return <Alert severity="warning">Restore failed: {restore.error}</Alert>;
  const report = restore.report;
  if (!report) return null;
  return (
    <Alert severity={restore.status === 'complete' ? 'success' : 'warning'}>
      Restored {report.restored} watch states; updated {report.playlistsUpdated} playlists.
      {report.pending.length > 0 && ` ${report.pending.length} episode(s) not found in Jellyfin yet; restore again after the scan.`}
      {report.failed.length > 0 && ` ${report.failed.length} write(s) failed; see the server log.`}
    </Alert>
  );
}

/** Settings > Maintenance: move existing downloads into the Jellyfin TV layout. */
export function TvLibraryMigrationCard({ token }: { token: string | null }) {
  const migration = useTvLibraryMigration(token);
  const { plan, loading, error, actionPending, actionError } = migration;
  const [verifyChecksums, setVerifyChecksums] = useState(true);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const busy = isBusy(plan) || actionPending;
  const canPreview = !plan || ['planned', 'applied', 'rolled-back'].includes(plan.status);

  const closeDialog = () => {
    setConfirming(null);
    setAcknowledged(false);
  };
  const confirm = () => {
    const action = confirming;
    closeDialog();
    if (action === 'apply') void migration.apply({ acceptUserStateLoss: false });
    if (action === 'rollback') void migration.rollback();
  };

  return (
    <ConfigurationCard title="Move existing downloads into the TV library">
      <div className="flex flex-col gap-4">
        <Typography variant="body2" color="text.secondary">
          Moves videos already downloaded in the regular layout into the Jellyfin TV layout (channel = show,
          year = season), without downloading anything again. Preview first: the preview changes nothing.
          Applying pauses downloads and cleanup until it finishes, and can be resumed or rolled back.
        </Typography>

        {loading && <CircularProgress size={16} />}
        {error && <Alert severity="warning">{error}</Alert>}

        {plan && (
          <>
            <Typography variant="body2" className="font-medium">
              Plan {plan.planId}: {STATUS_TEXT[plan.status]}
              {plan.status === 'applying' && ` ${plan.progress.done ?? 0} of ${plan.items.length} moved.`}
            </Typography>
            {plan.error && <Alert severity="error">{plan.error}</Alert>}
            {plan.userStateSkipped && <Alert severity="warning">{plan.userStateSkipped}</Alert>}
            {plan.status === 'applied' && <NextSteps plan={plan} />}
            <RestoreStatus plan={plan} />
            <MigrationPlanDetails plan={plan} />
          </>
        )}

        {actionError && (
          <Alert severity="warning">
            {actionError.message}
            {actionError.code === 'snapshot-failed' && (
              <div className="mt-2">
                <Button size="small" variant="outlined" onClick={() => void migration.apply({ acceptUserStateLoss: true })}>
                  Apply without Jellyfin viewing state
                </Button>
              </div>
            )}
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {canPreview && (
            <>
              <Button variant={plan ? 'outlined' : 'contained'} disabled={busy} onClick={() => void migration.preview({ verifyChecksums })}>
                {plan ? 'New preview' : 'Preview migration'}
              </Button>
              <FormControlLabel
                control={<Checkbox checked={verifyChecksums} onChange={(event) => setVerifyChecksums(event.target.checked)} />}
                label="Verify checksums (reads every video twice)"
              />
            </>
          )}
          {plan?.status === 'planned' && (
            <Button variant="contained" disabled={busy || plan.blockers.length > 0 || plan.items.length === 0} onClick={() => setConfirming('apply')}>
              Apply migration
            </Button>
          )}
          {plan?.status === 'interrupted' && plan.interruptedFrom !== 'rolling-back' && (
            <Button variant="contained" disabled={busy} onClick={() => void migration.resume()}>Resume</Button>
          )}
          {plan && ['interrupted', 'applied'].includes(plan.status) && (
            <Button variant="outlined" color="error" disabled={busy} onClick={() => setConfirming('rollback')}>Roll back</Button>
          )}
          {plan?.status === 'applied' && plan.userState && (
            <Button variant="contained" disabled={busy} onClick={() => void migration.restoreUserState()}>
              Restore Jellyfin viewing state
            </Button>
          )}
          {busy && <CircularProgress size={16} />}
        </div>
      </div>

      <Dialog open={confirming !== null} onClose={closeDialog}>
        <DialogTitle>{confirming === 'apply' ? 'Apply the TV library migration?' : 'Roll back the migration?'}</DialogTitle>
        <DialogContent>
          <Typography variant="body2" className="mb-3">
            {confirming === 'apply'
              ? `This moves ${plan?.items.length ?? 0} videos and their subtitles and thumbnails. Downloads, cleanup and rescans pause until it finishes. If it stops, you can resume or roll back.`
              : 'This moves every migrated video back to where the preview found it and restores its database row. Viewing state already written to new Jellyfin episodes is not undone.'}
          </Typography>
          <FormControlLabel
            control={<Checkbox checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />}
            label="I have a backup of my config folder and database"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDialog}>Cancel</Button>
          <Button variant="contained" disabled={!acknowledged} onClick={confirm}>
            {confirming === 'apply' ? 'Apply' : 'Roll back'}
          </Button>
        </DialogActions>
      </Dialog>
    </ConfigurationCard>
  );
}

export default TvLibraryMigrationCard;
