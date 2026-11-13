// A payment that arrives after the order was cancelled (by the buyer, the seller, the expiry job or a race).
// The money was taken, so the ledger must show the payment and the refund that is owed. Plus the normal payment path.
const request = require('supertest');
const { app, prisma, expireUnpaidOrders } = require('../server');
const { createUser, asUser, resetDb, createCategory, createProduct, newPaymentId, signPayment, confirmPayment } = require('./helpers');

const LATE_TITLE = 'Payment received for a cancelled order';

let otherBuyer;
let category;
let rzpCounter = 0;
const newRzpOrderId = () => {
  rzpCounter += 1;
  return `order_test_${rzpCounter}_${Date.now()}`;
};

beforeAll(async () => {
  await resetDb();
  otherBuyer = await createUser();
  category = await createCategory();
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

// An order with its own buyer, seller and product. Created directly, so no checkout is needed.
async function makeOrder({ status = 'payment_pending', razorpayOrderId = newRzpOrderId(), quantity = 2, stock = 10, createdAt } = {}) {
  const buyer = await createUser();
  const seller = await createUser({ isSeller: true });
  const product = await createProduct(seller, category, { stock });
  const order = await prisma.order.create({
    data: {
      buyerId: buyer.id,
      sellerId: seller.id,
      subtotal: 10,
      deliveryAddress: '1 Test Street, Chennai',
      status,
      razorpayOrderId,
      ...(createdAt ? { createdAt } : {}),
      items: { create: [{ productId: product.id, quantity, price: 5 }] },
    },
  });
  return { order, product, buyer, seller, razorpayOrderId };
}

const cancelOrder = (order, who) => request(app).post(`/api/orders/${order.id}/cancel`).set(asUser(who)).send({});
const orderNow = (id) => prisma.order.findUnique({ where: { id } });
const stockOf = async (product) => (await prisma.product.findUnique({ where: { id: product.id } })).stock;
const ledgerRows = (orderId) => prisma.transaction.findMany({ where: { orderId } });
const typesOf = (rows) => rows.map((r) => r.type).sort();
const lateNotes = (user) => prisma.notification.findMany({ where: { userId: user.id, category: 'refunds', title: LATE_TITLE } });

describe('starting a payment is unchanged', () => {
  test('an unpaid order can still start a payment', async () => {
    const { order, buyer } = await makeOrder({ razorpayOrderId: null });
    const res = await request(app).post(`/api/orders/${order.id}/create-payment`).set(asUser(buyer)).send({});
    expect(res.status).toBe(200);
    expect(res.body.razorpayOrderId).toBeTruthy();
    expect((await orderNow(order.id)).razorpayOrderId).toBe(res.body.razorpayOrderId);
  });

  test('a cancelled order still cannot start a payment', async () => {
    const { order, buyer } = await makeOrder({ status: 'cancelled' });
    const res = await request(app).post(`/api/orders/${order.id}/create-payment`).set(asUser(buyer)).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This order is not awaiting payment');
  });
});

describe('a normal payment still works', () => {
  test('a valid payment confirms the order, takes the stock and writes the ledger', async () => {
    const { order, product, buyer, razorpayOrderId } = await makeOrder();
    const paymentId = newPaymentId();
    const res = await confirmPayment(buyer, order, razorpayOrderId, paymentId);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Payment confirmed');
    const after = await orderNow(order.id);
    expect(after.status).toBe('confirmed');
    expect(after.razorpayPaymentId).toBe(paymentId);
    expect(await stockOf(product)).toBe(8);
    expect(typesOf(await ledgerRows(order.id))).toEqual(['payment', 'payout', 'platform_fee']);
  });
});

describe('a payment that arrives after the order was cancelled', () => {
  test.each([
    ['the buyer', (o) => o.buyer],
    ['the seller', (o) => o.seller],
  ])('cancelled by %s: the payment and the refund owed are both recorded', async (label, who) => {
    const o = await makeOrder();
    expect((await cancelOrder(o.order, who(o))).status).toBe(200);
    expect(await ledgerRows(o.order.id)).toHaveLength(0); // an unpaid order leaves no ledger rows

    const paymentId = newPaymentId();
    const res = await confirmPayment(o.buyer, o.order, o.razorpayOrderId, paymentId);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cancelled/);
    expect(res.body.error).toMatch(/refund/);

    const after = await orderNow(o.order.id);
    expect(after.status).toBe('cancelled');
    expect(after.razorpayPaymentId).toBe(paymentId);
    expect(await stockOf(o.product)).toBe(10);

    const rows = await ledgerRows(o.order.id);
    expect(typesOf(rows)).toEqual(['payment', 'refund']);
    expect(rows.find((r) => r.type === 'payment').amount).toBe(10);
    expect(rows.find((r) => r.type === 'refund').amount).toBe(-10);
    expect(await lateNotes(o.buyer)).toHaveLength(1);
  });

  test('expired by the expiry job: the payment and the refund owed are recorded', async () => {
    const dayAndAHalfAgo = new Date(Date.now() - 36 * 60 * 60 * 1000);
    const o = await makeOrder({ createdAt: dayAndAHalfAgo });
    expect(await expireUnpaidOrders()).toBeGreaterThanOrEqual(1);
    expect((await orderNow(o.order.id)).status).toBe('cancelled');

    const res = await confirmPayment(o.buyer, o.order, o.razorpayOrderId, newPaymentId());
    expect(res.status).toBe(409);
    expect(typesOf(await ledgerRows(o.order.id))).toEqual(['payment', 'refund']);
    expect(await stockOf(o.product)).toBe(10);
    expect(await lateNotes(o.buyer)).toHaveLength(1);
  });

  test('the same late payment sent again changes nothing', async () => {
    const o = await makeOrder();
    await cancelOrder(o.order, o.buyer);
    const paymentId = newPaymentId();
    const first = await confirmPayment(o.buyer, o.order, o.razorpayOrderId, paymentId);
    const again = await confirmPayment(o.buyer, o.order, o.razorpayOrderId, paymentId);
    expect(first.status).toBe(409);
    expect(again.status).toBe(409);
    expect(await ledgerRows(o.order.id)).toHaveLength(2);
    expect(await lateNotes(o.buyer)).toHaveLength(1);
  });

  test('two copies of the same late payment at the same moment are recorded once', async () => {
    const o = await makeOrder();
    await cancelOrder(o.order, o.buyer);
    const paymentId = newPaymentId();
    const results = await Promise.all([
      confirmPayment(o.buyer, o.order, o.razorpayOrderId, paymentId),
      confirmPayment(o.buyer, o.order, o.razorpayOrderId, paymentId),
      confirmPayment(o.buyer, o.order, o.razorpayOrderId, paymentId),
    ]);
    expect(results.every((r) => r.status === 409)).toBe(true);
    expect(await ledgerRows(o.order.id)).toHaveLength(2);
    expect(await lateNotes(o.buyer)).toHaveLength(1);
  });
});

describe('a payment that does not check out is refused and nothing is written', () => {
  async function expectRefused(o, res) {
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This order is not awaiting payment');
    expect(await ledgerRows(o.order.id)).toHaveLength(0);
    expect((await orderNow(o.order.id)).razorpayPaymentId).toBeNull();
    expect(await lateNotes(o.buyer)).toHaveLength(0);
  }

  test('a wrong signature on a cancelled order', async () => {
    const o = await makeOrder({ status: 'cancelled' });
    const res = await confirmPayment(o.buyer, o.order, o.razorpayOrderId, newPaymentId(), 'not-a-real-signature');
    await expectRefused(o, res);
  });

  test('a payment signed for a different Razorpay order', async () => {
    const o = await makeOrder({ status: 'cancelled' });
    const paymentId = newPaymentId();
    const foreign = newRzpOrderId();
    const res = await confirmPayment(o.buyer, o.order, foreign, paymentId, signPayment(foreign, paymentId));
    await expectRefused(o, res);
  });

  test('a cancelled order that never started a payment', async () => {
    const o = await makeOrder({ status: 'cancelled', razorpayOrderId: null });
    const paymentId = newPaymentId();
    const res = await confirmPayment(o.buyer, o.order, 'order_never_created', paymentId);
    await expectRefused(o, res);
  });

  test('an order in another status, such as shipped', async () => {
    const o = await makeOrder({ status: 'shipped' });
    const res = await confirmPayment(o.buyer, o.order, o.razorpayOrderId, newPaymentId());
    await expectRefused(o, res);
  });

  test("another buyer cannot record a payment on someone else's order", async () => {
    const o = await makeOrder({ status: 'cancelled' });
    const res = await confirmPayment(otherBuyer, o.order, o.razorpayOrderId, newPaymentId());
    expect(res.status).toBe(404);
    expect(await ledgerRows(o.order.id)).toHaveLength(0);
  });

  test('a payment id that was already used on another order is refused and the second order is untouched', async () => {
    const first = await makeOrder();
    await cancelOrder(first.order, first.buyer);
    const paymentId = newPaymentId();
    expect((await confirmPayment(first.buyer, first.order, first.razorpayOrderId, paymentId)).status).toBe(409);

    const second = await makeOrder({ status: 'cancelled' });
    const res = await confirmPayment(second.buyer, second.order, second.razorpayOrderId, paymentId);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This payment was already used for another order');
    expect((await orderNow(second.order.id)).razorpayPaymentId).toBeNull();
    expect(await ledgerRows(second.order.id)).toHaveLength(0);
    expect(await lateNotes(second.buyer)).toHaveLength(0);
  });
});

describe('an order that was paid and then cancelled', () => {
  test('sending the same payment again records nothing more', async () => {
    const o = await makeOrder({ status: 'confirmed' });
    const paymentId = newPaymentId();
    await prisma.order.update({ where: { id: o.order.id }, data: { razorpayPaymentId: paymentId, platformFee: 1.5, payoutAmount: 8.5 } });
    await prisma.transaction.createMany({
      data: [
        { orderId: o.order.id, type: 'payment', amount: 10 },
        { orderId: o.order.id, type: 'platform_fee', amount: 1.5 },
        { orderId: o.order.id, type: 'payout', amount: 8.5 },
      ],
    });
    expect((await cancelOrder(o.order, o.buyer)).status).toBe(200);
    expect(await ledgerRows(o.order.id)).toHaveLength(6);

    const res = await confirmPayment(o.buyer, o.order, o.razorpayOrderId, paymentId);
    expect(res.status).toBe(409);
    expect(await ledgerRows(o.order.id)).toHaveLength(6);
    expect(await lateNotes(o.buyer)).toHaveLength(0);
  });
});

describe('paying and cancelling at the same moment', () => {
  test('whichever wins, the books match the final status (repeated 6 times)', async () => {
    for (let i = 0; i < 6; i += 1) {
      const o = await makeOrder();
      const paymentId = newPaymentId();
      const [cancelRes, payRes] = await Promise.all([
        cancelOrder(o.order, o.buyer),
        confirmPayment(o.buyer, o.order, o.razorpayOrderId, paymentId),
      ]);
      expect(cancelRes.status === 200 && payRes.status === 200).toBe(false);

      const final = await orderNow(o.order.id);
      const rows = await ledgerRows(o.order.id);
      if (final.status === 'confirmed') {
        expect(payRes.status).toBe(200);
        expect([400, 409]).toContain(cancelRes.status);
        expect(typesOf(rows)).toEqual(['payment', 'payout', 'platform_fee']);
        expect(await stockOf(o.product)).toBe(8);
      } else {
        expect(final.status).toBe('cancelled');
        expect(cancelRes.status).toBe(200);
        expect(payRes.status).toBe(409);
        expect(typesOf(rows)).toEqual(['payment', 'refund']);
        expect(final.razorpayPaymentId).toBe(paymentId);
        expect(await stockOf(o.product)).toBe(10);
        expect(await lateNotes(o.buyer)).toHaveLength(1);
      }
    }
  });
});
