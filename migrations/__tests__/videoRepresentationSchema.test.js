'use strict';

jest.mock('../helpers', () => ({
  createTableIfNotExists: jest.fn(),
  dropTableIfExists: jest.fn(),
  addIndexIfMissing: jest.fn(),
}));
const Sequelize = require('sequelize');
const { createTableIfNotExists, addIndexIfMissing } = require('../helpers');
const migration = require('../20261106204303-create-video-representations');

beforeEach(async () => {
  jest.clearAllMocks();
  await migration.up({}, Sequelize);
});

test('uses the shared table collation and explicit large-prefix row format', () => {
  expect(createTableIfNotExists.mock.calls.map(call => call[3])).toEqual(Array(3).fill({
    charset: 'utf8mb4', collate: 'utf8mb4_unicode_ci', rowFormat: 'DYNAMIC',
  }));
});

test('keeps YouTube identities binary and ordered dates precise to milliseconds', () => {
  for (const [, , columns] of createTableIfNotExists.mock.calls) {
    expect(columns.youtube_id.type.toSql()).toBe('VARCHAR(64) BINARY');
    for (const column of Object.values(columns)) {
      if (column.type instanceof Sequelize.DATE) expect(column.type.options.length).toBe(3);
    }
  }
});

test('the subject index fits the 3072-byte DYNAMIC limit', () => {
  const [, , columns] = createTableIfNotExists.mock.calls[2];
  const [, , fields] = addIndexIfMissing.mock.calls.find(call => call[3].name === 'watch_state_carryover_subject_uq');
  const bytes = fields.reduce((total, field) => total + (columns[field].type instanceof Sequelize.STRING
    ? columns[field].type.options.length * 4 : 4), 0);
  expect(bytes).toBe(832);
  expect(bytes).toBeLessThanOrEqual(3072);
});
