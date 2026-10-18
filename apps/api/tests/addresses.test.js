const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, asUser, resetDb } = require('./helpers');

const validAddress = (label) => ({
  label,
  fullName: 'Test Person',
  phone: '9876543210',
  line1: '1 Test Street',
  city: 'Chennai',
  state: 'Tamil Nadu',
  postalCode: '600001',
});

let owner;
let stranger;

beforeAll(async () => {
  await resetDb();
  owner = await createUser();
  stranger = await createUser();
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

const add = (user, body) => request(app).post('/api/addresses').set(asUser(user)).send(body);
const list = async (user) => (await request(app).get('/api/addresses').set(asUser(user))).body;

describe('saved addresses', () => {
  test('the first address becomes the default, and a new default replaces it', async () => {
    const first = await add(owner, validAddress('Home'));
    expect(first.status).toBe(201);
    expect(first.body.isDefault).toBe(true);

    const second = await add(owner, { ...validAddress('Office'), isDefault: true });
    expect(second.status).toBe(201);

    const addresses = await list(owner);
    expect(addresses.filter((a) => a.isDefault)).toHaveLength(1);
    expect(addresses[0].label).toBe('Office');
  });

  test('missing fields are refused', async () => {
    const { city, ...incomplete } = validAddress('Broken');
    const res = await add(owner, incomplete);
    expect(res.status).toBe(400);
  });

  test('another user cannot edit, delete or see someone else\'s address', async () => {
    const mine = (await list(owner))[0];

    const edit = await request(app)
      .put(`/api/addresses/${mine.id}`)
      .set(asUser(stranger))
      .send({ city: 'Hacked' });
    expect(edit.status).toBe(404);

    const del = await request(app).delete(`/api/addresses/${mine.id}`).set(asUser(stranger));
    expect(del.status).toBe(404);

    expect(await list(stranger)).toEqual([]);
  });

  test('deleting the default address promotes another one', async () => {
    const addresses = await list(owner);
    const defaultOne = addresses.find((a) => a.isDefault);
    const other = addresses.find((a) => !a.isDefault);

    const del = await request(app).delete(`/api/addresses/${defaultOne.id}`).set(asUser(owner));
    expect(del.status).toBe(200);

    const after = await list(owner);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(other.id);
    expect(after[0].isDefault).toBe(true);
  });

  test('you cannot turn off the default directly', async () => {
    const [only] = await list(owner);
    const res = await request(app)
      .put(`/api/addresses/${only.id}`)
      .set(asUser(owner))
      .send({ isDefault: false });
    expect(res.status).toBe(400);
  });

  test('a user can save at most 10 addresses', async () => {
    for (let i = 0; i < 9; i += 1) {
      const res = await add(owner, validAddress(`Extra ${i}`));
      expect(res.status).toBe(201);
    }
    const eleventh = await add(owner, validAddress('Eleventh'));
    expect(eleventh.status).toBe(400);
    expect(await list(owner)).toHaveLength(10);
  });
});
