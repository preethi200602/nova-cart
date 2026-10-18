const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, asUser, resetDb } = require('./helpers');

const adminRoutes = [
  ['get', '/api/admin/analytics/overview'],
  ['get', '/api/admin/orders'],
  ['get', '/api/admin/payouts'],
  ['get', '/api/admin/products'],
  ['get', '/api/admin/seller-applications'],
  ['post', '/api/admin/orders/expire-unpaid'],
  ['post', '/api/admin/categories'],
];

const sellerRoutes = [
  ['get', '/api/seller/dashboard'],
  ['get', '/api/seller/orders'],
  ['get', '/api/seller/products'],
  ['get', '/api/seller/store'],
  ['get', '/api/seller/earnings/summary'],
  ['get', '/api/seller/analytics/overview'],
];

const signedInRoutes = [
  ['get', '/api/auth/me'],
  ['get', '/api/cart'],
  ['get', '/api/orders'],
  ['get', '/api/addresses'],
  ['get', '/api/notifications'],
  ['post', '/api/checkout/preview'],
];

let buyer;
let seller;
let admin;

beforeAll(async () => {
  await resetDb();
  buyer = await createUser();
  seller = await createUser({ isSeller: true });
  admin = await createUser({ isAdmin: true });
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

const call = (method, path, headers = {}) => request(app)[method](path).set(headers).send({});

describe('admin routes', () => {
  test.each(adminRoutes)('%s %s needs a login', async (method, path) => {
    expect((await call(method, path)).status).toBe(401);
  });

  test.each(adminRoutes)('%s %s is closed to buyers and sellers', async (method, path) => {
    expect((await call(method, path, asUser(buyer))).status).toBe(403);
    expect((await call(method, path, asUser(seller))).status).toBe(403);
  });

  test.each(adminRoutes)('%s %s is open to admins', async (method, path) => {
    const res = await call(method, path, asUser(admin));
    expect([401, 403]).not.toContain(res.status);
  });
});

describe('seller routes', () => {
  test.each(sellerRoutes)('%s %s needs a login', async (method, path) => {
    expect((await call(method, path)).status).toBe(401);
  });

  test.each(sellerRoutes)('%s %s is closed to buyers', async (method, path) => {
    expect((await call(method, path, asUser(buyer))).status).toBe(403);
  });

  test.each(sellerRoutes)('%s %s is open to sellers', async (method, path) => {
    const res = await call(method, path, asUser(seller));
    expect([401, 403]).not.toContain(res.status);
  });
});

describe('signed-in routes', () => {
  test.each(signedInRoutes)('%s %s needs a login', async (method, path) => {
    expect((await call(method, path)).status).toBe(401);
  });

  test.each(signedInRoutes)('%s %s works for a signed-in buyer', async (method, path) => {
    const res = await call(method, path, asUser(buyer));
    expect([401, 403]).not.toContain(res.status);
  });
});
