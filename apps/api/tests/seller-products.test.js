const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, asUser, resetDb, createCategory, createProduct } = require('./helpers');

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let seller;
let otherSeller;
let buyer;
let category;

const validBody = (overrides = {}) => ({
  name: 'Phone case',
  description: 'A sturdy case',
  price: 20,
  categoryId: category.id,
  ...overrides,
});

const postProduct = (who, body) => request(app).post('/api/products').set(asUser(who)).send(body);
const putProduct = (who, id, body) => request(app).put(`/api/products/${id}`).set(asUser(who)).send(body);
const deactivate = (who, id) => request(app).post(`/api/products/${id}/deactivate`).set(asUser(who));
const row = (id) => prisma.product.findUnique({ where: { id } });
const sorted = (arr) => [...arr].sort();

beforeEach(async () => {
  await resetDb();
  seller = await createUser({ isSeller: true });
  otherSeller = await createUser({ isSeller: true });
  buyer = await createUser();
  category = await createCategory();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Creating a product
// ---------------------------------------------------------------------------

describe('POST /api/products', () => {
  test('a seller can create a product, which starts as a draft and belongs to them', async () => {
    const res = await postProduct(seller, validBody());

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Phone case', description: 'A sturdy case', price: 20, sellerId: seller.id, state: 'draft' });

    const saved = await row(res.body.id);
    expect(saved.sellerId).toBe(seller.id);
    expect(saved.categoryId).toBe(category.id);
  });

  test('optional fields are saved and the name and description are trimmed', async () => {
    const res = await postProduct(
      seller,
      validBody({
        name: '   Phone case   ',
        description: '  A sturdy case  ',
        salePrice: 15,
        stock: 7,
        tags: 'case,phone',
        images: ['http://example.com/a.png', 'http://example.com/b.png'],
      })
    );

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Phone case',
      description: 'A sturdy case',
      salePrice: 15,
      stock: 7,
      tags: 'case,phone',
      images: ['http://example.com/a.png', 'http://example.com/b.png'],
    });
  });

  test('a seller can publish straight away with state "active" (and some stock)', async () => {
    const res = await postProduct(seller, validBody({ state: 'active', stock: 5 }));

    expect(res.status).toBe(201);
    expect(res.body.state).toBe('active');
  });

  test('fields the seller must not control are ignored: id, owner and moderation details', async () => {
    const res = await postProduct(
      seller,
      validBody({ id: 'my-own-id', sellerId: otherSeller.id, moderationReason: 'sneaky', moderatedAt: new Date().toISOString() })
    );

    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe('my-own-id');
    expect(res.body.sellerId).toBe(seller.id);
    expect(res.body.moderationReason).toBeNull();
    expect(res.body.moderatedAt).toBeNull();
  });

  test('the largest allowed values are all accepted together', async () => {
    const res = await postProduct(
      seller,
      validBody({
        name: 'n'.repeat(120),
        description: 'd'.repeat(5000),
        price: 10000000,
        salePrice: 9999999,
        stock: 1000000,
        tags: 't'.repeat(200),
        images: Array.from({ length: 10 }, () => 'u'.repeat(500)),
      })
    );

    expect(res.status).toBe(201);
    expect(res.body.images).toHaveLength(10);
  });

  test('a stock of 0 is accepted', async () => {
    const res = await postProduct(seller, validBody({ stock: 0 }));

    expect(res.status).toBe(201);
    expect(res.body.stock).toBe(0);
  });

  test.each(['name', 'description', 'price', 'categoryId'])('a missing %s gives 400 and creates nothing', async (field) => {
    const body = validBody();
    delete body[field];

    const res = await postProduct(seller, body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('name, description, price, and categoryId are required');
    expect(await prisma.product.count({})).toBe(0);
  });

  test('a price of 0 gives 400 and creates nothing', async () => {
    const res = await postProduct(seller, validBody({ price: 0 }));

    expect(res.status).toBe(400);
    expect(await prisma.product.count({})).toBe(0);
  });

  test.each([
    ['a name of 121 characters', { name: 'n'.repeat(121) }, 'Name must be 1 to 120 characters'],
    ['a name of only spaces', { name: '     ' }, 'Name must be 1 to 120 characters'],
    ['a name that is not text', { name: 123 }, 'Name must be 1 to 120 characters'],
    ['a description of 5001 characters', { description: 'd'.repeat(5001) }, 'Description must be 1 to 5000 characters'],
    ['a description of only spaces', { description: '     ' }, 'Description must be 1 to 5000 characters'],
    ['a negative price', { price: -5 }, 'Price must be a positive number'],
    ['a price written as text', { price: '10' }, 'Price must be a positive number'],
    ['a price above 10,000,000', { price: 10000001 }, 'Price must be a positive number'],
    ['a negative stock', { stock: -1 }, 'Stock must be a whole number, 0 or more'],
    ['a stock with decimals', { stock: 1.5 }, 'Stock must be a whole number, 0 or more'],
    ['a stock written as text', { stock: '5' }, 'Stock must be a whole number, 0 or more'],
    ['a stock above 1,000,000', { stock: 1000001 }, 'Stock must be a whole number, 0 or more'],
    ['a sale price of 0', { salePrice: 0 }, 'Sale price must be a positive number or null'],
    ['a sale price written as text', { salePrice: '5' }, 'Sale price must be a positive number or null'],
    ['a sale price equal to the price', { price: 20, salePrice: 20 }, 'Sale price must be lower than the price'],
    ['a sale price above the price', { price: 20, salePrice: 25 }, 'Sale price must be lower than the price'],
    ['tags of 201 characters', { tags: 't'.repeat(201) }, 'Tags must be text up to 200 characters'],
    ['tags that are a number', { tags: 5 }, 'Tags must be text up to 200 characters'],
    ['11 images', { images: Array.from({ length: 11 }, () => 'http://example.com/a.png') }, 'Images must be a list of up to 10 URLs'],
    ['an image address of 501 characters', { images: ['u'.repeat(501)] }, 'Images must be a list of up to 10 URLs'],
    ['an image that is not text', { images: [5] }, 'Images must be a list of up to 10 URLs'],
    ['images given as a short piece of text', { images: 'a.png' }, 'Images must be a list of up to 10 URLs'],
    ['images given as an object', { images: { 0: 'a.png' } }, 'Images must be a list of up to 10 URLs'],
    ['the state removed', { state: 'removed' }, 'State must be draft or active'],
    ['the state archived', { state: 'archived' }, 'State must be draft or active'],
    ['the state out_of_stock', { state: 'out_of_stock' }, 'State must be draft or active'],
    ['a category that does not exist', { categoryId: MISSING_ID }, 'Invalid categoryId'],
    ['a category that is not text', { categoryId: 123 }, 'Invalid categoryId'],
  ])('%s gives 400 and creates nothing', async (label, overrides, message) => {
    const res = await postProduct(seller, validBody(overrides));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(message);
    expect(await prisma.product.count({})).toBe(0);
  });

  test('a user who is not a seller gets 403 and nothing is created', async () => {
    const res = await postProduct(buyer, validBody());

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Seller access required');
    expect(await prisma.product.count({})).toBe(0);
  });

  test('a request without a token is refused', async () => {
    const res = await request(app).post('/api/products').send(validBody());

    expect(res.status).toBe(401);
    expect(await prisma.product.count({})).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The seller's own list
// ---------------------------------------------------------------------------

describe('GET /api/seller/products', () => {
  test('lists my products in every state, with their category, and never another seller\'s', async () => {
    const mine = [
      await createProduct(seller, category, { name: 'Draft', state: 'draft' }),
      await createProduct(seller, category, { name: 'Active', state: 'active' }),
      await createProduct(seller, category, { name: 'Sold out', state: 'out_of_stock', stock: 0 }),
      await createProduct(seller, category, { name: 'Archived', state: 'archived' }),
      await createProduct(seller, category, { name: 'Removed', state: 'removed', moderationReason: 'Counterfeit goods' }),
    ];
    await createProduct(otherSeller, category, { name: 'Not mine' });

    const res = await request(app).get('/api/seller/products').set(asUser(seller));

    expect(res.status).toBe(200);
    expect(sorted(res.body.map((p) => p.id))).toEqual(sorted(mine.map((p) => p.id)));
    for (const p of res.body) {
      expect(p.category.id).toBe(category.id);
      expect(p.category.name).toBe(category.name);
    }
    expect(res.body.find((p) => p.name === 'Removed').moderationReason).toBe('Counterfeit goods');
  });

  test('a seller with no products gets an empty list', async () => {
    const res = await request(app).get('/api/seller/products').set(asUser(seller));

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('a user who is not a seller gets 403', async () => {
    const res = await request(app).get('/api/seller/products').set(asUser(buyer));

    expect(res.status).toBe(403);
  });

  test('a request without a token is refused', async () => {
    const res = await request(app).get('/api/seller/products');

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Editing a product
// ---------------------------------------------------------------------------

describe('PUT /api/products/:id', () => {
  let product;

  beforeEach(async () => {
    product = await createProduct(seller, category, { name: 'Old name', price: 100, stock: 10, state: 'active' });
  });

  test('a seller can edit their own product (text is trimmed) and the rest stays as it was', async () => {
    const res = await putProduct(seller, product.id, {
      name: '  New name  ',
      description: 'New description',
      price: 120,
      tags: 'new,tags',
      images: ['http://example.com/new.png'],
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: product.id,
      name: 'New name',
      description: 'New description',
      price: 120,
      tags: 'new,tags',
      images: ['http://example.com/new.png'],
      stock: 10,
      state: 'active',
      sellerId: seller.id,
    });
    expect((await row(product.id)).name).toBe('New name');
  });

  test('a single field can be changed on its own', async () => {
    const res = await putProduct(seller, product.id, { stock: 4 });

    expect(res.status).toBe(200);
    expect(res.body.stock).toBe(4);
    expect(res.body.name).toBe('Old name');
    expect(res.body.price).toBe(100);
  });

  test('a product can be moved to another category', async () => {
    const other = await createCategory('Other');

    const res = await putProduct(seller, product.id, { categoryId: other.id });

    expect(res.status).toBe(200);
    expect(res.body.categoryId).toBe(other.id);
  });

  test('a category that does not exist gives 400 and changes nothing', async () => {
    const res = await putProduct(seller, product.id, { categoryId: MISSING_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid categoryId');
    expect((await row(product.id)).categoryId).toBe(category.id);
  });

  test('an empty request, or one with only unknown fields, gives 400 "Nothing to update"', async () => {
    const empty = await putProduct(seller, product.id, {});
    const unknown = await putProduct(seller, product.id, { colour: 'red' });

    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe('Nothing to update');
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toBe('Nothing to update');
  });

  test.each([
    ['a name of 121 characters', { name: 'n'.repeat(121) }, 'Name must be 1 to 120 characters'],
    ['a negative price', { price: -1 }, 'Price must be a positive number'],
    ['a price of 0', { price: 0 }, 'Price must be a positive number'],
    ['a stock with decimals', { stock: 2.5 }, 'Stock must be a whole number, 0 or more'],
    ['the state removed', { state: 'removed' }, 'State must be draft or active'],
    ['the state archived', { state: 'archived' }, 'State must be draft or active'],
    ['the state out_of_stock', { state: 'out_of_stock' }, 'State must be draft or active'],
  ])('%s gives 400 and changes nothing', async (label, body, message) => {
    const res = await putProduct(seller, product.id, body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(message);
    const saved = await row(product.id);
    expect(saved.name).toBe('Old name');
    expect(saved.price).toBe(100);
    expect(saved.state).toBe('active');
  });

  test('the sale price is checked against the price already saved, and the price against the saved sale price', async () => {
    const same = await putProduct(seller, product.id, { salePrice: 100 });
    const ok = await putProduct(seller, product.id, { salePrice: 80 });
    const tooLow = await putProduct(seller, product.id, { price: 70 });
    const fine = await putProduct(seller, product.id, { price: 90 });
    const cleared = await putProduct(seller, product.id, { salePrice: null });

    expect(same.status).toBe(400);
    expect(same.body.error).toBe('Sale price must be lower than the price');
    expect(ok.status).toBe(200);
    expect(ok.body.salePrice).toBe(80);
    expect(tooLow.status).toBe(400);
    expect(tooLow.body.error).toBe('Sale price must be lower than the price');
    expect(fine.status).toBe(200);
    expect(fine.body.price).toBe(90);
    expect(cleared.status).toBe(200);
    expect(cleared.body.salePrice).toBeNull();
  });

  test('fields the seller must not control (owner, moderation details) are ignored', async () => {
    const res = await putProduct(seller, product.id, { name: 'Renamed', sellerId: otherSeller.id, moderationReason: 'sneaky' });

    expect(res.status).toBe(200);
    expect(res.body.sellerId).toBe(seller.id);
    expect(res.body.moderationReason).toBeNull();
  });

  test('an unknown product gives 404', async () => {
    const res = await putProduct(seller, MISSING_ID, { name: 'Anything' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Product not found');
  });

  test('another seller\'s product gives 403 and changes nothing', async () => {
    const res = await putProduct(otherSeller, product.id, { name: 'Hijacked' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('You can only edit your own products');
    expect((await row(product.id)).name).toBe('Old name');
  });

  test('a user who is not a seller gets 403 and nothing changes', async () => {
    const res = await putProduct(buyer, product.id, { name: 'Hijacked' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Seller access required');
    expect((await row(product.id)).name).toBe('Old name');
  });

  test('a request without a token is refused', async () => {
    const res = await request(app).put(`/api/products/${product.id}`).send({ name: 'Hijacked' });

    expect(res.status).toBe(401);
    expect((await row(product.id)).name).toBe('Old name');
  });

  describe('a product removed by an admin is locked', () => {
    let removed;

    beforeEach(async () => {
      removed = await createProduct(seller, category, { name: 'Removed one', state: 'removed', moderationReason: 'Counterfeit goods' });
    });

    test('its own seller cannot edit it (403) and nothing changes', async () => {
      const res = await putProduct(seller, removed.id, { name: 'Sneaky edit', state: 'active', stock: 50 });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('This product was removed by an admin and cannot be edited');
      const saved = await row(removed.id);
      expect(saved.name).toBe('Removed one');
      expect(saved.state).toBe('removed');
      expect(saved.moderationReason).toBe('Counterfeit goods');
    });

    test('another seller still gets the "own products" message, not the removal message', async () => {
      const res = await putProduct(otherSeller, removed.id, { name: 'Hijacked' });

      expect(res.status).toBe(403);
      expect(res.body.error).toBe('You can only edit your own products');
    });

    test('once an admin has restored it (back to draft) the seller can edit it again', async () => {
      await prisma.product.update({ where: { id: removed.id }, data: { state: 'draft', moderationReason: null, moderatedAt: null } });

      const res = await putProduct(seller, removed.id, { name: 'Fixed and compliant' });

      expect(res.status).toBe(200);
      expect(res.body.name).toBe('Fixed and compliant');
    });
  });

  describe('the automatic out-of-stock state follows the stock', () => {
    test('an active product whose stock is set to 0 becomes out_of_stock', async () => {
      const res = await putProduct(seller, product.id, { stock: 0 });

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('out_of_stock');
      expect((await row(product.id)).state).toBe('out_of_stock');
    });

    test('an out_of_stock product that is restocked becomes active again', async () => {
      const soldOut = await createProduct(seller, category, { state: 'out_of_stock', stock: 0 });

      const res = await putProduct(seller, soldOut.id, { stock: 5 });

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('active');
      expect(res.body.stock).toBe(5);
    });

    test('an out_of_stock product that is edited without changing the stock stays out_of_stock', async () => {
      const soldOut = await createProduct(seller, category, { state: 'out_of_stock', stock: 0 });

      const res = await putProduct(seller, soldOut.id, { name: 'Renamed while sold out' });

      expect(res.body.state).toBe('out_of_stock');
    });

    test('a draft product stays a draft whatever its stock does', async () => {
      const draft = await createProduct(seller, category, { state: 'draft', stock: 5 });

      const emptied = await putProduct(seller, draft.id, { stock: 0 });
      const refilled = await putProduct(seller, draft.id, { stock: 9 });

      expect(emptied.body.state).toBe('draft');
      expect(refilled.body.state).toBe('draft');
    });

    test('an archived product stays archived when it is restocked', async () => {
      const archived = await createProduct(seller, category, { state: 'archived', stock: 0 });

      const res = await putProduct(seller, archived.id, { stock: 9 });

      expect(res.body.state).toBe('archived');
    });

    test('publishing a draft that has stock makes it active', async () => {
      const draft = await createProduct(seller, category, { state: 'draft', stock: 3 });

      const res = await putProduct(seller, draft.id, { state: 'active' });

      expect(res.body.state).toBe('active');
    });

    test('publishing a draft that has no stock makes it out_of_stock straight away', async () => {
      const draft = await createProduct(seller, category, { state: 'draft', stock: 0 });

      const res = await putProduct(seller, draft.id, { state: 'active' });

      expect(res.body.state).toBe('out_of_stock');
    });

    test('a seller can unpublish an active product by setting it back to draft', async () => {
      const res = await putProduct(seller, product.id, { state: 'draft' });

      expect(res.status).toBe(200);
      expect(res.body.state).toBe('draft');
    });

    test('editing does not notify the seller about out of stock (they just did it themselves)', async () => {
      await putProduct(seller, product.id, { stock: 0 });

      const notes = await prisma.notification.findMany({ where: { userId: seller.id } });
      expect(notes).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Deactivating a product
// ---------------------------------------------------------------------------

describe('POST /api/products/:id/deactivate', () => {
  test.each(['draft', 'active', 'out_of_stock'])('a seller can deactivate their own %s product, which becomes archived', async (state) => {
    const product = await createProduct(seller, category, { state, stock: state === 'out_of_stock' ? 0 : 5 });

    const res = await deactivate(seller, product.id);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('archived');
    expect((await row(product.id)).state).toBe('archived');
  });

  test('a deactivated product disappears from the public storefront', async () => {
    const product = await createProduct(seller, category, { name: 'Going away', state: 'active' });
    const before = await request(app).get(`/api/sellers/${seller.id}/products`);

    await deactivate(seller, product.id);
    const after = await request(app).get(`/api/sellers/${seller.id}/products`);

    expect(before.body.map((p) => p.name)).toEqual(['Going away']);
    expect(after.body).toEqual([]);
  });

  test('a deactivated product can be published again by editing its state', async () => {
    const product = await createProduct(seller, category, { state: 'active', stock: 5 });
    await deactivate(seller, product.id);

    const res = await putProduct(seller, product.id, { state: 'active' });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('active');
  });

  test('a product removed by an admin gives 409 and stays removed', async () => {
    const removed = await createProduct(seller, category, { state: 'removed', moderationReason: 'Counterfeit goods' });

    const res = await deactivate(seller, removed.id);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This product was already removed by an admin');
    expect((await row(removed.id)).state).toBe('removed');
  });

  test('an unknown product gives 404', async () => {
    const res = await deactivate(seller, MISSING_ID);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Product not found');
  });

  test('another seller\'s product gives 403 and stays as it was', async () => {
    const product = await createProduct(seller, category, { state: 'active' });

    const res = await deactivate(otherSeller, product.id);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('You can only manage your own products');
    expect((await row(product.id)).state).toBe('active');
  });

  test('a user who is not a seller gets 403 and the product stays as it was', async () => {
    const product = await createProduct(seller, category, { state: 'active' });

    const res = await deactivate(buyer, product.id);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Seller access required');
    expect((await row(product.id)).state).toBe('active');
  });

  test('a request without a token is refused', async () => {
    const product = await createProduct(seller, category, { state: 'active' });

    const res = await request(app).post(`/api/products/${product.id}/deactivate`);

    expect(res.status).toBe(401);
    expect((await row(product.id)).state).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// The public storefront of one seller
// ---------------------------------------------------------------------------

describe('GET /api/sellers/:sellerId/products', () => {
  test('lists only active and out-of-stock products of that seller, with their category, and needs no login', async () => {
    await createProduct(seller, category, { name: 'Active', state: 'active' });
    await createProduct(seller, category, { name: 'Sold out', state: 'out_of_stock', stock: 0 });
    await createProduct(otherSeller, category, { name: 'Other seller', state: 'active' });

    const res = await request(app).get(`/api/sellers/${seller.id}/products`);

    expect(res.status).toBe(200);
    expect(sorted(res.body.map((p) => p.name))).toEqual(['Active', 'Sold out']);
    for (const p of res.body) {
      expect(p.sellerId).toBe(seller.id);
      expect(p.category.id).toBe(category.id);
    }
  });

  test.each(['draft', 'archived', 'removed'])('a %s product is not listed', async (state) => {
    await createProduct(seller, category, { name: 'Visible', state: 'active' });
    await createProduct(seller, category, { name: 'Hidden', state });

    const res = await request(app).get(`/api/sellers/${seller.id}/products`);

    expect(res.body.map((p) => p.name)).toEqual(['Visible']);
  });

  test('a seller who has only hidden products gets an empty list', async () => {
    await createProduct(seller, category, { state: 'draft' });
    await createProduct(seller, category, { state: 'removed' });

    const res = await request(app).get(`/api/sellers/${seller.id}/products`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('an unknown seller gives an empty list', async () => {
    const res = await request(app).get(`/api/sellers/${MISSING_ID}/products`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});