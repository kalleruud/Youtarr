const fs = require('fs');
const path = require('path');
const logger = require('../logger');
const ratingMapper = require('./ratingMapper');

/**
 * Generates an NFO file for a video
 * This is compatible with Jellyfin/Kodi/Emby
 */
class NfoGenerator {
  /**
   * Escapes special XML characters in text content
   * @param {string} text - Text to escape
   * @returns {string} XML-safe text
   */
  escapeXml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  /**
   * Converts YYYYMMDD date string to YYYY-MM-DD format
   * @param {string|number} dateStr - Date in YYYYMMDD format
   * @returns {string|null} Date in YYYY-MM-DD format or null if invalid
   */
  formatDate(dateStr) {
    if (!dateStr) return null;

    const str = String(dateStr);
    if (str.length !== 8) return null;

    const year = str.substring(0, 4);
    const month = str.substring(4, 6);
    const day = str.substring(6, 8);

    // Validate the date
    const date = new Date(`${year}-${month}-${day}T00:00:00`);
    if (isNaN(date.getTime())) return null;

    return `${year}-${month}-${day}`;
  }

  /**
   * Formats a Date as YYYY-MM-DD HH:mm:ss for NFO <dateadded> element
   * @param {Date} [date=new Date()] - Date to format (defaults to now)
   * @returns {string} Formatted date string in 'YYYY-MM-DD HH:mm:ss' format (UTC)
   */
  formatDateAdded(date = new Date()) {
    const pad = (n) => String(n).padStart(2, '0');
    const year = date.getUTCFullYear();
    const month = pad(date.getUTCMonth() + 1);
    const day = pad(date.getUTCDate());
    const hours = pad(date.getUTCHours());
    const minutes = pad(date.getUTCMinutes());
    const seconds = pad(date.getUTCSeconds());
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  }

  /**
   * Converts duration in seconds to minutes (rounded up)
   * @param {number} seconds - Duration in seconds
   * @returns {number} Duration in minutes
   */
  calculateRuntime(seconds) {
    if (!seconds || seconds <= 0) return 0;
    return Math.ceil(seconds / 60);
  }

  /**
   * Builds YouTube plugin URL for Kodi
   * @param {string} videoId - YouTube video ID
   * @returns {string} Plugin URL
   */
  buildYouTubeTrailerUrl(videoId) {
    if (!videoId) return '';
    return `plugin://plugin.video.youtube/?action=play_video&amp;videoid=${videoId}`;
  }

  /**
   * Escapes text for XML after removing characters XML 1.0 cannot carry
   * (control codes other than tab/newline/CR, lone surrogates, U+FFFE/U+FFFF).
   * Titles and descriptions come straight from YouTube, so they can hold any
   * of these, and one bad character makes the whole NFO unreadable.
   * @param {string} text
   * @returns {string}
   */
  xmlText(text) {
    if (text === null || text === undefined) return '';
    const cleaned = String(text)
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
      .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
    return this.escapeXml(cleaned);
  }

  _element(name, value, indent = '  ') {
    if (value === null || value === undefined || value === '') return '';
    return `${indent}<${name}>${this.xmlText(value)}</${name}>\n`;
  }

  /**
   * Builds tvshow.nfo XML for a channel published as a TV show.
   * @param {{title: string, plot?: string, channelId: string}} show
   * @returns {string}
   */
  buildTvShowNfo({ title, plot, channelId }) {
    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    xml += '<tvshow>\n';
    xml += this._element('title', title || channelId);
    xml += this._element('plot', plot);
    xml += `  <uniqueid type="youtube" default="true">${this.xmlText(channelId)}</uniqueid>\n`;
    xml += this._element('studio', 'YouTube');
    xml += '</tvshow>\n';
    return xml;
  }

  /**
   * Builds season.nfo XML for a publication-year season.
   * @param {{season: number}} params
   * @returns {string}
   */
  buildSeasonNfo({ season }) {
    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    xml += '<season>\n';
    xml += this._element('title', String(season));
    xml += this._element('seasonnumber', String(season));
    xml += '</season>\n';
    return xml;
  }

  /**
   * Builds episode NFO XML (<episodedetails>) for one published video.
   * @param {object} episode
   * @param {string} episode.title - Episode title (the video title)
   * @param {string} episode.showTitle - Show title (the channel)
   * @param {number} episode.season - Assigned season (publication year)
   * @param {number} episode.episode - Assigned episode number
   * @param {string|null} episode.aired - YYYY-MM-DD
   * @param {string} [episode.plot]
   * @param {string} episode.youtubeId
   * @param {number} [episode.durationSeconds]
   * @param {string[]} [episode.genres]
   * @param {string[]} [episode.tags]
   * @param {string|null} [episode.rating] - Normalized rating code
   * @param {string} episode.dateAdded - YYYY-MM-DD HH:mm:ss, kept across regenerations
   * @returns {string}
   */
  buildEpisodeNfo(episode) {
    const {
      title, showTitle, season, episode: number, aired, plot, youtubeId,
      durationSeconds, genres = [], tags = [], rating = null, dateAdded,
    } = episode;
    let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    xml += '<episodedetails>\n';
    xml += this._element('title', title || 'Unknown Title');
    xml += this._element('showtitle', showTitle);
    xml += this._element('season', String(season));
    xml += this._element('episode', String(number));
    xml += this._element('plot', plot);
    if (youtubeId) {
      xml += `  <uniqueid type="youtube" default="true">${this.xmlText(youtubeId)}</uniqueid>\n`;
    }
    if (aired) {
      xml += this._element('aired', aired);
      xml += this._element('premiered', aired);
      xml += this._element('year', aired.substring(0, 4));
    }
    xml += this._element('dateadded', dateAdded);
    xml += this._element('studio', showTitle);
    for (const genre of genres) xml += this._element('genre', genre);
    for (const tag of tags) xml += this._element('tag', tag);
    xml += this._element('mpaa', rating);
    if (durationSeconds > 0) {
      xml += this._element('runtime', String(this.calculateRuntime(durationSeconds)));
    }
    xml += '</episodedetails>\n';
    return xml;
  }

  /**
   * Generates and writes an NFO file for a video
   * @param {string} videoPath - Path to the video file
   * @param {object} jsonData - Parsed .info.json data
   * @returns {boolean} True if successful, false otherwise
   */
  writeVideoNfoFile(videoPath, jsonData) {
    logger.info({ videoPath }, 'Writing NFO file for video');
    try {
      // Generate NFO path (same as video but with .nfo extension)
      const parsedPath = path.parse(videoPath);
      const nfoPath = path.format({
        dir: parsedPath.dir,
        name: parsedPath.name,
        ext: '.nfo'
      });

      // Extract and prepare data
      const title = this.escapeXml(jsonData.fulltitle || jsonData.title || 'Unknown Title');
      const plot = this.escapeXml(jsonData.description || '');
      const youtubeId = jsonData.id || '';
      const premiered = this.formatDate(jsonData.upload_date);

      // Use uploader as primary, fall back to channel
      const studio = this.escapeXml(
        jsonData.uploader ||
        jsonData.channel ||
        jsonData.uploader_id ||
        jsonData.channel_id ||
        'Unknown Channel'
      );
      const credits = this.escapeXml(jsonData.uploader || '');

      // Runtime calculations
      const durationSeconds = jsonData.duration || 0;
      const runtimeMinutes = this.calculateRuntime(durationSeconds);

      // Build genre tags from categories
      const genres = (jsonData.categories || [])
        .map(cat => `  <genre>${this.escapeXml(cat)}</genre>`)
        .join('\n');

      // Build tag elements from tags array
      const tags = (jsonData.tags || [])
        .map(tag => `  <tag>${this.escapeXml(tag)}</tag>`)
        .join('\n');

      // Build the XML content
      let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
      xml += '<movie>\n';
      xml += `  <title>${title}</title>\n`;

      if (plot) {
        xml += `  <plot>${plot}</plot>\n`;
      }

      xml += '\n  <!-- IDs -->\n';
      if (youtubeId) {
        xml += `  <uniqueid type="youtube" default="true">${youtubeId}</uniqueid>\n`;
        xml += `  <youtubeid>${youtubeId}</youtubeid>\n`;
      }

      xml += '\n  <!-- Dates -->\n';
      if (premiered) {
        xml += `  <premiered>${premiered}</premiered>\n`;
        // Without <year>, Emby guesses ProductionYear and breaks episode sorting
        xml += `  <year>${premiered.substring(0, 4)}</year>\n`;
      }
      xml += `  <dateadded>${this.formatDateAdded()}</dateadded>\n`;

      xml += '\n  <!-- People / orgs -->\n';
      xml += `  <studio>${studio}</studio>\n`;
      if (credits) {
        xml += `  <credits>${credits}</credits>\n`;
      }

      if (genres || tags) {
        xml += '\n  <!-- Classification -->\n';
        if (genres) {
          xml += genres + '\n';
        }
        if (tags) {
          xml += tags + '\n';
        }
      }

      // Add rating information if available
      if (jsonData.normalized_rating) {
        const displayCode = this.escapeXml(jsonData.normalized_rating);
        const numeric = ratingMapper.mapToNumericRating(jsonData.normalized_rating);

        xml += '\n  <!-- Ratings -->\n';
        // Keep the MPAA code for clients that prefer the textual code
        xml += `  <mpaa>${displayCode}</mpaa>\n`;
        xml += '  <ratings>\n';
        // Include a numeric rating where possible (preferred by some media servers)
        if (numeric !== null) {
          xml += `    <rating name="mpaa" max="10">${numeric}</rating>\n`;
        } else {
          // Fall back to textual code if numeric mapping isn't available
          xml += `    <rating name="mpaa" max="10">${displayCode}</rating>\n`;
        }
        if (jsonData.rating_source) {
          xml += `    <rating name="source">${this.escapeXml(jsonData.rating_source)}</rating>\n`;
        }
        xml += '  </ratings>\n';
      }

      if (durationSeconds > 0) {
        xml += '\n  <!-- Runtime -->\n';
        xml += `  <runtime>${runtimeMinutes}</runtime>\n`;
        xml += '  <fileinfo>\n';
        xml += '    <streamdetails>\n';
        xml += '      <video>\n';
        xml += `        <durationinseconds>${durationSeconds}</durationinseconds>\n`;
        xml += '      </video>\n';
        xml += '    </streamdetails>\n';
        xml += '  </fileinfo>\n';
      }

      if (youtubeId) {
        xml += '\n  <!-- Backlink to YouTube in Kodi format -->\n';
        xml += `  <trailer>${this.buildYouTubeTrailerUrl(youtubeId)}</trailer>\n`;
      }

      // Optional: Add channel as collection (commented out by default)
      // xml += `\n  <!-- Optional: group by channel -->\n`;
      // xml += `  <!-- <set>${studio}</set> -->\n`;

      xml += '</movie>\n';

      // Write the NFO file
      fs.writeFileSync(nfoPath, xml, 'utf8');
      logger.info({ nfoPath }, 'NFO file created successfully');

      return true;
    } catch (error) {
      logger.error({ err: error, videoPath }, 'Error creating NFO file');
      return false;
    }
  }
}

module.exports = new NfoGenerator();