// Tests for the token hashing and APP_URL helpers (no database needed).
const crypto = require('crypto');
const { hashToken, appUrl } = require('../tokens');

describe('hashToken', () => {
  test('returns a 64-character hex string', () => {
    expect(hashToken('abc')).toMatch(/^[0-9a-f]{64}$/);
  });
  test('gives the same result for the same token', () => {
    expect(hashToken('abc')).toBe(hashToken('abc'));
  });
  test('gives different results for different tokens', () => {
    expect(hashToken('abc')).not.toBe(hashToken('abd'));
  });
  test('never returns the token itself', () => {
    const token = crypto.randomBytes(32).toString('hex');
    expect(hashToken(token)).not.toBe(token);
  });
  test('matches a known SHA-256 value', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  test('a stored hash cannot be used as the token (it hashes to something else)', () => {
    const token = 'secret-token';
    const stored = hashToken(token);
    expect(hashToken(stored)).not.toBe(stored);
  });
});

describe('appUrl', () => {
  const original = process.env.APP_URL;
  afterEach(() => {
    if (original === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = original;
  });

  test('defaults to http://localhost:3000 when APP_URL is not set', () => {
    delete process.env.APP_URL;
    expect(appUrl()).toBe('http://localhost:3000');
  });
  test('uses APP_URL when it is set', () => {
    process.env.APP_URL = 'https://shop.example.com';
    expect(appUrl()).toBe('https://shop.example.com');
  });
  test('removes trailing slashes', () => {
    process.env.APP_URL = 'https://shop.example.com//';
    expect(appUrl()).toBe('https://shop.example.com');
  });
});
