const dbModule = require('../../db/database');

describe('Simple Progress Test', () => {
  test('should have progress functions exported', () => {
    console.log('Available functions:', Object.keys(dbModule));
    console.log('addVideoProgress type:', typeof dbModule.addVideoProgress);
    
    expect(dbModule.addVideoProgress).toBeDefined();
    expect(typeof dbModule.addVideoProgress).toBe('function');
    expect(dbModule.getVideoProgress).toBeDefined();
    expect(typeof dbModule.getVideoProgress).toBe('function');
    expect(dbModule.updateVideoProgress).toBeDefined();
    expect(typeof dbModule.updateVideoProgress).toBe('function');
    expect(dbModule.deleteVideoProgress).toBeDefined();
    expect(typeof dbModule.deleteVideoProgress).toBe('function');
    expect(dbModule.getBatchVideoProgress).toBeDefined();
    expect(typeof dbModule.getBatchVideoProgress).toBe('function');
  });
});