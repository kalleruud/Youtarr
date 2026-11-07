jest.mock('../../../db', () => {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  return { sequelize: { transaction: jest.fn(work => work(transaction)) }, transaction };
});
jest.mock('../../../models/videoRepresentation', () => ({ findAll: jest.fn(), findOne: jest.fn(), create: jest.fn() }));
jest.mock('../../../models/videoRepresentationHead', () => ({ findByPk: jest.fn(), bulkCreate: jest.fn(), update: jest.fn() }));

const { UniqueConstraintError, Op } = require('sequelize');
const VideoRepresentation = require('../../../models/videoRepresentation');
const Head = require('../../../models/videoRepresentationHead');
const store = require('../representationStore');

const lease = { youtubeId: 'vid12345678', owner: 'me', operation: 'download-promotion' };
const row = (values) => ({ ...values, update: jest.fn(async function update(next) { Object.assign(this, next); }) });

beforeEach(() => {
  jest.clearAllMocks();
  Head.bulkCreate.mockResolvedValue([]);
});

describe('renewLease', () => {
  test('extends a lease the caller still owns', async () => {
    Head.update.mockResolvedValue([1]);
    await store.renewLease(lease);
    expect(Head.update.mock.calls[0][1].where).toEqual({ youtube_id: 'vid12345678', lease_owner: 'me' });
  });

  test('accepts a renewal that changed nothing while the caller still owns the lease', async () => {
    Head.update.mockResolvedValue([0]);
    Head.findByPk.mockResolvedValue({ lease_owner: 'me' });
    await expect(store.renewLease(lease)).resolves.toBeUndefined();
  });

  test('reports a lease another operation took over', async () => {
    Head.update.mockResolvedValue([0]);
    Head.findByPk.mockResolvedValue({ lease_owner: 'other' });
    await expect(store.renewLease(lease)).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
});

describe('lease expiry on the database clock', () => {
  const sql = (value) => value && value.val;

  test('a claim sets the expiry from the database clock', async () => {
    Head.update.mockResolvedValue([1]);
    await store.acquireLease('vid12345678', 'eviction');
    expect(sql(Head.update.mock.calls[0][0].lease_expires_at)).toBe('UTC_TIMESTAMP(3) + INTERVAL 300000000 MICROSECOND');
  });

  test('a claim takes over only a lease expired by the database clock', async () => {
    Head.update.mockResolvedValue([1]);
    await store.acquireLease('vid12345678', 'eviction');
    const expired = Head.update.mock.calls[0][1].where[Op.or][2];
    expect(sql(expired.lease_expires_at[Op.lt])).toBe('UTC_TIMESTAMP(3)');
  });

  test('a renewal extends the lease from the database clock', async () => {
    Head.update.mockResolvedValue([1]);
    await store.renewLease(lease);
    expect(sql(Head.update.mock.calls[0][0].lease_expires_at)).toBe('UTC_TIMESTAMP(3) + INTERVAL 1800000000 MICROSECOND');
  });
});

describe('listDuplicateCandidates', () => {
  const findLibraryFiles = jest.fn();

  test('runs one query and nothing else when no STRM entry is published', async () => {
    VideoRepresentation.findAll.mockResolvedValueOnce([]);
    expect([await store.listDuplicateCandidates({ findLibraryFiles }), VideoRepresentation.findAll.mock.calls.length, findLibraryFiles.mock.calls.length])
      .toEqual([[], 1, 0]);
  });

  test('lists published episodes with a recorded or library local copy', async () => {
    VideoRepresentation.findAll
      .mockResolvedValueOnce([{ youtube_id: 'a' }, { youtube_id: 'b' }, { youtube_id: 'c' }])
      .mockResolvedValueOnce([{ youtube_id: 'a', location: '/x/a.mp4' }]);
    findLibraryFiles.mockResolvedValue(new Map([['b', '/x/b.mp4']]));
    expect(await store.listDuplicateCandidates({ findLibraryFiles })).toEqual([
      { youtubeId: 'a', localLocations: ['/x/a.mp4'] }, { youtubeId: 'b', localLocations: ['/x/b.mp4'] },
    ]);
  });
});

describe('listStreamEntries', () => {
  test('lists published STRM locations and every video with a STRM record', async () => {
    VideoRepresentation.findAll.mockResolvedValue([
      { youtube_id: 'a', state: 'published', location: '/x/a.strm' },
      { youtube_id: 'b', state: 'retired', location: '/x/b.strm' },
    ]);
    const { published, youtubeIds } = await store.listStreamEntries();
    expect([[...published], [...youtubeIds]]).toEqual([[['a', '/x/a.strm']], ['a', 'b']]);
  });
});

describe('acquireLease', () => {
  test('claims a free or expired lease with a conditional update', async () => {
    Head.update.mockResolvedValue([1]);
    const result = await store.acquireLease('vid12345678', 'eviction');
    expect([result.operation, Head.update.mock.calls[0][1].where.youtube_id]).toEqual(['eviction', 'vid12345678']);
  });

  test('reports a busy lease once the wait runs out', async () => {
    Head.update.mockResolvedValue([0]);
    Head.findByPk.mockResolvedValue({ revision: 1, lease_owner: 'other', lease_operation: 'stream-publication', lease_expires_at: new Date(Date.now() + 60000) });
    await expect(store.acquireLease('vid12345678', 'eviction')).rejects.toMatchObject({
      code: 'LEASE_BUSY', holder: expect.objectContaining({ operation: 'stream-publication' }),
    });
  });

  test('waits for a holder to release the lease', async () => {
    Head.update.mockResolvedValueOnce([0]).mockResolvedValueOnce([1]);
    await store.acquireLease('vid12345678', 'eviction', { waitMs: 5000 });
    expect(Head.update).toHaveBeenCalledTimes(2);
  });

  test('tolerates a concurrent first creation of the head row', async () => {
    Head.bulkCreate.mockRejectedValue(new UniqueConstraintError({}));
    Head.update.mockResolvedValue([1]);
    await expect(store.acquireLease('vid12345678', 'eviction')).resolves.toMatchObject({ youtubeId: 'vid12345678' });
  });

  test('creates the head row with INSERT IGNORE', async () => {
    Head.update.mockResolvedValue([1]);
    await store.acquireLease('vid12345678', 'eviction');
    expect(Head.bulkCreate).toHaveBeenCalledWith([expect.objectContaining({ youtube_id: 'vid12345678' })], expect.objectContaining({ ignoreDuplicates: true }));
  });

  test('retries a head row insert that lost a deadlock once', async () => {
    Head.bulkCreate.mockRejectedValueOnce(Object.assign(new Error('deadlock'), { original: { code: 'ER_LOCK_DEADLOCK' } })).mockResolvedValueOnce([]);
    Head.update.mockResolvedValue([1]);
    await store.acquireLease('vid12345678', 'eviction');
    expect(Head.bulkCreate).toHaveBeenCalledTimes(2);
  });
});

describe('releaseLease', () => {
  test('releases only a lease the caller still owns', async () => {
    await store.releaseLease(lease);
    expect(Head.update.mock.calls[0][1].where).toEqual({ youtube_id: 'vid12345678', lease_owner: 'me' });
  });
});

describe('record', () => {
  test('creates a representation and bumps the episode revision', async () => {
    const head = row({ lease_owner: 'me', revision: 2 });
    Head.findByPk.mockResolvedValue(head);
    VideoRepresentation.findOne.mockResolvedValue(null);
    VideoRepresentation.create.mockImplementation(async values => ({ id: 5, ...values }));
    const result = await store.record(lease, { kind: 'local', state: 'verified', location: '/a [x].mp4', sizeBytes: 3, verified: true });
    expect([result.changed, result.revision, result.representation.kind]).toEqual([true, 3, 'local']);
  });

  test('changes nothing when the representation is already recorded as given', async () => {
    Head.findByPk.mockResolvedValue(row({ lease_owner: 'me', revision: 2 }));
    VideoRepresentation.findOne.mockResolvedValue(row({ id: 5, kind: 'local', state: 'verified', location: '/a', size_bytes: '3', detail: null, revision: 1 }));
    const result = await store.record(lease, { kind: 'local', state: 'verified', location: '/a', sizeBytes: 3 });
    expect([result.changed, result.revision]).toEqual([false, 2]);
  });

  test('refuses a write after the lease was taken over', async () => {
    Head.findByPk.mockResolvedValue(row({ lease_owner: 'someone-else', revision: 2 }));
    await expect(store.record(lease, { kind: 'local', state: 'verified' })).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });

  test('refuses a write against a stale revision', async () => {
    Head.findByPk.mockResolvedValue(row({ lease_owner: 'me', revision: 4 }));
    await expect(store.record(lease, { kind: 'local', state: 'evicted' }, { expectedRevision: 3 }))
      .rejects.toMatchObject({ code: 'REVISION_CONFLICT', currentRevision: 4 });
  });

  test('runs its queries once, outside the global query retry', async () => {
    Head.findByPk.mockResolvedValue(row({ lease_owner: 'me', revision: 0 }));
    VideoRepresentation.findOne.mockResolvedValue(null);
    VideoRepresentation.create.mockImplementation(async values => ({ id: 1, ...values }));
    await store.record(lease, { kind: 'strm', state: 'published', location: '/a [x].strm' });
    expect(VideoRepresentation.create).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ retry: { max: 1 } }));
  });
});

describe('select', () => {
  test('refuses a representation of another video', async () => {
    Head.findByPk.mockResolvedValue(row({ lease_owner: 'me', revision: 1 }));
    VideoRepresentation.findOne.mockResolvedValue(null);
    await expect(store.select(lease, 9)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  test('stores the selection and bumps the revision', async () => {
    const head = row({ lease_owner: 'me', revision: 1, selected_representation_id: null });
    Head.findByPk.mockResolvedValue(head);
    VideoRepresentation.findOne.mockResolvedValue({ id: 9 });
    await store.select(lease, 9);
    expect([head.selected_representation_id, head.revision]).toEqual([9, 2]);
  });
});

describe('getHead', () => {
  test('reports no lease once it expired', async () => {
    Head.findByPk.mockResolvedValue({ revision: 3, selected_representation_id: null, lease_owner: 'x', lease_expires_at: new Date(Date.now() - 1000) });
    expect(await store.getHead('vid12345678')).toEqual({ revision: 3, selectedRepresentationId: null, lease: null });
  });
});
