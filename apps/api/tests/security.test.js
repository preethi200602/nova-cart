process.env.LOGIN_RATE_LIMIT = '3';

const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, resetDb } = require('./helpers');

beforeAll(resetDb);
afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('login brute-force protection', () => {
  test('repeated wrong passwords lock the login, even for the right password', async () => {
    const user = await createUser();
    const wrong = { email: user.email, password: 'wrongwrong' };

    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).post('/api/auth/login').send(wrong)).status).toBe(401);
    }

    expect((await request(app).post('/api/auth/login').send(wrong)).status).toBe(429);

    const right = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'Password123!' });
    expect(right.status).toBe(429);
    expect(right.body.token).toBeUndefined();
  });
});
