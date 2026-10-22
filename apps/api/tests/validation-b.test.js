// Tests for batch (b) schemas: cart, reviews, refunds, order status (no database needed).
const s = require('../schemas');

const ok = (schema, body) => schema.safeParse(body);
const failMsg = (schema, body) => {
  const r = schema.safeParse(body);
  return r.success ? null : `${r.error.issues[0].path.join('.')}: ${r.error.issues[0].message}`;
};

describe('add cart item schema', () => {
  test('accepts a product id and a whole quantity', () => {
    expect(ok(s.addCartItemSchema, { productId: 'abc', quantity: 2 }).success).toBe(true);
  });
  test('rejects a missing product id', () => {
    expect(failMsg(s.addCartItemSchema, { quantity: 2 })).toMatch(/^productId:/);
  });
  test('rejects quantity 0 and negative quantity', () => {
    expect(ok(s.addCartItemSchema, { productId: 'abc', quantity: 0 }).success).toBe(false);
    expect(ok(s.addCartItemSchema, { productId: 'abc', quantity: -3 }).success).toBe(false);
  });
  test('rejects a fractional quantity', () => {
    expect(failMsg(s.addCartItemSchema, { productId: 'abc', quantity: 1.5 })).toMatch(/whole number/);
  });
  test('rejects quantity given as text', () => {
    expect(ok(s.addCartItemSchema, { productId: 'abc', quantity: '2' }).success).toBe(false);
  });
  test('rejects a quantity over 1000', () => {
    expect(ok(s.addCartItemSchema, { productId: 'abc', quantity: 1001 }).success).toBe(false);
  });
});

describe('update cart item schema', () => {
  test('accepts a positive whole quantity', () => {
    expect(ok(s.updateCartItemSchema, { quantity: 3 }).success).toBe(true);
  });
  test('rejects a missing or zero quantity', () => {
    expect(ok(s.updateCartItemSchema, {}).success).toBe(false);
    expect(ok(s.updateCartItemSchema, { quantity: 0 }).success).toBe(false);
  });
});

describe('review schema', () => {
  const good = { orderId: 'o1', rating: 5, comment: 'Great' };
  test('accepts a full review', () => {
    expect(ok(s.reviewSchema, good).success).toBe(true);
  });
  test('comment is optional and may be null', () => {
    expect(ok(s.reviewSchema, { orderId: 'o1', rating: 4 }).success).toBe(true);
    expect(ok(s.reviewSchema, { orderId: 'o1', rating: 4, comment: null }).success).toBe(true);
  });
  test('rejects ratings outside 1 to 5', () => {
    expect(ok(s.reviewSchema, { ...good, rating: 0 }).success).toBe(false);
    expect(ok(s.reviewSchema, { ...good, rating: 6 }).success).toBe(false);
  });
  test('rejects a fractional rating', () => {
    expect(failMsg(s.reviewSchema, { ...good, rating: 4.5 })).toMatch(/whole number/);
  });
  test('rejects a missing order id', () => {
    expect(failMsg(s.reviewSchema, { rating: 5 })).toMatch(/^orderId:/);
  });
  test('rejects a comment over 2000 characters', () => {
    expect(ok(s.reviewSchema, { ...good, comment: 'x'.repeat(2001) }).success).toBe(false);
  });
});

describe('seller response schema', () => {
  test('accepts text and trims it', () => {
    const r = ok(s.sellerResponseSchema, { sellerResponse: '  Thank you  ' });
    expect(r.data).toEqual({ sellerResponse: 'Thank you' });
  });
  test('rejects missing, blank, or too-long text', () => {
    expect(ok(s.sellerResponseSchema, {}).success).toBe(false);
    expect(ok(s.sellerResponseSchema, { sellerResponse: '   ' }).success).toBe(false);
    expect(ok(s.sellerResponseSchema, { sellerResponse: 'x'.repeat(2001) }).success).toBe(false);
  });
});

describe('refund schemas', () => {
  test('request-refund reason is optional, may be null', () => {
    expect(ok(s.requestRefundSchema, {}).success).toBe(true);
    expect(ok(s.requestRefundSchema, { reason: null }).success).toBe(true);
    expect(ok(s.requestRefundSchema, { reason: 'Damaged' }).success).toBe(true);
  });
  test('request-refund rejects a reason over 1000 characters or non-text', () => {
    expect(ok(s.requestRefundSchema, { reason: 'x'.repeat(1001) }).success).toBe(false);
    expect(ok(s.requestRefundSchema, { reason: 42 }).success).toBe(false);
  });
  test('reject-refund requires a non-blank reason', () => {
    expect(ok(s.rejectRefundSchema, { reason: 'Item was used' }).success).toBe(true);
    expect(ok(s.rejectRefundSchema, {}).success).toBe(false);
    expect(ok(s.rejectRefundSchema, { reason: '  ' }).success).toBe(false);
  });
});

describe('order status schema', () => {
  test('accepts a status with optional tracking info', () => {
    expect(ok(s.orderStatusSchema, { status: 'shipped', trackingInfo: 'AWB123' }).success).toBe(true);
    expect(ok(s.orderStatusSchema, { status: 'processing' }).success).toBe(true);
  });
  test('still lets unknown status words through (the route decides which are allowed)', () => {
    expect(ok(s.orderStatusSchema, { status: 'cancelled' }).success).toBe(true);
  });
  test('rejects a missing or non-text status', () => {
    expect(ok(s.orderStatusSchema, {}).success).toBe(false);
    expect(ok(s.orderStatusSchema, { status: 7 }).success).toBe(false);
  });
  test('rejects tracking info over 500 characters', () => {
    expect(ok(s.orderStatusSchema, { status: 'shipped', trackingInfo: 'x'.repeat(501) }).success).toBe(false);
  });
});
