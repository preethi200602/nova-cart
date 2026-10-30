// Buyer-facing order responses must not contain seller-side money or payment fields.
const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, asUser, resetDb, createCategory, createProduct, placeOrder } = require('./helpers');

const HIDDEN = [
  'platformFee',
  'payoutAmount',
  'payoutStatus',
  'payoutPaidAt',
  'payoutReference',
  'razorpayOrderId',
  'razorpayPaymentId',
];
const leaked = (obj) => HIDDEN.filter((key) => key in obj);

let seller;
let buyer;
let product;
let counter = 0;

beforeAll(async () => {
  await resetDb();
  seller = await createUser({ isSeller: true });
  buyer = await createUser();
  const category = await createCategory();
  product = await createProduct(seller, category);
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

// Places a real order, then gives it the money and payment fields a paid order would have.
async function paidOrder(extra = {}) {
  const [order] = await placeOrder(buyer, [{ product }]);
  counter += 1;
  return prisma.order.update({
    where: { id: order.id },
    data: {
      status: 'confirmed',
      platformFee: 1.5,
      payoutAmount: 8.5,
      payoutStatus: 'pending',
      payoutReference: `ref-bv-${counter}`,
      razorpayOrderId: `order_bv_${counter}`,
      razorpayPaymentId: `pay_bv_${counter}`,
      ...extra,
    },
  });
}

describe('buyer-facing order responses hide seller-side fields', () => {
  test('request-refund response has no money or payment fields', async () => {
    const order = await paidOrder({ status: 'delivered', deliveredAt: new Date() });
    const res = await request(app)
      .post(`/api/orders/${order.id}/request-refund`)
      .set(asUser(buyer))
      .send({ reason: 'Damaged' });
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('refund_requested');
    expect(leaked(res.body.order)).toEqual([]);
  });

  test('cancel by the buyer has no money or payment fields', async () => {
    const order = await paidOrder();
    const res = await request(app).post(`/api/orders/${order.id}/cancel`).set(asUser(buyer));
    expect(res.status).toBe(200);
    expect(res.body.order.status).toBe('cancelled');
    expect(leaked(res.body.order)).toEqual([]);
  });

  test('cancel by the seller still shows the seller their own money fields', async () => {
    const order = await paidOrder();
    const res = await request(app).post(`/api/orders/${order.id}/cancel`).set(asUser(seller));
    expect(res.status).toBe(200);
    expect(res.body.order.platformFee).toBe(1.5);
    expect(res.body.order.payoutAmount).toBe(8.5);
  });

  test("the buyer's order list has no money or payment fields", async () => {
    await paidOrder();
    const res = await request(app).get('/api/orders').set(asUser(buyer));
    expect(res.status).toBe(200);
    expect(res.body.orders.length).toBeGreaterThan(0);
    for (const order of res.body.orders) {
      expect(leaked(order)).toEqual([]);
    }
  });
});
