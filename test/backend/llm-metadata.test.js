// lib/llm.js: metadata is parsed once per row (not inside the sort
// comparator), all stored formats work, and the input is not mutated.
const OpenRouterClient = require('../../lib/llm');

const rows = [
  {
    id: 1,
    title: 'Legacy full blob',
    added_date: '2025-01-01T00:00:00.000Z',
    metadata: JSON.stringify({ category: 'Raids', encounterID: 1, difficulty: 'M', start: 1757626649000, duration: 1059, deaths: [{ name: 'A', timestamp: 48.99 }], combatants: [] })
  },
  {
    id: 2,
    title: 'Slim stored row',
    added_date: '2025-01-01T00:00:00.000Z',
    metadata: JSON.stringify({ slim: 1, start: 1790160663350, duration: 58.1, zone: 'Unknown Raid', encounter: 'Sszorak', deaths: [{ name: 'Evandeux', timestamp: 14.1 }] })
  },
  {
    id: 3,
    title: 'Unmigrated schema v1 row',
    added_date: '2025-01-01T00:00:00.000Z',
    metadata: JSON.stringify({ schema_version: 1, start_unix_ms: 1788616628001, duration_ms: 1821351, details: { dungeon_name: 'Pit of Saron', keystone_level: 23 }, timeline: [{ kind: 'death', start_ms: 803409, label: 'Qweekm' }], meter: { fights: [] } })
  },
  { id: 4, title: 'Broken', added_date: '2025-01-01T00:00:00.000Z', metadata: '{not json' }
];

describe('OpenRouterClient metadata handling', () => {
  let client;

  beforeEach(() => {
    process.env.OPENROUTER_API_KEY = 'test-key';
    client = new OpenRouterClient();
  });

  afterEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    jest.restoreAllMocks();
  });

  test('parses each row once, sorts newest first, matches the LLM answer back', async () => {
    const input = [...rows];
    const snapshot = input.map((row) => row.id);
    let prompt = '';
    jest.spyOn(client, 'makeRequest').mockImplementation(async (_endpoint, data) => {
      prompt = data.messages[0].content;
      return {
        choices: [{
          message: {
            content: JSON.stringify([
              { date: new Date(1788616628001).toISOString(), duration: 1821.4, reason: 'Pit of Saron death' },
              { date: new Date(1757626649000).toISOString(), duration: 1059, reason: 'legacy' }
            ])
          }
        }]
      };
    });
    const parseSpy = jest.spyOn(JSON, 'parse');

    const results = await client.searchVideos('who died in Pit of Saron', input);

    const metadataParses = parseSpy.mock.calls.filter((call) => rows.some((row) => row.metadata === call[0]));
    expect(metadataParses).toHaveLength(rows.length);
    expect(input.map((row) => row.id)).toEqual(snapshot); // not mutated/sorted in place

    // Newest first: 2 (2026-09), 3 (2026-09-05), 1 (2025-09); broken row skipped.
    const order = [...prompt.matchAll(/title="([^"]+)"/g)].map((match) => match[1]);
    expect(order).toEqual(['Slim stored row', 'Unmigrated schema v1 row', 'Legacy full blob']);
    expect(prompt).toContain('zone="Pit of Saron"');
    expect(prompt).toContain('key=+23');
    expect(prompt).toContain('"name":"Qweekm","timestamp":803.4');

    expect(results.map((video) => video.id)).toEqual([3, 1]);
    expect(results[0].searchReason).toBe('Pit of Saron death');
  });

  test('no longer carries an unused baseUrl', () => {
    expect(client.baseUrl).toBeUndefined();
  });
});
