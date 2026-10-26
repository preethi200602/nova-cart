const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, resetDb, createCategory, createProduct } = require('./helpers');

// Dataset (price in brackets), all owned by one dedicated seller:
//   A [50] ratings 5,5,5  -> average 5.0, 3 reviews, in stock
//   E [40] rating  5      -> average 5.0, 1 review,  in stock
//   B [30] ratings 4,3    -> average 3.5, 2 reviews, in stock
//   C [20] rating  2      -> average 2.0, 1 review,  OUT OF STOCK
//   D [10] no reviews     -> average null, 0 reviews, in stock
// Every query uses ?seller=<id>, so other data in the database cannot disturb the results.

let seller;
let buyer;
let category;
let P; // { A, B, C, D, E }

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

async function addReviews(product, ratings) {
  for (const rating of ratings) await addReview(product, rating);
}

// Runs GET /api/products for the dedicated seller plus any extra query text.
function list(extra = '') {
  return request(app).get(`/api/products?seller=${seller.id}${extra ? `&${extra}` : ''}`);
}

const names = (res) => res.body.products.map((p) => p.name);
const sorted = (arr) => [...arr].sort();

beforeEach(async () => {
  await resetDb();
  seller = await createUser({ isSeller: true });
  buyer = await createUser();
  category = await createCategory();

  // Explicit creation times, one second apart, so "newest first" never depends on the clock.
  const base = Date.now() - 60000;
  const at = (n) => new Date(base + n * 1000);

  P = {
    A: await createProduct(seller, category, { name: 'A', price: 50, createdAt: at(0) }),
    E: await createProduct(seller, category, { name: 'E', price: 40, createdAt: at(1) }),
    B: await createProduct(seller, category, { name: 'B', price: 30, createdAt: at(2) }),
    C: await createProduct(seller, category, { name: 'C', price: 20, stock: 0, state: 'out_of_stock', createdAt: at(3) }),
    D: await createProduct(seller, category, { name: 'D', price: 10, createdAt: at(4) }),
  };

  await addReviews(P.A, [5, 5, 5]);
  await addReviews(P.E, [5]);
  await addReviews(P.B, [4, 3]);
  await addReviews(P.C, [2]);
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/products: rating data on every product', () => {
  test('each product shows its average rating (one decimal) and review count', async () => {
    const res = await list();

    expect(res.status).toBe(200);
    const byName = Object.fromEntries(res.body.products.map((p) => [p.name, p]));

    expect([byName.A.avgRating, byName.A.reviewCount]).toEqual([5, 3]);
    expect([byName.E.avgRating, byName.E.reviewCount]).toEqual([5, 1]);
    expect([byName.B.avgRating, byName.B.reviewCount]).toEqual([3.5, 2]);
    expect([byName.C.avgRating, byName.C.reviewCount]).toEqual([2, 1]);
    expect([byName.D.avgRating, byName.D.reviewCount]).toEqual([null, 0]);
  });

  test('every product also carries its category', async () => {
    const res = await list();

    expect(res.body.products).toHaveLength(5);
    for (const p of res.body.products) {
      expect(p.category.id).toBe(category.id);
      expect(p.category.name).toBe(category.name);
    }
  });

  test('the average is rounded to one decimal', async () => {
    // Ratings 5, 4, 4 average 4.333...: shown as 4.3.
    const rounded = await createProduct(seller, category, { name: 'R', price: 60 });
    await addReviews(rounded, [5, 4, 4]);

    const res = await list();
    const r = res.body.products.find((p) => p.name === 'R');

    expect(r.avgRating).toBe(4.3);
    expect(r.reviewCount).toBe(3);
  });
});

describe('GET /api/products: minimum rating filter', () => {
  test('minRating=4 returns only A and E', async () => {
    const res = await list('minRating=4');

    expect(sorted(names(res))).toEqual(['A', 'E']);
    expect(res.body.pagination.total).toBe(2);
  });

  test('minRating=3.5 is inclusive: A, E and B', async () => {
    const res = await list('minRating=3.5');

    expect(sorted(names(res))).toEqual(['A', 'B', 'E']);
  });

  test('minRating=3.6 leaves B out', async () => {
    const res = await list('minRating=3.6');

    expect(sorted(names(res))).toEqual(['A', 'E']);
  });

  test('minRating=2 returns every rated product and leaves out the unreviewed one', async () => {
    const res = await list('minRating=2');

    expect(sorted(names(res))).toEqual(['A', 'B', 'C', 'E']);
  });

  test('minRating=9 behaves like 5 (the highest rating allowed)', async () => {
    const res = await list('minRating=9');

    expect(sorted(names(res))).toEqual(['A', 'E']);
  });

  test('a minRating that is not a number is ignored', async () => {
    const res = await list('minRating=abc');

    expect(res.body.pagination.total).toBe(5);
  });

  test('a rating filter can be combined with a price filter', async () => {
    const res = await list('minRating=3.5&maxPrice=45');

    expect(sorted(names(res))).toEqual(['B', 'E']);
  });
});

describe('GET /api/products: sorting', () => {
  test('sort=rating: highest average first, ties by more reviews, unreviewed last', async () => {
    const res = await list('sort=rating');

    expect(names(res)).toEqual(['A', 'E', 'B', 'C', 'D']);
  });

  test('sort=most_reviewed: most reviews first, ties by higher rating, unreviewed last', async () => {
    const res = await list('sort=most_reviewed');

    expect(names(res)).toEqual(['A', 'B', 'E', 'C', 'D']);
  });

  test('sort=price_asc: cheapest first', async () => {
    const res = await list('sort=price_asc');

    expect(names(res)).toEqual(['D', 'C', 'B', 'E', 'A']);
  });

  test('sort=price_desc: most expensive first', async () => {
    const res = await list('sort=price_desc');

    expect(names(res)).toEqual(['A', 'E', 'B', 'C', 'D']);
  });

  test('sort=newest: the last product created comes first', async () => {
    const res = await list('sort=newest');

    expect(names(res)).toEqual(['D', 'C', 'B', 'E', 'A']);
  });

  test('a rating filter and a sort work together', async () => {
    const res = await list('minRating=3.5&sort=most_reviewed');

    expect(names(res)).toEqual(['A', 'B', 'E']);
  });
});

describe('GET /api/products: price, stock and seller filters', () => {
  test('minPrice and maxPrice are both inclusive', async () => {
    const res = await list('minPrice=30&maxPrice=40&sort=price_asc');

    expect(names(res)).toEqual(['B', 'E']);
  });

  test('minPrice=25&maxPrice=45 returns E and B', async () => {
    const res = await list('minPrice=25&maxPrice=45');

    expect(sorted(names(res))).toEqual(['B', 'E']);
    expect(res.body.pagination.total).toBe(2);
  });

  test('inStock=true leaves out the out-of-stock product, which is otherwise still listed', async () => {
    const inStockOnly = await list('inStock=true');
    const everything = await list();

    expect(sorted(names(inStockOnly))).toEqual(['A', 'B', 'D', 'E']);
    expect(sorted(names(everything))).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  test("another seller's products (and their reviews) do not appear in this seller's results", async () => {
    const other = await createUser({ isSeller: true });
    const foreign = await createProduct(other, category, { name: 'X', price: 5 });
    await addReviews(foreign, [5, 5, 5, 5]);

    const res = await list('sort=most_reviewed');

    expect(names(res)).toEqual(['A', 'B', 'E', 'C', 'D']);
    expect(res.body.pagination.total).toBe(5);
  });
});

describe('GET /api/products: products that must stay hidden', () => {
  test.each(['draft', 'archived', 'removed'])('a %s product is not listed and not counted, even with reviews', async (state) => {
    const hidden = await createProduct(seller, category, { name: 'Hidden', price: 5, state });
    await addReviews(hidden, [5, 5, 5, 5, 5]);

    const res = await list('sort=most_reviewed');

    expect(names(res)).not.toContain('Hidden');
    expect(res.body.pagination.total).toBe(5);
  });
});

describe('GET /api/products: paging', () => {
  test('limit=2&page=2 with price_asc returns B and E, and total is 5', async () => {
    const res = await list('sort=price_asc&limit=2&page=2');

    expect(names(res)).toEqual(['B', 'E']);
    expect(res.body.pagination).toEqual({ page: 2, limit: 2, total: 5 });
  });

  test('the last page holds the remainder', async () => {
    const res = await list('sort=price_asc&limit=2&page=3');

    expect(names(res)).toEqual(['A']);
    expect(res.body.pagination).toEqual({ page: 3, limit: 2, total: 5 });
  });

  test('a page past the end is empty but the total is still correct', async () => {
    const res = await list('sort=price_asc&limit=2&page=4');

    expect(res.body.products).toEqual([]);
    expect(res.body.pagination.total).toBe(5);
  });

  test('the total counts all matches, not just the current page', async () => {
    const res = await list('minRating=3.5&limit=1');

    expect(res.body.products).toHaveLength(1);
    expect(res.body.pagination).toEqual({ page: 1, limit: 1, total: 3 });
  });

  test('a limit above 100 is reduced to 100', async () => {
    const res = await list('limit=500');

    expect(res.body.pagination.limit).toBe(100);
  });

  test('page defaults to 1 and limit to 20', async () => {
    const res = await list();

    expect(res.body.pagination).toEqual({ page: 1, limit: 20, total: 5 });
  });
});