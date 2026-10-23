// Refresh tokens: login issues a pair, refresh swaps it, reuse and password reset end sessions.
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app, prisma } = require('../server');
const { hashToken } = require('../tokens');
const { createUser, resetDb } = require('./helpers');

beforeAll(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

async function login(user) {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ email: user.email, password: 'Password123!' });
  expect(res.status).toBe(200);
  return res.body;
}

const refresh = (refreshToken) => request(app).post('/api/auth/refresh').send({ refreshToken });

describe('sessions with refresh tokens', () => {
  test('login returns both tokens and stores only a fingerprint of the refresh token', async () => {
    const user = await createUser();
    const { token, refreshToken } = await login(user);
    expect(typeof token).toBe('string');
    expect(refreshToken).toMatch(/^[0-9a-f]{96}$/);

    const rows = await prisma.refreshToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashToken(refreshToken));
    expect(rows[0].tokenHash).not.toBe(refreshToken);
  });

  test('the access token lasts 15 minutes by default', async () => {
    const saved = process.env.ACCESS_TOKEN_TTL;
    delete process.env.ACCESS_TOKEN_TTL;
    try {
      const { token } = await login(await createUser());
      const payload = jwt.decode(token);
      expect(payload.exp - payload.iat).toBe(900);
    } finally {
      if (saved !== undefined) process.env.ACCESS_TOKEN_TTL = saved;
    }
  });

  test('refresh swaps the token for a new pair, and the new access token works', async () => {
    const user = await createUser();
    const first = await login(user);
    const res = await refresh(first.refreshToken);
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).not.toBe(first.refreshToken);

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(user.email);
  });

  test('a refresh token can only be used once', async () => {
    const { refreshToken } = await login(await createUser());
    expect((await refresh(refreshToken)).status).toBe(200);
    const again = await refresh(refreshToken);
    expect(again.status).toBe(401);
    expect(again.body).toEqual({ error: 'Invalid refresh token' });
  });

  test('reusing an old token also cancels the newer one', async () => {
    const first = await login(await createUser());
    const second = await refresh(first.refreshToken);
    expect(second.status).toBe(200);

    expect((await refresh(first.refreshToken)).status).toBe(401);
    expect((await refresh(second.body.refreshToken)).status).toBe(401);
  });

  test('expired, unknown and missing refresh tokens are rejected', async () => {
    const user = await createUser();
    const { refreshToken } = await login(user);
    await prisma.refreshToken.updateMany({
      where: { userId: user.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect((await refresh(refreshToken)).status).toBe(401);
    expect((await refresh('f'.repeat(96))).status).toBe(401);
    expect((await request(app).post('/api/auth/refresh').send({})).status).toBe(400);
  });

  test('logout cancels the refresh token, and an unknown token is accepted quietly', async () => {
    const { refreshToken } = await login(await createUser());
    const out = await request(app).post('/api/auth/logout').send({ refreshToken });
    expect(out.status).toBe(200);
    expect((await refresh(refreshToken)).status).toBe(401);

    const unknown = await request(app).post('/api/auth/logout').send({ refreshToken: 'a'.repeat(96) });
    expect(unknown.status).toBe(200);
  });

  test('a password reset cancels every refresh token for that user', async () => {
    const user = await createUser();
    const a = await login(user);
    const b = await login(user);
    await prisma.user.update({
      where: { id: user.id },
      data: { resetToken: hashToken('known-reset-code'), resetTokenExpiry: new Date(Date.now() + 15 * 60 * 1000) },
    });

    const reset = await request(app)
      .post('/api/auth/reset-password')
      .send({ token: 'known-reset-code', newPassword: 'BrandNewPass1!' });
    expect(reset.status).toBe(200);

    expect((await refresh(a.refreshToken)).status).toBe(401);
    expect((await refresh(b.refreshToken)).status).toBe(401);
  });
});
