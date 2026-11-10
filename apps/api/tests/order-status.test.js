// PUT /api/orders/:id/status: who may call it, which moves are allowed, tracking info, notifications, double clicks.
const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, asUser, resetDb } = require('./helpers');

let seller;
let otherSeller;
let buyer;
let admin;

beforeAll(async () => {
  await resetDb();
  seller = await createUser({ isSeller: true });
  otherSeller = await createUser({ isSeller: true });
  buyer = await createUser();
  admin = await createUser({ isAdmin: true });
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

// An order that sits in the given status. Created directly, so no payment is needed.
const makeOrder = (status, overrides = {}) =>
  prisma.order.create({
    data: {
      buyerId: buyer.id,
      sellerId: seller.id,
      subtotal: 10,
      deliveryAddress: '1 Test Street, Chennai',
      status,
      ...overrides,
    },
  });

const setStatus = (orderId, who, body) =>
  request(app).put(`/api/orders/${orderId}/status`).set(asUser(who)).send(body);

const orderNow = (id) => prisma.order.findUnique({ where: { id } });
// Notifications are per buyer, so every test that counts them uses its own fresh buyer.
async function freshBuyerOrder(status) {
  const b = await createUser();
  const order = await prisma.order.create({
    data: { buyerId: b.id, sellerId: seller.id, subtotal: 10, deliveryAddress: '1 Test Street, Chennai', status },
  });
  const notes = () => prisma.notification.findMany({ where: { userId: b.id, category: 'orders' } });
  return { order, notes };
}

const STATUSES = ['payment_pending', 'confirmed', 'processing', 'shipped', 'delivered', 'refund_requested', 'cancelled', 'refunded'];
const SETTABLE = ['processing', 'shipped', 'delivered'];
const ALLOWED = { confirmed: ['processing'], processing: ['shipped'], shipped: ['delivered'] };

describe('who may change the status', () => {
  test('the owning seller can move a confirmed order to processing', async () => {
    const order = await makeOrder('confirmed');
    const res = await setStatus(order.id, seller, { status: 'processing' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Order status updated');
    expect(res.body.order.status).toBe('processing');
    expect((await orderNow(order.id)).status).toBe('processing');
  });

  test('an admin who is not the seller can also change it', async () => {
    const order = await makeOrder('confirmed');
    const res = await setStatus(order.id, admin, { status: 'processing' });
    expect(res.status).toBe(200);
    expect((await orderNow(order.id)).status).toBe('processing');
  });

  test.each([
    ['another seller', () => otherSeller],
    ['the buyer who placed the order', () => buyer],
  ])('%s is refused with 403 and the order does not change', async (label, who) => {
    const order = await makeOrder('confirmed');
    const res = await setStatus(order.id, who(), { status: 'processing' });
    expect(res.status).toBe(403);
    expect((await orderNow(order.id)).status).toBe('confirmed');
  });

  test('someone who is not logged in gets 401', async () => {
    const order = await makeOrder('confirmed');
    const res = await request(app).put(`/api/orders/${order.id}/status`).send({ status: 'processing' });
    expect(res.status).toBe(401);
    expect((await orderNow(order.id)).status).toBe('confirmed');
  });

  test('an unknown order id gives 404', async () => {
    const res = await setStatus('00000000-0000-4000-8000-000000000000', seller, { status: 'processing' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Order not found');
  });
});

describe('the body must have a usable status', () => {
  test.each([
    ['no status', {}],
    ['an empty status', { status: '' }],
    ['a status of only spaces', { status: '     ' }],
    ['a status that is a number', { status: 5 }],
    ['a status of 51 characters', { status: 'a'.repeat(51) }],
  ])('%s is refused with 400 and the order does not change', async (label, body) => {
    const order = await makeOrder('confirmed');
    const res = await setStatus(order.id, seller, body);
    expect(res.status).toBe(400);
    expect((await orderNow(order.id)).status).toBe('confirmed');
  });
});

describe('statuses that cannot be set here at all', () => {
  test.each(['cancelled', 'refunded', 'refund_requested', 'confirmed', 'payment_pending', 'banana'])(
    '"%s" is refused and points to the dedicated endpoints',
    async (status) => {
      const order = await makeOrder('processing');
      const res = await setStatus(order.id, seller, { status });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(`"${status}" cannot be set here. Use the dedicated cancel or refund endpoints instead.`);
      expect((await orderNow(order.id)).status).toBe('processing');
    }
  );
});

describe('the allowed moves, and every move that is not allowed', () => {
  const allowed = [];
  const blocked = [];
  for (const from of STATUSES) {
    for (const to of SETTABLE) {
      if ((ALLOWED[from] || []).includes(to)) allowed.push([from, to]);
      else blocked.push([from, to]);
    }
  }

  test('the table has 3 allowed moves and 21 blocked ones', () => {
    expect(allowed).toHaveLength(3);
    expect(blocked).toHaveLength(21);
  });

  test.each(allowed)('%s can move to %s', async (from, to) => {
    const order = await makeOrder(from);
    const res = await setStatus(order.id, seller, { status: to });
    expect(res.status).toBe(200);
    expect((await orderNow(order.id)).status).toBe(to);
  });

  test.each(blocked)('%s cannot move to %s: refused, nothing changes', async (from, to) => {
    const { order, notes } = await freshBuyerOrder(from);
    const res = await setStatus(order.id, seller, { status: to });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Cannot move order from "${from}" to "${to}"`);
    const after = await orderNow(order.id);
    expect(after.status).toBe(from);
    expect(after.deliveredAt).toBeNull();
    expect(after.trackingInfo).toBeNull();
    expect(await notes()).toHaveLength(0);
  });

  test('a whole journey works step by step: confirmed, processing, shipped, delivered', async () => {
    const order = await makeOrder('confirmed');
    for (const status of ['processing', 'shipped', 'delivered']) {
      const res = await setStatus(order.id, seller, { status });
      expect(res.status).toBe(200);
    }
    expect((await orderNow(order.id)).status).toBe('delivered');
  });
});

describe('tracking info, delivery time and buyer notifications', () => {
  test('shipping with tracking info saves it and tells the buyer', async () => {
    const { order, notes } = await freshBuyerOrder('processing');
    const res = await setStatus(order.id, seller, { status: 'shipped', trackingInfo: 'TRK-12345' });
    expect(res.status).toBe(200);
    expect(res.body.order.trackingInfo).toBe('TRK-12345');
    expect((await orderNow(order.id)).trackingInfo).toBe('TRK-12345');
    const sent = await notes();
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('Your order has shipped');
    expect(sent[0].message).toBe('Your order is on its way. Tracking: TRK-12345');
  });

  test('shipping without tracking info still works and the message has no tracking line', async () => {
    const { order, notes } = await freshBuyerOrder('processing');
    const res = await setStatus(order.id, seller, { status: 'shipped' });
    expect(res.status).toBe(200);
    expect((await orderNow(order.id)).trackingInfo).toBeNull();
    const sent = await notes();
    expect(sent).toHaveLength(1);
    expect(sent[0].message).toBe('Your order is on its way.');
  });

  test('tracking info is only kept when the order is shipped', async () => {
    const order = await makeOrder('confirmed');
    const res = await setStatus(order.id, seller, { status: 'processing', trackingInfo: 'TRK-IGNORED' });
    expect(res.status).toBe(200);
    expect((await orderNow(order.id)).trackingInfo).toBeNull();
  });

  test('delivering sets the delivery time and tells the buyer', async () => {
    const { order, notes } = await freshBuyerOrder('shipped');
    const before = Date.now();
    const res = await setStatus(order.id, seller, { status: 'delivered' });
    expect(res.status).toBe(200);
    const after = await orderNow(order.id);
    expect(after.deliveredAt).toBeInstanceOf(Date);
    expect(after.deliveredAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(after.deliveredAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const sent = await notes();
    expect(sent).toHaveLength(1);
    expect(sent[0].title).toBe('Your order was delivered');
  });

  test('moving to processing sends the buyer no notification and sets no delivery time', async () => {
    const { order, notes } = await freshBuyerOrder('confirmed');
    await setStatus(order.id, seller, { status: 'processing' });
    expect(await notes()).toHaveLength(0);
    expect((await orderNow(order.id)).deliveredAt).toBeNull();
  });

  test('a refused move sends no notification (shipping an order that is already delivered)', async () => {
    const { order, notes } = await freshBuyerOrder('delivered');
    const res = await setStatus(order.id, seller, { status: 'shipped', trackingInfo: 'TRK-LATE' });
    expect(res.status).toBe(400);
    expect(await notes()).toHaveLength(0);
  });
});

describe('two requests at the same moment', () => {
  test('three simultaneous "shipped" requests: one succeeds, the buyer is told once', async () => {
    const { order, notes } = await freshBuyerOrder('processing');
    const results = await Promise.all([
      setStatus(order.id, seller, { status: 'shipped', trackingInfo: 'TRK-1' }),
      setStatus(order.id, seller, { status: 'shipped', trackingInfo: 'TRK-2' }),
      setStatus(order.id, seller, { status: 'shipped', trackingInfo: 'TRK-3' }),
    ]);
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    // The others are told "no" (400 if they read the order after the change, 409 if they raced it).
    expect(codes.filter((c) => c !== 200).every((c) => c === 400 || c === 409)).toBe(true);
    expect((await orderNow(order.id)).status).toBe('shipped');
    // The saved tracking info belongs to the request that won.
    const winner = results.find((r) => r.status === 200);
    expect((await orderNow(order.id)).trackingInfo).toBe(winner.body.order.trackingInfo);
    const sent = await notes();
    expect(sent.filter((n) => n.title === 'Your order has shipped')).toHaveLength(1);
  });

  test('three simultaneous "delivered" requests: the delivery time is set once and the buyer is told once', async () => {
    const { order, notes } = await freshBuyerOrder('shipped');
    const results = await Promise.all([
      setStatus(order.id, seller, { status: 'delivered' }),
      setStatus(order.id, seller, { status: 'delivered' }),
      setStatus(order.id, seller, { status: 'delivered' }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const sent = await notes();
    expect(sent.filter((n) => n.title === 'Your order was delivered')).toHaveLength(1);
  });
});
