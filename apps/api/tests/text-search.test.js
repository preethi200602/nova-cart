const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, resetDb, createCategory, createProduct } = require('./helpers');

// Products used by every test (all active, one seller). Price in brackets.
//
//   Smartphone X          [300]  description: "A fast phone with a great camera"        tags: mobile,android
//   Laptop Pro            [900]  description: "A powerful laptop for work"              tags: computer,notebook
//   Wireless Headphones    [80]  description: "Noise cancelling over-ear headphones"    tags: audio,music
//   Cotton T-Shirt         [20]  description: "Soft cotton shirt in many colours"       tags: clothing,summer
//   Coffee Mug             [12]  description: "Ceramic mug for hot drinks"              tags: kitchen,gift
//   Phone                 [150]  description: "Basic handset"                           tags: mobile
//   Phone Case             [10]  description: "Protective case for phones"             tags: accessory
//   Mega 100% Cotton Towel [25]  description: "Soft bath towel"                         tags: bath
//   Eco Bottle             [18]  description: "Reusable steel bottle"                   tags: eco_friendly,outdoor
//   Ultra Wide Curved Gaming Monitor With Adjustable Stand And Built In Speakers [400]
//                                description: "Big screen for games"                    tags: display
//
// Why these words: "smartfone" can only be found through typo similarity on the name, "camera" only through the
// description, "notebook" only through the tags, and "monitor" only because it sits INSIDE a very long name.
// Every query uses ?seller=<id> unless it says otherwise, so other data cannot disturb the results.

let seller;
let category;

const catalogue = [
  ['Smartphone X', 'A fast phone with a great camera', 'mobile,android', 300],
  ['Laptop Pro', 'A powerful laptop for work', 'computer,notebook', 900],
  ['Wireless Headphones', 'Noise cancelling over-ear headphones', 'audio,music', 80],
  ['Cotton T-Shirt', 'Soft cotton shirt in many colours', 'clothing,summer', 20],
  ['Coffee Mug', 'Ceramic mug for hot drinks', 'kitchen,gift', 12],
  ['Phone', 'Basic handset', 'mobile', 150],
  ['Phone Case', 'Protective case for phones', 'accessory', 10],
  ['Mega 100% Cotton Towel', 'Soft bath towel', 'bath', 25],
  ['Eco Bottle', 'Reusable steel bottle', 'eco_friendly,outdoor', 18],
  ['Ultra Wide Curved Gaming Monitor With Adjustable Stand And Built In Speakers', 'Big screen for games', 'display', 400],
];

const search = (q, extra = '') =>
  request(app).get(`/api/products?seller=${seller.id}&q=${encodeURIComponent(q)}${extra ? `&${extra}` : ''}`);
const names = (res) => res.body.products.map((p) => p.name);
const sorted = (arr) => [...arr].sort();

beforeEach(async () => {
  await resetDb();
  seller = await createUser({ isSeller: true });
  category = await createCategory();

  const base = Date.now() - 3600 * 1000;
  for (let i = 0; i < catalogue.length; i += 1) {
    const [name, description, tags, price] = catalogue[i];
    await createProduct(seller, category, { name, description, tags, price, createdAt: new Date(base + i * 1000) });
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe('GET /api/products?q= (finding products by text)', () => {
  test.each(['laptop', 'LAPTOP', 'LaPtOp'])('the word "%s" finds the product with that word in its name, whatever the letter case', async (word) => {
    const res = await search(word);

    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['Laptop Pro']);
    expect(res.body.pagination.total).toBe(1);
  });

  test('a misspelled word is still found (typo tolerance on the name)', async () => {
    const res = await search('smartfone');

    expect(names(res)).toEqual(['Smartphone X']);
  });

  test('a word that only appears in the description finds the product', async () => {
    const res = await search('camera');

    expect(names(res)).toEqual(['Smartphone X']);
  });

  test.each([
    ['notebook', 'Laptop Pro'],
    ['kitchen', 'Coffee Mug'],
    ['audio', 'Wireless Headphones'],
    ['android', 'Smartphone X'],
    ['summer', 'Cotton T-Shirt'],
  ])('the tag "%s" finds the product it is attached to', async (tag, expected) => {
    const res = await search(tag);

    expect(names(res)).toEqual([expected]);
  });

  test('a word that sits inside a very long name is found by its spelling', async () => {
    const res = await search('monitor');

    expect(names(res)).toEqual(['Ultra Wide Curved Gaming Monitor With Adjustable Stand And Built In Speakers']);
  });

  test('a word that matches nothing gives an empty list and a total of 0', async () => {
    const res = await search('zzzzzz');

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
    expect(res.body.pagination.total).toBe(0);
  });

  test('a word shared by several products finds all of them', async () => {
    const res = await search('cotton');

    expect(sorted(names(res))).toEqual(['Cotton T-Shirt', 'Mega 100% Cotton Towel']);
  });
});

describe('GET /api/products?q= (spaces and special characters)', () => {
  test('spaces around the search text are ignored', async () => {
    const res = await search('   laptop   ');

    expect(names(res)).toEqual(['Laptop Pro']);
  });

  test('a search made only of spaces filters nothing', async () => {
    const res = await search('   ');

    expect(res.body.pagination.total).toBe(10);
  });

  test('a percent sign is searched as a percent sign, not as "anything"', async () => {
    const res = await search('%');

    expect(names(res)).toEqual(['Mega 100% Cotton Towel']);
  });

  test('"100%" finds only the product with that exact text', async () => {
    const res = await search('100%');

    expect(names(res)).toEqual(['Mega 100% Cotton Towel']);
  });

  test('an underscore is searched as an underscore, not as "any one character"', async () => {
    const res = await search('_');

    expect(names(res)).toEqual(['Eco Bottle']);
  });

  test('a backslash is searched as a backslash and does not break the search', async () => {
    await createProduct(seller, category, { name: 'Back\\slash Gadget', description: 'Has a backslash in its name', price: 7 });

    const res = await search('\\');

    expect(res.status).toBe(200);
    expect(names(res)).toEqual(['Back\\slash Gadget']);
  });

  test('a lone backslash finds nothing when no product contains one (and does not crash)', async () => {
    const res = await search('\\');

    expect(res.status).toBe(200);
    expect(res.body.products).toEqual([]);
  });

  test('quotes and SQL in the search text are only text: nothing breaks and nothing is deleted', async () => {
    const attack = await search('\'; DROP TABLE "Product"; --');
    const everything = await request(app).get(`/api/products?seller=${seller.id}`);

    // The text is searched like any other (it may even match a product loosely); what matters is that
    // the request works and the table is untouched.
    expect(attack.status).toBe(200);
    expect(Array.isArray(attack.body.products)).toBe(true);
    expect(everything.status).toBe(200);
    expect(everything.body.pagination.total).toBe(10);
  });
});

describe('GET /api/products?q= (ranking, sorting and paging)', () => {
  test('results are ranked: the closest name first, then looser matches', async () => {
    const res = await search('phone');

    expect(names(res)).toEqual(['Phone', 'Phone Case', 'Smartphone X', 'Wireless Headphones']);
  });

  test('equally good matches are shown newest first', async () => {
    const base = Date.now();
    await createProduct(seller, category, { name: 'Twinbrand Gadget', description: 'First one', price: 5, createdAt: new Date(base - 5000) });
    await createProduct(seller, category, { name: 'Twinbrand Gadget', description: 'Second one', price: 6, createdAt: new Date(base) });

    const res = await search('twinbrand');

    expect(res.body.products.map((p) => p.description)).toEqual(['Second one', 'First one']);
  });

  test('an explicit sort order replaces the ranking', async () => {
    const cheapest = await search('phone', 'sort=price_asc');
    const dearest = await search('phone', 'sort=price_desc');

    expect(names(cheapest)).toEqual(['Phone Case', 'Wireless Headphones', 'Phone', 'Smartphone X']);
    expect(names(dearest)).toEqual(['Smartphone X', 'Phone', 'Wireless Headphones', 'Phone Case']);
  });

  test('a price filter works together with a text search and keeps the ranking', async () => {
    const res = await search('phone', 'maxPrice=100');

    expect(names(res)).toEqual(['Phone Case', 'Wireless Headphones']);
    expect(res.body.pagination.total).toBe(2);
  });

  test('paging: the total counts every match, not just the page', async () => {
    const first = await search('phone', 'limit=2&page=1');
    const second = await search('phone', 'limit=2&page=2');

    expect(names(first)).toEqual(['Phone', 'Phone Case']);
    expect(names(second)).toEqual(['Smartphone X', 'Wireless Headphones']);
    expect(first.body.pagination).toEqual({ page: 1, limit: 2, total: 4 });
    expect(second.body.pagination).toEqual({ page: 2, limit: 2, total: 4 });
  });
});

describe('GET /api/products?q= (which products can be found)', () => {
  test.each(['draft', 'archived', 'removed'])('a %s product is never found, and is not counted', async (state) => {
    await createProduct(seller, category, { name: 'Secretgadget hidden', description: 'Not for sale', state });
    await createProduct(seller, category, { name: 'Secretgadget visible', description: 'For sale' });

    const res = await search('secretgadget');

    expect(names(res)).toEqual(['Secretgadget visible']);
    expect(res.body.pagination.total).toBe(1);
  });

  test('an out-of-stock product is still found', async () => {
    await createProduct(seller, category, { name: 'Soldoutgadget', state: 'out_of_stock', stock: 0 });

    const res = await search('soldoutgadget');

    expect(names(res)).toEqual(['Soldoutgadget']);
  });

  test('without a seller filter, products of every seller are found', async () => {
    const other = await createUser({ isSeller: true });
    await createProduct(other, category, { name: 'Phone Deluxe', description: 'From another seller', price: 999 });

    const res = await request(app).get(`/api/products?q=${encodeURIComponent('deluxe')}`);

    expect(names(res)).toEqual(['Phone Deluxe']);
  });
});