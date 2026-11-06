const { Op, Transaction } = require('sequelize');
const { sequelize } = require('../db');
const ChannelVideo = require('../models/channelvideo');
const EpisodeShow = require('../models/episodeShow');
const EpisodeAssignment = require('../models/episodeAssignment');

const MAX_RETRIES = 5;
const NO_QUERY_RETRY = { max: 0 };
const sourceRank = source => source === 'exact' ? 2 : 1;

function dateOf(value, source) {
  if (!value || source === 'estimated') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)) return null;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return null;
  const date = new Date(time);
  if (date.toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  const year = date.getUTCFullYear();
  return year >= 1900 && year <= 9999 ? date.toISOString() : null;
}

class EpisodeAssignments {
  async getStatus(youtubeId) {
    const rows = await ChannelVideo.findAll({ where: { youtube_id: youtubeId }, attributes: ['youtube_id', 'channel_id', 'publishedAt', 'published_at_source'] });
    const catalog = rows.filter(row => row.youtube_id === youtubeId)
      .filter(row => dateOf(row.publishedAt, row.published_at_source))
      .sort((a, b) => sourceRank(b.published_at_source) - sourceRank(a.published_at_source) || dateOf(a.publishedAt, a.published_at_source).localeCompare(dateOf(b.publishedAt, b.published_at_source)));
    const existing = await EpisodeAssignment.findByPk(youtubeId);
    const observation = catalog[0];
    if (existing) return this.result(existing, observation?.publishedAt, observation?.published_at_source);
    return { status: observation ? 'not-assigned' : 'date-required' };
  }
  // Called at the publication seam: the first call allocates the entire known
  // channel catalog, so publication order does not determine initial numbers.
  async ensureEpisodeAssignment({ channelId, youtubeId, publishedAt, source = null }) {
    if (typeof channelId !== 'string' || !channelId || channelId.length > 191 ||
        typeof youtubeId !== 'string' || !youtubeId || youtubeId.length > 191) {
      throw new Error('A channel ID and YouTube ID are required');
    }
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        return await this.allocate({ channelId, youtubeId, publishedAt, source });
      } catch (err) {
        const code = err.original?.code;
        if (attempt === MAX_RETRIES - 1 || !['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(code)) throw err;
      }
    }
  }

  async allocate({ channelId, youtubeId, publishedAt, source }) {
    return sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED }, async transaction => {
      await EpisodeShow.findOrCreate({ where: { channel_id: channelId }, transaction, retry: NO_QUERY_RETRY });
      await EpisodeShow.findByPk(channelId, { transaction, lock: transaction.LOCK.UPDATE, retry: NO_QUERY_RETRY });
      const catalog = await ChannelVideo.findAll({ where: { channel_id: channelId }, attributes: ['youtube_id', 'publishedAt', 'published_at_source'], transaction, retry: NO_QUERY_RETRY });
      const candidates = new Map();
      for (const row of catalog) {
        const date = dateOf(row.publishedAt, row.published_at_source);
        const previous = candidates.get(row.youtube_id);
        if (date && (!previous || sourceRank(row.published_at_source) > sourceRank(previous.source) ||
          (sourceRank(row.published_at_source) === sourceRank(previous.source) &&
            (date < previous.date || (date === previous.date && String(row.published_at_source) < String(previous.source)))))) {
          candidates.set(row.youtube_id, { id: row.youtube_id, date, source: row.published_at_source });
        }
      }
      const requestedDate = dateOf(publishedAt, source);
      if (requestedDate && (source === 'exact' || !candidates.has(youtubeId))) candidates.set(youtubeId, { id: youtubeId, date: requestedDate, source });
      const observedDate = publishedAt || candidates.get(youtubeId)?.date;
      const observedSource = publishedAt ? source : candidates.get(youtubeId)?.source;
      const existing = await EpisodeAssignment.findByPk(youtubeId, { transaction, retry: NO_QUERY_RETRY });
      if (existing) {
        if (existing.channel_id !== channelId) throw new Error('Video is already assigned to another channel');
        return this.result(existing, observedDate, observedSource);
      }
      const sorted = [...candidates.values()].sort((a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const assigned = await EpisodeAssignment.findAll({ where: { channel_id: channelId }, transaction, retry: NO_QUERY_RETRY });
      const claimed = await EpisodeAssignment.findAll({ where: { youtube_id: { [Op.in]: [...candidates.keys()] } }, transaction, retry: NO_QUERY_RETRY });
      const owner = claimed.find(row => row.youtube_id === youtubeId);
      if (owner && owner.channel_id !== channelId) throw new Error('Video is already assigned to another channel');
      if (owner) return this.result(owner, observedDate, observedSource);
      const ids = new Set(claimed.map(row => row.youtube_id));
      const max = new Map();
      for (const row of assigned) max.set(row.season, Math.max(max.get(row.season) || 0, row.episode));
      let target = null;
      for (const candidate of sorted) {
        if (ids.has(candidate.id)) continue;
        const season = Number(candidate.date.slice(0, 4));
        const episode = (max.get(season) || 0) + 1;
        const row = await EpisodeAssignment.create({ youtube_id: candidate.id, channel_id: channelId, season, episode,
          published_at: candidate.date, published_at_source: candidate.source, assignment_version: 1 }, { transaction, retry: NO_QUERY_RETRY });
        max.set(season, episode);
        if (candidate.id === youtubeId) target = row;
      }
      if (!target) return { showKey: channelId, season: null, episode: null, assignmentVersion: null, status: 'date-required' };
      return this.result(target, observedDate, observedSource);
    });
  }

  result(row, publishedAt, source) {
    const observed = dateOf(publishedAt, source);
    return { showKey: row.channel_id, season: row.season, episode: row.episode,
      assignmentVersion: row.assignment_version, publishedAt: row.published_at,
      publishedAtSource: row.published_at_source, observedPublishedAt: observed,
      observedPublishedAtSource: observed ? source : null,
      status: observed && observed !== row.published_at ? 'date-correction-review' : 'assigned' };
  }
}
module.exports = new EpisodeAssignments();
