// Seller applications: the admin list, approving and rejecting (one decision per application, all-or-nothing approval).
const request = require('supertest');
const { app, prisma } = require('../server');
const { createUser, asUser, resetDb } = require('./helpers');

let admin;

beforeAll(async () => {
  await resetDb();
  admin = await createUser({ isAdmin: true });
});

afterAll(async () => {
  await resetDb();
  await prisma.$disconnect();
});

// A new applicant with a pending application.
async function pendingApplication(overrides = {}) {
  const applicant = await createUser();
  const application = await prisma.sellerApplication.create({
    data: {
      userId: applicant.id,
      businessName: 'Acme Crafts',
      description: 'We make handmade things',
      categoryFocus: 'Home',
      contactDetails: 'acme@example.com',
      ...overrides,
    },
  });
  return { applicant, application };
}

const approve = (id, who = admin) => request(app).post(`/api/admin/seller-applications/${id}/approve`).set(asUser(who)).send({});
const reject = (id, body, who = admin) => request(app).post(`/api/admin/seller-applications/${id}/reject`).set(asUser(who)).send(body);

const applicationNow = (id) => prisma.sellerApplication.findUnique({ where: { id } });
const userNow = (id) => prisma.user.findUnique({ where: { id } });
const storesOf = (userId) => prisma.store.findMany({ where: { userId } });
const sellerNotes = (userId) => prisma.notification.findMany({ where: { userId, category: 'seller' } });

describe('the admin list of applications', () => {
  test('a pending application is listed with the applicant name and email', async () => {
    const { applicant, application } = await pendingApplication();
    const res = await request(app).get('/api/admin/seller-applications').set(asUser(admin));
    expect(res.status).toBe(200);
    const row = res.body.find((a) => a.id === application.id);
    expect(row).toBeDefined();
    expect(row.user.email).toBe(applicant.email);
    expect(row.user.name).toBe(applicant.name);
  });

  test('an approved application is no longer listed', async () => {
    const { application } = await pendingApplication();
    await approve(application.id);
    const res = await request(app).get('/api/admin/seller-applications').set(asUser(admin));
    expect(res.body.find((a) => a.id === application.id)).toBeUndefined();
  });

  test('a rejected application is no longer listed', async () => {
    const { application } = await pendingApplication();
    await reject(application.id, { rejectionReason: 'Incomplete details' });
    const res = await request(app).get('/api/admin/seller-applications').set(asUser(admin));
    expect(res.body.find((a) => a.id === application.id)).toBeUndefined();
  });

  test('a normal user cannot see the list', async () => {
    const res = await request(app).get('/api/admin/seller-applications').set(asUser(await createUser()));
    expect(res.status).toBe(403);
  });
});

describe('approving an application', () => {
  test('the admin approves: status, seller flag, store and notification all change', async () => {
    const { applicant, application } = await pendingApplication({ businessName: 'Blue Door Pottery' });
    const res = await approve(application.id);
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Application approved');
    expect(res.body.application.status).toBe('approved');

    expect((await applicationNow(application.id)).status).toBe('approved');
    expect((await userNow(applicant.id)).isSeller).toBe(true);
    const stores = await storesOf(applicant.id);
    expect(stores).toHaveLength(1);
    expect(stores[0].storeName).toBe('Blue Door Pottery');
    const notes = await sellerNotes(applicant.id);
    expect(notes.map((n) => n.title)).toEqual(['Your seller application was approved']);
  });

  test('approving one application does not touch another applicant', async () => {
    const first = await pendingApplication();
    const second = await pendingApplication();
    await approve(first.application.id);
    expect((await applicationNow(second.application.id)).status).toBe('pending');
    expect((await userNow(second.applicant.id)).isSeller).toBe(false);
    expect(await storesOf(second.applicant.id)).toHaveLength(0);
  });

  test('a normal user cannot approve, and nothing changes', async () => {
    const { applicant, application } = await pendingApplication();
    const res = await approve(application.id, await createUser());
    expect(res.status).toBe(403);
    expect((await applicationNow(application.id)).status).toBe('pending');
    expect((await userNow(applicant.id)).isSeller).toBe(false);
    expect(await storesOf(applicant.id)).toHaveLength(0);
  });

  test('the applicant cannot approve their own application', async () => {
    const { applicant, application } = await pendingApplication();
    const res = await approve(application.id, applicant);
    expect(res.status).toBe(403);
    expect((await applicationNow(application.id)).status).toBe('pending');
  });

  test('an unknown application id gives 404', async () => {
    const res = await approve('00000000-0000-4000-8000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Application not found');
  });

  test('an id that is not even a uuid gives 404, not a crash', async () => {
    const res = await approve('not-a-real-id');
    expect(res.status).toBe(404);
  });

  test('approving twice: the second try is refused and nothing is duplicated', async () => {
    const { applicant, application } = await pendingApplication();
    expect((await approve(application.id)).status).toBe(200);
    const again = await approve(application.id);
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('Application is already approved');
    expect(await storesOf(applicant.id)).toHaveLength(1);
    expect(await sellerNotes(applicant.id)).toHaveLength(1);
  });

  test('a rejected application cannot be approved afterwards', async () => {
    const { applicant, application } = await pendingApplication();
    await reject(application.id, { rejectionReason: 'Not enough detail' });
    const res = await approve(application.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Application is already rejected');
    expect((await applicationNow(application.id)).status).toBe('rejected');
    expect((await userNow(applicant.id)).isSeller).toBe(false);
    expect(await storesOf(applicant.id)).toHaveLength(0);
  });

  test('two admins approving at the same moment: one wins, one store, one notification', async () => {
    const { applicant, application } = await pendingApplication();
    const results = await Promise.all([approve(application.id), approve(application.id), approve(application.id)]);
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409, 409]);
    expect(await storesOf(applicant.id)).toHaveLength(1);
    expect(await sellerNotes(applicant.id)).toHaveLength(1);
    expect((await userNow(applicant.id)).isSeller).toBe(true);
  });

  test('all or nothing: if the store cannot be created, the application and the seller flag stay as they were', async () => {
    const { applicant, application } = await pendingApplication();
    // Set up a broken state on purpose: this user already owns a store row, so the store step fails.
    await prisma.store.create({ data: { userId: applicant.id, storeName: 'Leftover store' } });
    const res = await approve(application.id);
    expect(res.status).toBe(500);
    expect((await applicationNow(application.id)).status).toBe('pending');
    expect((await userNow(applicant.id)).isSeller).toBe(false);
    expect(await sellerNotes(applicant.id)).toHaveLength(0);
    const stores = await storesOf(applicant.id);
    expect(stores).toHaveLength(1);
    expect(stores[0].storeName).toBe('Leftover store');
  });
});

describe('rejecting an application', () => {
  test('the admin rejects with a reason: it is saved and the applicant is told', async () => {
    const { applicant, application } = await pendingApplication();
    const res = await reject(application.id, { rejectionReason: 'Business details could not be verified' });
    expect(res.status).toBe(200);
    expect(res.body.message).toBe('Application rejected');
    expect(res.body.application.status).toBe('rejected');
    expect(res.body.application.rejectionReason).toBe('Business details could not be verified');

    const saved = await applicationNow(application.id);
    expect(saved.status).toBe('rejected');
    expect(saved.rejectionReason).toBe('Business details could not be verified');
    expect((await userNow(applicant.id)).isSeller).toBe(false);
    expect(await storesOf(applicant.id)).toHaveLength(0);

    const notes = await sellerNotes(applicant.id);
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Your seller application was not approved');
    expect(notes[0].message).toContain('Business details could not be verified');
  });

  test('spaces around the reason are removed before it is saved', async () => {
    const { application } = await pendingApplication();
    await reject(application.id, { rejectionReason: '   Not a fit for the marketplace   ' });
    expect((await applicationNow(application.id)).rejectionReason).toBe('Not a fit for the marketplace');
  });

  test('the applicant can read the decision and the reason on their own application', async () => {
    const { applicant, application } = await pendingApplication();
    await reject(application.id, { rejectionReason: 'Please add a business address' });
    const res = await request(app).get('/api/seller/application').set(asUser(applicant));
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.rejectionReason).toBe('Please add a business address');
  });

  describe.each([
    ['no reason at all', {}],
    ['an empty reason', { rejectionReason: '' }],
    ['a reason made only of spaces', { rejectionReason: '        ' }],
    ['a reason of 4 characters', { rejectionReason: 'abcd' }],
    ['a reason of 501 characters', { rejectionReason: 'a'.repeat(501) }],
    ['a reason that is a number', { rejectionReason: 12345 }],
    ['a reason that is null', { rejectionReason: null }],
  ])('a bad reason: %s', (label, body) => {
    test('is refused with 400 and the application stays pending', async () => {
      const { applicant, application } = await pendingApplication();
      const res = await reject(application.id, body);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Rejection reason/);
      expect((await applicationNow(application.id)).status).toBe('pending');
      expect((await applicationNow(application.id)).rejectionReason).toBeNull();
      expect(await sellerNotes(applicant.id)).toHaveLength(0);
    });
  });

  test('a reason of exactly 5 characters is accepted', async () => {
    const { application } = await pendingApplication();
    const res = await reject(application.id, { rejectionReason: 'abcde' });
    expect(res.status).toBe(200);
  });

  test('a reason of exactly 500 characters is accepted', async () => {
    const { application } = await pendingApplication();
    const res = await reject(application.id, { rejectionReason: 'a'.repeat(500) });
    expect(res.status).toBe(200);
    expect((await applicationNow(application.id)).rejectionReason).toHaveLength(500);
  });

  test('a normal user cannot reject, and nothing changes', async () => {
    const { application } = await pendingApplication();
    const res = await reject(application.id, { rejectionReason: 'Trying my luck' }, await createUser());
    expect(res.status).toBe(403);
    expect((await applicationNow(application.id)).status).toBe('pending');
  });

  test('an unknown application id gives 404', async () => {
    const res = await reject('00000000-0000-4000-8000-000000000000', { rejectionReason: 'No such application' });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Application not found');
  });

  test('rejecting twice: the second try is refused and the first reason is kept', async () => {
    const { applicant, application } = await pendingApplication();
    await reject(application.id, { rejectionReason: 'First reason given' });
    const again = await reject(application.id, { rejectionReason: 'A different reason' });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('Application is already rejected');
    expect((await applicationNow(application.id)).rejectionReason).toBe('First reason given');
    expect(await sellerNotes(applicant.id)).toHaveLength(1);
  });

  test('an approved application cannot be rejected: the seller keeps the flag and the store', async () => {
    const { applicant, application } = await pendingApplication();
    await approve(application.id);
    const res = await reject(application.id, { rejectionReason: 'Changed our mind' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Application is already approved');
    const saved = await applicationNow(application.id);
    expect(saved.status).toBe('approved');
    expect(saved.rejectionReason).toBeNull();
    expect((await userNow(applicant.id)).isSeller).toBe(true);
    expect(await storesOf(applicant.id)).toHaveLength(1);
  });

  test('an approval and a rejection at the same moment: exactly one decision wins', async () => {
    const { applicant, application } = await pendingApplication();
    const results = await Promise.all([approve(application.id), reject(application.id, { rejectionReason: 'Decided against it' })]);
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([200, 409]);
    const saved = await applicationNow(application.id);
    const user = await userNow(applicant.id);
    const stores = await storesOf(applicant.id);
    if (saved.status === 'approved') {
      expect(user.isSeller).toBe(true);
      expect(stores).toHaveLength(1);
    } else {
      expect(saved.status).toBe('rejected');
      expect(user.isSeller).toBe(false);
      expect(stores).toHaveLength(0);
    }
    expect(await sellerNotes(applicant.id)).toHaveLength(1);
  });
});
