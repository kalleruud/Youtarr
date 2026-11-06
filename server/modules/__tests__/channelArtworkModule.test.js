const fs = require('fs');
const os = require('os');
const path = require('path');

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
// Fixture images carry their dimensions in their bytes; the mocked probe
// reads them back, so no real ffmpeg/ffprobe runs in these tests.
const image = (width, height, tag = '') => Buffer.concat([JPEG_MAGIC, Buffer.from(`IMG:${width}x${height}:${tag}`)]);

// jest.mock factories may only reference variables prefixed with "mock".
const mockState = {};
let root;

jest.mock('../configModule', () => ({
  getConfig: () => mockState.config,
  getImagePath: () => mockState.imageDir,
  getDefaultSubfolder: () => null,
  ffmpegPath: '/usr/bin/ffmpeg',
  get directoryPath() { return mockState.libraryDir; },
}));
jest.mock('../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../models/channel', () => ({
  findOne: jest.fn(async ({ where }) => (where.channel_id === 'UC1'
    ? { channel_id: 'UC1', title: 'Pawel Code Stuff', folder_name: 'Pawel', sub_folder: null }
    : null)),
}));
jest.mock('../../models/video', () => ({ findAll: jest.fn(async () => mockState.videos) }));
jest.mock('../../models/channelArtwork', () => {
  const makeRecord = (fields) => {
    const record = { ...fields };
    record.update = jest.fn(async (changes) => Object.assign(record, changes));
    return record;
  };
  return {
    findOrCreate: jest.fn(async ({ where, defaults }) => {
      if (!mockState.artworkRows.has(where.channel_id)) mockState.artworkRows.set(where.channel_id, makeRecord(defaults));
      return [mockState.artworkRows.get(where.channel_id), false];
    }),
    findByPk: jest.fn(async (id) => mockState.artworkRows.get(id) || null),
  };
});
jest.mock('../mediaServers/serverRegistry', () => ({ getEnabledAdapters: jest.fn(() => mockState.adapters) }));
jest.mock('../artwork/imageInspector', () => {
  const actual = jest.requireActual('../artwork/imageInspector');
  const nodeFs = jest.requireActual('fs');
  return {
    ...actual,
    probeImage: jest.fn(async (filePath) => {
      try {
        const match = /IMG:(\d+)x(\d+)/.exec(nodeFs.readFileSync(filePath, 'latin1'));
        return match ? { width: Number(match[1]), height: Number(match[2]) } : null;
      } catch (err) {
        return null;
      }
    }),
  };
});
jest.mock('../artwork/posterComposer', () => {
  const nodeFs = jest.requireActual('fs');
  return {
    // Deterministic stand-in: the output depends only on the inputs.
    composePoster: jest.fn(async ({ sourcePath, outputPath, title }) => {
      const source = sourcePath ? nodeFs.readFileSync(sourcePath, 'latin1') : 'none';
      nodeFs.writeFileSync(outputPath, Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from(`IMG:1000x1500:${source}:${title}`)]));
    }),
    normalizeUpload: jest.fn(async ({ inputPath, outputPath }) => nodeFs.copyFileSync(inputPath, outputPath)),
  };
});

const posterComposer = require('../artwork/posterComposer');
const Video = require('../../models/video');
const artwork = require('../channelArtworkModule');

const avatarPath = () => path.join(mockState.imageDir, 'channelavatar-UC1.jpg');
const folderPoster = () => path.join(mockState.libraryDir, 'Pawel', 'poster.jpg');
const record = () => mockState.artworkRows.get('UC1');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-artwork-'));
  mockState.imageDir = path.join(root, 'images');
  mockState.libraryDir = path.join(root, 'library');
  fs.mkdirSync(mockState.imageDir);
  fs.mkdirSync(path.join(mockState.libraryDir, 'Pawel'), { recursive: true });
  mockState.config = { tvShowArtwork: true, writeChannelPosters: true };
  mockState.artworkRows = new Map();
  mockState.videos = [];
  mockState.adapters = [];
  jest.clearAllMocks();
  fs.writeFileSync(avatarPath(), image(900, 900, 'avatar-v1'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('poster selection and publication', () => {
  test('composes a 2:3 poster from a square avatar and publishes it as poster.jpg', async () => {
    await artwork.publishPoster('UC1');
    expect(record()).toMatchObject({ poster_origin: 'generated', poster_width: 1000, poster_height: 1500, poster_revision: 1 });
  });

  test('replaces the old square avatar copy in the channel folder', async () => {
    fs.writeFileSync(folderPoster(), image(360, 360, 'legacy'));
    await artwork.publishPoster('UC1');
    expect(fs.readFileSync(folderPoster())).toEqual(fs.readFileSync(artwork.posterCachePath('UC1')));
  });

  test('keeps a portrait poster.jpg that Youtarr did not write', async () => {
    fs.writeFileSync(folderPoster(), image(600, 900, 'hand-made'));
    const result = await artwork.publishPoster('UC1');
    expect(result.note).toMatch(/did not write/);
  });

  test('leaves no staging files behind', async () => {
    await artwork.publishPoster('UC1');
    expect(fs.readdirSync(path.join(mockState.libraryDir, 'Pawel'))).toEqual(['poster.jpg']);
  });

  test('does nothing to the folder when portrait artwork is off', async () => {
    mockState.config.tvShowArtwork = false;
    await artwork.publishPoster('UC1');
    expect(fs.existsSync(folderPoster())).toBe(false);
  });

  test('copies an upstream image that is already poster-shaped without composing', async () => {
    fs.writeFileSync(avatarPath(), image(680, 1000, 'portrait'));
    await artwork.publishPoster('UC1');
    expect(posterComposer.composePoster).not.toHaveBeenCalled();
  });
});

describe('deterministic regeneration', () => {
  test('regenerating unchanged inputs keeps the same bytes and revision', async () => {
    await artwork.publishPoster('UC1');
    const before = fs.readFileSync(artwork.posterCachePath('UC1'));
    await artwork.regenerate('UC1');
    expect({ bytes: fs.readFileSync(artwork.posterCachePath('UC1')), revision: record().poster_revision })
      .toEqual({ bytes: before, revision: 1 });
  });

  test('unchanged inputs skip composition entirely on the next sync', async () => {
    await artwork.publishPoster('UC1');
    posterComposer.composePoster.mockClear();
    await artwork.syncChannel('UC1');
    expect(posterComposer.composePoster).not.toHaveBeenCalled();
  });

  test('a new upstream avatar produces a new revision', async () => {
    await artwork.publishPoster('UC1');
    fs.writeFileSync(avatarPath(), image(900, 900, 'avatar-v2'));
    await artwork.syncChannel('UC1');
    expect(record().poster_revision).toBe(2);
  });

  test('regeneration writes episode thumbnails from existing files without touching the media', async () => {
    const media = path.join(mockState.libraryDir, 'Pawel', 'Video [abc]', 'Pawel - Video [abc].mp4');
    fs.mkdirSync(path.dirname(media));
    fs.writeFileSync(media, 'media-bytes');
    fs.writeFileSync(media.replace(/\.mp4$/, '.jpg'), image(1280, 720, 'thumb'));
    mockState.videos = [{ filePath: media }, { filePath: '/elsewhere/audio.mp3' }];
    const status = await artwork.regenerate('UC1');
    expect({ episodes: status.episodes, media: fs.readFileSync(media, 'utf8') })
      .toEqual({ episodes: { written: 1, existing: 0, missing: 0, failed: 0 }, media: 'media-bytes' });
  });

  test('regeneration only reads the video table', async () => {
    await artwork.regenerate('UC1');
    expect(Video.findAll).toHaveBeenCalledWith(expect.objectContaining({ where: { channel_id: 'UC1', removed: false } }));
  });
});

describe('owner choices survive channel refreshes', () => {
  test('an uploaded poster is selected, pinned and published', async () => {
    const status = await artwork.uploadManualPoster('UC1', image(600, 900, 'owner'));
    expect(status).toMatchObject({ source: 'manual', protected: true, origin: 'manual', manualAvailable: true });
  });

  test('an uploaded poster survives a new upstream avatar', async () => {
    await artwork.uploadManualPoster('UC1', image(600, 900, 'owner'));
    fs.writeFileSync(avatarPath(), image(900, 900, 'avatar-v2'));
    await artwork.syncChannel('UC1');
    expect(fs.readFileSync(folderPoster(), 'latin1')).toContain('owner');
  });

  test('a pinned automatic poster survives a new upstream avatar', async () => {
    await artwork.publishPoster('UC1');
    await artwork.updatePreference('UC1', { protected: true });
    fs.writeFileSync(avatarPath(), image(900, 900, 'avatar-v2'));
    await artwork.syncChannel('UC1');
    expect(fs.readFileSync(folderPoster(), 'latin1')).toContain('avatar-v1');
  });

  test('reset removes the upload and returns to automatic artwork', async () => {
    await artwork.uploadManualPoster('UC1', image(600, 900, 'owner'));
    const status = await artwork.resetPoster('UC1');
    expect(status).toMatchObject({ source: 'auto', protected: false, origin: 'generated', manualAvailable: false });
  });
});

describe('upload validation', () => {
  const rejected = [
    ['non-image content', Buffer.from('<svg/>'), /JPEG, PNG or WebP/],
    ['an unreadable image', Buffer.concat([JPEG_MAGIC, Buffer.from('garbage')]), /could not be read/],
    ['a landscape image', image(1280, 720), /portrait/],
    ['a tiny image', image(100, 150), /at least/],
    ['an oversized image', image(9000, 13500), /larger than/],
  ];

  test.each(rejected)('rejects %s', async (_label, buffer, message) => {
    await expect(artwork.uploadManualPoster('UC1', buffer)).rejects.toThrow(message);
  });

  test('a rejected upload keeps the existing good poster', async () => {
    await artwork.uploadManualPoster('UC1', image(600, 900, 'good'));
    await artwork.uploadManualPoster('UC1', image(1280, 720, 'bad')).catch(() => {});
    expect(fs.readFileSync(artwork.manualPosterPath('UC1'), 'latin1')).toContain('good');
  });

  test('a rejected upload leaves no temporary files', async () => {
    await artwork.uploadManualPoster('UC1', image(1280, 720, 'bad')).catch(() => {});
    expect(fs.readdirSync(mockState.imageDir)).toEqual(['channelavatar-UC1.jpg']);
  });

  test('selecting a manual poster requires an upload', async () => {
    await expect(artwork.updatePreference('UC1', { source: 'manual' })).rejects.toThrow(/Upload a poster/);
  });

  test('returns null for an unknown channel', async () => {
    await expect(artwork.uploadManualPoster('UCX', image(600, 900))).resolves.toBeNull();
  });
});

describe('Jellyfin artwork refresh', () => {
  test('records that no Jellyfin server is configured', async () => {
    await artwork.publishPoster('UC1');
    expect(record().refresh_status).toBe('not-configured');
  });

  test('records a failed refresh so it is visible', async () => {
    mockState.adapters = [{ refreshFolderImages: jest.fn(async () => ({ status: 'failed', message: 'Jellyfin artwork refresh failed: timeout' })) }];
    await artwork.publishPoster('UC1');
    expect((await artwork.getStatus('UC1')).refresh).toMatchObject({ status: 'failed', message: expect.stringContaining('timeout') });
  });

  test('a retry asks Jellyfin again for the same folder', async () => {
    const refreshFolderImages = jest.fn(async () => ({ status: 'refreshed', message: 'ok' }));
    mockState.adapters = [{ refreshFolderImages }];
    await artwork.requestRefresh('UC1');
    expect(refreshFolderImages).toHaveBeenCalledWith(path.join(mockState.libraryDir, 'Pawel'));
  });

  test('does not ask Jellyfin again when the published poster is unchanged', async () => {
    const refreshFolderImages = jest.fn(async () => ({ status: 'refreshed', message: 'ok' }));
    mockState.adapters = [{ refreshFolderImages }];
    await artwork.publishPoster('UC1');
    await artwork.syncChannel('UC1');
    expect(refreshFolderImages).toHaveBeenCalledTimes(1);
  });
});

test('getStatus does not create a row for a channel never resolved', async () => {
  const status = await artwork.getStatus('UC1');
  expect({ status, rows: mockState.artworkRows.size }).toEqual({
    status: expect.objectContaining({ enabled: true, source: 'auto', revision: 0, posterUrl: null }),
    rows: 0,
  });
});
