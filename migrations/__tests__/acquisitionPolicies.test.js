const migration = require('../20261106104340-create-acquisition-policies');

const S = { STRING: () => 'STRING', INTEGER: 'INTEGER', DATE: 'DATE' };

const fakeQueryInterface = (tables) => ({
  showAllTables: jest.fn(async () => tables),
  createTable: jest.fn(async name => { tables.push(name); }),
  showIndex: jest.fn(async () => []),
  addIndex: jest.fn(),
  dropTable: jest.fn(),
  addColumn: jest.fn(),
  changeColumn: jest.fn(),
  removeColumn: jest.fn(),
});

test('migration only adds the acquisition_policies table', async () => {
  const q = fakeQueryInterface(['videos', 'channels', 'channelvideos', 'jobvideos']);
  await migration.up(q, S);
  expect(q.createTable.mock.calls.map(call => call[0])).toEqual(['acquisition_policies']);
  expect([q.addColumn, q.changeColumn, q.removeColumn, q.dropTable].map(fn => fn.mock.calls.length)).toEqual([0, 0, 0, 0]);
});

test('each scope subject has at most one policy row', async () => {
  const q = fakeQueryInterface([]);
  await migration.up(q, S);
  expect(q.addIndex).toHaveBeenCalledWith('acquisition_policies', ['scope', 'subject_id'], expect.objectContaining({ unique: true }));
});

test('re-running the migration is a no-op', async () => {
  const q = fakeQueryInterface(['acquisition_policies']);
  q.showIndex.mockResolvedValue([
    { name: 'acquisition_policy_subject_uq', fields: [{ attribute: 'scope' }, { attribute: 'subject_id' }] },
    { name: 'acquisition_policy_channel_idx', fields: [{ attribute: 'scope' }, { attribute: 'channel_id' }] },
  ]);
  await migration.up(q, S);
  expect([q.createTable.mock.calls.length, q.addIndex.mock.calls.length]).toEqual([0, 0]);
});
