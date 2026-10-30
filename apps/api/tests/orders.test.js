const request = require('supertest');
const { app, prisma } = require('../server');
const {
  createUser,
  asUser,
  resetDb,
  createCategory,
  createProduct,
  placeOrder,
  payOrder,
  ledger,
  totalOf,
} = require('./helpers');

let buyer;
let sellerA;
let sellerB;
let admin;
let category;

beforeEach(async () => {
  await resetDb();
  buyer = await createUser();
  sellerA = await createUser({ isSeller: true });
  sellerB = await createUser({ isSeller: true });
  admin = await createUser({ isAdmin: true });
  category = await createCategory();
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('checkout', () => {
  test('creates one order per seller, rounds the subtotals and empties the cart', async () => {
    const a = await createProduct(sellerA, category, { price: 17.99 });
    const b = await createProduct(sellerB, category, { price: 9.99 });

    const orders = await placeOrder(buyer, [{ product: a, quantity: 3 }, { product: b, quantity: 2 }]);
    expect(orders).toHaveLength(2);

    const bySeller = Object.fromEntries(orders.map((o) => [o.sellerId, o]));
    expect(bySeller[sellerA.id].subtotal).toBe(53.97);
    expect(bySeller[sellerB.id].subtotal).toBe(19.98);
    orders.forEach((o) => expect(o.status).toBe('payment_pending'));

    const cart = await request(app).get('/api/cart').set(asUser(buyer));
    expect(cart.body.items).toHaveLength(0);
  });

  test('the preview total matches what checkout creates', async () => {
    const a = await createProduct(sellerA, category, { price: 17.99 });
    const b = await createProduct(sellerB, category, { price: 9.99 });
    for (const [product, quantity] of [[a, 1], [b, 2]]) {
      await request(app).post('/api/cart/items').set(asUser(buyer)).send({ productId: product.id, quantity });
    }

    const preview = await request(app)
      .post('/api/checkout/preview')
      .set(asUser(buyer))
      .send({ deliveryAddress: '1 Test Street, Chennai' });
    expect(preview.status).toBe(200);
    expect(preview.body.total).toBe(37.97);
    expect(preview.body.canCheckout).toBe(true);

    const checkout = await request(app)
      .post('/api/checkout')
      .set(asUser(buyer))
      .send({ deliveryAddress: '1 Test Street, Chennai' });
    const created = checkout.body.orders.reduce((sum, o) => sum + o.subtotal, 0);
    expect(Math.round(created * 100) / 100).toBe(preview.body.total);
  });

  test('a product that stopped being available blocks checkout and shows in the preview', async () => {
    const product = await createProduct(sellerA, category);
    await request(app).post('/api/cart/items').set(asUser(buyer)).send({ productId: product.id, quantity: 1 });
    await prisma.product.update({ where: { id: product.id }, data: { state: 'archived' } });

    const preview = await request(app)
      .post('/api/checkout/preview')
      .set(asUser(buyer))
      .send({ deliveryAddress: '1 Test Street, Chennai' });
    expect(preview.body.canCheckout).toBe(false);
    expect(preview.body.issues[0].problem).toBe('unavailable');

    const checkout = await request(app)
      .post('/api/checkout')
      .set(asUser(buyer))
      .send({ deliveryAddress: '1 Test Street, Chennai' });
    expect(checkout.status).toBe(400);
  });

  test('an empty cart cannot be checked out', async () => {
    const res = await request(app)
      .post('/api/checkout')
      .set(asUser(buyer))
      .send({ deliveryAddress: '1 Test Street, Chennai' });
    expect(res.status).toBe(400);
  });

  test("another user's saved address cannot be used", async () => {
    const stranger = await createUser();
    const address = await request(app)
      .post('/api/addresses')
      .set(asUser(stranger))
      .send({
        label: 'Home',
        fullName: 'Stranger',
        phone: '9876543210',
        line1: '9 Other Road',
        city: 'Chennai',
        state: 'Tamil Nadu',
        postalCode: '600001',
      });

    const product = await createProduct(sellerA, category);
    await request(app).post('/api/cart/items').set(asUser(buyer)).send({ productId: product.id, quantity: 1 });
    const res = await request(app)
      .post('/api/checkout')
      .set(asUser(buyer))
      .send({ addressId: address.body.id });
    expect(res.status).toBe(400);
  });
});

describe('cancelling a paid order', () => {
  test('restocks the product, flips the state back and the ledger nets to zero', async () => {
    const product = await createProduct(sellerA, category, { price: 17.99, stock: 1 });
    const [order] = await placeOrder(buyer, [{ product }]);
    await payOrder(buyer, order);

    const soldOut = await prisma.product.findUnique({ where: { id: product.id } });
    expect(soldOut.state).toBe('out_of_stock');

    const res = await request(app).post(`/api/orders/${order.id}/cancel`).set(asUser(buyer)).send({});
    expect(res.status).toBe(200);

    const restocked = await prisma.product.findUnique({ where: { id: product.id } });
    expect(restocked.stock).toBe(1);
    expect(restocked.state).toBe('active');

    const rows = await ledger(order.id);
    expect(totalOf(rows, 'payment', 'refund')).toBe(0);
    expect(totalOf(rows, 'platform_fee', 'payout')).toBe(0);
  });
});

describe('who sees what on an order', () => {
  test('buyer, seller, admin and strangers each get the right view', async () => {
    const product = await createProduct(sellerA, category, { price: 17.99 });
    const [order] = await placeOrder(buyer, [{ product }]);
    await payOrder(buyer, order);
    const stranger = await createUser();

    const asBuyer = await request(app).get(`/api/orders/${order.id}`).set(asUser(buyer));
    expect(asBuyer.status).toBe(200);
    expect(asBuyer.body.viewerRole).toBe('buyer');
    expect(asBuyer.body.platformFee).toBeUndefined();
    expect(asBuyer.body.payoutAmount).toBeUndefined();

    const asSeller = await request(app).get(`/api/orders/${order.id}`).set(asUser(sellerA));
    expect(asSeller.body.viewerRole).toBe('seller');
    expect(asSeller.body.platformFee).toBe(1.8);
    expect(asSeller.body.payoutAmount).toBe(16.19);

    const asAdmin = await request(app).get(`/api/orders/${order.id}`).set(asUser(admin));
    expect(asAdmin.body.viewerRole).toBe('admin');

    const asStranger = await request(app).get(`/api/orders/${order.id}`).set(asUser(stranger));
    expect(asStranger.status).toBe(404);
  });

  test("the buyer's ledger and order list never show fee or payout figures", async () => {
    const product = await createProduct(sellerA, category, { price: 17.99 });
    const [order] = await placeOrder(buyer, [{ product }]);
    await payOrder(buyer, order);

    const buyerLedger = await request(app).get(`/api/orders/${order.id}/transactions`).set(asUser(buyer));
    expect(buyerLedger.body.map((t) => t.type)).toEqual(['payment']);

    const adminLedger = await request(app).get(`/api/orders/${order.id}/transactions`).set(asUser(admin));
    expect(adminLedger.body.map((t) => t.type)).toEqual(['payment', 'platform_fee', 'payout']);

    const list = await request(app).get('/api/orders').set(asUser(buyer));
    expect('platformFee' in list.body.orders[0]).toBe(false);
    expect('payoutAmount' in list.body.orders[0]).toBe(false);
  });
});

describe('expiry of unpaid orders', () => {
  test('only unpaid orders older than 24 hours are cancelled, once, with a notification', async () => {
    const a = await createProduct(sellerA, category);
    const b = await createProduct(sellerB, category);
    const [oldOrder, freshOrder] = await placeOrder(buyer, [{ product: a }, { product: b }]);
    await prisma.order.update({
      where: { id: oldOrder.id },
      data: { createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000) },
    });

    const first = await request(app).post('/api/admin/orders/expire-unpaid').set(asUser(admin)).send({});
    expect(first.status).toBe(200);
    expect(first.body.expired).toBe(1);

    expect((await prisma.order.findUnique({ where: { id: oldOrder.id } })).status).toBe('cancelled');
    expect((await prisma.order.findUnique({ where: { id: freshOrder.id } })).status).toBe('payment_pending');

    const notes = await request(app).get('/api/notifications').set(asUser(buyer));
    expect(notes.body.map((n) => n.title)).toContain('Order expired');

    const second = await request(app).post('/api/admin/orders/expire-unpaid').set(asUser(admin)).send({});
    expect(second.body.expired).toBe(0);
  });

  test('a paid order is never expired', async () => {
    const product = await createProduct(sellerA, category);
    const [order] = await placeOrder(buyer, [{ product }]);
    await payOrder(buyer, order);
    await prisma.order.update({
      where: { id: order.id },
      data: { createdAt: new Date(Date.now() - 48 * 60 * 60 * 1000) },
    });

    const res = await request(app).post('/api/admin/orders/expire-unpaid').set(asUser(admin)).send({});
    expect(res.body.expired).toBe(0);
    expect((await prisma.order.findUnique({ where: { id: order.id } })).status).toBe('confirmed');
  });
});
