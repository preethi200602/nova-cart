const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, asUser, resetDb, createCategory, createProduct, placeOrder, payOrder } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;

let buyer;
let seller;
let admin;
let category;

beforeEach(async () => {
  await resetDb();
  buyer = await createUser();
  seller = await createUser({ isSeller: true });
  admin = await createUser({ isAdmin: true });
  category = await createCategory();
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

async function paidOrder(price = 17.99) {
  const product = await createProduct(seller, category, { price });
  const [order] = await placeOrder(buyer, [{ product }]);
  const paid = await payOrder(buyer, order);
  expect(paid.status).toBe(200);
  return order;
}

const markPaid = (orderId, headers, body = {}) =>
  request(app).post(`/api/admin/orders/${orderId}/mark-payout-paid`).set(headers).send(body);

describe('payouts', () => {
  test('only delivered orders can be paid out', async () => {
    const order = await paidOrder();
    const res = await markPaid(order.id, asUser(admin));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/only delivered orders/i);
  });

  test('a payout is held until 7 days after delivery', async () => {
    const order = await paidOrder();
    await prisma.order.update({ where: { id: order.id }, data: { status: 'delivered', deliveredAt: new Date() } });

    const held = await markPaid(order.id, asUser(admin));
    expect(held.status).toBe(400);
    expect(held.body.error).toMatch(/held until/i);

    await prisma.order.update({ where: { id: order.id }, data: { deliveredAt: new Date(Date.now() - 8 * DAY) } });
    const paid = await markPaid(order.id, asUser(admin), { reference: 'TEST-REF-001' });
    expect(paid.status).toBe(200);
    expect(paid.body.payoutStatus).toBe('paid');
    expect(paid.body.payoutReference).toBe('TEST-REF-001');
  });

  test('a payout can only be paid once', async () => {
    const order = await paidOrder();
    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'delivered', deliveredAt: new Date(Date.now() - 8 * DAY) },
    });

    expect((await markPaid(order.id, asUser(admin))).status).toBe(200);
    expect((await markPaid(order.id, asUser(admin))).status).toBe(409);
  });

  test('only admins can mark a payout as paid', async () => {
    const order = await paidOrder();
    expect((await markPaid(order.id, asUser(seller))).status).toBe(403);
    expect((await markPaid(order.id, asUser(buyer))).status).toBe(403);
    expect((await markPaid(order.id, {})).status).toBe(401);
  });

  test('the seller summary and the admin list reflect paid and unpaid payouts', async () => {
    const paidOne = await paidOrder(17.99);
    await paidOrder(10);
    await prisma.order.update({
      where: { id: paidOne.id },
      data: { status: 'delivered', deliveredAt: new Date(Date.now() - 8 * DAY) },
    });

    const list = await request(app).get('/api/admin/payouts?eligible=true').set(asUser(admin));
    expect(list.body.pagination.total).toBe(1);
    expect(list.body.payouts[0].eligible).toBe(true);

    await markPaid(paidOne.id, asUser(admin));

    const summary = await request(app).get('/api/seller/earnings/summary').set(asUser(seller));
    expect(summary.body.payouts.paid).toBe(16.19);
    expect(summary.body.payouts.unpaid).toBe(9);
    expect(summary.body.netEarnings).toBe(25.19);
  });
});
