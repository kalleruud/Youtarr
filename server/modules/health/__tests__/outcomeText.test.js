const { boundMessage, boundDetails, boundReasonCode } = require('../outcomeText');
const { MAX_MESSAGE_LENGTH, MAX_DETAILS_BYTES } = require('../constants');

describe('outcome text redaction', () => {
  test('configured API keys and notification URLs are replaced', () => {
    const config = { jellyfinApiKey: 'abcdef1234567890', appriseUrls: ['discord://hook/secret-token-value'] };
    const text = boundMessage('key abcdef1234567890 sent to discord://hook/secret-token-value', config);
    expect(text).not.toMatch(/abcdef1234567890|secret-token-value/);
  });

  test('signed googlevideo URLs and cookie headers are removed', () => {
    const text = boundMessage('GET https://rr1---sn.googlevideo.com/videoplayback?sig=AAA&ip=1.2.3.4 Cookie: SID=topsecret', {});
    expect(text).not.toMatch(/googlevideo|topsecret|1\.2\.3\.4/);
  });

  test('token query parameters are removed', () => {
    expect(boundMessage('http://plex/x?X-Plex-Token=tok12345678', {})).not.toContain('tok12345678');
  });

  test('messages are capped', () => {
    expect(boundMessage('x'.repeat(5000), {}).length).toBe(MAX_MESSAGE_LENGTH);
  });

  test('oversized details are shortened to fit', () => {
    const json = boundDetails({ mediaPath: 'p'.repeat(10000), n: 1 }, {});
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(MAX_DETAILS_BYTES);
  });

  test('reason codes keep only safe characters', () => {
    expect(boundReasonCode('a b/c')).toBe('a-b-c');
  });
});
