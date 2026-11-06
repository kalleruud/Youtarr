jest.mock('../../../db', () => {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  return { sequelize: { transaction: jest.fn(work => work(transaction)) }, transaction };
});
jest.mock('../../../models/acquisitionPolicy', () => ({
  findOne: jest.fn(),
  findAll: jest.fn(),
  create: jest.fn(),
  count: jest.fn(),
}));

const { UniqueConstraintError } = require('sequelize');
const AcquisitionPolicy = require('../../../models/acquisitionPolicy');
const store = require('../acquisitionPolicyStore');

const deadlock = () => Object.assign(new Error('Deadlock found'), { original: { code: 'ER_LOCK_DEADLOCK', errno: 1213 } });
const row = (values) => ({ ...values, update: jest.fn(function update(next) { Object.assign(this, next); }) });

beforeEach(() => jest.clearAllMocks());

describe('acquisitionPolicyStore.set', () => {
  test('creates the first selection at revision 1', async () => {
    AcquisitionPolicy.findOne.mockResolvedValue(null);
    AcquisitionPolicy.create.mockImplementation(async values => values);
    const result = await store.set('channel', 'UC1', { delivery: 'stream' });
    expect(result).toMatchObject({ delivery: 'stream', live: null, revision: 1 });
  });

  test('locks the row it updates', async () => {
    AcquisitionPolicy.findOne.mockResolvedValue(null);
    AcquisitionPolicy.create.mockImplementation(async values => values);
    await store.set('channel', 'UC1', { delivery: 'stream' });
    expect(AcquisitionPolicy.findOne).toHaveBeenCalledWith(expect.objectContaining({ lock: 'UPDATE' }));
  });

  test('changes only the given fields and bumps the revision', async () => {
    const existing = row({ delivery_policy: 'stream', live_policy: 'record', revision: 3 });
    AcquisitionPolicy.findOne.mockResolvedValue(existing);
    const result = await store.set('channel', 'UC1', { live: null });
    expect(result).toMatchObject({ delivery: 'stream', live: null, revision: 4 });
  });

  test('refuses a stale expected revision', async () => {
    AcquisitionPolicy.findOne.mockResolvedValue(row({ revision: 2 }));
    await expect(store.set('channel', 'UC1', { delivery: 'download' }, { expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT', currentRevision: 2 });
  });

  test('runs its queries once, outside the global query retry', async () => {
    AcquisitionPolicy.findOne.mockResolvedValue(null);
    AcquisitionPolicy.create.mockImplementation(async values => values);
    await store.set('channel', 'UC1', { delivery: 'stream' });
    expect(AcquisitionPolicy.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ retry: { max: 1 } }));
  });

  test('a first write that loses the creation race updates the row the winner created', async () => {
    const created = row({ delivery_policy: 'download', live_policy: null, revision: 1 });
    AcquisitionPolicy.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(created);
    AcquisitionPolicy.create.mockRejectedValueOnce(new UniqueConstraintError({}));
    const result = await store.set('channel', 'UC1', { delivery: 'stream' });
    expect(result).toMatchObject({ delivery: 'stream', revision: 2 });
  });

  test('a first write that loses the creation race to a deadlock is tried again', async () => {
    const created = row({ delivery_policy: 'download', live_policy: null, revision: 1 });
    AcquisitionPolicy.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(created);
    AcquisitionPolicy.create.mockRejectedValueOnce(deadlock());
    const result = await store.set('channel', 'UC1', { delivery: 'stream' });
    expect(result).toMatchObject({ delivery: 'stream', revision: 2 });
  });

  test('a write expecting no row reports a conflict after losing the creation race', async () => {
    AcquisitionPolicy.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce(row({ revision: 1 }));
    AcquisitionPolicy.create.mockRejectedValueOnce(deadlock());
    await expect(store.set('channel', 'UC1', { delivery: 'stream' }, { expectedRevision: 0 }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT', currentRevision: 1 });
  });

  test('a second lost creation race is reported as a revision conflict', async () => {
    AcquisitionPolicy.findOne.mockResolvedValue(null);
    AcquisitionPolicy.create.mockRejectedValue(new UniqueConstraintError({}));
    await expect(store.set('video', 'aaaaaaaaaaa', { delivery: 'stream' })).rejects.toBeInstanceOf(store.PolicyRevisionConflictError);
  });

  test('recognizes a deadlock by its error number', async () => {
    AcquisitionPolicy.findOne.mockResolvedValue(null);
    AcquisitionPolicy.create.mockRejectedValue(Object.assign(new Error('Deadlock found'), { original: { errno: 1213 } }));
    await expect(store.set('channel', 'UC1', { delivery: 'stream' })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
  });

  test('propagates any other database error without trying again', async () => {
    const failure = Object.assign(new Error('Lock wait timeout'), { original: { code: 'ER_LOCK_WAIT_TIMEOUT', errno: 1205 } });
    AcquisitionPolicy.findOne.mockResolvedValue(null);
    AcquisitionPolicy.create.mockRejectedValue(failure);
    await expect(store.set('channel', 'UC1', { delivery: 'stream' })).rejects.toBe(failure);
    expect(AcquisitionPolicy.create).toHaveBeenCalledTimes(1);
  });

  test('records the channel of a video override', async () => {
    AcquisitionPolicy.findOne.mockResolvedValue(null);
    AcquisitionPolicy.create.mockImplementation(async values => values);
    await store.set('video', 'aaaaaaaaaaa', { delivery: 'stream' }, { channelId: 'UC1' });
    expect(AcquisitionPolicy.create).toHaveBeenCalledWith(expect.objectContaining({ channel_id: 'UC1', subject_id: 'aaaaaaaaaaa' }), expect.anything());
  });
});

describe('acquisitionPolicyStore reads', () => {
  test('a subject without a row inherits everything at revision 0', async () => {
    AcquisitionPolicy.findOne.mockResolvedValue(null);
    expect(await store.getGlobal()).toEqual({ delivery: null, live: null, revision: 0, updatedAt: null });
  });

  test('getChannelPolicies keys policies by channel id', async () => {
    AcquisitionPolicy.findAll.mockResolvedValue([{ subject_id: 'UC1', delivery_policy: 'stream', live_policy: null, revision: 1 }]);
    const policies = await store.getChannelPolicies(['UC1', 'UC1', null]);
    expect(policies.get('UC1')).toMatchObject({ delivery: 'stream' });
  });

  test('getChannelPolicies skips the query for no channels', async () => {
    await store.getChannelPolicies([]);
    expect(AcquisitionPolicy.findAll).not.toHaveBeenCalled();
  });

  test('getVideoOverridesForChannels returns ids with their channel', async () => {
    AcquisitionPolicy.findAll.mockResolvedValue([{ subject_id: 'aaaaaaaaaaa', channel_id: 'UC1', delivery_policy: 'download', live_policy: null, revision: 2 }]);
    expect(await store.getVideoOverridesForChannels(['UC1'])).toEqual([
      expect.objectContaining({ youtubeId: 'aaaaaaaaaaa', channelId: 'UC1', delivery: 'download' }),
    ]);
  });
});
