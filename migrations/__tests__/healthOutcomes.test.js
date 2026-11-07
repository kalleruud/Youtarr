const migration = require('../20261106204350-create-health-outcomes');

const S = { STRING: () => 'STRING', INTEGER: 'INTEGER', DATE: 'DATE', BOOLEAN: 'BOOLEAN', TEXT: 'TEXT' };

const fakeQueryInterface = (tables) => ({
  showAllTables: jest.fn(async () => tables),
  createTable: jest.fn(async name => { tables.push(name); }),
  showIndex: jest.fn(async () => []),
  addIndex: jest.fn(),
  dropTable: jest.fn(),
  addColumn: jest.fn(),
  changeColumn: jest.fn(),
  removeColumn: jest.fn(),
  addConstraint: jest.fn(),
});

test('migration only adds the health_outcomes table, without foreign keys', async () => {
  const q = fakeQueryInterface(['videos', 'jobs']);
  await migration.up(q, S);
  expect(q.createTable.mock.calls.map(call => call[0])).toEqual(['health_outcomes']);
  expect([q.addColumn, q.changeColumn, q.removeColumn, q.dropTable, q.addConstraint].map(fn => fn.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
});

test('each video stage has at most one outcome row', async () => {
  const q = fakeQueryInterface([]);
  await migration.up(q, S);
  expect(q.addIndex).toHaveBeenCalledWith('health_outcomes', ['youtube_id', 'stage'], expect.objectContaining({ unique: true }));
});

test('re-running the migration is a no-op', async () => {
  const q = fakeQueryInterface(['health_outcomes']);
  q.showIndex.mockResolvedValue([
    { name: 'health_outcome_video_stage_uq', fields: [{ attribute: 'youtube_id' }, { attribute: 'stage' }] },
    { name: 'health_outcome_status_updated_idx', fields: [{ attribute: 'status' }, { attribute: 'updated_at' }] },
  ]);
  await migration.up(q, S);
  expect([q.createTable.mock.calls.length, q.addIndex.mock.calls.length]).toEqual([0, 0]);
});

test('down drops only the new table', async () => {
  const q = fakeQueryInterface(['health_outcomes', 'videos']);
  await migration.down(q);
  expect(q.dropTable.mock.calls.map(call => call[0])).toEqual(['health_outcomes']);
});
