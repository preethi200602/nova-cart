const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, asUser, resetDb, createCategory, createProduct } = require('./helpers');

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

let admin;
let seller;
let buyer;

// Creates a category straight in the database.
function makeCategory(name, parentId = null) {
  return prisma.category.create({ data: { name, parentId } });
}

const postCategory = (who, body) => request(app).post('/api/admin/categories').set(asUser(who)).send(body);
const putCategory = (who, id, body) => request(app).put(`/api/admin/categories/${id}`).set(asUser(who)).send(body);
const deleteCategory = (who, id) => request(app).delete(`/api/admin/categories/${id}`).set(asUser(who));
const removeProduct = (who, id, body) => request(app).post(`/api/admin/products/${id}/remove`).set(asUser(who)).send(body);
const restoreProduct = (who, id) => request(app).post(`/api/admin/products/${id}/restore`).set(asUser(who));
const adminList = (who, query = '') => request(app).get(`/api/admin/products${query ? `?${query}` : ''}`).set(asUser(who));

async function categoryRow(id) {
  return prisma.category.findUnique({ where: { id } });
}

async function productRow(id) {
  return prisma.product.findUnique({ where: { id } });
}

beforeEach(async () => {
  await resetDb();
  admin = await createUser({ isAdmin: true });
  seller = await createUser({ isSeller: true });
  buyer = await createUser();
});

afterAll(async () => {
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

describe('GET /api/categories', () => {
  test('returns the category tree, sorted by name at every level, with no login needed', async () => {
    // Created out of order on purpose.
    const electronics = await makeCategory('Electronics');
    const books = await makeCategory('Books');
    const phones = await makeCategory('Phones', electronics.id);
    const laptops = await makeCategory('Laptops', electronics.id);
    const gaming = await makeCategory('Gaming', laptops.id);

    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      categories: [
        { id: books.id, name: 'Books', children: [] },
        {
          id: electronics.id,
          name: 'Electronics',
          children: [
            { id: laptops.id, name: 'Laptops', children: [{ id: gaming.id, name: 'Gaming', children: [] }] },
            { id: phones.id, name: 'Phones', children: [] },
          ],
        },
      ],
    });
  });

  test('returns an empty list when there are no categories', async () => {
    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ categories: [] });
  });
});

describe('POST /api/admin/categories', () => {
  test('an admin can create a top-level category', async () => {
    const res = await postCategory(admin, { name: 'Toys' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Toys');
    expect(res.body.parentId).toBeNull();

    const row = await categoryRow(res.body.id);
    expect(row.name).toBe('Toys');
  });

  test('an admin can create a subcategory under an existing category', async () => {
    const parent = await makeCategory('Toys');

    const res = await postCategory(admin, { name: 'Puzzles', parentId: parent.id });

    expect(res.status).toBe(201);
    expect(res.body.parentId).toBe(parent.id);
  });

  test('the name is trimmed before it is saved', async () => {
    const res = await postCategory(admin, { name: '   Toys   ' });

    expect(res.status).toBe(201);
    expect(res.body.name).toBe('Toys');
  });

  test('names of 1 and 60 characters are accepted', async () => {
    const one = await postCategory(admin, { name: 'X' });
    const sixty = await postCategory(admin, { name: 'y'.repeat(60) });

    expect(one.status).toBe(201);
    expect(sixty.status).toBe(201);
  });

  test.each([
    ['missing', {}],
    ['empty', { name: '' }],
    ['only spaces', { name: '     ' }],
    ['61 characters', { name: 'z'.repeat(61) }],
    ['a number', { name: 123 }],
  ])('a name that is %s gives 400 and creates nothing', async (label, body) => {
    const res = await postCategory(admin, body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Name must be 1 to 60 characters');
    expect(await prisma.category.count()).toBe(0);
  });

  test('a parent that does not exist gives 400 and creates nothing', async () => {
    const res = await postCategory(admin, { name: 'Puzzles', parentId: MISSING_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Parent category not found');
    expect(await prisma.category.count()).toBe(0);
  });

  test('a duplicate name at the same level gives 409, ignoring upper and lower case', async () => {
    await makeCategory('Books');

    const res = await postCategory(admin, { name: 'bOOKS' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A category with this name already exists here');
    expect(await prisma.category.count()).toBe(1);
  });

  test('a duplicate name under the same parent gives 409', async () => {
    const parent = await makeCategory('Electronics');
    await makeCategory('Phones', parent.id);

    const res = await postCategory(admin, { name: 'phones', parentId: parent.id });

    expect(res.status).toBe(409);
    expect(await prisma.category.count()).toBe(2);
  });

  test('the same name is allowed under a different parent', async () => {
    const electronics = await makeCategory('Electronics');
    const toys = await makeCategory('Toys');
    await makeCategory('Accessories', electronics.id);

    const res = await postCategory(admin, { name: 'Accessories', parentId: toys.id });

    expect(res.status).toBe(201);
    expect(await prisma.category.count()).toBe(4);
  });

  test.each([
    ['a buyer', () => buyer],
    ['a seller', () => seller],
  ])('%s cannot create a category (403)', async (label, who) => {
    const res = await postCategory(who(), { name: 'Toys' });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Admin access required');
    expect(await prisma.category.count()).toBe(0);
  });

  test('a request without a token is refused', async () => {
    const res = await request(app).post('/api/admin/categories').send({ name: 'Toys' });

    expect(res.status).toBe(401);
    expect(await prisma.category.count()).toBe(0);
  });
});

describe('PUT /api/admin/categories/:id', () => {
  test('an admin can rename a category (the new name is trimmed)', async () => {
    const cat = await makeCategory('Toyz');

    const res = await putCategory(admin, cat.id, { name: '  Toys  ' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Toys');
    expect((await categoryRow(cat.id)).name).toBe('Toys');
  });

  test('a category can be renamed to the same name in different letter case', async () => {
    const cat = await makeCategory('Books');

    const res = await putCategory(admin, cat.id, { name: 'BOOKS' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('BOOKS');
  });

  test.each([
    ['empty', ''],
    ['only spaces', '    '],
    ['61 characters', 'z'.repeat(61)],
    ['a number', 5],
  ])('a new name that is %s gives 400 and changes nothing', async (label, name) => {
    const cat = await makeCategory('Books');

    const res = await putCategory(admin, cat.id, { name });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Name must be 1 to 60 characters');
    expect((await categoryRow(cat.id)).name).toBe('Books');
  });

  test('an empty request gives 400 "Nothing to update"', async () => {
    const cat = await makeCategory('Books');

    const res = await putCategory(admin, cat.id, {});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Nothing to update');
  });

  test('an unknown category gives 404', async () => {
    const res = await putCategory(admin, MISSING_ID, { name: 'Anything' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Category not found');
  });

  test('a category can be moved under another category', async () => {
    const electronics = await makeCategory('Electronics');
    const phones = await makeCategory('Phones');

    const res = await putCategory(admin, phones.id, { parentId: electronics.id });

    expect(res.status).toBe(200);
    expect(res.body.parentId).toBe(electronics.id);
    expect((await categoryRow(phones.id)).parentId).toBe(electronics.id);
  });

  test('a category can be moved back to the top level with parentId null', async () => {
    const electronics = await makeCategory('Electronics');
    const phones = await makeCategory('Phones', electronics.id);

    const res = await putCategory(admin, phones.id, { parentId: null });

    expect(res.status).toBe(200);
    expect(res.body.parentId).toBeNull();
    expect((await categoryRow(phones.id)).parentId).toBeNull();
  });

  test('a new parent that does not exist gives 400 and changes nothing', async () => {
    const phones = await makeCategory('Phones');

    const res = await putCategory(admin, phones.id, { parentId: MISSING_ID });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Parent category not found');
    expect((await categoryRow(phones.id)).parentId).toBeNull();
  });

  test('a category cannot be moved under itself', async () => {
    const cat = await makeCategory('Electronics');

    const res = await putCategory(admin, cat.id, { parentId: cat.id });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('A category cannot be moved under itself or its own subcategory');
    expect((await categoryRow(cat.id)).parentId).toBeNull();
  });

  test('a category cannot be moved under its own child or grandchild', async () => {
    const top = await makeCategory('Electronics');
    const child = await makeCategory('Laptops', top.id);
    const grandchild = await makeCategory('Gaming', child.id);

    const underChild = await putCategory(admin, top.id, { parentId: child.id });
    const underGrandchild = await putCategory(admin, top.id, { parentId: grandchild.id });

    expect(underChild.status).toBe(400);
    expect(underGrandchild.status).toBe(400);
    expect((await categoryRow(top.id)).parentId).toBeNull();
  });

  test('a category can be moved under a category in a different branch', async () => {
    const electronics = await makeCategory('Electronics');
    const laptops = await makeCategory('Laptops', electronics.id);
    const toys = await makeCategory('Toys');

    const res = await putCategory(admin, electronics.id, { parentId: toys.id });

    expect(res.status).toBe(200);
    expect((await categoryRow(laptops.id)).parentId).toBe(electronics.id);
  });

  test('renaming to a name already used by a sibling gives 409 (letter case ignored)', async () => {
    await makeCategory('Books');
    const toys = await makeCategory('Toys');

    const res = await putCategory(admin, toys.id, { name: 'books' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A category with this name already exists here');
    expect((await categoryRow(toys.id)).name).toBe('Toys');
  });

  test('moving next to a category with the same name gives 409', async () => {
    const electronics = await makeCategory('Electronics');
    await makeCategory('Accessories', electronics.id);
    const loose = await makeCategory('Accessories');

    const res = await putCategory(admin, loose.id, { parentId: electronics.id });

    expect(res.status).toBe(409);
    expect((await categoryRow(loose.id)).parentId).toBeNull();
  });

  test.each([
    ['a buyer', () => buyer],
    ['a seller', () => seller],
  ])('%s cannot edit a category (403) and nothing changes', async (label, who) => {
    const cat = await makeCategory('Books');

    const res = await putCategory(who(), cat.id, { name: 'Hacked' });

    expect(res.status).toBe(403);
    expect((await categoryRow(cat.id)).name).toBe('Books');
  });

  test('a request without a token is refused', async () => {
    const cat = await makeCategory('Books');

    const res = await request(app).put(`/api/admin/categories/${cat.id}`).send({ name: 'Hacked' });

    expect(res.status).toBe(401);
    expect((await categoryRow(cat.id)).name).toBe('Books');
  });
});

describe('DELETE /api/admin/categories/:id', () => {
  test('an admin can delete an empty category', async () => {
    const cat = await makeCategory('Toys');

    const res = await deleteCategory(admin, cat.id);

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Category deleted');
    expect(await categoryRow(cat.id)).toBeNull();
  });

  test('a category that has subcategories cannot be deleted (409)', async () => {
    const parent = await makeCategory('Electronics');
    await makeCategory('Phones', parent.id);

    const res = await deleteCategory(admin, parent.id);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Move or delete its subcategories first');
    expect(await categoryRow(parent.id)).not.toBeNull();
  });

  test('a category that has products cannot be deleted (409)', async () => {
    const cat = await makeCategory('Electronics');
    await createProduct(seller, cat);

    const res = await deleteCategory(admin, cat.id);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Move its products to another category first');
    expect(await categoryRow(cat.id)).not.toBeNull();
  });

  test('a category can be deleted once its subcategory is gone', async () => {
    const parent = await makeCategory('Electronics');
    const child = await makeCategory('Phones', parent.id);

    const first = await deleteCategory(admin, child.id);
    const second = await deleteCategory(admin, parent.id);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await prisma.category.count()).toBe(0);
  });

  test('an unknown category gives 404', async () => {
    const res = await deleteCategory(admin, MISSING_ID);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Category not found');
  });

  test.each([
    ['a buyer', () => buyer],
    ['a seller', () => seller],
  ])('%s cannot delete a category (403) and it stays', async (label, who) => {
    const cat = await makeCategory('Toys');

    const res = await deleteCategory(who(), cat.id);

    expect(res.status).toBe(403);
    expect(await categoryRow(cat.id)).not.toBeNull();
  });

  test('a request without a token is refused', async () => {
    const cat = await makeCategory('Toys');

    const res = await request(app).delete(`/api/admin/categories/${cat.id}`);

    expect(res.status).toBe(401);
    expect(await categoryRow(cat.id)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Admin product moderation
// ---------------------------------------------------------------------------

describe('GET /api/admin/products', () => {
  let category;
  let otherSeller;

  beforeEach(async () => {
    category = await createCategory();
    otherSeller = await createUser({ isSeller: true });
  });

  test('lists products in every state, newest first, with category and seller details', async () => {
    const base = Date.now() - 60000;
    const oldest = await createProduct(seller, category, { name: 'Oldest', state: 'active', createdAt: new Date(base) });
    const middle = await createProduct(seller, category, { name: 'Middle', state: 'draft', createdAt: new Date(base + 1000) });
    const newest = await createProduct(seller, category, { name: 'Newest', state: 'removed', createdAt: new Date(base + 2000) });

    const res = await adminList(admin);

    expect(res.status).toBe(200);
    expect(res.body.products.map((p) => p.id)).toEqual([newest.id, middle.id, oldest.id]);
    expect(res.body.pagination).toEqual({ page: 1, limit: 20, total: 3 });

    const first = res.body.products[0];
    expect(first.category.id).toBe(category.id);
    expect(first.seller).toEqual({ id: seller.id, name: seller.name, email: seller.email });
  });

  test('never exposes the seller password', async () => {
    await createProduct(seller, category);

    const res = await adminList(admin);

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('password');
  });

  test('the state filter returns only products in that state', async () => {
    await createProduct(seller, category, { name: 'Live', state: 'active' });
    const hidden = await createProduct(seller, category, { name: 'Gone', state: 'removed' });

    const res = await adminList(admin, 'state=removed');

    expect(res.body.products.map((p) => p.id)).toEqual([hidden.id]);
    expect(res.body.pagination.total).toBe(1);
  });

  test('an unknown state value is ignored', async () => {
    await createProduct(seller, category, { state: 'active' });
    await createProduct(seller, category, { state: 'draft' });

    const res = await adminList(admin, 'state=banana');

    expect(res.body.pagination.total).toBe(2);
  });

  test('the seller filter returns only that seller\'s products', async () => {
    await createProduct(seller, category, { name: 'Mine' });
    const theirs = await createProduct(otherSeller, category, { name: 'Theirs' });

    const res = await adminList(admin, `seller=${otherSeller.id}`);

    expect(res.body.products.map((p) => p.id)).toEqual([theirs.id]);
  });

  test('the name search ignores letter case and matches part of a name', async () => {
    const phone = await createProduct(seller, category, { name: 'Smartphone X' });
    await createProduct(seller, category, { name: 'Laptop Pro' });

    const res = await adminList(admin, 'q=PHONE');

    expect(res.body.products.map((p) => p.id)).toEqual([phone.id]);
    expect(res.body.pagination.total).toBe(1);
  });

  test('a search made only of spaces is ignored', async () => {
    await createProduct(seller, category, { name: 'One' });
    await createProduct(seller, category, { name: 'Two' });

    const res = await adminList(admin, 'q=%20%20');

    expect(res.body.pagination.total).toBe(2);
  });

  test('filters can be combined', async () => {
    await createProduct(seller, category, { name: 'Red Phone', state: 'active' });
    const target = await createProduct(seller, category, { name: 'Blue Phone', state: 'removed' });
    await createProduct(otherSeller, category, { name: 'Green Phone', state: 'removed' });

    const res = await adminList(admin, `q=phone&state=removed&seller=${seller.id}`);

    expect(res.body.products.map((p) => p.id)).toEqual([target.id]);
  });

  test('paging: page 2 of size 2 holds the oldest of three products, and the total counts all', async () => {
    const base = Date.now() - 60000;
    const oldest = await createProduct(seller, category, { name: 'P1', createdAt: new Date(base) });
    await createProduct(seller, category, { name: 'P2', createdAt: new Date(base + 1000) });
    await createProduct(seller, category, { name: 'P3', createdAt: new Date(base + 2000) });

    const res = await adminList(admin, 'limit=2&page=2');

    expect(res.body.products.map((p) => p.id)).toEqual([oldest.id]);
    expect(res.body.pagination).toEqual({ page: 2, limit: 2, total: 3 });
  });

  test('a limit above 100 is reduced to 100', async () => {
    const res = await adminList(admin, 'limit=500');

    expect(res.body.pagination.limit).toBe(100);
  });

  test.each([
    ['a buyer', () => buyer],
    ['a seller', () => seller],
  ])('%s cannot use the admin product list (403)', async (label, who) => {
    const res = await adminList(who());

    expect(res.status).toBe(403);
  });

  test('a request without a token is refused', async () => {
    const res = await request(app).get('/api/admin/products');

    expect(res.status).toBe(401);
  });
});

describe('POST /api/admin/products/:id/remove', () => {
  let category;
  let product;

  beforeEach(async () => {
    category = await createCategory();
    product = await createProduct(seller, category, { name: 'Smartphone X', state: 'active' });
  });

  async function sellerNotes(title) {
    const rows = await prisma.notification.findMany({ where: { userId: seller.id, category: 'seller' } });
    return rows.filter((n) => n.title === title);
  }

  test('an admin can remove a product with a reason', async () => {
    const res = await removeProduct(admin, product.id, { reason: 'Counterfeit goods' });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('removed');
    expect(res.body.moderationReason).toBe('Counterfeit goods');
    expect(res.body.moderatedAt).toBeTruthy();

    const row = await productRow(product.id);
    expect(row.state).toBe('removed');
    expect(row.moderationReason).toBe('Counterfeit goods');
    expect(row.moderatedAt).not.toBeNull();
  });

  test('the reason is trimmed before it is saved', async () => {
    const res = await removeProduct(admin, product.id, { reason: '   Counterfeit goods   ' });

    expect(res.status).toBe(200);
    expect(res.body.moderationReason).toBe('Counterfeit goods');
  });

  test('the seller gets a "Product removed" notification that mentions the reason', async () => {
    await removeProduct(admin, product.id, { reason: 'Counterfeit goods' });

    const notes = await sellerNotes('Product removed');
    expect(notes).toHaveLength(1);
    // The whole row is searched on purpose, so this does not depend on the message column's name.
    expect(JSON.stringify(notes[0])).toContain('Counterfeit goods');
    expect(JSON.stringify(notes[0])).toContain('Smartphone X');

    const buyerNotes = await prisma.notification.findMany({ where: { userId: buyer.id } });
    expect(buyerNotes).toHaveLength(0);
  });

  test.each(['draft', 'active', 'out_of_stock', 'archived'])('a %s product can be removed', async (state) => {
    const other = await createProduct(seller, category, { state });

    const res = await removeProduct(admin, other.id, { reason: 'Policy violation' });

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('removed');
  });

  test('a reason of exactly 5 and exactly 500 characters is accepted', async () => {
    const second = await createProduct(seller, category);

    const short = await removeProduct(admin, product.id, { reason: 'abcde' });
    const long = await removeProduct(admin, second.id, { reason: 'r'.repeat(500) });

    expect(short.status).toBe(200);
    expect(long.status).toBe(200);
  });

  test.each([
    ['missing', {}],
    ['4 characters', { reason: 'abcd' }],
    ['only spaces', { reason: '          ' }],
    ['501 characters', { reason: 'r'.repeat(501) }],
    ['a number', { reason: 12345 }],
  ])('a reason that is %s gives 400, changes nothing and sends no notification', async (label, body) => {
    const res = await removeProduct(admin, product.id, body);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('A reason of 5 to 500 characters is required');
    expect((await productRow(product.id)).state).toBe('active');
    expect(await sellerNotes('Product removed')).toHaveLength(0);
  });

  test('an unknown product gives 404', async () => {
    const res = await removeProduct(admin, MISSING_ID, { reason: 'Counterfeit goods' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Product not found');
  });

  test('removing an already removed product gives 409 and sends no second notification', async () => {
    await removeProduct(admin, product.id, { reason: 'Counterfeit goods' });

    const res = await removeProduct(admin, product.id, { reason: 'A different reason' });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Product is already removed');
    expect((await productRow(product.id)).moderationReason).toBe('Counterfeit goods');
    expect(await sellerNotes('Product removed')).toHaveLength(1);
  });

  test.each([
    ['a buyer', () => buyer],
    ['the product\'s own seller', () => seller],
  ])('%s cannot remove a product (403) and it stays active', async (label, who) => {
    const res = await removeProduct(who(), product.id, { reason: 'Counterfeit goods' });

    expect(res.status).toBe(403);
    expect((await productRow(product.id)).state).toBe('active');
  });

  test('a request without a token is refused', async () => {
    const res = await request(app).post(`/api/admin/products/${product.id}/remove`).send({ reason: 'Counterfeit goods' });

    expect(res.status).toBe(401);
    expect((await productRow(product.id)).state).toBe('active');
  });
});

describe('POST /api/admin/products/:id/restore', () => {
  let category;
  let product;

  beforeEach(async () => {
    category = await createCategory();
    product = await createProduct(seller, category, { name: 'Smartphone X', state: 'active' });
  });

  async function sellerNotes(title) {
    const rows = await prisma.notification.findMany({ where: { userId: seller.id, category: 'seller' } });
    return rows.filter((n) => n.title === title);
  }

  test('an admin can restore a removed product, which comes back as a draft with the moderation details cleared', async () => {
    await removeProduct(admin, product.id, { reason: 'Counterfeit goods' });

    const res = await restoreProduct(admin, product.id);

    expect(res.status).toBe(200);
    expect(res.body.state).toBe('draft');
    expect(res.body.moderationReason).toBeNull();
    expect(res.body.moderatedAt).toBeNull();

    const row = await productRow(product.id);
    expect(row.state).toBe('draft');
    expect(row.moderationReason).toBeNull();
    expect(row.moderatedAt).toBeNull();
  });

  test('the seller gets a "Product restored" notification', async () => {
    await removeProduct(admin, product.id, { reason: 'Counterfeit goods' });

    await restoreProduct(admin, product.id);

    const notes = await sellerNotes('Product restored');
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes[0])).toContain('Smartphone X');
  });

  test.each(['draft', 'active', 'out_of_stock', 'archived'])('a %s product cannot be restored (409)', async (state) => {
    const other = await createProduct(seller, category, { state });

    const res = await restoreProduct(admin, other.id);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Product is not removed');
    expect((await productRow(other.id)).state).toBe(state);
    expect(await sellerNotes('Product restored')).toHaveLength(0);
  });

  test('an unknown product gives 404', async () => {
    const res = await restoreProduct(admin, MISSING_ID);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Product not found');
  });

  test.each([
    ['a buyer', () => buyer],
    ['the product\'s own seller', () => seller],
  ])('%s cannot restore a product (403) and it stays removed', async (label, who) => {
    await removeProduct(admin, product.id, { reason: 'Counterfeit goods' });

    const res = await restoreProduct(who(), product.id);

    expect(res.status).toBe(403);
    expect((await productRow(product.id)).state).toBe('removed');
  });

  test('a request without a token is refused', async () => {
    await removeProduct(admin, product.id, { reason: 'Counterfeit goods' });

    const res = await request(app).post(`/api/admin/products/${product.id}/restore`);

    expect(res.status).toBe(401);
    expect((await productRow(product.id)).state).toBe('removed');
  });

  test('a removed product shows its moderation reason in the admin list', async () => {
    await removeProduct(admin, product.id, { reason: 'Counterfeit goods' });

    const res = await adminList(admin, 'state=removed');

    expect(res.body.products).toHaveLength(1);
    expect(res.body.products[0].moderationReason).toBe('Counterfeit goods');
  });
});