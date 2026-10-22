// Tests for batch (c) schema: notification preferences (no database needed).
const s = require('../schemas');

const ok = (schema, body) => schema.safeParse(body);
const failMsg = (schema, body) => {
  const r = schema.safeParse(body);
  return r.success ? null : `${r.error.issues[0].path.join('.')}: ${r.error.issues[0].message}`;
};

describe('notification preference schema', () => {
  test('accepts a category with both flags', () => {
    expect(ok(s.notificationPreferenceSchema, { category: 'orders', email: false, inApp: true }).success).toBe(true);
  });
  test('email and inApp are each optional', () => {
    expect(ok(s.notificationPreferenceSchema, { category: 'orders' }).success).toBe(true);
    expect(ok(s.notificationPreferenceSchema, { category: 'orders', email: true }).success).toBe(true);
    expect(ok(s.notificationPreferenceSchema, { category: 'orders', inApp: false }).success).toBe(true);
  });
  test('rejects a missing or blank category', () => {
    expect(failMsg(s.notificationPreferenceSchema, { email: true })).toMatch(/^category:/);
    expect(ok(s.notificationPreferenceSchema, { category: '  ' }).success).toBe(false);
  });
  test('rejects a category that is not text, or too long', () => {
    expect(ok(s.notificationPreferenceSchema, { category: 5 }).success).toBe(false);
    expect(ok(s.notificationPreferenceSchema, { category: 'x'.repeat(51) }).success).toBe(false);
  });
  test('rejects flags that are not true or false', () => {
    expect(failMsg(s.notificationPreferenceSchema, { category: 'orders', email: 'false' })).toMatch(/^email:/);
    expect(failMsg(s.notificationPreferenceSchema, { category: 'orders', inApp: 1 })).toMatch(/^inApp:/);
    expect(ok(s.notificationPreferenceSchema, { category: 'orders', email: null }).success).toBe(false);
  });
  test('lets an unknown category word through (the route decides which categories exist)', () => {
    expect(ok(s.notificationPreferenceSchema, { category: 'nonsense' }).success).toBe(true);
  });
  test('drops unknown fields', () => {
    const r = ok(s.notificationPreferenceSchema, { category: 'orders', userId: 'hacker' });
    expect(r.data).toEqual({ category: 'orders' });
  });
});
