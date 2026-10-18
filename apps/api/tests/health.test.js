const request = require('supertest');
const { app, prisma } = require('../server');

afterAll(async () => {
  await prisma.$disconnect();
});

describe('platform basics', () => {
  test('health check reports the database is up', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', database: 'up' });
  });

  test('security headers are present and X-Powered-By is hidden', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toBeDefined();
  });

  test('unknown routes return a JSON 404', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  test('malformed JSON returns a JSON 400', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/json')
      .send('{bad');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid json/i);
  });

  test('oversized bodies are refused with 413', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'a@b.c', password: 'x'.repeat(200000) });
    expect(res.status).toBe(413);
  });

  test('CORS allows the frontend origin and nobody else', async () => {
    const allowed = await request(app).get('/health').set('Origin', 'http://localhost:5173');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    const denied = await request(app).get('/health').set('Origin', 'https://evil.example');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('every API response carries a request id, and a supplied one is kept', async () => {
    const generated = await request(app).get('/api/categories');
    expect(generated.headers['x-request-id']).toBeTruthy();

    const kept = await request(app).get('/api/categories').set('X-Request-Id', 'my-test-1');
    expect(kept.headers['x-request-id']).toBe('my-test-1');
  });
});
