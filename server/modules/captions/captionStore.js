/**
 * Persistence for caption provenance rows and delayed caption checks. Plain
 * objects in and out, so the catalog and the worker can be tested with an
 * in-memory store. Models are required directly (not the models index).
 */
const { Op } = require('sequelize');
const Video = require('../../models/video');
const CaptionTrack = require('../../models/captionTrack');
const CaptionEnrichmentJob = require('../../models/captionEnrichmentJob');

const VIDEO_ATTRIBUTES = ['youtubeId', 'youTubeVideoName', 'filePath', 'audioFilePath', 'duration', 'removed'];

function plain(row) {
  return row ? row.get({ plain: true }) : null;
}

function plainVideo(row) {
  if (!row) return null;
  const video = plain(row);
  return {
    youtubeId: video.youtubeId,
    title: video.youTubeVideoName,
    filePath: video.filePath,
    audioFilePath: video.audioFilePath,
    duration: video.duration,
    removed: Boolean(video.removed),
  };
}

class CaptionStore {
  async getVideo(youtubeId) {
    return plainVideo(await Video.findOne({ where: { youtubeId }, attributes: VIDEO_ATTRIBUTES }));
  }

  async listRecentVideos(limit) {
    const rows = await Video.findAll({
      where: { removed: false, filePath: { [Op.ne]: null } },
      attributes: VIDEO_ATTRIBUTES,
      order: [['id', 'DESC']],
      limit,
    });
    return rows.map(plainVideo);
  }

  async listTracks(youtubeId) {
    return (await CaptionTrack.findAll({ where: { youtube_id: youtubeId }, order: [['track_code', 'ASC']] })).map(plain);
  }

  async saveTrack(fields) {
    const values = { ...fields, updated_at: new Date() };
    const existing = await CaptionTrack.findOne({ where: { youtube_id: fields.youtube_id, track_code: fields.track_code } });
    if (existing) await existing.update(values);
    else await CaptionTrack.create(values);
  }

  async deleteTracks(youtubeId, codes) {
    if (!codes.length) return;
    await CaptionTrack.destroy({ where: { youtube_id: youtubeId, track_code: codes } });
  }

  async setProtected(youtubeId, code, value) {
    const [count] = await CaptionTrack.update(
      { protected: value, updated_at: new Date() },
      { where: { youtube_id: youtubeId, track_code: code } }
    );
    return count > 0;
  }

  async getJob(youtubeId) {
    return plain(await CaptionEnrichmentJob.findOne({ where: { youtube_id: youtubeId } }));
  }

  async saveJob(youtubeId, fields) {
    const now = new Date();
    const existing = await CaptionEnrichmentJob.findOne({ where: { youtube_id: youtubeId } });
    if (existing) {
      await existing.update({ ...fields, updated_at: now });
      return plain(existing);
    }
    return plain(await CaptionEnrichmentJob.create({ ...fields, youtube_id: youtubeId, created_at: now, updated_at: now }));
  }

  /**
   * Lease up to `limit` due pending checks. The status predicate on the
   * update makes a check claimable once even with two claimers.
   */
  async claimDueJobs({ now, limit, leaseUntil }) {
    const due = await CaptionEnrichmentJob.findAll({
      where: { status: 'pending', next_attempt_at: { [Op.lte]: now } },
      order: [['next_attempt_at', 'ASC']],
      limit,
    });
    const claimed = [];
    for (const row of due) {
      const [count] = await CaptionEnrichmentJob.update(
        { status: 'running', lease_until: leaseUntil, updated_at: now },
        { where: { id: row.id, status: 'pending' } }
      );
      if (count > 0) claimed.push({ ...plain(row), status: 'running', lease_until: leaseUntil });
    }
    return claimed;
  }

  /**
   * Checks a stopped process left running return to the queue unchanged (no
   * attempt is counted). At startup every running check is abandoned.
   */
  async recoverExpiredLeases(now, { all = false } = {}) {
    const where = all ? { status: 'running' } : { status: 'running', lease_until: { [Op.lt]: now } };
    const [count] = await CaptionEnrichmentJob.update(
      { status: 'pending', lease_until: null, updated_at: now },
      { where }
    );
    return count;
  }
}

module.exports = new CaptionStore();
module.exports.CaptionStore = CaptionStore;
