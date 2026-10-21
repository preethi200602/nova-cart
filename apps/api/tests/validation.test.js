// Tests for the zod schemas and the validate() middleware (no database needed).
const express = require('express');
const request = require('supertest');
const { validate } = require('../validate');
const s = require('../schemas');

const ok = (schema, body) => schema.safeParse(body);
const failMsg = (schema, body) => {
  const r = schema.safeParse(body);
  return r.success ? null : `${r.error.issues[0].path.join('.')}: ${r.error.issues[0].message}`;
};

describe('register schema', () => {
  test('accepts a good body and trims text', () => {
    const r = ok(s.registerSchema, { email: ' a@b.com ', password: 'password123', name: ' Pree ' });
    expect(r.success).toBe(true);
    expect(r.data).toEqual({ email: 'a@b.com', password: 'password123', name: 'Pree' });
  });
  test('name is optional', () => {
    expect(ok(s.registerSchema, { email: 'a@b.com', password: 'password123' }).success).toBe(true);
  });
  test('rejects a bad email', () => {
    expect(failMsg(s.registerSchema, { email: 'nope', password: 'password123' })).toMatch(/^email:/);
  });
  test('rejects a non-text email', () => {
    expect(failMsg(s.registerSchema, { email: 123, password: 'password123' })).toMatch(/^email:/);
  });
  test('rejects a password under 8 characters', () => {
    expect(failMsg(s.registerSchema, { email: 'a@b.com', password: 'short' })).toMatch(/at least 8/);
  });
  test('rejects a password over 72 characters', () => {
    expect(failMsg(s.registerSchema, { email: 'a@b.com', password: 'x'.repeat(73) })).toMatch(/at most 72/);
  });
  test('rejects an empty body', () => {
    expect(ok(s.registerSchema, {}).success).toBe(false);
  });
  test('rejects a name over 80 characters', () => {
    expect(failMsg(s.registerSchema, { email: 'a@b.com', password: 'password123', name: 'x'.repeat(81) })).toMatch(/^name:/);
  });
});

describe('login schema', () => {
  test('does not enforce the 8-character rule (old accounts keep working)', () => {
    expect(ok(s.loginSchema, { email: 'a@b.com', password: 'x' }).success).toBe(true);
  });
  test('rejects an empty password', () => {
    expect(failMsg(s.loginSchema, { email: 'a@b.com', password: '' })).toMatch(/^password:/);
  });
  test('rejects a missing email', () => {
    expect(failMsg(s.loginSchema, { password: 'password123' })).toMatch(/^email:/);
  });
});

describe('email-only and token schemas', () => {
  test('forgot-password needs a valid email', () => {
    expect(ok(s.forgotPasswordSchema, { email: 'a@b.com' }).success).toBe(true);
    expect(ok(s.forgotPasswordSchema, {}).success).toBe(false);
    expect(ok(s.forgotPasswordSchema, { email: 'bad' }).success).toBe(false);
  });
  test('resend-verification needs a valid email', () => {
    expect(ok(s.resendVerificationSchema, { email: 'a@b.com' }).success).toBe(true);
    expect(ok(s.resendVerificationSchema, { email: '' }).success).toBe(false);
  });
  test('verify-email needs a non-empty token', () => {
    expect(ok(s.verifyEmailSchema, { token: 'abc' }).success).toBe(true);
    expect(ok(s.verifyEmailSchema, { token: '   ' }).success).toBe(false);
    expect(ok(s.verifyEmailSchema, {}).success).toBe(false);
  });
});

describe('reset-password schema', () => {
  test('accepts a token and a good new password', () => {
    expect(ok(s.resetPasswordSchema, { token: 'abc', newPassword: 'password123' }).success).toBe(true);
  });
  test('rejects a short new password', () => {
    expect(failMsg(s.resetPasswordSchema, { token: 'abc', newPassword: 'short' })).toMatch(/^newPassword:/);
  });
  test('rejects a missing token', () => {
    expect(failMsg(s.resetPasswordSchema, { newPassword: 'password123' })).toMatch(/^token:/);
  });
});

describe('seller application schema', () => {
  const good = { businessName: 'A', description: 'B', categoryFocus: 'C', contactDetails: 'D' };
  test('accepts all four fields', () => {
    expect(ok(s.sellerApplySchema, good).success).toBe(true);
  });
  test('rejects a missing field', () => {
    expect(ok(s.sellerApplySchema, { businessName: 'A' }).success).toBe(false);
  });
  test('rejects a blank field', () => {
    expect(ok(s.sellerApplySchema, { ...good, description: '   ' }).success).toBe(false);
  });
  test('rejects text that is too long', () => {
    expect(ok(s.sellerApplySchema, { ...good, businessName: 'x'.repeat(101) }).success).toBe(false);
  });
});

describe('store update schema', () => {
  test('an empty update is allowed (nothing changes)', () => {
    expect(ok(s.storeUpdateSchema, {}).success).toBe(true);
  });
  test('rejects null and non-text values', () => {
    expect(ok(s.storeUpdateSchema, { banner: null }).success).toBe(false);
    expect(ok(s.storeUpdateSchema, { policies: 5 }).success).toBe(false);
  });
  test('rejects a store name over 80 characters', () => {
    expect(ok(s.storeUpdateSchema, { storeName: 'x'.repeat(81) }).success).toBe(false);
  });
  test('drops unknown fields so they can never reach the database', () => {
    const r = ok(s.storeUpdateSchema, { storeName: 'Shop', userId: 'hacker', isAdmin: true });
    expect(r.data).toEqual({ storeName: 'Shop' });
  });
});

describe('validate() middleware', () => {
  const app = express();
  app.use(express.json());
  app.post('/t', validate(s.resetPasswordSchema), (req, res) => res.json({ got: req.body }));

  test('returns 400 with the project error shape on bad input', async () => {
    const res = await request(app).post('/t').send({ token: 'abc', newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'newPassword: Password must be at least 8 characters' });
  });
  test('passes cleaned data to the handler on good input', async () => {
    const res = await request(app).post('/t').send({ token: ' abc ', newPassword: 'password123', extra: 1 });
    expect(res.status).toBe(200);
    expect(res.body.got).toEqual({ token: 'abc', newPassword: 'password123' });
  });
  test('handles a request with no body', async () => {
    const res = await request(app).post('/t');
    expect(res.status).toBe(400);
  });
});
