const { resolveAcquisitionPolicy } = require('../resolveAcquisitionPolicy');
const { CAPABILITIES } = require('../capabilities');
const { DELIVERY_POLICIES, LIVE_POLICIES } = require('../policyValues');

const ALL = { download: true, stream: true, livePlayback: true, liveRecording: true };

const resolve = (input) => resolveAcquisitionPolicy({ capabilities: ALL, ...input });

describe('precedence', () => {
  test.each([
    ['built-in default', {}, 'download', 'default', 'replay', 'default'],
    ['global over default', { global: { delivery: 'stream', live: 'ignore' } }, 'stream', 'global', 'ignore', 'global'],
    ['channel over global', { global: { delivery: 'stream', live: 'ignore' }, channel: { delivery: 'download', live: 'record' } }, 'download', 'channel', 'record', 'channel'],
    ['video over channel', { channel: { delivery: 'download', live: 'record' }, video: { delivery: 'stream', live: 'play' } }, 'stream', 'video', 'play', 'video'],
    ['null inherits', { global: { delivery: 'stream' }, channel: { delivery: null }, video: { delivery: null } }, 'stream', 'global', 'replay', 'default'],
    ['fields inherit independently', { global: { live: 'record' }, channel: { delivery: 'stream' } }, 'stream', 'channel', 'record', 'global'],
  ])('%s', (_name, layers, delivery, deliverySource, live, liveSource) => {
    const { effectivePolicy } = resolve({ ...layers, contentKind: 'video', sourceState: 'available' });
    expect(effectivePolicy).toEqual({ delivery, live, sources: { delivery: deliverySource, live: liveSource } });
  });

  test('an invalid value at the winning layer fails closed', () => {
    const result = resolve({ global: { delivery: 'download' }, video: { delivery: 'bogus' }, contentKind: 'video', sourceState: 'available' });
    expect(result).toMatchObject({ plannedActions: [], jobAction: null });
    expect(result.reasons).toEqual([expect.objectContaining({ code: 'invalid_policy', field: 'delivery', source: 'video' })]);
  });
});

// Every content kind x source state x policy combination for automatic sweeps.
const NORMAL_CASES = [];
for (const contentKind of ['video', 'short']) {
  for (const delivery of DELIVERY_POLICIES) {
    NORMAL_CASES.push([contentKind, delivery, 'available', [delivery], null]);
    NORMAL_CASES.push([contentKind, delivery, 'unavailable', [], 'source_unavailable']);
    NORMAL_CASES.push([contentKind, delivery, 'upcoming', [], 'source_not_ready']);
  }
}

describe('normal videos and Shorts (automatic)', () => {
  test.each(NORMAL_CASES)('%s with delivery=%s in state %s', (contentKind, delivery, sourceState, actions, reason) => {
    const result = resolve({ channel: { delivery }, contentKind, sourceState });
    expect(result.plannedActions).toEqual(actions);
    expect(result.reasons.map(r => r.code)).toEqual(reason ? [reason] : []);
  });

  test('only download produces a queued job', () => {
    expect(resolve({ channel: { delivery: 'download' }, contentKind: 'video', sourceState: 'available' }).jobAction).toBe('download');
    expect(resolve({ channel: { delivery: 'stream' }, contentKind: 'video', sourceState: 'available' }).jobAction).toBeNull();
  });
});

const LIVE_TABLE = {
  // live policy: [upcoming, live, replay] planned actions (delivery = download)
  ignore: [[], [], []],
  replay: [[], [], ['download']],
  play: [[], ['livePlayback'], ['download']],
  record: [[], ['liveRecording'], ['download']],
  play_and_record: [[], ['livePlayback', 'liveRecording'], ['download']],
};
const LIVE_CASES = LIVE_POLICIES.flatMap(live => ['upcoming', 'live', 'replay']
  .map((sourceState, i) => [live, sourceState, LIVE_TABLE[live][i]]));

describe('livestreams (automatic)', () => {
  test.each(LIVE_CASES)('live=%s in state %s', (live, sourceState, actions) => {
    expect(resolve({ channel: { live }, contentKind: 'livestream', sourceState }).plannedActions).toEqual(actions);
  });

  test.each(LIVE_POLICIES)('live=%s: an unavailable broadcast is a source problem, not a policy exclusion', (live) => {
    const result = resolve({ channel: { live }, contentKind: 'livestream', sourceState: 'unavailable' });
    expect(result.reasons.map(r => r.code)).toEqual(['source_unavailable']);
  });

  test('ignore is reported as a policy exclusion', () => {
    const result = resolve({ channel: { live: 'ignore' }, contentKind: 'livestream', sourceState: 'replay' });
    expect(result.reasons.map(r => r.code)).toEqual(['policy_excluded']);
  });

  test('a replay follows the delivery policy', () => {
    const result = resolve({ channel: { delivery: 'stream', live: 'record' }, contentKind: 'livestream', sourceState: 'replay' });
    expect(result.plannedActions).toEqual(['stream']);
  });

  test('live playback plus recording plans one logical item with a single job', () => {
    const result = resolve({ channel: { live: 'play_and_record' }, contentKind: 'livestream', sourceState: 'live', youtubeId: 'abcdefghijk' });
    expect(result).toMatchObject({ logicalItem: 'abcdefghijk', jobAction: 'liveRecording' });
  });

  test('the later replay of a recorded broadcast keeps the same logical item', () => {
    const live = resolve({ channel: { live: 'record' }, contentKind: 'livestream', sourceState: 'live', youtubeId: 'abcdefghijk' });
    const replay = resolve({ channel: { live: 'record' }, contentKind: 'livestream', sourceState: 'replay', youtubeId: 'abcdefghijk' });
    expect([live.logicalItem, replay.logicalItem]).toEqual(['abcdefghijk', 'abcdefghijk']);
  });
});

describe('capabilities', () => {
  test('unavailable stream capability explains itself and queues nothing', () => {
    const result = resolveAcquisitionPolicy({ channel: { delivery: 'stream' }, contentKind: 'video', sourceState: 'available', capabilities: CAPABILITIES });
    expect(result.plannedActions).toEqual([]);
    expect(result.reasons).toEqual([{ code: 'capability_unavailable', action: 'stream', message: CAPABILITIES.stream.reason }]);
  });

  test('an unknown capability is reported as unknown with an action to take', () => {
    const result = resolveAcquisitionPolicy({ contentKind: 'video', sourceState: 'available', capabilities: {} });
    expect(result.reasons).toEqual([expect.objectContaining({ code: 'capability_unknown', action: 'download', message: expect.stringMatching(/Update Youtarr or choose another policy/) })]);
  });

  test('a missing recording capability does not block supported live playback', () => {
    const result = resolveAcquisitionPolicy({ channel: { live: 'play_and_record' }, contentKind: 'livestream', sourceState: 'live', capabilities: { livePlayback: true, liveRecording: false } });
    expect(result.plannedActions).toEqual(['livePlayback']);
    expect(result.reasons.map(r => [r.code, r.action])).toEqual([['capability_unavailable', 'liveRecording']]);
  });

  test('unsupported live modes are reported before the broadcast starts', () => {
    const result = resolveAcquisitionPolicy({ channel: { live: 'record' }, contentKind: 'livestream', sourceState: 'upcoming', capabilities: CAPABILITIES });
    expect(result.reasons.map(r => r.code)).toEqual(['waiting_for_broadcast', 'capability_unavailable']);
  });

  test('the shipped capabilities download replays under any non-ignore live mode', () => {
    const plans = ['replay', 'play', 'record', 'play_and_record'].map(live => resolveAcquisitionPolicy({
      channel: { live }, contentKind: 'livestream', sourceState: 'replay', capabilities: CAPABILITIES,
    }).jobAction);
    expect(plans).toEqual(['download', 'download', 'download', 'download']);
  });
});

describe('manual downloads', () => {
  test.each([
    ['a video on a stream channel', { channel: { delivery: 'stream' } }, 'video', 'available'],
    ['a Short with a stream override', { video: { delivery: 'stream' } }, 'short', 'available'],
    ['a replay on a channel ignoring livestreams', { channel: { live: 'ignore' } }, 'livestream', 'replay'],
  ])('%s stays eligible for a manual download', (_name, layers, contentKind, sourceState) => {
    const result = resolveAcquisitionPolicy({ ...layers, contentKind, sourceState, capabilities: CAPABILITIES, trigger: 'manual' });
    expect(result.jobAction).toBe('download');
  });

  test('a broadcast still live cannot be downloaded manually yet', () => {
    const result = resolve({ contentKind: 'livestream', sourceState: 'live', trigger: 'manual' });
    expect(result.reasons.map(r => r.code)).toEqual(['source_not_ready']);
  });
});

describe('content-kind filters and invalid input', () => {
  test('a kind excluded by the channel tabs is filtered', () => {
    const result = resolve({ contentKind: 'short', sourceState: 'available', contentKindEnabled: false });
    expect(result.reasons.map(r => r.code)).toEqual(['content_kind_filtered']);
  });

  test('an explicit video override wins over the tab filter', () => {
    const result = resolve({ video: { delivery: 'download' }, contentKind: 'short', sourceState: 'available', contentKindEnabled: false });
    expect(result.plannedActions).toEqual(['download']);
  });

  test('unknown content kinds cannot schedule anything', () => {
    const result = resolve({ contentKind: 'podcast', sourceState: 'available' });
    expect(result.reasons.map(r => r.code)).toEqual(['unknown_content_kind']);
  });

  test('no policy combination plans anything but acquisition or playback', () => {
    const actions = new Set();
    for (const delivery of DELIVERY_POLICIES) {
      for (const live of LIVE_POLICIES) {
        for (const contentKind of ['video', 'short', 'livestream']) {
          for (const sourceState of ['available', 'unavailable', 'upcoming', 'live', 'replay']) {
            resolve({ channel: { delivery, live }, contentKind, sourceState }).plannedActions.forEach(a => actions.add(a));
          }
        }
      }
    }
    expect([...actions].sort()).toEqual(['download', 'liveRecording', 'livePlayback', 'stream'].sort());
  });
});
