const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { prisma } = require('../server');

let counter = 0;

async function createUser(overrides = {}) {
  counter += 1;
  return prisma.user.create({
    data: {
      email: `user${counter}-${Date.now()}@test.local`,
      password: await bcrypt.hash('Password123!', 4),
      name: `User ${counter}`,
      emailVerified: true,
      ...overrides,
    },
  });
}

function tokenFor(user) {
  return jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function asUser(user) {
  return { Authorization: `Bearer ${tokenFor(user)}` };
}

async function resetDb() {
  const tables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

const crypto = require('crypto');
const request = require('supertest');
const { app } = require('../server');

let productCounter = 0;
let paymentCounter = 0;

async function createCategory(name = 'Test Category') {
  return prisma.category.create({ data: { name: `${name} ${Date.now()}-${Math.random().toString(36).slice(2, 6)}` } });
}

async function createProduct(seller, category, overrides = {}) {
  productCounter += 1;
  return prisma.product.create({
    data: {
      sellerId: seller.id,
      categoryId: category.id,
      name: `Product ${productCounter}`,
      description: 'A product made for testing',
      price: 10,
      stock: 10,
      state: 'active',
      ...overrides,
    },
  });
}

function signPayment(razorpayOrderId, paymentId) {
  return crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${paymentId}`)
    .digest('hex');
}

function newPaymentId() {
  paymentCounter += 1;
  return `pay_test_${paymentCounter}_${Date.now()}`;
}

// Puts items in the buyer's cart and checks out. Returns the created orders.
async function placeOrder(buyer, items) {
  for (const { product, quantity = 1 } of items) {
    const added = await request(app)
      .post('/api/cart/items')
      .set(asUser(buyer))
      .send({ productId: product.id, quantity });
    if (added.status >= 300) throw new Error(`add to cart failed: ${added.status} ${JSON.stringify(added.body)}`);
  }
  const res = await request(app)
    .post('/api/checkout')
    .set(asUser(buyer))
    .send({ deliveryAddress: '1 Test Street, Chennai' });
  if (res.status !== 201) throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.orders;
}

async function startPayment(buyer, order) {
  const res = await request(app).post(`/api/orders/${order.id}/create-payment`).set(asUser(buyer));
  if (res.status !== 200) throw new Error(`create-payment failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.razorpayOrderId;
}

function confirmPayment(buyer, order, razorpayOrderId, paymentId, signature) {
  return request(app)
    .post(`/api/orders/${order.id}/confirm-payment`)
    .set(asUser(buyer))
    .send({
      razorpay_order_id: razorpayOrderId,
      razorpay_payment_id: paymentId,
      razorpay_signature: signature === undefined ? signPayment(razorpayOrderId, paymentId) : signature,
    });
}

// Creates the Razorpay order and confirms a valid payment in one go.
async function payOrder(buyer, order) {
  const razorpayOrderId = await startPayment(buyer, order);
  return confirmPayment(buyer, order, razorpayOrderId, newPaymentId());
}

async function ledger(orderId) {
  const rows = await prisma.transaction.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } });
  return rows.map((r) => ({ type: r.type, amount: Math.round(r.amount * 100) / 100 }));
}

function totalOf(rows, ...types) {
  return Math.round(rows.filter((r) => types.includes(r.type)).reduce((sum, r) => sum + r.amount, 0) * 100) / 100;
}

module.exports = {
  createUser,
  tokenFor,
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
  totalOf,
};
