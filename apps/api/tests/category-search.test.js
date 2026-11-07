const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, resetDb, createProduct } = require('./helpers');

const MISSING_ID = '00000000-0000-4000-8000-000000000000';

// The category tree used by every test:
//
//   Electronics            product "Electronics item"  [10]
//     Phones               product "Phone"             [20]
//       Smartphones        product "Smartphone"        [30]
//     Laptops              product "Laptop"            [40]
//   Books                  product "Book"              [50]
//   Empty                  (no products, no subcategories)
//
// Every query uses ?seller=<id> unless it says otherwise, so other data cannot disturb the results.

let seller;
let buyer;
let cat; // { electronics, phones, smartphones, laptops, books, empty }
let prod; // { electronicsItem, phone, smartphone, laptop, book }

function makeCategory(name, parentId = null) {
  return prisma.category.create({ data: { name, parentId } });
}

// A review needs its own delivered order (Review is unique per product and order).
async function addReview(product, rating) {
  const order = await prisma.order.create({
    data: {
      buyerId: buyer.id,
      sellerId: seller.id,
      subtotal: product.price,
      deliveryAddress: '1 Test Street, Chennai',
      status: 'delivered',
      deliveredAt: new Date(),
      items: { create: [{ productId: product.id, quantity: 1, price: product.price }] },
    },
  });
  return prisma.review.create({
    data: { productId: product.id, orderId: order.id, buyerId: buyer.id, rating, comment: null },
  });
}

const list = (extra = '') => request(app).get(`/api/products?seller=${seller.id}${extra ? `&${extra}` : ''}`);
const names = (res) => res.body.products.map((p) => p.name);
const sorted = (arr) => [...arr].sort();

beforeEach(async () => {
  await resetDb();
  seller = await createUser({ isSeller: true });
  buyer = await createUser();

  const electronics = await makeCategory('Electronics');
  const phones = await makeCategory('Phones', electronics.id);
  const smartphones = await makeCategory('Smartphones', phones.id);
  const laptops = await makeCategory('Laptops', electronics.id);
  const books = await makeCategory('Books');
  const empty = await makeCategory('Empty');
  cat = { electronics, phones, smartphones, laptops, books, empty };

  const base = Date.now() - 60000;
  const at = (n) => new Date(base + n * 1000);
  prod = {
    electronicsItem: await createProduct(seller, electronics, { name: 'Electronics item', price: 10, createdAt: at(0) }),
    phone: await createProduct(seller, phones, { name: 'Phone', price: 20, createdAt: at(1) }),
    smartphone: await createProduct(seller, smartphones, { name: 'Smartphone', price: 30, createdAt: at(2) }),
    laptop: await createProduct(seller, laptops, { name: 'Laptop', price: 40, createdAt: at(3) }),
    book: await createProduct(seller, books, { name: 'Book', price: 50, createdAt: at(4) }),
  };
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/products?category=<id> (a category includes its subcategories)', () => {
  test('a top-level category includes the products of every subcategory at every depth, and nothing else', async () => {
    const res = await list(`category=${cat.electronics.id}`);

    expect(res.status).toBe(200);
    expect(sorted(names(res))).toEqual(['Electronics item', 'Laptop', 'Phone', 'Smartphone']);
    expect(res.body.pagination.total).toBe(4);
  });

  test('a middle category includes its own products and its children\'s, but not its parent\'s or its siblings\'', async () => {
    const res = await list(`category=${cat.phones.id}`);

    expect(sorted(names(res))).toEqual(['Phone', 'Smartphone']);
    expect(res.body.pagination.total).toBe(2);
  });

  test.each([
    ['smartphones', ['Smartphone']],
    ['laptops', ['Laptop']],
    ['books', ['Book']],
  ])('the bottom category "%s" returns only its own products', async (key, expected) => {
    const res = await list(`category=${cat[key].id}`);

    expect(names(res)).toEqual(expected);
  });

  test('every product still shows its OWN category, not the one that was searched', async () => {
    const res = await list(`category=${cat.electronics.id}`);

    const byName = Object.fromEntries(res.body.products.map((p) => [p.name, p.category]));
    expect(byName.Smartphone).toEqual({ id: cat.smartphones.id, name: 'Smartphones', parentId: cat.phones.id });
    expect(byName.Laptop).toEqual({ id: cat.laptops.id, name: 'Laptops', parentId: cat.electronics.id });
    expect(byName['Electronics item']).toEqual({ id: cat.electronics.id, name: 'Electronics', parentId: null });
  });

  test('a category with no products and no subcategories returns nothing', async () => {
    const res = await list(`category=${cat.empty.id}`);

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  test('a category id that does not exist returns nothing (not everything)', async () => {
    const res = await list(`category=${MISSING_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  test('without a category, or with an empty one, nothing is filtered out', async () => {
    const without = await list();
    const blank = await list('category=');

    expect(without.body.pagination.total).toBe(5);
    expect(blank.body.pagination.total).toBe(5);
  });

  test('products that are hidden (draft, removed) stay hidden inside subcategories and are not counted', async () => {
    const category = cat.smartphones;
    await createProduct(seller, category, { name: 'Draft smartphone', state: 'draft' });
    await createProduct(seller, cat.phones, { name: 'Removed phone', state: 'removed' });
    await createProduct(seller, cat.laptops, { name: 'Archived laptop', state: 'archived' });

    const res = await list(`category=${cat.electronics.id}`);

    expect(sorted(names(res))).toEqual(['Electronics item', 'Laptop', 'Phone', 'Smartphone']);
    expect(res.body.pagination.total).toBe(4);
  });

  test('another seller\'s products in the same subcategories are left out when a seller is chosen', async () => {
    const other = await createUser({ isSeller: true });
    await createProduct(other, cat.smartphones, { name: 'Their smartphone' });

    const res = await list(`category=${cat.electronics.id}`);

    expect(names(res)).not.toContain('Their smartphone');
    expect(res.body.pagination.total).toBe(4);
  });

  test('without a seller filter, products of all sellers in the category tree are found', async () => {
    const other = await createUser({ isSeller: true });
    await createProduct(other, cat.smartphones, { name: 'Their smartphone' });

    const res = await request(app).get(`/api/products?category=${cat.phones.id}`);

    expect(sorted(names(res))).toEqual(['Phone', 'Smartphone', 'Their smartphone']);
  });
});

describe('GET /api/products?category=<id> combined with other filters and sorting', () => {
  test('with a price range', async () => {
    const res = await list(`category=${cat.electronics.id}&minPrice=25&maxPrice=35`);

    expect(names(res)).toEqual(['Smartphone']);
    expect(res.body.pagination.total).toBe(1);
  });

  test('with the in-stock filter (an out-of-stock product is still found without it)', async () => {
    await prisma.product.update({ where: { id: prod.laptop.id }, data: { stock: 0, state: 'out_of_stock' } });

    const inStock = await list(`category=${cat.electronics.id}&inStock=true`);
    const all = await list(`category=${cat.electronics.id}`);

    expect(sorted(names(inStock))).toEqual(['Electronics item', 'Phone', 'Smartphone']);
    expect(sorted(names(all))).toEqual(['Electronics item', 'Laptop', 'Phone', 'Smartphone']);
  });

  test('with a minimum rating', async () => {
    await addReview(prod.smartphone, 5);
    await addReview(prod.laptop, 4);
    await addReview(prod.phone, 3);

    const res = await list(`category=${cat.electronics.id}&minRating=4`);

    expect(sorted(names(res))).toEqual(['Laptop', 'Smartphone']);
    expect(res.body.pagination.total).toBe(2);
  });

  test('with a sort order', async () => {
    const res = await list(`category=${cat.electronics.id}&sort=price_desc`);

    expect(names(res)).toEqual(['Laptop', 'Smartphone', 'Phone', 'Electronics item']);
  });

  test('with paging: the total counts the whole category tree, not just the page', async () => {
    const res = await list(`category=${cat.electronics.id}&sort=price_asc&limit=2&page=2`);

    expect(names(res)).toEqual(['Smartphone', 'Laptop']);
    expect(res.body.pagination).toEqual({ page: 2, limit: 2, total: 4 });
  });
});

describe('GET /api/products?category=<id> after the category tree changes', () => {
  test('moving a category moves its whole subtree\'s products with it', async () => {
    await prisma.category.update({ where: { id: cat.phones.id }, data: { parentId: cat.books.id } });

    const books = await list(`category=${cat.books.id}`);
    const electronics = await list(`category=${cat.electronics.id}`);

    expect(sorted(names(books))).toEqual(['Book', 'Phone', 'Smartphone']);
    expect(sorted(names(electronics))).toEqual(['Electronics item', 'Laptop']);
  });

  test('a new subcategory is included straight away', async () => {
    const tablets = await makeCategory('Tablets', cat.electronics.id);
    await createProduct(seller, tablets, { name: 'Tablet', price: 60 });

    const res = await list(`category=${cat.electronics.id}`);

    expect(names(res)).toContain('Tablet');
    expect(res.body.pagination.total).toBe(5);
  });
});