const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, asUser, resetDb, createCategory, createProduct } = require('./helpers');

// Money and payment fields the buyer must never see in an order list.
const HIDDEN_FROM_BUYER = [
  'platformFee',
  'payoutAmount',
  'payoutStatus',
  'payoutPaidAt',
  'payoutReference',
  'razorpayOrderId',
  'razorpayPaymentId',
];

let admin;
let buyer;
let otherBuyer;
let seller;
let otherSeller;
let product;

// One order straight in the database.
function makeOrder(forBuyer, forSeller, overrides = {}) {
  return prisma.order.create({
    data: {
      buyerId: forBuyer.id,
      sellerId: forSeller.id,
      subtotal: product.price,
      deliveryAddress: '1 Test Street, Chennai',
      status: 'confirmed',
      items: { create: [{ productId: product.id, quantity: 1, price: product.price }] },
      ...overrides,
    },
  });
}

// Creates n orders, one second apart. Returns them oldest first.
async function makeOrders(n, forBuyer, forSeller) {
  const base = Date.now() - 3600 * 1000;
  const orders = [];
  for (let i = 0; i < n; i += 1) {
    orders.push(await makeOrder(forBuyer, forSeller, { createdAt: new Date(base + i * 1000) }));
  }
  return orders;
}

const newestFirstIds = (orders) => [...orders].reverse().map((o) => o.id);
const orderIds = (res) => res.body.orders.map((o) => o.id);
const get = (path, who) => request(app).get(path).set(asUser(who));

beforeEach(async () => {
  await resetDb();
  admin = await createUser({ isAdmin: true });
  buyer = await createUser();
  otherBuyer = await createUser();
  seller = await createUser({ isSeller: true });
  otherSeller = await createUser({ isSeller: true });
  const category = await createCategory();
  product = await createProduct(seller, category, { name: 'Test Product', price: 10 });
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Buyer order list
// ---------------------------------------------------------------------------

describe('GET /api/orders (buyer list) paging', () => {
  test('by default returns the 20 newest orders and the paging details', async () => {
    const all = await makeOrders(25, buyer, seller);

    const res = await get('/api/orders', buyer);

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ page: 1, limit: 20, total: 25 });
    expect(orderIds(res)).toEqual(newestFirstIds(all).slice(0, 20));
  });

  test('page 2 holds the remaining orders', async () => {
    const all = await makeOrders(25, buyer, seller);

    const res = await get('/api/orders?page=2', buyer);

    expect(res.body.pagination).toEqual({ page: 2, limit: 20, total: 25 });
    expect(orderIds(res)).toEqual(newestFirstIds(all).slice(20));
  });

  test('walking through every page gives each order exactly once, newest first', async () => {
    const all = await makeOrders(25, buyer, seller);

    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = await get(`/api/orders?limit=10&page=${page}`, buyer);
      expect(res.body.pagination).toEqual({ page, limit: 10, total: 25 });
      seen.push(...orderIds(res));
    }

    expect(seen).toEqual(newestFirstIds(all));
  });

  test('a page past the end is empty but the total is still correct', async () => {
    await makeOrders(3, buyer, seller);

    const res = await get('/api/orders?page=9', buyer);

    expect(res.status).toBe(200);
    expect(res.body.orders).toEqual([]);
    expect(res.body.pagination).toEqual({ page: 9, limit: 20, total: 3 });
  });

  test('a buyer with no orders gets an empty list and a total of 0', async () => {
    const res = await get('/api/orders', buyer);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ orders: [], pagination: { page: 1, limit: 20, total: 0 } });
  });

  test('a limit above 100 is reduced to 100', async () => {
    await makeOrders(3, buyer, seller);

    const res = await get('/api/orders?limit=500', buyer);

    expect(res.body.pagination.limit).toBe(100);
    expect(res.body.orders).toHaveLength(3);
  });

  test.each([
    ['page=abc&limit=abc', { page: 1, limit: 20 }],
    ['page=0', { page: 1, limit: 20 }],
    ['page=-4', { page: 1, limit: 20 }],
    ['limit=0', { page: 1, limit: 20 }],
    ['limit=-5', { page: 1, limit: 1 }],
    ['page=2&limit=5', { page: 2, limit: 5 }],
  ])('the query "%s" gives %j', async (query, expected) => {
    await makeOrders(3, buyer, seller);

    const res = await get(`/api/orders?${query}`, buyer);

    expect(res.status).toBe(200);
    expect(res.body.pagination.page).toBe(expected.page);
    expect(res.body.pagination.limit).toBe(expected.limit);
  });

  test('only my own orders are listed and counted', async () => {
    const mine = await makeOrders(3, buyer, seller);
    await makeOrders(4, otherBuyer, seller);

    const res = await get('/api/orders', buyer);

    expect(res.body.pagination.total).toBe(3);
    expect(orderIds(res)).toEqual(newestFirstIds(mine));
  });

  test('orders with the same creation time are still split cleanly across pages (nothing repeated, nothing missing)', async () => {
    const sameTime = new Date(Date.now() - 60000);
    const created = [];
    for (let i = 0; i < 6; i += 1) created.push(await makeOrder(buyer, seller, { createdAt: sameTime }));

    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = await get(`/api/orders?limit=2&page=${page}`, buyer);
      seen.push(...orderIds(res));
    }

    expect(seen).toHaveLength(6);
    expect([...seen].sort()).toEqual(created.map((o) => o.id).sort());
  });

  test('each order lists its items with the product name', async () => {
    await makeOrders(2, buyer, seller);

    const res = await get('/api/orders', buyer);

    for (const order of res.body.orders) {
      expect(order.items).toHaveLength(1);
      expect(order.items[0].product.name).toBe('Test Product');
    }
  });

  test('every page still hides the money and payment fields from the buyer', async () => {
    for (let i = 0; i < 3; i += 1) {
      await makeOrder(buyer, seller, {
        platformFee: 1.5,
        payoutAmount: 8.5,
        payoutStatus: 'paid',
        payoutPaidAt: new Date(),
        payoutReference: `ref-secret-${i}`,
        razorpayOrderId: `order_secret_${i}`,
        razorpayPaymentId: `pay_secret_${i}`,
      });
    }

    const first = await get('/api/orders?limit=2&page=1', buyer);
    const second = await get('/api/orders?limit=2&page=2', buyer);

    for (const res of [first, second]) {
      for (const order of res.body.orders) {
        for (const field of HIDDEN_FROM_BUYER) expect(Object.keys(order)).not.toContain(field);
      }
      const raw = JSON.stringify(res.body);
      expect(raw).not.toContain(`ref-secret-`);
      expect(raw).not.toContain(`order_secret_`);
      expect(raw).not.toContain(`pay_secret_`);
    }
  });
});

// ---------------------------------------------------------------------------
// Seller order list
// ---------------------------------------------------------------------------

describe('GET /api/seller/orders paging', () => {
  test('by default returns the 20 newest orders and the paging details', async () => {
    const all = await makeOrders(25, buyer, seller);

    const res = await get('/api/seller/orders', seller);

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ page: 1, limit: 20, total: 25 });
    expect(orderIds(res)).toEqual(newestFirstIds(all).slice(0, 20));
  });

  test('walking through every page gives each order exactly once, newest first', async () => {
    const all = await makeOrders(25, buyer, seller);

    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = await get(`/api/seller/orders?limit=10&page=${page}`, seller);
      seen.push(...orderIds(res));
    }

    expect(seen).toEqual(newestFirstIds(all));
  });

  test('only orders for this seller are listed and counted', async () => {
    const mine = await makeOrders(3, buyer, seller);
    await makeOrders(4, buyer, otherSeller);

    const res = await get('/api/seller/orders', seller);

    expect(res.body.pagination.total).toBe(3);
    expect(orderIds(res)).toEqual(newestFirstIds(mine));
  });

  test('a seller with no orders gets an empty list and a total of 0', async () => {
    const res = await get('/api/seller/orders', otherSeller);

    expect(res.body).toEqual({ orders: [], pagination: { page: 1, limit: 20, total: 0 } });
  });

  test('a page past the end is empty but the total is still correct', async () => {
    await makeOrders(3, buyer, seller);

    const res = await get('/api/seller/orders?page=5', seller);

    expect(res.body.orders).toEqual([]);
    expect(res.body.pagination.total).toBe(3);
  });

  test('a limit above 100 is reduced to 100', async () => {
    const res = await get('/api/seller/orders?limit=500', seller);

    expect(res.body.pagination.limit).toBe(100);
  });

  test('orders with the same creation time are still split cleanly across pages (nothing repeated, nothing missing)', async () => {
    const sameTime = new Date(Date.now() - 60000);
    const created = [];
    for (let i = 0; i < 6; i += 1) created.push(await makeOrder(buyer, seller, { createdAt: sameTime }));

    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = await get(`/api/seller/orders?limit=2&page=${page}`, seller);
      seen.push(...orderIds(res));
    }

    expect(seen).toHaveLength(6);
    expect([...seen].sort()).toEqual(created.map((o) => o.id).sort());
  });

  test('a user who is not a seller is refused (403)', async () => {
    const res = await get('/api/seller/orders', buyer);

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Admin order list
// ---------------------------------------------------------------------------

describe('GET /api/admin/orders paging', () => {
  test('lists every order from every buyer and seller, newest first, 20 per page by default', async () => {
    const base = Date.now() - 3600 * 1000;
    const all = [];
    for (let i = 0; i < 25; i += 1) {
      all.push(
        await makeOrder(i % 2 === 0 ? buyer : otherBuyer, i % 3 === 0 ? seller : otherSeller, {
          createdAt: new Date(base + i * 1000),
        })
      );
    }

    const first = await get('/api/admin/orders', admin);
    const second = await get('/api/admin/orders?page=2', admin);

    expect(first.status).toBe(200);
    expect(first.body.pagination).toEqual({ page: 1, limit: 20, total: 25 });
    expect(orderIds(first)).toEqual(newestFirstIds(all).slice(0, 20));
    expect(orderIds(second)).toEqual(newestFirstIds(all).slice(20));
  });

  test('walking through every page gives each order exactly once', async () => {
    const all = await makeOrders(25, buyer, seller);

    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = await get(`/api/admin/orders?limit=10&page=${page}`, admin);
      seen.push(...orderIds(res));
    }

    expect(seen).toEqual(newestFirstIds(all));
  });

  test('orders with the same creation time are still split cleanly across pages (nothing repeated, nothing missing)', async () => {
    const sameTime = new Date(Date.now() - 60000);
    const created = [];
    for (let i = 0; i < 6; i += 1) created.push(await makeOrder(buyer, seller, { createdAt: sameTime }));

    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = await get(`/api/admin/orders?limit=2&page=${page}`, admin);
      seen.push(...orderIds(res));
    }

    expect(seen).toHaveLength(6);
    expect([...seen].sort()).toEqual(created.map((o) => o.id).sort());
  });

  test('each order shows who bought and who sold, but never a password', async () => {
    await makeOrder(buyer, seller);

    const res = await get('/api/admin/orders', admin);

    const order = res.body.orders[0];
    expect(order.buyer).toEqual({ id: buyer.id, name: buyer.name, email: buyer.email });
    expect(order.seller).toEqual({ id: seller.id, name: seller.name, email: seller.email });
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  test('an empty system gives an empty list and a total of 0', async () => {
    const res = await get('/api/admin/orders', admin);

    expect(res.body).toEqual({ orders: [], pagination: { page: 1, limit: 20, total: 0 } });
  });

  test('a limit above 100 is reduced to 100', async () => {
    const res = await get('/api/admin/orders?limit=500', admin);

    expect(res.body.pagination.limit).toBe(100);
  });

  test.each([
    ['a buyer', () => buyer],
    ['a seller', () => seller],
  ])('%s is refused (403)', async (label, who) => {
    const res = await get('/api/admin/orders', who());

    expect(res.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Notification inbox (stays a plain list; page and limit are optional)
// ---------------------------------------------------------------------------

describe('GET /api/notifications paging', () => {
  // N0 is the oldest, N24 the newest.
  async function makeNotes(forUser, n) {
    const base = Date.now() - 3600 * 1000;
    const rows = [];
    for (let i = 0; i < n; i += 1) {
      rows.push({ userId: forUser.id, category: 'orders', title: `N${i}`, message: 'm', createdAt: new Date(base + i * 1000) });
    }
    await prisma.notification.createMany({ data: rows });
  }

  const titles = (res) => res.body.map((n) => n.title);
  const expectedTitles = (from, to) => {
    const out = [];
    for (let i = from; i >= to; i -= 1) out.push(`N${i}`);
    return out;
  };

  test('is still a plain list, newest first', async () => {
    await makeNotes(buyer, 5);

    const res = await get('/api/notifications', buyer);

    expect(Array.isArray(res.body)).toBe(true);
    expect(titles(res)).toEqual(expectedTitles(4, 0));
  });

  test('limit and page walk through older notifications without repeats or gaps', async () => {
    await makeNotes(buyer, 25);

    const first = await get('/api/notifications?limit=10&page=1', buyer);
    const second = await get('/api/notifications?limit=10&page=2', buyer);
    const third = await get('/api/notifications?limit=10&page=3', buyer);
    const fourth = await get('/api/notifications?limit=10&page=4', buyer);

    expect(titles(first)).toEqual(expectedTitles(24, 15));
    expect(titles(second)).toEqual(expectedTitles(14, 5));
    expect(titles(third)).toEqual(expectedTitles(4, 0));
    expect(fourth.body).toEqual([]);
  });

  test('without a limit the default is still 50', async () => {
    await makeNotes(buyer, 60);

    const first = await get('/api/notifications', buyer);
    const second = await get('/api/notifications?page=2', buyer);

    expect(first.body).toHaveLength(50);
    expect(first.body[0].title).toBe('N59');
    expect(second.body).toHaveLength(10);
    expect(second.body[9].title).toBe('N0');
  });

  test('a limit above 100 is reduced to 100', async () => {
    await makeNotes(buyer, 120);

    const res = await get('/api/notifications?limit=500', buyer);

    expect(res.body).toHaveLength(100);
  });

  test.each(['page=abc', 'page=0', 'page=-3'])('the query "%s" behaves like page 1', async (query) => {
    await makeNotes(buyer, 5);

    const res = await get(`/api/notifications?${query}`, buyer);

    expect(titles(res)).toEqual(expectedTitles(4, 0));
  });

  test('other users\' notifications never appear on any page', async () => {
    await makeNotes(buyer, 25);
    await makeNotes(otherBuyer, 5);

    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = await get(`/api/notifications?limit=10&page=${page}`, buyer);
      res.body.forEach((n) => expect(n.userId).toBe(buyer.id));
      seen.push(...res.body);
    }

    expect(seen).toHaveLength(25);
  });

  test('notifications with the same creation time are still split cleanly across pages', async () => {
    const sameTime = new Date(Date.now() - 60000);
    const rows = [];
    for (let i = 0; i < 6; i += 1) {
      rows.push({ userId: buyer.id, category: 'orders', title: `T${i}`, message: 'm', createdAt: sameTime });
    }
    await prisma.notification.createMany({ data: rows });

    const seen = [];
    for (const page of [1, 2, 3]) {
      const res = await get(`/api/notifications?limit=2&page=${page}`, buyer);
      seen.push(...titles(res));
    }

    expect(seen).toHaveLength(6);
    expect([...seen].sort()).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5']);
  });
});