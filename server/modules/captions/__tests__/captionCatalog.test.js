jest.mock('../../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const { CaptionCatalog } = require('../captionCatalog');
const { createMemoryStore } = require('./memoryStore');
const { createSandbox, YOUTUBE_ID } = require('./sandbox');
const { uploaded, automatic, info, SRT } = require('./fixtures');

const NOW = new Date('2026-03-01T12:00:00Z');
let sandbox;
let store;

function setup({ metadata = info(), config } = {}) {
  sandbox = createSandbox({ info: metadata, config });
  store = createMemoryStore({ videos: [sandbox.video] });
  return new CaptionCatalog({ store, configModule: sandbox.configModule, now: () => NOW });
}

afterEach(() => sandbox.cleanup());

describe('recordDownload', () => {
  test('records the provenance the post-processor reported', async () => {
    const metadata = info({
      automaticCaptions: { en: automatic('en') },
      _youtarr_captions: [{ code: 'en', source: 'automatic', sourceSha256: 'b'.repeat(64), normalizerVersion: 2 }],
    });
    const catalog = setup({ metadata });
    fs.writeFileSync(sandbox.sidecar('en'), SRT);
    await catalog.recordDownload({ youtubeId: YOUTUBE_ID, filePath: sandbox.filePath });
    expect((await store.listTracks(YOUTUBE_ID))[0]).toMatchObject({
      track_code: 'en', source: 'automatic', origin: 'download', source_sha256: 'b'.repeat(64), normalizer_version: 2,
    });
  });

  test('schedules a check at the first retry offset for a missing language', async () => {
    const catalog = setup();
    await catalog.recordDownload({ youtubeId: YOUTUBE_ID, filePath: sandbox.filePath });
    expect(await store.getJob(YOUTUBE_ID)).toMatchObject({
      status: 'pending', attempts: 0, max_attempts: 3, next_attempt_at: new Date('2026-03-01T13:00:00Z'),
    });
  });

  test('schedules nothing while delayed checks are turned off', async () => {
    const catalog = setup({ config: { captionEnrichmentEnabled: false } });
    await catalog.recordDownload({ youtubeId: YOUTUBE_ID, filePath: sandbox.filePath });
    expect(await store.getJob(YOUTUBE_ID)).toBeNull();
  });

  test('a broadcast with only automatic captions waits for uploaded ones', async () => {
    const catalog = setup({ metadata: info({ live_status: 'was_live', automaticCaptions: { en: automatic('en') } }) });
    fs.writeFileSync(sandbox.sidecar('en'), SRT);
    await catalog.recordDownload({ youtubeId: YOUTUBE_ID, filePath: sandbox.filePath });
    expect(JSON.parse((await store.getJob(YOUTUBE_ID)).wanted)).toEqual([{ language: 'en', reason: 'awaiting-uploaded' }]);
  });

  test('an existing automatic track under uploaded-only schedules a check and stays on disk', async () => {
    const catalog = setup({ metadata: info({ automaticCaptions: { en: automatic('en') } }), config: { captionSourcePolicy: 'uploaded-only' } });
    fs.writeFileSync(sandbox.sidecar('en'), SRT);
    await catalog.recordDownload({ youtubeId: YOUTUBE_ID, filePath: sandbox.filePath });
    expect([JSON.parse((await store.getJob(YOUTUBE_ID)).wanted), fs.existsSync(sandbox.sidecar('en'))])
      .toEqual([[{ language: 'en', reason: 'automatic-not-allowed' }], true]);
  });

  test('an existing machine translation with translations disabled schedules a check and stays on disk', async () => {
    const metadata = info({ automaticCaptions: { nb: automatic('nb', { from: 'en' }) } });
    const catalog = setup({ metadata, config: { subtitleLanguage: 'nb' } });
    fs.writeFileSync(sandbox.sidecar('nb'), SRT);
    await catalog.recordDownload({ youtubeId: YOUTUBE_ID, filePath: sandbox.filePath });
    expect([JSON.parse((await store.getJob(YOUTUBE_ID)).wanted), fs.existsSync(sandbox.sidecar('nb'))])
      .toEqual([[{ language: 'nb', reason: 'translation-only' }], true]);
  });

  test('a complete download schedules no check', async () => {
    const catalog = setup({ metadata: info({ subtitles: { en: uploaded('en') } }) });
    fs.writeFileSync(sandbox.sidecar('en'), SRT);
    await catalog.recordDownload({ youtubeId: YOUTUBE_ID, filePath: sandbox.filePath });
    expect(await store.getJob(YOUTUBE_ID)).toBeNull();
  });
});

describe('getVideoCaptions', () => {
  test('describes an unrecorded sidecar from the cached metadata', async () => {
    const catalog = setup({ metadata: info({ subtitles: { 'en-GB': uploaded('en-GB') } }) });
    fs.writeFileSync(sandbox.sidecar('en-GB'), SRT);
    const summary = await catalog.getVideoCaptions(YOUTUBE_ID);
    expect(summary.tracks[0]).toMatchObject({ code: 'en-GB', source: 'uploaded', origin: 'unrecorded' });
  });

  test('a scheduled language is pending', async () => {
    const catalog = setup();
    await catalog.recordDownload({ youtubeId: YOUTUBE_ID, filePath: sandbox.filePath });
    expect((await catalog.getVideoCaptions(YOUTUBE_ID)).missing).toEqual([{ language: 'en', reason: 'not-offered', state: 'pending' }]);
  });

  test('an unscheduled missing language is unavailable', async () => {
    const catalog = setup({ config: { captionEnrichmentEnabled: false } });
    expect((await catalog.getVideoCaptions(YOUTUBE_ID)).missing[0].state).toBe('unavailable');
  });

  test('an unknown video is null', async () => {
    const catalog = setup();
    expect(await catalog.getVideoCaptions('zzzzzzzzzzz')).toBeNull();
  });
});

describe('setProtection and requestRetry', () => {
  test('protecting an unrecorded sidecar records it as protected', async () => {
    const catalog = setup({ metadata: info({ automaticCaptions: { en: automatic('en') } }) });
    fs.writeFileSync(sandbox.sidecar('en'), SRT);
    await catalog.setProtection(YOUTUBE_ID, 'en', true);
    expect((await store.listTracks(YOUTUBE_ID))[0]).toMatchObject({ track_code: 'en', protected: true });
  });

  test('repeating protection keeps an enrichment-recorded track as recorded', async () => {
    const catalog = setup({ metadata: info({ automaticCaptions: { en: automatic('en') } }) });
    fs.writeFileSync(sandbox.sidecar('en-GB'), SRT);
    const recorded = {
      youtube_id: YOUTUBE_ID, track_code: 'en-GB', language: 'en', source: 'uploaded', origin: 'enrichment',
      file_path: sandbox.sidecar('en-GB'), media_revision: 'rev-1', source_sha256: 'a'.repeat(64),
      result_sha256: 'b'.repeat(64), normalizer_version: 2, retrieved_at: NOW, protected: false,
    };
    await store.saveTrack(recorded);
    const results = [];
    for (let i = 0; i < 2; i++) results.push(await catalog.setProtection(YOUTUBE_ID, 'en-GB', true));
    expect([results, (await store.listTracks(YOUTUBE_ID))]).toEqual([
      [{ status: 'ok' }, { status: 'ok' }],
      [{ ...recorded, protected: true }],
    ]);
  });

  test('protecting a missing sidecar is not found', async () => {
    const catalog = setup();
    expect(await catalog.setProtection(YOUTUBE_ID, 'en', true)).toEqual({ status: 'not-found' });
  });

  test('check again after exhaustion grants one more attempt due now', async () => {
    const catalog = setup();
    await store.saveJob(YOUTUBE_ID, { status: 'exhausted', attempts: 3, max_attempts: 3, baseline_at: NOW, wanted: '[]' });
    await catalog.requestRetry(YOUTUBE_ID);
    expect(await store.getJob(YOUTUBE_ID)).toMatchObject({ status: 'pending', attempts: 3, max_attempts: 4, next_attempt_at: NOW });
  });

  test('check again with nothing missing is refused', async () => {
    const catalog = setup({ metadata: info({ subtitles: { en: uploaded('en') } }) });
    fs.writeFileSync(sandbox.sidecar('en'), SRT);
    expect(await catalog.requestRetry(YOUTUBE_ID)).toEqual({ status: 'nothing-missing' });
  });
});

describe('previewPreferences', () => {
  test('reports a language the proposed source policy would no longer cover', async () => {
    const catalog = setup({ metadata: info({ automaticCaptions: { en: automatic('en') } }) });
    const preview = await catalog.previewPreferences({ captionSourcePolicy: 'uploaded-only' });
    expect(preview.examples[0]).toMatchObject({ youtubeId: YOUTUBE_ID, removed: ['en'], missing: [{ language: 'en', reason: 'automatic-not-allowed' }] });
  });

  test('an unchanged preference reports no changed videos', async () => {
    const catalog = setup({ metadata: info({ automaticCaptions: { en: automatic('en') } }) });
    expect((await catalog.previewPreferences({})).totals).toMatchObject({ videosChecked: 1, videosChanged: 0 });
  });

  test('preview writes nothing', async () => {
    const catalog = setup({ metadata: info({ automaticCaptions: { en: automatic('en') } }) });
    await catalog.previewPreferences({ subtitleLanguage: 'en,nb' });
    expect([store.tracks.size, store.jobs.size]).toEqual([0, 0]);
  });
});
