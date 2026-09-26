const crypto = require('crypto');

describe('lib/cdn', () => {
  let cdn;

  beforeEach(() => {
    jest.isolateModules(() => {
      cdn = require('../../lib/cdn');
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('is a no-op while disabled', () => {
    expect(cdn.shouldUseCdn('/api/videos/1/stream', 'video')).toBe(false);
    expect(cdn.getCdnUrl('/api/videos/1/stream', 'video')).toBe('/api/videos/1/stream');
  });

  test('needs a base URL and a supported content type', () => {
    cdn.initCdn({ enabled: true, baseUrl: '' });
    expect(cdn.shouldUseCdn('/x', 'video')).toBe(false);

    cdn.initCdn({ baseUrl: 'https://cdn.example.com' });
    expect(cdn.shouldUseCdn('/x', 'video')).toBe(true);
    expect(cdn.shouldUseCdn('/x', 'thumbnail')).toBe(true);
    expect(cdn.shouldUseCdn('/x', 'preview')).toBe(false);
  });

  test.each(['cloudflare', 'keycdn', 'custom'])('%s maps the request path onto the base URL once', (provider) => {
    cdn.initCdn({ enabled: true, provider, baseUrl: 'https://cdn.example.com/' });
    expect(cdn.getCdnUrl('/vods/api/videos/7/stream?x=1', 'video')).toBe('https://cdn.example.com/vods/api/videos/7/stream');
  });

  test('custom signed URLs keep the expires+HMAC-SHA1 format', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    cdn.initCdn({ enabled: true, provider: 'custom', baseUrl: 'https://cdn.example.com', signedUrls: true, signedUrlsSecret: 's3cret' });

    const expires = 1_000_000_000 + 3600;
    const unsigned = `https://cdn.example.com/api/videos/1/stream?expires=${expires}`;
    const signature = crypto.createHmac('sha1', 's3cret').update(unsigned).digest('hex');
    expect(cdn.getCdnUrl('/api/videos/1/stream', 'video')).toBe(`${unsigned}&signature=${signature}`);
  });

  test('bunny uses token authentication and never leaks the raw key', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    cdn.initCdn({ enabled: true, provider: 'bunny', baseUrl: 'https://cdn.example.com', token: 'raw-security-key' });

    const url = cdn.getCdnUrl('/api/videos/1/stream', 'video');
    const expires = 1_000_000_000 + 3600;
    const token = crypto.createHash('sha256').update(`raw-security-key/api/videos/1/stream${expires}`).digest('base64url');
    expect(url).toBe(`https://cdn.example.com/api/videos/1/stream?token=${token}&expires=${expires}`);
    expect(url).not.toContain('raw-security-key');
  });

  test('bunny signs the path the CDN sees, including the CDN_BASE_URL path', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_000_000_000_000);
    cdn.initCdn({ enabled: true, provider: 'bunny', baseUrl: 'https://x.b-cdn.net/vods/', token: 'key' });

    const expires = 1_000_000_000 + 3600;
    const token = crypto.createHash('sha256').update(`key/vods/api/videos/1/stream${expires}`).digest('base64url');
    expect(cdn.getCdnUrl('/api/videos/1/stream', 'video'))
      .toBe(`https://x.b-cdn.net/vods/api/videos/1/stream?token=${token}&expires=${expires}`);
  });

  test('returns null instead of an origin-relative URL when the base URL is invalid', () => {
    cdn.initCdn({ enabled: true, baseUrl: 'not a url' });
    expect(cdn.getCdnUrl('/api/videos/1/stream', 'video')).toBeNull();
  });
});
