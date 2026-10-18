const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, asUser, resetDb } = require('./helpers');

beforeAll(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('login', () => {
  test('returns a token that works on a protected route', async () => {
    const user = await createUser();
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'Password123!' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(user.email);
  });

  test('a wrong password and an unknown email give the same answer', async () => {
    const user = await createUser();
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'not-the-password' });
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@test.local', password: 'Password123!' });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    expect(wrongPassword.body).toEqual(unknownEmail.body);
  });

  test('an unverified email cannot log in', async () => {
    const user = await createUser({ emailVerified: false });
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'Password123!' });
    expect(res.status).toBe(403);
    expect(res.body.token).toBeUndefined();
  });
});

describe('tokens', () => {
  test('a missing, malformed or tampered token is refused', async () => {
    const user = await createUser();
    const good = asUser(user).Authorization;

    expect((await request(app).get('/api/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Authorization', 'Bearer nonsense')).status).toBe(401);
    expect((await request(app).get('/api/auth/me').set('Authorization', good.slice(0, -3) + 'abc')).status).toBe(401);
  });
});

describe('profile', () => {
  test('a user cannot promote themselves to admin or seller', async () => {
    const user = await createUser();
    const res = await request(app)
      .put('/api/auth/me')
      .set(asUser(user))
      .send({ isAdmin: true, isSeller: true });
    expect(res.status).toBe(400);

    const fresh = await prisma.user.findUnique({ where: { id: user.id } });
    expect(fresh.isAdmin).toBe(false);
    expect(fresh.isSeller).toBe(false);
  });

  test('the phone number is cleaned, validated and can be removed', async () => {
    const user = await createUser();

    const ok = await request(app).put('/api/auth/me').set(asUser(user)).send({ phone: '+91 98765-43210' });
    expect(ok.status).toBe(200);
    expect(ok.body.phone).toBe('+919876543210');

    const bad = await request(app).put('/api/auth/me').set(asUser(user)).send({ phone: 'abc' });
    expect(bad.status).toBe(400);

    const cleared = await request(app).put('/api/auth/me').set(asUser(user)).send({ phone: null });
    expect(cleared.status).toBe(200);
    expect(cleared.body.phone).toBeNull();
  });

  test('an empty name is refused', async () => {
    const user = await createUser();
    const res = await request(app).put('/api/auth/me').set(asUser(user)).send({ name: '' });
    expect(res.status).toBe(400);
  });
});
