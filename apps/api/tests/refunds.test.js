// Refunds: requesting, approving (stock back, ledger reversed) and rejecting.
const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, asUser, resetDb, createCategory, createProduct, placeOrder, ledger, totalOf } = require('./helpers');

let seller;
let otherSeller;
let buyer;
let otherBuyer;
let admin;
let product;

beforeAll(async () => {
  await resetDb();
  seller = await createUser({ isSeller: true });
  otherSeller = await createUser({ isSeller: true });
  buyer = await createUser();
  otherBuyer = await createUser();
  admin = await createUser({ isAdmin: true });
  const category = await createCategory();
  product = await createProduct(seller, category);
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

// A paid order that has been delivered. platformFee and payoutAmount are what a paid order carries.
async function deliveredOrder({ status = 'delivered', daysAgo = 1, stock = 5 } = {}) {
  const [order] = await placeOrder(buyer, [{ product }]);
  await prisma.product.update({ where: { id: product.id }, data: { stock } });
  return prisma.order.update({
    where: { id: order.id },
    data: {
      status,
      deliveredAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
      platformFee: 1.5,
      payoutAmount: 8.5,
    },
  });
}

const stockNow = async () => (await prisma.product.findUnique({ where: { id: product.id } })).stock;
const notificationsFor = (user, title) =>
  prisma.notification.findMany({ where: { userId: user.id, category: 'refunds' } }).then((rows) => rows.filter((n) => n.title === title));

describe('requesting a refund', () => {
  test('the buyer can request a refund on a delivered order', async () => {
    const order = await deliveredOrder();
    const res = await request(app)
      .post(`/api/orders/${order.id}/request-refund`)
      .set(asUser(buyer))
      .send({ reason: 'Arrived damaged' });
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('refund_requested');
    expect(res.body.order.refundReason).toBe('Arrived damaged');
    expect(await notificationsFor(seller, 'Refund requested')).not.toHaveLength(0);
  });

  test('an order that is not delivered cannot be refunded', async () => {
    const order = await deliveredOrder({ status: 'confirmed' });
    const res = await request(app).post(`/api/orders/${order.id}/request-refund`).set(asUser(buyer)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Only delivered orders can be refunded');
  });

  test('a refund cannot be requested after the return window', async () => {
    const order = await deliveredOrder({ daysAgo: 400 });
    const res = await request(app).post(`/api/orders/${order.id}/request-refund`).set(asUser(buyer)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Return window has expired');
  });

  test("someone else's order looks like it does not exist", async () => {
    const order = await deliveredOrder();
    const res = await request(app).post(`/api/orders/${order.id}/request-refund`).set(asUser(otherBuyer)).send({});
    expect(res.status).toBe(404);
  });

  test('a refund cannot be requested twice', async () => {
    const order = await deliveredOrder();
    const first = await request(app).post(`/api/orders/${order.id}/request-refund`).set(asUser(buyer)).send({});
    expect(first.status).toBe(200);
    const second = await request(app).post(`/api/orders/${order.id}/request-refund`).set(asUser(buyer)).send({});
    expect(second.status).toBe(400);
  });
});

describe('approving a refund', () => {
  test('the seller approves: stock comes back, the ledger is reversed, both sides are told', async () => {
    const order = await deliveredOrder({ stock: 5 });
    await request(app).post(`/api/orders/${order.id}/request-refund`).set(asUser(buyer)).send({ reason: 'Wrong size' });

    const res = await request(app).post(`/api/orders/${order.id}/approve-refund`).set(asUser(seller));
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('refunded');
    expect(await stockNow()).toBe(6);

    const rows = await ledger(order.id);
    expect(totalOf(rows, 'refund')).toBe(-order.subtotal);
    expect(totalOf(rows, 'platform_fee')).toBe(-1.5);
    expect(totalOf(rows, 'payout')).toBe(-8.5);

    expect(await notificationsFor(buyer, 'Refund approved')).not.toHaveLength(0);
    expect(await notificationsFor(seller, 'Refund processed')).not.toHaveLength(0);
  });

  test('an admin can approve a refund on any order', async () => {
    const order = await deliveredOrder({ status: 'refund_requested' });
    const res = await request(app).post(`/api/orders/${order.id}/approve-refund`).set(asUser(admin));
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('refunded');
  });

  test('another seller and the buyer cannot approve, and nothing changes', async () => {
    const order = await deliveredOrder({ status: 'refund_requested', stock: 5 });
    const byOtherSeller = await request(app).post(`/api/orders/${order.id}/approve-refund`).set(asUser(otherSeller));
    const byBuyer = await request(app).post(`/api/orders/${order.id}/approve-refund`).set(asUser(buyer));
    expect(byOtherSeller.status).toBe(403);
    expect(byBuyer.status).toBe(403);

    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after.status).toBe('refund_requested');
    expect(await stockNow()).toBe(5);
    expect(await ledger(order.id)).toEqual([]);
  });

  test('an order with no pending request cannot be approved', async () => {
    const order = await deliveredOrder();
    const res = await request(app).post(`/api/orders/${order.id}/approve-refund`).set(asUser(seller));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This order has no pending refund request');
  });

  test('approving twice restores stock only once', async () => {
    const order = await deliveredOrder({ status: 'refund_requested', stock: 5 });
    expect((await request(app).post(`/api/orders/${order.id}/approve-refund`).set(asUser(seller))).status).toBe(200);
    expect((await request(app).post(`/api/orders/${order.id}/approve-refund`).set(asUser(seller))).status).toBe(400);
    expect(await stockNow()).toBe(6);
    expect((await ledger(order.id)).filter((r) => r.type === 'refund')).toHaveLength(1);
  });
});

describe('rejecting a refund', () => {
  test('a reason is required, and the order stays as it was', async () => {
    const order = await deliveredOrder({ status: 'refund_requested' });
    const res = await request(app).post(`/api/orders/${order.id}/reject-refund`).set(asUser(seller)).send({});
    expect(res.status).toBe(400);
    const after = await prisma.order.findUnique({ where: { id: order.id } });
    expect(after.status).toBe('refund_requested');
  });

  test('the seller rejects: the order goes back to delivered, the reason is kept, the buyer is told', async () => {
    const order = await deliveredOrder({ status: 'refund_requested', stock: 5 });
    const res = await request(app)
      .post(`/api/orders/${order.id}/reject-refund`)
      .set(asUser(seller))
      .send({ reason: 'Item was used' });
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('delivered');
    expect(res.body.order.refundRejectionReason).toBe('Item was used');

    expect(await stockNow()).toBe(5);
    expect(await ledger(order.id)).toEqual([]);

    const told = await notificationsFor(buyer, 'Refund request rejected');
    expect(told.some((n) => n.message.includes('Item was used'))).toBe(true);
  });

  test('another seller cannot reject', async () => {
    const order = await deliveredOrder({ status: 'refund_requested' });
    const res = await request(app)
      .post(`/api/orders/${order.id}/reject-refund`)
      .set(asUser(otherSeller))
      .send({ reason: 'No' });
    expect(res.status).toBe(403);
  });

  test('an order with no pending request cannot be rejected', async () => {
    const order = await deliveredOrder();
    const res = await request(app)
      .post(`/api/orders/${order.id}/reject-refund`)
      .set(asUser(seller))
      .send({ reason: 'No' });
    expect(res.status).toBe(400);
  });
});
