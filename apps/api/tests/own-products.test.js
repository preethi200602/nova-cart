// A seller cannot buy their own products: blocked in add-to-cart, checkout and checkout preview.
const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, asUser, resetDb, createCategory, createProduct, placeOrder } = require('./helpers');

const ADDRESS = { deliveryAddress: '1 Test Street, Chennai' };

let seller;
let otherSeller;
let buyer;
let ownProduct;
let otherProduct;

beforeAll(async () => {
  await resetDb();
  seller = await createUser({ isSeller: true });
  otherSeller = await createUser({ isSeller: true });
  buyer = await createUser();
  const category = await createCategory();
  ownProduct = await createProduct(seller, category);
  otherProduct = await createProduct(otherSeller, category);
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

// Puts a product in a user's cart directly in the database, skipping the add-to-cart check.
async function forceIntoCart(user, product) {
  const cart = (await prisma.cart.findUnique({ where: { buyerId: user.id } })) || (await prisma.cart.create({ data: { buyerId: user.id } }));
  await prisma.cartItem.create({ data: { cartId: cart.id, productId: product.id, quantity: 1 } });
}

describe('sellers cannot buy their own products', () => {
  test('add-to-cart refuses your own product', async () => {
    const res = await request(app)
      .post('/api/cart/items')
      .set(asUser(seller))
      .send({ productId: ownProduct.id, quantity: 1 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'You cannot buy your own products' });
  });

  test('another buyer can still add the same product', async () => {
    const res = await request(app)
      .post('/api/cart/items')
      .set(asUser(buyer))
      .send({ productId: ownProduct.id, quantity: 1 });
    expect(res.status).toBe(201);
  });

  test('a seller can still buy another seller\'s product', async () => {
    const orders = await placeOrder(seller, [{ product: otherProduct }]);
    expect(orders).toHaveLength(1);
    expect(orders[0].sellerId).toBe(otherSeller.id);
  });

  test('checkout refuses a cart that already holds your own product, and creates no order', async () => {
    const user = await createUser({ isSeller: true });
    const category = await createCategory();
    const mine = await createProduct(user, category);
    await forceIntoCart(user, mine);

    const res = await request(app).post('/api/checkout').set(asUser(user)).send(ADDRESS);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot buy your own products/);
    expect(await prisma.order.count({ where: { buyerId: user.id } })).toBe(0);
  });

  test('checkout preview lists your own products and says the cart cannot be checked out', async () => {
    const user = await createUser({ isSeller: true });
    const category = await createCategory();
    const mine = await createProduct(user, category);
    await forceIntoCart(user, mine);

    const res = await request(app).post('/api/checkout/preview').set(asUser(user)).send(ADDRESS);
    expect(res.status).toBe(200);
    expect(res.body.ownProducts).toEqual([{ productId: mine.id, name: mine.name }]);
    expect(res.body.canCheckout).toBe(false);
  });

  test('checkout preview for an ordinary cart has no own products and can be checked out', async () => {
    const shopper = await createUser();
    const add = await request(app)
      .post('/api/cart/items')
      .set(asUser(shopper))
      .send({ productId: otherProduct.id, quantity: 1 });
    expect(add.status).toBe(201);

    const res = await request(app).post('/api/checkout/preview').set(asUser(shopper)).send(ADDRESS);
    expect(res.status).toBe(200);
    expect(res.body.ownProducts).toEqual([]);
    expect(res.body.canCheckout).toBe(true);
  });
});
