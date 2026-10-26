const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, asUser, resetDb, createCategory, createProduct } = require('./helpers');

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let seller;
let otherSeller;
let buyer;
let category;
let product;

// Builds an order straight in the database (no Razorpay needed).
// Pass one product or an array of products. Overrides replace the defaults (for example status).
async function makeOrder(forBuyer, forSeller, products, overrides = {}) {
  const list = Array.isArray(products) ? products : [products];
  return prisma.order.create({
    data: {
      buyerId: forBuyer.id,
      sellerId: forSeller.id,
      subtotal: list.reduce((sum, p) => sum + p.price, 0),
      deliveryAddress: '1 Test Street, Chennai',
      status: 'delivered',
      deliveredAt: new Date(),
      items: { create: list.map((p) => ({ productId: p.id, quantity: 1, price: p.price })) },
      ...overrides,
    },
  });
}

// Creates a review straight in the database (used where the API is not what we are testing).
async function makeReview(forBuyer, forProduct, overrides = {}) {
  const order = await makeOrder(forBuyer, seller, forProduct);
  return prisma.review.create({
    data: {
      productId: forProduct.id,
      orderId: order.id,
      buyerId: forBuyer.id,
      rating: 4,
      comment: 'Nice',
      ...overrides,
    },
  });
}

function postReview(who, productId, body) {
  return request(app).post(`/api/products/${productId}/reviews`).set(asUser(who)).send(body);
}

beforeEach(async () => {
  await resetDb();
  seller = await createUser({ isSeller: true });
  otherSeller = await createUser({ isSeller: true });
  buyer = await createUser();
  category = await createCategory();
  product = await createProduct(seller, category);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('POST /api/products/:id/reviews', () => {
  test('a buyer can review a product from a delivered order', async () => {
    const order = await makeOrder(buyer, seller, product);

    const res = await postReview(buyer, product.id, { orderId: order.id, rating: 5, comment: 'Great case' });

    expect(res.status).toBe(201);
    expect(res.body.rating).toBe(5);
    expect(res.body.comment).toBe('Great case');
    expect(res.body.productId).toBe(product.id);
    expect(res.body.buyerId).toBe(buyer.id);

    const rows = await prisma.review.findMany({ where: { productId: product.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].orderId).toBe(order.id);
  });

  test('the seller gets a "New review received" notification in the reviews category', async () => {
    const order = await makeOrder(buyer, seller, product);

    const res = await postReview(buyer, product.id, { orderId: order.id, rating: 4 });
    expect(res.status).toBe(201);

    const notes = await prisma.notification.findMany({ where: { userId: seller.id, category: 'reviews' } });
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('New review received');

    const buyerNotes = await prisma.notification.findMany({ where: { userId: buyer.id, category: 'reviews' } });
    expect(buyerNotes).toHaveLength(0);
  });

  test('the comment is optional and is stored as null when left out', async () => {
    const order = await makeOrder(buyer, seller, product);

    const res = await postReview(buyer, product.id, { orderId: order.id, rating: 3 });

    expect(res.status).toBe(201);
    expect(res.body.comment).toBeNull();
  });

  test('a request without a token is refused', async () => {
    const order = await makeOrder(buyer, seller, product);

    const res = await request(app).post(`/api/products/${product.id}/reviews`).send({ orderId: order.id, rating: 5 });

    expect(res.status).toBe(401);
    expect(await prisma.review.count()).toBe(0);
  });

  test('an order that is not delivered is refused', async () => {
    const order = await makeOrder(buyer, seller, product, { status: 'shipped', deliveredAt: null });

    const res = await postReview(buyer, product.id, { orderId: order.id, rating: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('You can only review products from delivered orders');
    expect(await prisma.review.count()).toBe(0);
  });

  test('a product that is not in the order is refused', async () => {
    const otherProduct = await createProduct(seller, category);
    const order = await makeOrder(buyer, seller, product);

    const res = await postReview(buyer, otherProduct.id, { orderId: order.id, rating: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This product was not part of that order');
    expect(await prisma.review.count()).toBe(0);
  });

  test('a product id that does not exist is refused', async () => {
    const order = await makeOrder(buyer, seller, product);

    const res = await postReview(buyer, MISSING_ID, { orderId: order.id, rating: 5 });

    expect(res.status).toBe(400);
    expect(await prisma.review.count()).toBe(0);
  });

  test("someone else's order gives 404", async () => {
    const stranger = await createUser();
    const order = await makeOrder(buyer, seller, product);

    const res = await postReview(stranger, product.id, { orderId: order.id, rating: 5 });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Order not found');
    expect(await prisma.review.count()).toBe(0);
  });

  test('an order id that does not exist gives 404', async () => {
    const res = await postReview(buyer, product.id, { orderId: MISSING_ID, rating: 5 });

    expect(res.status).toBe(404);
    expect(await prisma.review.count()).toBe(0);
  });

  test('a second review for the same product and order gives 409 and adds no row or notification', async () => {
    const order = await makeOrder(buyer, seller, product);

    const first = await postReview(buyer, product.id, { orderId: order.id, rating: 5 });
    const second = await postReview(buyer, product.id, { orderId: order.id, rating: 1 });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('You have already reviewed this product for this order');

    const rows = await prisma.review.findMany({ where: { productId: product.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].rating).toBe(5);

    const notes = await prisma.notification.findMany({ where: { userId: seller.id, category: 'reviews' } });
    expect(notes).toHaveLength(1);
  });

  test('two products in one order can each be reviewed once', async () => {
    const second = await createProduct(seller, category);
    const order = await makeOrder(buyer, seller, [product, second]);

    const a = await postReview(buyer, product.id, { orderId: order.id, rating: 5 });
    const b = await postReview(buyer, second.id, { orderId: order.id, rating: 2 });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await prisma.review.count()).toBe(2);
  });

  test('the same product bought in a second delivered order can be reviewed again', async () => {
    const orderOne = await makeOrder(buyer, seller, product);
    const orderTwo = await makeOrder(buyer, seller, product);

    const a = await postReview(buyer, product.id, { orderId: orderOne.id, rating: 5 });
    const b = await postReview(buyer, product.id, { orderId: orderTwo.id, rating: 4 });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(await prisma.review.count()).toBe(2);
  });

  test.each([
    ['0', 0],
    ['6', 6],
    ['-1', -1],
    ['a decimal (3.5)', 3.5],
    ['text ("5")', '5'],
    ['null', null],
  ])('a rating of %s gives 400 and creates no row', async (label, rating) => {
    const order = await makeOrder(buyer, seller, product);

    const res = await postReview(buyer, product.id, { orderId: order.id, rating });

    expect(res.status).toBe(400);
    expect(await prisma.review.count()).toBe(0);
  });

  test('a missing rating gives 400 and creates no row', async () => {
    const order = await makeOrder(buyer, seller, product);

    const res = await postReview(buyer, product.id, { orderId: order.id });

    expect(res.status).toBe(400);
    expect(await prisma.review.count()).toBe(0);
  });

  test('a missing order id gives 400 and creates no row', async () => {
    const res = await postReview(buyer, product.id, { rating: 5 });

    expect(res.status).toBe(400);
    expect(await prisma.review.count()).toBe(0);
  });

  test('a rating of exactly 1 and exactly 5 are both accepted', async () => {
    const productTwo = await createProduct(seller, category);
    const order = await makeOrder(buyer, seller, [product, productTwo]);

    const low = await postReview(buyer, product.id, { orderId: order.id, rating: 1 });
    const high = await postReview(buyer, productTwo.id, { orderId: order.id, rating: 5 });

    expect(low.status).toBe(201);
    expect(high.status).toBe(201);
  });
});

describe('PUT /api/reviews/:id/response', () => {
  let review;

  beforeEach(async () => {
    review = await makeReview(buyer, product);
  });

  async function storedResponse() {
    const row = await prisma.review.findUnique({ where: { id: review.id } });
    return row.sellerResponse;
  }

  test('the owning seller can respond', async () => {
    const res = await request(app)
      .put(`/api/reviews/${review.id}/response`)
      .set(asUser(seller))
      .send({ sellerResponse: 'Thank you for your feedback!' });

    expect(res.status).toBe(200);
    expect(res.body.sellerResponse).toBe('Thank you for your feedback!');
    expect(await storedResponse()).toBe('Thank you for your feedback!');
  });

  test('another seller cannot respond (403) and nothing is saved', async () => {
    const res = await request(app)
      .put(`/api/reviews/${review.id}/response`)
      .set(asUser(otherSeller))
      .send({ sellerResponse: 'Not my product' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('You can only respond to reviews on your own products');
    expect(await storedResponse()).toBeNull();
  });

  test('a user who is not a seller cannot respond (403) and nothing is saved', async () => {
    const res = await request(app)
      .put(`/api/reviews/${review.id}/response`)
      .set(asUser(buyer))
      .send({ sellerResponse: 'I am only a buyer' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Seller access required');
    expect(await storedResponse()).toBeNull();
  });

  test('a request without a token is refused', async () => {
    const res = await request(app).put(`/api/reviews/${review.id}/response`).send({ sellerResponse: 'Hello' });

    expect(res.status).toBe(401);
    expect(await storedResponse()).toBeNull();
  });

  test('an empty response gives 400 and nothing is saved', async () => {
    const res = await request(app)
      .put(`/api/reviews/${review.id}/response`)
      .set(asUser(seller))
      .send({ sellerResponse: '' });

    expect(res.status).toBe(400);
    expect(await storedResponse()).toBeNull();
  });

  test('a missing response gives 400 and nothing is saved', async () => {
    const res = await request(app).put(`/api/reviews/${review.id}/response`).set(asUser(seller)).send({});

    expect(res.status).toBe(400);
    expect(await storedResponse()).toBeNull();
  });

  test('an unknown review gives 404', async () => {
    const res = await request(app)
      .put(`/api/reviews/${MISSING_ID}/response`)
      .set(asUser(seller))
      .send({ sellerResponse: 'Hello' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Review not found');
  });
});

describe('DELETE /api/admin/reviews/:id', () => {
  let review;
  let admin;

  beforeEach(async () => {
    review = await makeReview(buyer, product);
    admin = await createUser({ isAdmin: true });
  });

  test('an admin can delete a review', async () => {
    const res = await request(app).delete(`/api/admin/reviews/${review.id}`).set(asUser(admin));

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Review removed');
    expect(await prisma.review.count()).toBe(0);
  });

  test('a deleted review no longer appears on the product page', async () => {
    await request(app).delete(`/api/admin/reviews/${review.id}`).set(asUser(admin));

    const res = await request(app).get(`/api/products/${product.id}`);

    expect(res.status).toBe(200);
    expect(res.body.reviews).toEqual([]);
  });

  test.each([
    ['a buyer', () => buyer],
    ['the product seller', () => seller],
  ])('%s cannot delete a review (403) and the review stays', async (label, who) => {
    const res = await request(app).delete(`/api/admin/reviews/${review.id}`).set(asUser(who()));

    expect(res.status).toBe(403);
    expect(await prisma.review.count()).toBe(1);
  });

  test('a request without a token is refused', async () => {
    const res = await request(app).delete(`/api/admin/reviews/${review.id}`);

    expect(res.status).toBe(401);
    expect(await prisma.review.count()).toBe(1);
  });

  test('an unknown review gives 404', async () => {
    const res = await request(app).delete(`/api/admin/reviews/${MISSING_ID}`).set(asUser(admin));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Review not found');
    expect(await prisma.review.count()).toBe(1);
  });
});

describe('GET /api/products/:id (reviews on the product page)', () => {
  test('reviews are listed newest first', async () => {
    const buyerTwo = await createUser();
    const buyerThree = await createUser();
    await makeReview(buyer, product, { comment: 'oldest', createdAt: new Date('2024-01-01T10:00:00Z') });
    await makeReview(buyerTwo, product, { comment: 'newest', createdAt: new Date('2024-03-01T10:00:00Z') });
    await makeReview(buyerThree, product, { comment: 'middle', createdAt: new Date('2024-02-01T10:00:00Z') });

    const res = await request(app).get(`/api/products/${product.id}`);

    expect(res.status).toBe(200);
    expect(res.body.reviews.map((r) => r.comment)).toEqual(['newest', 'middle', 'oldest']);
  });

  test('each review shows the buyer name only, with no email or password', async () => {
    await makeReview(buyer, product);

    const res = await request(app).get(`/api/products/${product.id}`);

    expect(res.status).toBe(200);
    expect(res.body.reviews).toHaveLength(1);
    expect(res.body.reviews[0].buyer).toEqual({ name: buyer.name });

    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(buyer.email);
    expect(raw).not.toContain('password');
  });

  test('a product with no reviews returns an empty list', async () => {
    const res = await request(app).get(`/api/products/${product.id}`);

    expect(res.status).toBe(200);
    expect(res.body.reviews).toEqual([]);
  });

  test('an unknown product id gives 404', async () => {
    const res = await request(app).get(`/api/products/${MISSING_ID}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Product not found');
  });

  test.each(['draft', 'removed'])('a %s product gives 404', async (state) => {
    const hidden = await createProduct(seller, category, { state });

    const res = await request(app).get(`/api/products/${hidden.id}`);

    expect(res.status).toBe(404);
  });

  test('an out-of-stock product is still visible', async () => {
    const soldOut = await createProduct(seller, category, { state: 'out_of_stock', stock: 0 });

    const res = await request(app).get(`/api/products/${soldOut.id}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(soldOut.id);
  });
});