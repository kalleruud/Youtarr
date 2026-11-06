const migration = require('../20261106084206-create-episode-assignments');

test('migration only adds identity tables and a unique episode index', async () => {
  const tables = ['videos', 'jobvideos', 'channels', 'channelvideos'];
  const q = {
    showAllTables: jest.fn(async () => tables),
    createTable: jest.fn(async name => { tables.push(name); }),
    showIndex: jest.fn(async () => []),
    addIndex: jest.fn(),
  };
  await migration.up(q, { STRING: () => 'STRING', INTEGER: 'INTEGER' });
  expect(q.createTable.mock.calls.map(call => call[0])).toEqual(['episode_shows', 'episode_assignments']);
  expect(q.addIndex).toHaveBeenCalledWith('episode_assignments', ['channel_id', 'season', 'episode'], expect.objectContaining({ unique: true }));
  expect(tables).toEqual(expect.arrayContaining(['videos', 'jobvideos', 'channels', 'channelvideos']));
});
