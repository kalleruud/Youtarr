// In-memory stand-in for captionStore with the same plain-object contract.
function createMemoryStore({ videos = [] } = {}) {
  const tracks = new Map();
  const jobs = new Map();
  let nextJobId = 1;
  const key = (youtubeId, code) => `${youtubeId}|${code}`;
  return {
    videos,
    tracks,
    jobs,
    async getVideo(youtubeId) {
      const video = videos.find((item) => item.youtubeId === youtubeId);
      return video ? { ...video } : null;
    },
    async listRecentVideos(limit) {
      return videos.filter((video) => !video.removed && video.filePath).slice(0, limit).map((video) => ({ ...video }));
    },
    async listTracks(youtubeId) {
      return [...tracks.values()].filter((row) => row.youtube_id === youtubeId).map((row) => ({ ...row }));
    },
    async saveTrack(fields) {
      tracks.set(key(fields.youtube_id, fields.track_code), { protected: false, ...tracks.get(key(fields.youtube_id, fields.track_code)), ...fields });
    },
    async deleteTracks(youtubeId, codes) {
      for (const code of codes) tracks.delete(key(youtubeId, code));
    },
    // Like the real store: existence is looked up, and the row is written
    // only when the value changes (MySQL counts changed rows, not matched).
    async setProtected(youtubeId, code, value) {
      const row = tracks.get(key(youtubeId, code));
      if (!row) return false;
      if (row.protected !== value) row.protected = value;
      return true;
    },
    async getJob(youtubeId) {
      const job = jobs.get(youtubeId);
      return job ? { ...job } : null;
    },
    async saveJob(youtubeId, fields) {
      const job = { id: nextJobId, youtube_id: youtubeId, attempts: 0, max_attempts: 3, ...jobs.get(youtubeId), ...fields };
      if (!jobs.has(youtubeId)) nextJobId++;
      jobs.set(youtubeId, job);
      return { ...job };
    },
    async claimDueJobs({ now, limit, leaseUntil }) {
      const due = [...jobs.values()]
        .filter((job) => job.status === 'pending' && job.next_attempt_at && job.next_attempt_at <= now)
        .sort((a, b) => a.next_attempt_at - b.next_attempt_at)
        .slice(0, limit);
      for (const job of due) Object.assign(job, { status: 'running', lease_until: leaseUntil });
      return due.map((job) => ({ ...job }));
    },
    async recoverExpiredLeases(now, { all = false } = {}) {
      let count = 0;
      for (const job of jobs.values()) {
        if (job.status === 'running' && (all || job.lease_until < now)) {
          Object.assign(job, { status: 'pending', lease_until: null });
          count++;
        }
      }
      return count;
    },
  };
}

module.exports = { createMemoryStore };
