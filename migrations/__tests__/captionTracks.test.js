const migration = require('../20261106203537-create-caption-tracks');

const S = { STRING: () => 'STRING', BOOLEAN: 'BOOLEAN', INTEGER: 'INTEGER', DATE: 'DATE', TEXT: 'TEXT' };

function queryInterface(tables) {
  return {
    showAllTables: jest.fn(async () => tables),
    createTable: jest.fn(async (name) => { tables.push(name); }),
    showIndex: jest.fn(async () => []),
    addIndex: jest.fn(async () => {}),
  };
}

test('migration only adds the caption tables', async () => {
  const q = queryInterface(['videos', 'channels']);
  await migration.up(q, S);
  expect(q.createTable.mock.calls.map((call) => call[0])).toEqual(['caption_tracks', 'caption_enrichment_jobs']);
});

test('migration is idempotent when the tables already exist', async () => {
  const q = queryInterface(['caption_tracks', 'caption_enrichment_jobs']);
  q.showIndex.mockResolvedValue([
    { name: 'caption_tracks_video_code' }, { name: 'caption_enrichment_jobs_video' }, { name: 'caption_enrichment_jobs_due' },
  ]);
  await migration.up(q, S);
  expect([q.createTable.mock.calls.length, q.addIndex.mock.calls.length]).toEqual([0, 0]);
});
