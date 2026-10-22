// Integration tests: email tokens are stored hashed and links use APP_URL.
// notify() is mocked so the test can read the real token out of the "email".
jest.mock('../notify', () => ({ notify: jest.fn() }));

const bcrypt = require('bcrypt');
const request = require('supertest');
const { app, prisma } = require('../server');
const { notify } = require('../notify');
const { hashToken } = require('../tokens');
const { createUser, resetDb } = require('./helpers');

const TEST_URL = 'https://shop.test';
const originalAppUrl = process.env.APP_URL;

beforeAll(async () => {
  process.env.APP_URL = TEST_URL;
  await resetDb();
});
afterAll(async () => {
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;
  await resetDb();
  await prisma.$disconnect();
});
beforeEach(() => notify.mockClear());

// The email text is the 4th argument of notify(userId, category, title, message, options).
function lastEmail() {
  const calls = notify.mock.calls;
  const message = calls[calls.length - 1][3];
  const match = message.match(/\/(verify-email|reset-password)\?token=([0-9a-f]+)/);
  return { message, page: match[1], token: match[2] };
}

describe('email tokens are stored hashed', () => {
  test('register: stores a hash, emails the real token, and only the real token verifies', async () => {
    const email = `tok-${Date.now()}@test.local`;
    const reg = await request(app).post('/api/auth/register').send({ email, password: 'Password123!', name: 'Tok' });
    expect(reg.status).toBe(201);

    const mail = lastEmail();
    expect(mail.page).toBe('verify-email');
    expect(mail.message).toContain(`${TEST_URL}/verify-email?token=`);

    const stored = await prisma.user.findUnique({ where: { email } });
    expect(stored.verificationToken).toBe(hashToken(mail.token));
    expect(stored.verificationToken).not.toBe(mail.token);

    // The stored hash is useless as a token.
    const withHash = await request(app).post('/api/auth/verify-email').send({ token: stored.verificationToken });
    expect(withHash.status).toBe(400);

    const withReal = await request(app).post('/api/auth/verify-email').send({ token: mail.token });
    expect(withReal.status).toBe(200);

    const after = await prisma.user.findUnique({ where: { email } });
    expect(after.emailVerified).toBe(true);
    expect(after.verificationToken).toBeNull();
  });

  test('forgot-password then reset-password: hash stored, real token resets, token is cleared', async () => {
    const user = await createUser();
    const res = await request(app).post('/api/auth/forgot-password').send({ email: user.email });
    expect(res.status).toBe(200);

    const mail = lastEmail();
    expect(mail.page).toBe('reset-password');
    expect(mail.message).toContain(`${TEST_URL}/reset-password?token=`);

    const stored = await prisma.user.findUnique({ where: { email: user.email } });
    expect(stored.resetToken).toBe(hashToken(mail.token));
    expect(stored.resetToken).not.toBe(mail.token);

    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: mail.token, newPassword: 'BrandNewPass1!' });
    expect(reset.status).toBe(200);

    const after = await prisma.user.findUnique({ where: { email: user.email } });
    expect(after.resetToken).toBeNull();
    expect(await bcrypt.compare('BrandNewPass1!', after.password)).toBe(true);
  });

  test('resend-verification: stores a hash of the new token and uses APP_URL', async () => {
    const user = await createUser({ emailVerified: false });
    const res = await request(app).post('/api/auth/resend-verification').send({ email: user.email });
    expect(res.status).toBe(200);

    const mail = lastEmail();
    expect(mail.message).toContain(`${TEST_URL}/verify-email?token=`);

    const stored = await prisma.user.findUnique({ where: { email: user.email } });
    expect(stored.verificationToken).toBe(hashToken(mail.token));
    expect(stored.verificationToken).not.toBe(mail.token);
  });
});
