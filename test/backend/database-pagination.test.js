describe('getVideosPaginated', () => {
  let getVideosPaginated;
  let getVideosByIds;

  beforeEach(() => {
    jest.resetModules();
    jest.unmock('../../db/database');
    ({ getVideosPaginated, getVideosByIds } = require('../../db/database'));
  });

  test('uses projected columns instead of SELECT *', async () => {
    const db = {
      get: jest.fn((_query, _params, callback) => callback(null, { totalCount: 1 })),
      all: jest.fn((query, _params, callback) => callback(null, [{ id: 1, title: 'A' }]))
    };

    const result = await getVideosPaginated(db, 1, 20, null, 'date_added_desc');

    expect(db.all).toHaveBeenCalledTimes(1);
    const calledQuery = db.all.mock.calls[0][0];
    expect(calledQuery).toContain('SELECT id, title, path, duration, width, height, added_date, thumbnail_path');
    expect(calledQuery).toContain('preview_clips');
    expect(calledQuery).not.toContain('SELECT *');
    expect(result.totalCount).toBe(1);
    expect(result.videos).toHaveLength(1);
  });

  test('applies search filters to count and list queries', async () => {
    const db = {
      get: jest.fn((_query, _params, callback) => callback(null, { totalCount: 2 })),
      all: jest.fn((_query, _params, callback) => callback(null, [{ id: 1 }, { id: 2 }]))
    };

    await getVideosPaginated(db, 2, 10, 'm+ run', 'title_asc');

    expect(db.get.mock.calls[0][0]).toContain('WHERE title LIKE ? COLLATE NOCASE');
    expect(db.all.mock.calls[0][0]).toContain('WHERE title LIKE ? COLLATE NOCASE');
    expect(db.all.mock.calls[0][0]).toContain('ORDER BY title COLLATE NOCASE ASC');
    expect(db.all.mock.calls[0][1]).toEqual(['%m+ run%', 10, 10]);
  });
});

describe('getVideosByIds', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.unmock('../../db/database');
    ({ getVideosByIds } = require('../../db/database'));
  });

  test('skips the database for an empty page', async () => {
    const db = { all: jest.fn() };
    await expect(getVideosByIds(db, [])).resolves.toEqual([]);
    expect(db.all).not.toHaveBeenCalled();
  });

  test('uses one parameterized projected query', async () => {
    const rows = [{ id: 2 }, { id: 1 }];
    const db = {
      all: jest.fn((_query, _ids, callback) => callback(null, rows))
    };

    await expect(getVideosByIds(db, [1, 2])).resolves.toEqual(rows);
    expect(db.all).toHaveBeenCalledTimes(1);
    expect(db.all.mock.calls[0][0]).toContain('WHERE id IN (?, ?)');
    expect(db.all.mock.calls[0][0]).not.toContain('SELECT *');
    expect(db.all.mock.calls[0][1]).toEqual([1, 2]);
  });
});
