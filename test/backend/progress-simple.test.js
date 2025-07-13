const path = require('path');

// Directly require from the database module
const databasePath = path.resolve(__dirname, '../../db/database.js');
delete require.cache[databasePath]; // Clear any cached version
const db = require(databasePath);

describe('Progress Database Functions Test', () => {
  test('exports should include progress functions', () => {
    console.log('Database module exports:', Object.keys(db));
    
    expect(db).toHaveProperty('addVideoProgress');
    expect(db).toHaveProperty('getVideoProgress');
    expect(db).toHaveProperty('updateVideoProgress');
    expect(db).toHaveProperty('deleteVideoProgress');
    expect(db).toHaveProperty('getBatchVideoProgress');
    
    expect(typeof db.addVideoProgress).toBe('function');
    expect(typeof db.getVideoProgress).toBe('function');
    expect(typeof db.updateVideoProgress).toBe('function');
    expect(typeof db.deleteVideoProgress).toBe('function');
    expect(typeof db.getBatchVideoProgress).toBe('function');
  });
});