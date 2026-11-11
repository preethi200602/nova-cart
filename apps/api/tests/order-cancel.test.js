// Cancelling an order: who may cancel, what is put back (stock, ledger), and what happens on double clicks and races.
const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, asUser, resetDb, createCategory, createProduct } = require('./helpers');

const INT_MAX = 2147483647;

let otherSeller;
let otherBuyer;
let category;

beforeAll(async () => {
  await resetDb();
  otherSeller = await createUser({ isSeller: true });
  otherBuyer = await createUser();
  category = await createCategory();
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

// An order with its own buyer, seller and products, so counts in one test never leak into another.
// quantities: one entry per item (one product each). stocks: the stock each product has AFTER payment.
// A paid order (anything but payment_pending) also carries the three ledger rows that payment writes.
async function makeOrder({ status = 'confirmed', quantities = [2], stocks = [8], productState = 'active' } = {}) {
  const buyer = await createUser();
  const seller = await createUser({ isSeller: true });
  const products = [];
  for (let i = 0; i < quantities.length; i += 1) {
    products.push(await createProduct(seller, category, { stock: stocks[i], state: productState }));
  }
  const paid = status !== 'payment_pending';
  const order = await prisma.order.create({
    data: {
      buyerId: buyer.id,
      sellerId: seller.id,
      subtotal: 10,
      deliveryAddress: '1 Test Street, Chennai',
      status,
      ...(paid ? { platformFee: 1.5, payoutAmount: 8.5 } : {}),
      items: { create: products.map((p, i) => ({ productId: p.id, quantity: quantities[i], price: 5 })) },
    },
  });
  if (paid) {
    await prisma.transaction.createMany({
      data: [
        { orderId: order.id, type: 'payment', amount: 10 },
        { orderId: order.id, type: 'platform_fee', amount: 1.5 },
        { orderId: order.id, type: 'payout', amount: 8.5 },
      ],
    });
  }
  return { order, products, product: products[0], buyer, seller };
}

const cancel = (orderId, who) => request(app).post(`/api/orders/${orderId}/cancel`).set(asUser(who)).send({});
const orderNow = (id) => prisma.order.findUnique({ where: { id } });
const stockOf = async (product) => (await prisma.product.findUnique({ where: { id: product.id } })).stock;
const ledgerRows = (orderId) => prisma.transaction.findMany({ where: { orderId } });
const total = (rows, ...types) =>
  Math.round(rows.filter((r) => types.includes(r.type)).reduce((sum, r) => sum + r.amount, 0) * 100) / 100;
const cancelNotes = (user) =>
  prisma.notification.findMany({ where: { userId: user.id, category: 'orders', title: 'Order cancelled' } });

describe('who may cancel', () => {
  test('the buyer cancels a confirmed order: stock goes back, the money is reversed, both sides are told', async () => {
    const { order, product, buyer, seller } = await makeOrder();
    const res = await cancel(order.id, buyer);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Order cancelled');
    expect(res.body.order.status).toBe('cancelled');
    expect(res.body.order.platformFee).toBeUndefined();
    expect(res.body.order.payoutAmount).toBeUndefined();

    expect((await orderNow(order.id)).status).toBe('cancelled');
    expect(await stockOf(product)).toBe(10);
    const rows = await ledgerRows(order.id);
    expect(rows).toHaveLength(6);
    expect(total(rows, 'payment', 'refund')).toBe(0);
    expect(total(rows, 'platform_fee', 'payout')).toBe(0);
    expect(await cancelNotes(buyer)).toHaveLength(1);
    expect(await cancelNotes(seller)).toHaveLength(1);
  });

  test('the seller cancels a processing order and still sees their own money fields', async () => {
    const { order, product, seller } = await makeOrder({ status: 'processing' });
    const res = await cancel(order.id, seller);
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('cancelled');
    expect(res.body.order.platformFee).toBe(1.5);
    expect(res.body.order.payoutAmount).toBe(8.5);
    expect(await stockOf(product)).toBe(10);
  });

  test.each([
    ['another buyer', () => otherBuyer],
    ['another seller', () => otherSeller],
  ])('%s is told the order does not exist (404) and nothing changes', async (label, who) => {
    const { order, product } = await makeOrder();
    const res = await cancel(order.id, who());
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Order not found');
    expect((await orderNow(order.id)).status).toBe('confirmed');
    expect(await stockOf(product)).toBe(8);
    expect(await ledgerRows(order.id)).toHaveLength(3);
  });

  test('an unknown order id gives 404', async () => {
    const res = await cancel('00000000-0000-4000-8000-000000000000', otherBuyer);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Order not found');
  });

  test('someone who is not logged in gets 401', async () => {
    const { order } = await makeOrder();
    const res = await request(app).post(`/api/orders/${order.id}/cancel`).send({});
    expect(res.status).toBe(401);
    expect((await orderNow(order.id)).status).toBe('confirmed');
  });
});

describe('what is put back', () => {
  test.each(['confirmed', 'processing'])('a %s order: stock goes back once and three reversing ledger rows are added', async (status) => {
    const { order, product, buyer } = await makeOrder({ status });
    const res = await cancel(order.id, buyer);
    expect(res.status).toBe(200);
    expect(await stockOf(product)).toBe(10);
    const rows = await ledgerRows(order.id);
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.type === 'refund')).toHaveLength(1);
    expect(rows.find((r) => r.type === 'refund').amount).toBe(-10);
    expect(rows.filter((r) => r.type === 'platform_fee' && r.amount === -1.5)).toHaveLength(1);
    expect(rows.filter((r) => r.type === 'payout' && r.amount === -8.5)).toHaveLength(1);
  });

  test('an order that was never paid: no stock goes back and nothing is written to the ledger', async () => {
    const { order, product, buyer, seller } = await makeOrder({ status: 'payment_pending' });
    const res = await cancel(order.id, buyer);
    expect(res.status).toBe(200);
    expect((await orderNow(order.id)).status).toBe('cancelled');
    expect(await stockOf(product)).toBe(8);
    expect(await ledgerRows(order.id)).toHaveLength(0);
    expect(await cancelNotes(buyer)).toHaveLength(1);
    expect(await cancelNotes(seller)).toHaveLength(1);
  });

  test('every item of the order is restocked', async () => {
    const { order, products, buyer } = await makeOrder({ quantities: [2, 3], stocks: [8, 7] });
    const res = await cancel(order.id, buyer);
    expect(res.status).toBe(200);
    expect(await stockOf(products[0])).toBe(10);
    expect(await stockOf(products[1])).toBe(10);
  });

  test('a product that sold out becomes active again', async () => {
    const { order, product, buyer } = await makeOrder({ quantities: [1], stocks: [0], productState: 'out_of_stock' });
    const res = await cancel(order.id, buyer);
    expect(res.status).toBe(200);
    const after = await prisma.product.findUnique({ where: { id: product.id } });
    expect(after.stock).toBe(1);
    expect(after.state).toBe('active');
  });
});

describe('orders that can no longer be cancelled', () => {
  test.each(['shipped', 'delivered', 'refund_requested', 'cancelled', 'refunded'])(
    'a %s order is refused with 400 and nothing changes',
    async (status) => {
      const { order, product, buyer, seller } = await makeOrder({ status });
      const res = await cancel(order.id, buyer);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(`Cannot cancel an order that is already "${status}"`);
      expect((await orderNow(order.id)).status).toBe(status);
      expect(await stockOf(product)).toBe(8);
      expect(await ledgerRows(order.id)).toHaveLength(3);
      expect(await cancelNotes(buyer)).toHaveLength(0);
      expect(await cancelNotes(seller)).toHaveLength(0);
    }
  );
});

describe('double clicks and races', () => {
  test('cancelling twice: the second try is refused, stock goes back once and the ledger is reversed once', async () => {
    const { order, product, buyer, seller } = await makeOrder();
    expect((await cancel(order.id, buyer)).status).toBe(200);
    const again = await cancel(order.id, buyer);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('Cannot cancel an order that is already "cancelled"');
    expect(await stockOf(product)).toBe(10);
    expect(await ledgerRows(order.id)).toHaveLength(6);
    expect(await cancelNotes(buyer)).toHaveLength(1);
    expect(await cancelNotes(seller)).toHaveLength(1);
  });

  test('the buyer and the seller cancel at the same moment: one wins, stock and ledger change once', async () => {
    const { order, product, buyer, seller } = await makeOrder();
    const results = await Promise.all([cancel(order.id, buyer), cancel(order.id, seller), cancel(order.id, buyer)]);
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    // The others are told "no" (400 if they read the order after the change, 409 if they raced it).
    expect(codes.filter((c) => c !== 200).every((c) => c === 400 || c === 409)).toBe(true);
    expect((await orderNow(order.id)).status).toBe('cancelled');
    expect(await stockOf(product)).toBe(10);
    expect(await ledgerRows(order.id)).toHaveLength(6);
    expect(await cancelNotes(buyer)).toHaveLength(1);
    expect(await cancelNotes(seller)).toHaveLength(1);
  });

  test('a cancel and a "shipped" at the same moment: exactly one wins and the books match the winner', async () => {
    const { order, product, buyer, seller } = await makeOrder({ status: 'processing' });
    const results = await Promise.all([
      cancel(order.id, buyer),
      request(app).put(`/api/orders/${order.id}/status`).set(asUser(seller)).send({ status: 'shipped' }),
    ]);
    const codes = results.map((r) => r.status);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c !== 200).every((c) => c === 400 || c === 409)).toBe(true);

    const final = await orderNow(order.id);
    expect(['cancelled', 'shipped']).toContain(final.status);
    if (final.status === 'cancelled') {
      expect(await stockOf(product)).toBe(10);
      expect(await ledgerRows(order.id)).toHaveLength(6);
    } else {
      expect(await stockOf(product)).toBe(8);
      expect(await ledgerRows(order.id)).toHaveLength(3);
      expect(await cancelNotes(buyer)).toHaveLength(0);
    }
  });

  test('all or nothing: if one item cannot be restocked, the order, the other stock and the ledger stay as they were', async () => {
    // The second product already holds the largest number the database can store, so adding to it fails.
    const { order, products, buyer, seller } = await makeOrder({ quantities: [2, 2], stocks: [8, INT_MAX] });
    const res = await cancel(order.id, buyer);
    expect(res.status).toBe(500);
    expect((await orderNow(order.id)).status).toBe('confirmed');
    expect(await stockOf(products[0])).toBe(8);
    expect(await stockOf(products[1])).toBe(INT_MAX);
    expect(await ledgerRows(order.id)).toHaveLength(3);
    expect(await cancelNotes(buyer)).toHaveLength(0);
    expect(await cancelNotes(seller)).toHaveLength(0);
  });
});
