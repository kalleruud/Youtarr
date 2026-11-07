jest.mock('../../../logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../configModule', () => ({ getConfig: jest.fn(() => ({})) }));
jest.mock('../../ytDlpRunner', () => ({ run: jest.fn() }));

const fs = require('fs');
const path = require('path');
const { CaptionCatalog } = require('../captionCatalog');
const { CaptionEnrichment } = require('../captionEnrichment');
const { CaptionFetchError } = require('../captionFetcher');
const { VideoPublicationLease } = require('../../download/videoPublicationLease');
const { createMemoryStore } = require('./memoryStore');
const { createSandbox, YOUTUBE_ID, VIDEO_BYTES } = require('./sandbox');
const { uploaded, automatic, info, SRT } = require('./fixtures');

const HOUR = 60 * 60 * 1000;
const START = new Date('2026-03-01T12:00:00Z');
// A rolling automatic track: the 10 ms middle cue repeats the previous line.
const ROLLING_SRT = '1\n00:00:01,000 --> 00:00:02,000\nhello there\n\n2\n00:00:02,000 --> 00:00:02,010\nhello there\n\n'
  + '3\n00:00:02,010 --> 00:00:03,000\nhello there\nhow are you\n';

let sandbox;
let store;
let clock;
let fetchResponses;
let sleeps;
let state;

function build({ metadata = info({ live_status: 'was_live' }), config, probe = 120, busy = false, onSleep = () => {} } = {}) {
  sandbox = createSandbox({ info: metadata, config });
  store = createMemoryStore({ videos: [sandbox.video] });
  clock = START.getTime();
  sleeps = [];
  fetchResponses = [];
  state = { busy };
  const now = () => new Date(clock);
  const lease = new VideoPublicationLease();
  const catalog = new CaptionCatalog({ store, configModule: sandbox.configModule, lease, now });
  const fetcher = {
    fetchCaptions: jest.fn(async (params) => {
      const { outputDir } = params;
      const response = fetchResponses.shift();
      if (response instanceof Error) throw response;
      if (typeof response === 'function') return response(params);
      for (const [code, text] of Object.entries(response.files || {})) {
        fs.writeFileSync(path.join(outputDir, `${YOUTUBE_ID}.${code}.srt`), text);
      }
      const captions = new Map(Object.keys(response.files || {}).map((code) => [code, path.join(outputDir, `${YOUTUBE_ID}.${code}.srt`)]));
      return { info: response.info, captions };
    }),
  };
  const enrichment = new CaptionEnrichment({
    store, catalog, configModule: sandbox.configModule, fetcher,
    probeDuration: async () => probe,
    isBusy: () => state.busy,
    lease,
    busyPollMs: 5,
    now,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; onSleep(); },
  });
  return { catalog, enrichment, fetcher, lease };
}

async function scheduleFromDownload(catalog) {
  await catalog.recordDownload({ youtubeId: YOUTUBE_ID, filePath: sandbox.filePath });
}

afterEach(() => sandbox.cleanup());

describe('a caption appearing after a broadcast', () => {
  async function runBroadcast(beforeChecks = () => {}) {
    const { catalog, enrichment } = build();
    await scheduleFromDownload(catalog);
    beforeChecks();
    fetchResponses.push({ info: info({ live_status: 'was_live' }) });
    clock = START.getTime() + HOUR;
    await enrichment.tick();
    fetchResponses.push({ info: info({ live_status: 'was_live', automaticCaptions: { en: automatic('en') } }), files: { en: ROLLING_SRT } });
    clock = START.getTime() + 24 * HOUR;
    await enrichment.tick();
    return { catalog, enrichment };
  }

  test('the first check finds nothing and schedules the next', async () => {
    const { catalog, enrichment } = build();
    await scheduleFromDownload(catalog);
    fetchResponses.push({ info: info({ live_status: 'was_live' }) });
    clock = START.getTime() + HOUR;
    await enrichment.tick();
    expect(await store.getJob(YOUTUBE_ID)).toMatchObject({ status: 'pending', attempts: 1, next_attempt_at: new Date(START.getTime() + 24 * HOUR) });
  });

  test('a later check publishes the caption next to the video', async () => {
    await runBroadcast();
    expect(fs.existsSync(sandbox.sidecar('en'))).toBe(true);
  });

  test('the published automatic caption is normalized', async () => {
    await runBroadcast();
    expect(fs.readFileSync(sandbox.sidecar('en'), 'utf8')).toBe(
      '1\n00:00:01,000 --> 00:00:02,010\nhello there\n\n2\n00:00:02,010 --> 00:00:03,000\nhow are you\n'
    );
  });

  test('the video bytes are unchanged', async () => {
    await runBroadcast();
    expect(fs.readFileSync(sandbox.filePath).equals(VIDEO_BYTES)).toBe(true);
  });

  test('no media item is added', async () => {
    await runBroadcast();
    expect([store.videos.length, fs.readdirSync(sandbox.videoDir).filter((name) => !name.endsWith('.srt'))])
      .toEqual([1, [`Video [${YOUTUBE_ID}].mp4`]]);
  });

  test('the cached info.json is not rewritten', async () => {
    let before;
    await runBroadcast(() => { before = fs.readFileSync(path.join(sandbox.jobsPath, 'info', `${YOUTUBE_ID}.info.json`), 'utf8'); });
    expect(fs.readFileSync(path.join(sandbox.jobsPath, 'info', `${YOUTUBE_ID}.info.json`), 'utf8')).toBe(before);
  });

  test('the track is recorded as automatic from enrichment', async () => {
    await runBroadcast();
    expect((await store.listTracks(YOUTUBE_ID))[0]).toMatchObject({ source: 'automatic', origin: 'enrichment', normalizer_version: 2 });
  });

  test('a broadcast keeps waiting for uploaded captions after an automatic one', async () => {
    await runBroadcast();
    expect(JSON.parse((await store.getJob(YOUTUBE_ID)).wanted)).toEqual([{ language: 'en', reason: 'awaiting-uploaded' }]);
  });

  test('an uploaded caption then replaces the automatic one', async () => {
    const { enrichment } = await runBroadcast();
    fetchResponses.push({ info: info({ subtitles: { 'en-GB': uploaded('en-GB') }, automaticCaptions: { en: automatic('en') } }), files: { 'en-GB': SRT } });
    clock = START.getTime() + 7 * 24 * HOUR;
    await enrichment.tick();
    expect([fs.existsSync(sandbox.sidecar('en')), fs.readFileSync(sandbox.sidecar('en-GB'), 'utf8')]).toEqual([false, SRT]);
  });
});

describe('guards', () => {
  test('a protected track is never replaced', async () => {
    const { catalog, enrichment } = build({ metadata: info({ live_status: 'was_live', automaticCaptions: { en: automatic('en') } }) });
    fs.writeFileSync(sandbox.sidecar('en'), 'my hand-fixed caption');
    await scheduleFromDownload(catalog);
    await catalog.setProtection(YOUTUBE_ID, 'en', true);
    fetchResponses.push({ info: info({ subtitles: { en: uploaded('en') } }), files: { en: SRT } });
    clock = START.getTime() + HOUR;
    await enrichment.tick();
    expect(fs.readFileSync(sandbox.sidecar('en'), 'utf8')).toBe('my hand-fixed caption');
  });

  test('a shorter stored video (SponsorBlock cut) blocks publication', async () => {
    const { catalog, enrichment } = build({ probe: 90 });
    await scheduleFromDownload(catalog);
    fetchResponses.push({ info: info({ automaticCaptions: { en: automatic('en') } }), files: { en: SRT } });
    clock = START.getTime() + HOUR;
    await enrichment.tick();
    expect([fs.existsSync(sandbox.sidecar('en')), (await store.getJob(YOUTUBE_ID)).reason]).toEqual([false, expect.stringContaining('30.0 s shorter')]);
  });

  test('a newer media revision blocks the older check', async () => {
    const { catalog, enrichment, fetcher } = build();
    await scheduleFromDownload(catalog);
    fs.writeFileSync(sandbox.filePath, 'a re-downloaded synthetic video file');
    clock = START.getTime() + HOUR;
    await enrichment.tick();
    expect([fetcher.fetchCaptions.mock.calls.length, (await store.getJob(YOUTUBE_ID)).status]).toEqual([0, 'blocked']);
  });

  test('a check waits while a download is running, without counting an attempt', async () => {
    const { catalog, enrichment } = build({ busy: true });
    await scheduleFromDownload(catalog);
    clock = START.getTime() + HOUR;
    await enrichment.tick();
    expect(await store.getJob(YOUTUBE_ID)).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

describe('rate limiting', () => {
  async function twoDueChecks(enrichmentConfig) {
    const built = build({ config: enrichmentConfig });
    const second = { ...sandbox.video, youtubeId: 'bcdefghijkl' };
    store.videos.push(second);
    await scheduleFromDownload(built.catalog);
    await store.saveJob('bcdefghijkl', { ...(await store.getJob(YOUTUBE_ID)), youtube_id: 'bcdefghijkl', media_revision: null });
    clock = START.getTime() + HOUR;
    return built;
  }

  test('checks are spaced by the configured interval', async () => {
    const { enrichment } = await twoDueChecks({ captionEnrichmentMinIntervalSeconds: 90 });
    fetchResponses.push({ info: info() }, { info: { ...info(), id: 'bcdefghijkl' } });
    await enrichment.tick();
    expect(sleeps).toEqual([90000]);
  });

  test('a throttle response pauses every check without counting attempts', async () => {
    const { enrichment, fetcher } = await twoDueChecks();
    fetchResponses.push(new CaptionFetchError('throttled', 'YouTube is limiting requests'));
    await enrichment.tick();
    expect([fetcher.fetchCaptions.mock.calls.length, (await store.getJob(YOUTUBE_ID)).attempts, (await store.getJob('bcdefghijkl')).status])
      .toEqual([1, 0, 'pending']);
  });

  test('the next tick inside the pause does nothing', async () => {
    const { enrichment } = await twoDueChecks();
    fetchResponses.push(new CaptionFetchError('throttled', 'YouTube is limiting requests'));
    await enrichment.tick();
    expect(await enrichment.tick()).toEqual({ status: 'skipped', reason: 'throttled' });
  });

  test('a tick claims at most five checks', async () => {
    const { catalog, enrichment, fetcher } = build();
    await scheduleFromDownload(catalog);
    const template = await store.getJob(YOUTUBE_ID);
    for (let i = 0; i < 7; i++) {
      const id = `video${String(i).padStart(6, '0')}`;
      store.videos.push({ ...sandbox.video, youtubeId: id });
      await store.saveJob(id, { ...template, youtube_id: id, media_revision: null });
      fetchResponses.push({ info: { ...info(), id } });
    }
    fetchResponses.unshift({ info: info() });
    clock = START.getTime() + HOUR;
    await enrichment.tick();
    expect(fetcher.fetchCaptions).toHaveBeenCalledTimes(5);
  });
});

describe('exhaustion', () => {
  test('the last check ends with an actionable reason', async () => {
    const { catalog, enrichment } = build({ config: { captionEnrichmentRetrySchedule: '1h' } });
    await scheduleFromDownload(catalog);
    fetchResponses.push({ info: info() });
    clock = START.getTime() + HOUR;
    await enrichment.tick();
    expect(await store.getJob(YOUTUBE_ID)).toMatchObject({
      status: 'exhausted',
      reason: 'Stopped after 1 check: YouTube offers no en captions. Use "Check again" to look once more, or adjust the caption preferences.',
    });
  });

  test('restart recovery returns a running check to the queue unchanged', async () => {
    const { catalog, enrichment } = build();
    await scheduleFromDownload(catalog);
    await store.saveJob(YOUTUBE_ID, { status: 'running', lease_until: new Date(clock + HOUR) });
    await enrichment.start();
    enrichment.stop();
    expect(await store.getJob(YOUTUBE_ID)).toMatchObject({ status: 'pending', attempts: 0 });
  });
});

describe('a failed replacement', () => {
  async function failedUpgrade() {
    const { catalog, enrichment } = build({ metadata: info({ live_status: 'was_live', automaticCaptions: { en: automatic('en') } }) });
    fs.writeFileSync(sandbox.sidecar('en'), SRT);
    await scheduleFromDownload(catalog);
    const before = await store.listTracks(YOUTUBE_ID);
    fetchResponses.push({
      info: info({ live_status: 'was_live', subtitles: { 'en-GB': uploaded('en-GB') }, automaticCaptions: { en: automatic('en') } }),
      files: { 'en-GB': Buffer.from([0xff, 0xfe, 0x00, 0x41]) },
    });
    clock = START.getTime() + HOUR;
    await enrichment.tick();
    return before;
  }

  test('keeps the playable caption it would have replaced', async () => {
    await failedUpgrade();
    expect([fs.readFileSync(sandbox.sidecar('en'), 'utf8'), fs.existsSync(sandbox.sidecar('en-GB'))]).toEqual([SRT, false]);
  });

  test('leaves the caption rows unchanged', async () => {
    const before = await failedUpgrade();
    expect(await store.listTracks(YOUTUBE_ID)).toEqual(before);
  });
});

describe('downloads and publication', () => {
  test('a download starting during the rate-limit wait sends no request', async () => {
    const { catalog, enrichment, fetcher } = build({ onSleep: () => { state.busy = true; } });
    await scheduleFromDownload(catalog);
    clock = START.getTime() + HOUR;
    enrichment.lastFetchAt = clock;
    await enrichment.tick();
    expect([fetcher.fetchCaptions.mock.calls.length, (await store.getJob(YOUTUBE_ID)).attempts]).toEqual([0, 0]);
  });

  async function downloadDuringRequest() {
    const { catalog, enrichment } = build();
    await scheduleFromDownload(catalog);
    let signal;
    fetchResponses.push(({ signal: received }) => new Promise((resolve, reject) => {
      signal = received;
      state.busy = true;
      received.addEventListener('abort', () => reject(new CaptionFetchError('aborted', 'stopped')));
    }));
    clock = START.getTime() + HOUR;
    await enrichment.tick();
    return signal;
  }

  test('a download starting during the request stops it', async () => {
    expect((await downloadDuringRequest()).aborted).toBe(true);
  });

  test('a request stopped for a download returns to the queue without counting an attempt', async () => {
    await downloadDuringRequest();
    expect(await store.getJob(YOUTUBE_ID)).toMatchObject({ status: 'pending', attempts: 0 });
  });

  // Runs `during` right after publication planned its writes (its second
  // look at the sidecars), while it holds the lease.
  function duringPublication(catalog, during) {
    const original = catalog.describeOnDisk.bind(catalog);
    let calls = 0;
    jest.spyOn(catalog, 'describeOnDisk').mockImplementation(async (...args) => {
      const result = await original(...args);
      calls += 1;
      if (calls === 2) await during();
      return result;
    });
  }

  test('a media revision change inside publication writes nothing', async () => {
    const { catalog, enrichment } = build();
    await scheduleFromDownload(catalog);
    duringPublication(catalog, async () => fs.writeFileSync(sandbox.filePath, 'a re-downloaded synthetic video file'));
    fetchResponses.push({ info: info({ live_status: 'was_live', automaticCaptions: { en: automatic('en') } }), files: { en: SRT } });
    clock = START.getTime() + HOUR;
    await enrichment.tick();
    expect([fs.existsSync(sandbox.sidecar('en')), await store.getJob(YOUTUBE_ID)])
      .toEqual([false, expect.objectContaining({ status: 'blocked', attempts: 0 })]);
  });

  test('protection set after planning prevents the replacement', async () => {
    const { catalog, enrichment } = build({ metadata: info({ live_status: 'was_live', automaticCaptions: { en: automatic('en') } }) });
    fs.writeFileSync(sandbox.sidecar('en'), 'my hand-fixed caption');
    await scheduleFromDownload(catalog);
    duringPublication(catalog, async () => { store.tracks.get(`${YOUTUBE_ID}|en`).protected = true; });
    fetchResponses.push({ info: info({ subtitles: { en: uploaded('en') } }), files: { en: SRT } });
    clock = START.getTime() + HOUR;
    await enrichment.tick();
    expect(fs.readFileSync(sandbox.sidecar('en'), 'utf8')).toBe('my hand-fixed caption');
  });

  test('a download starting inside publication writes nothing and returns the check to the queue', async () => {
    const { catalog, enrichment } = build();
    await scheduleFromDownload(catalog);
    duringPublication(catalog, async () => { state.busy = true; });
    fetchResponses.push({ info: info({ live_status: 'was_live', automaticCaptions: { en: automatic('en') } }), files: { en: SRT } });
    clock = START.getTime() + HOUR;
    await enrichment.tick();
    expect([fs.existsSync(sandbox.sidecar('en')), await store.getJob(YOUTUBE_ID)])
      .toEqual([false, expect.objectContaining({ status: 'pending', attempts: 0 })]);
  });

  test('download finalization of the same video waits for publication to finish', async () => {
    const { catalog, enrichment } = build();
    await scheduleFromDownload(catalog);
    const events = [];
    let finalization;
    duringPublication(catalog, async () => {
      finalization = catalog.recordDownload({ youtubeId: YOUTUBE_ID, filePath: sandbox.filePath }).then(() => events.push('finalized'));
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push('publication continues');
    });
    fetchResponses.push({ info: info({ live_status: 'was_live', automaticCaptions: { en: automatic('en') } }), files: { en: SRT } });
    clock = START.getTime() + HOUR;
    await enrichment.tick();
    await finalization;
    expect(events).toEqual(['publication continues', 'finalized']);
  });
});


test.each([
  [{ captionSourcePolicy: 'uploaded-only' }, 'automatic'],
  [{ captionAllowTranslated: false }, 'translated'],
])('disallowed existing source remains wanted: %j', (config, source) => {
  const { enrichment } = build({ config });
  expect(enrichment.stillWanted([{ language: 'en', reason: 'not-downloaded' }], [{ code: 'en', source }]))
    .toEqual([{ language: 'en', reason: 'not-downloaded' }]);
});
