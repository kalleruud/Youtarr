const migration = require('../20261106104507-create-channel-artworks');

const S = { STRING: () => 'STRING', BOOLEAN: 'BOOLEAN', INTEGER: 'INTEGER', DATE: 'DATE' };

test('migration only adds the channel_artworks table', async () => {
  const tables = ['channels', 'videos'];
  const q = {
    showAllTables: jest.fn(async () => tables),
    createTable: jest.fn(async (name) => { tables.push(name); }),
  };
  await migration.up(q, S);
  expect(q.createTable.mock.calls.map((call) => call[0])).toEqual(['channel_artworks']);
});

test('migration is idempotent when the table already exists', async () => {
  const q = {
    showAllTables: jest.fn(async () => ['channel_artworks']),
    createTable: jest.fn(),
  };
  await migration.up(q, S);
  expect(q.createTable).not.toHaveBeenCalled();
});
