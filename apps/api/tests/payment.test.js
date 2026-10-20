const request = require('supertest');
const { app, prisma } = require('../server');
const {
  createUser,
  asUser,
  resetDb,
  createCategory,
  createProduct,
  signPayment,
  newPaymentId,
  placeOrder,
  startPayment,
  confirmPayment,
  payOrder,
  ledger,
} = require('./helpers');

let buyer;
let sellerA;
let sellerB;
let category;

beforeEach(async () => {
  await resetDb();
  buyer = await createUser();
  sellerA = await createUser({ isSeller: true });
  sellerB = await createUser({ isSeller: true });
  category = await createCategory();
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

describe('creating a payment', () => {
  test('the same Razorpay order is reused and stored on the order', async () => {
    const product = await createProduct(sellerA, category, { price: 17.99 });
    const [order] = await placeOrder(buyer, [{ product }]);

    const first = await startPayment(buyer, order);
    const second = await startPayment(buyer, order);
    expect(first).toBeTruthy();
    expect(second).toBe(first);

    const stored = await prisma.order.findUnique({ where: { id: order.id } });
    expect(stored.razorpayOrderId).toBe(first);
  });

  test('an order that is no longer awaiting payment cannot be paid', async () => {
    const product = await createProduct(sellerA, category);
    const [order] = await placeOrder(buyer, [{ product }]);
    await prisma.order.update({ where: { id: order.id }, data: { status: 'cancelled' } });

    const res = await request(app).post(`/api/orders/${order.id}/create-payment`).set(asUser(buyer));
    expect(res.status).toBe(400);
  });

  test('someone else cannot start or confirm payment for your order', async () => {
    const product = await createProduct(sellerA, category);
    const [order] = await placeOrder(buyer, [{ product }]);
    const stranger = await createUser();

    const create = await request(app).post(`/api/orders/${order.id}/create-payment`).set(asUser(stranger));
    expect(create.status).toBe(404);

    const confirm = await request(app)
      .post(`/api/orders/${order.id}/confirm-payment`)
      .set(asUser(stranger))
      .send({ razorpay_order_id: 'order_x', razorpay_payment_id: 'pay_x', razorpay_signature: 'x' });
    expect(confirm.status).toBe(404);
  });
});

describe('confirming a payment', () => {
  test('takes the stock, writes the ledger and hides fee figures from the buyer', async () => {
    const product = await createProduct(sellerA, category, { price: 17.99, stock: 5 });
    const [order] = await placeOrder(buyer, [{ product }]);

    const res = await payOrder(buyer, order);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Payment confirmed');
    expect(res.body.order.status).toBe('confirmed');
    expect(res.body.order.platformFee).toBeUndefined();
    expect(res.body.order.payoutAmount).toBeUndefined();

    const fresh = await prisma.product.findUnique({ where: { id: product.id } });
    expect(fresh.stock).toBe(4);

    expect(await ledger(order.id)).toEqual([
      { type: 'payment', amount: 17.99 },
      { type: 'platform_fee', amount: 1.8 },
      { type: 'payout', amount: 16.19 },
    ]);
  });

  test('repeating the same confirmation is safe', async () => {
    const product = await createProduct(sellerA, category, { price: 10, stock: 5 });
    const [order] = await placeOrder(buyer, [{ product }]);

    const razorpayOrderId = await startPayment(buyer, order);
    const paymentId = newPaymentId();
    const first = await confirmPayment(buyer, order, razorpayOrderId, paymentId);
    const second = await confirmPayment(buyer, order, razorpayOrderId, paymentId);

    expect(first.body.message).toBe('Payment confirmed');
    expect(second.status).toBe(200);
    expect(second.body.message).toBe('Payment already confirmed');

    const fresh = await prisma.product.findUnique({ where: { id: product.id } });
    expect(fresh.stock).toBe(4);
    expect(await ledger(order.id)).toHaveLength(3);
  });

  test("a payment proof from another order is refused", async () => {
    const productA = await createProduct(sellerA, category);
    const productB = await createProduct(sellerB, category);
    const orders = await placeOrder(buyer, [{ product: productA }, { product: productB }]);
    const [orderA, orderB] = orders;

    const razorpayA = await startPayment(buyer, orderA);
    await startPayment(buyer, orderB);

    const paymentId = newPaymentId();
    const res = await confirmPayment(buyer, orderB, razorpayA, paymentId, signPayment(razorpayA, paymentId));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not belong/i);

    const stillPending = await prisma.order.findUnique({ where: { id: orderB.id } });
    expect(stillPending.status).toBe('payment_pending');
  });

  test('a wrong signature is rejected and recorded as one failed payment', async () => {
    const product = await createProduct(sellerA, category);
    const [order] = await placeOrder(buyer, [{ product }]);
    const razorpayOrderId = await startPayment(buyer, order);

    const res = await confirmPayment(buyer, order, razorpayOrderId, newPaymentId(), 'deadbeef');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/verification failed/i);

    expect(await ledger(order.id)).toEqual([{ type: 'payment_failed', amount: 10 }]);
  });

  test('missing fields are refused without writing a ledger row', async () => {
    const product = await createProduct(sellerA, category);
    const [order] = await placeOrder(buyer, [{ product }]);

    const res = await request(app)
      .post(`/api/orders/${order.id}/confirm-payment`)
      .set(asUser(buyer))
      .send({ razorpay_order_id: '', razorpay_payment_id: '', razorpay_signature: '' });
    expect(res.status).toBe(400);
    expect(await ledger(order.id)).toEqual([]);
  });

  test('the same payment id cannot pay two orders, and nothing is taken', async () => {
    const productA = await createProduct(sellerA, category, { stock: 5 });
    const productB = await createProduct(sellerB, category, { stock: 5 });
    const [orderA, orderB] = await placeOrder(buyer, [{ product: productA }, { product: productB }]);

    const razorpayA = await startPayment(buyer, orderA);
    const razorpayB = await startPayment(buyer, orderB);
    const paymentId = newPaymentId();

    const first = await confirmPayment(buyer, orderA, razorpayA, paymentId);
    expect(first.status).toBe(200);

    const reused = await confirmPayment(buyer, orderB, razorpayB, paymentId);
    expect(reused.status).toBe(409);
    expect(reused.body.error).toMatch(/already used/i);

    const pending = await prisma.order.findUnique({ where: { id: orderB.id } });
    expect(pending.status).toBe('payment_pending');
    const untouched = await prisma.product.findUnique({ where: { id: productB.id } });
    expect(untouched.stock).toBe(5);
  });

  test('two confirmations at the same moment take stock once and write one ledger', async () => {
    const product = await createProduct(sellerA, category, { price: 10, stock: 5 });
    const [order] = await placeOrder(buyer, [{ product }]);

    const razorpayOrderId = await startPayment(buyer, order);
    const paymentId = newPaymentId();

    const results = await Promise.all([
      confirmPayment(buyer, order, razorpayOrderId, paymentId),
      confirmPayment(buyer, order, razorpayOrderId, paymentId),
    ]);

    results.forEach((r) => expect([200, 409]).toContain(r.status));
    expect(results.filter((r) => r.body.message === 'Payment confirmed')).toHaveLength(1);

    const fresh = await prisma.product.findUnique({ where: { id: product.id } });
    expect(fresh.stock).toBe(4);
    expect(await ledger(order.id)).toHaveLength(3);
  });

  test('an item sold out after checkout cancels the order and records the refund owed', async () => {
    const product = await createProduct(sellerA, category, { price: 17.99, stock: 3 });
    const [order] = await placeOrder(buyer, [{ product }]);
    await prisma.product.update({ where: { id: product.id }, data: { stock: 0 } });

    const res = await payOrder(buyer, order);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/out of stock/i);

    const cancelled = await prisma.order.findUnique({ where: { id: order.id } });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.razorpayPaymentId).toBeTruthy();
    expect(await ledger(order.id)).toEqual([
      { type: 'payment', amount: 17.99 },
      { type: 'refund', amount: -17.99 },
    ]);

    const notes = await request(app).get('/api/notifications').set(asUser(buyer));
    expect(notes.body.map((n) => n.title)).toContain('Order cancelled');
  });

  test('buying the last unit marks the product out of stock and notifies the seller', async () => {
    const product = await createProduct(sellerA, category, { stock: 1 });
    const [order] = await placeOrder(buyer, [{ product }]);

    const res = await payOrder(buyer, order);
    expect(res.status).toBe(200);

    const fresh = await prisma.product.findUnique({ where: { id: product.id } });
    expect(fresh.stock).toBe(0);
    expect(fresh.state).toBe('out_of_stock');

    const notes = await request(app).get('/api/notifications').set(asUser(sellerA));
    expect(notes.body.map((n) => n.title)).toContain('Product out of stock');
  });
});
