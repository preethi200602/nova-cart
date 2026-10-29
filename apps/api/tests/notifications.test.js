const request = require('supertest');
const nodemailer = require('nodemailer');
const { app, prisma } = require('../server');
const { notify } = require('../notify');
const { createUser, asUser, resetDb, createCategory, createProduct } = require('./helpers');

const MISSING_ID = '00000000-0000-4000-8000-000000000000';
const CATEGORIES = ['account', 'orders', 'refunds', 'seller', 'reviews', 'security'];

// notify.js builds its email transporter the first time an email is sent and then keeps it.
// This hands it one that records every email, so the tests can count them.
// It must run before any email is sent in this file.
const sendMail = jest.fn(async () => ({ messageId: 'test-message' }));
jest.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail });

let logSpy;
let user;
let other;

// A notification straight in the database.
function addNote(forUser, overrides = {}) {
  return prisma.notification.create({
    data: { userId: forUser.id, category: 'orders', title: 'A title', message: 'A message', ...overrides },
  });
}

// A saved preference straight in the database.
function setPref(forUser, category, values) {
  return prisma.notificationPreference.create({ data: { userId: forUser.id, category, ...values } });
}

const notesOf = (forUser, where = {}) => prisma.notification.findMany({ where: { userId: forUser.id, ...where } });
const prefRows = (forUser, category) => prisma.notificationPreference.findMany({ where: { userId: forUser.id, category } });

const getNotes = (who) => request(app).get('/api/notifications').set(asUser(who));
const putPref = (who, body) => request(app).put('/api/notification-preferences').set(asUser(who)).send(body);

beforeAll(() => {
  // notify.js prints an email preview line for every email; keep the test output clean.
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(async () => {
  logSpy.mockRestore();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  sendMail.mockClear();
  user = await createUser();
  other = await createUser();
});

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

describe('every notification route needs a login', () => {
  test.each([
    ['get', '/api/notifications'],
    ['get', '/api/notifications/unread-count'],
    ['put', '/api/notifications/read-all'],
    ['put', `/api/notifications/${MISSING_ID}/read`],
    ['get', '/api/notification-preferences'],
    ['put', '/api/notification-preferences'],
  ])('%s %s without a token gives 401', async (method, path) => {
    const res = await request(app)[method](path).send({ category: 'orders', email: false });

    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// The inbox
// ---------------------------------------------------------------------------

describe('GET /api/notifications', () => {
  test('returns my notifications newest first, with all their details', async () => {
    const base = Date.now() - 60000;
    await addNote(user, { title: 'oldest', createdAt: new Date(base) });
    await addNote(user, { title: 'newest', createdAt: new Date(base + 2000) });
    await addNote(user, { title: 'middle', category: 'reviews', message: 'Hello there', createdAt: new Date(base + 1000) });

    const res = await getNotes(user);

    expect(res.status).toBe(200);
    expect(res.body.map((n) => n.title)).toEqual(['newest', 'middle', 'oldest']);
    expect(res.body[1]).toMatchObject({ category: 'reviews', message: 'Hello there', read: false, userId: user.id });
  });

  test('never shows another user\'s notifications', async () => {
    await addNote(user, { title: 'mine' });
    await addNote(other, { title: 'theirs' });

    const res = await getNotes(user);

    expect(res.body.map((n) => n.title)).toEqual(['mine']);
  });

  test('returns an empty list when there is nothing', async () => {
    const res = await getNotes(user);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  test('returns at most 50, keeping the newest', async () => {
    const base = Date.now() - 600000;
    const rows = [];
    for (let i = 0; i < 55; i += 1) {
      rows.push({ userId: user.id, category: 'orders', title: `N${i}`, message: 'm', createdAt: new Date(base + i * 1000) });
    }
    await prisma.notification.createMany({ data: rows });

    const res = await getNotes(user);

    expect(res.body).toHaveLength(50);
    expect(res.body[0].title).toBe('N54');
    expect(res.body[49].title).toBe('N5');
    expect(res.body.map((n) => n.title)).not.toContain('N4');
  });
});

describe('GET /api/notifications/unread-count', () => {
  test('counts only my unread notifications', async () => {
    await addNote(user);
    await addNote(user);
    await addNote(user);
    await addNote(user, { read: true });
    await addNote(user, { read: true });
    await addNote(other);
    await addNote(other);

    const res = await request(app).get('/api/notifications/unread-count').set(asUser(user));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unread: 3 });
  });

  test('is 0 when there is nothing', async () => {
    const res = await request(app).get('/api/notifications/unread-count').set(asUser(user));

    expect(res.body).toEqual({ unread: 0 });
  });
});

describe('PUT /api/notifications/:id/read', () => {
  test('marks one of my notifications as read and leaves the others unread', async () => {
    const first = await addNote(user, { title: 'first' });
    const second = await addNote(user, { title: 'second' });

    const res = await request(app).put(`/api/notifications/${first.id}/read`).set(asUser(user));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(first.id);
    expect(res.body.read).toBe(true);

    const rows = await notesOf(user);
    expect(rows.find((n) => n.id === first.id).read).toBe(true);
    expect(rows.find((n) => n.id === second.id).read).toBe(false);
  });

  test('lowers the unread count by one', async () => {
    const note = await addNote(user);
    await addNote(user);

    await request(app).put(`/api/notifications/${note.id}/read`).set(asUser(user));
    const res = await request(app).get('/api/notifications/unread-count').set(asUser(user));

    expect(res.body.unread).toBe(1);
  });

  test('marking an already read notification is fine', async () => {
    const note = await addNote(user, { read: true });

    const res = await request(app).put(`/api/notifications/${note.id}/read`).set(asUser(user));

    expect(res.status).toBe(200);
    expect(res.body.read).toBe(true);
  });

  test('someone else\'s notification gives 404 and stays unread', async () => {
    const theirs = await addNote(other);

    const res = await request(app).put(`/api/notifications/${theirs.id}/read`).set(asUser(user));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Notification not found');
    expect((await notesOf(other))[0].read).toBe(false);
  });

  test('an unknown notification gives 404', async () => {
    const res = await request(app).put(`/api/notifications/${MISSING_ID}/read`).set(asUser(user));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Notification not found');
  });
});

describe('PUT /api/notifications/read-all', () => {
  test('marks all of my notifications as read and leaves other users alone', async () => {
    await addNote(user);
    await addNote(user);
    await addNote(user, { read: true });
    await addNote(other);

    const res = await request(app).put('/api/notifications/read-all').set(asUser(user));

    expect(res.status).toBe(200);
    expect(res.body.message).toBe('All notifications marked as read');

    const mine = await notesOf(user);
    expect(mine).toHaveLength(3);
    expect(mine.every((n) => n.read === true)).toBe(true);

    const theirs = await notesOf(other);
    expect(theirs.every((n) => n.read === false)).toBe(true);

    const count = await request(app).get('/api/notifications/unread-count').set(asUser(user));
    expect(count.body.unread).toBe(0);
  });

  test('works when there is nothing to mark', async () => {
    const res = await request(app).put('/api/notifications/read-all').set(asUser(user));

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

describe('GET /api/notification-preferences', () => {
  test('a new user gets all six categories, in a fixed order, with everything switched on', async () => {
    const res = await request(app).get('/api/notification-preferences').set(asUser(user));

    expect(res.status).toBe(200);
    expect(res.body.map((p) => p.category)).toEqual(CATEGORIES);
    expect(res.body.every((p) => p.email === true && p.inApp === true)).toBe(true);
  });

  test('a saved choice shows up and the other categories keep their defaults', async () => {
    await setPref(user, 'orders', { email: false, inApp: true });
    await setPref(user, 'reviews', { email: true, inApp: false });

    const res = await request(app).get('/api/notification-preferences').set(asUser(user));
    const byCategory = Object.fromEntries(res.body.map((p) => [p.category, p]));

    expect(byCategory.orders).toEqual({ category: 'orders', email: false, inApp: true });
    expect(byCategory.reviews).toEqual({ category: 'reviews', email: true, inApp: false });
    expect(byCategory.refunds).toEqual({ category: 'refunds', email: true, inApp: true });
  });

  test('another user\'s choices never show up', async () => {
    await setPref(other, 'orders', { email: false, inApp: false });

    const res = await request(app).get('/api/notification-preferences').set(asUser(user));
    const orders = res.body.find((p) => p.category === 'orders');

    expect(orders).toEqual({ category: 'orders', email: true, inApp: true });
  });
});

describe('PUT /api/notification-preferences', () => {
  test('switching email off for a category is saved and shown', async () => {
    const res = await putPref(user, { category: 'orders', email: false });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ category: 'orders', email: false, inApp: true });

    const list = await request(app).get('/api/notification-preferences').set(asUser(user));
    expect(list.body.find((p) => p.category === 'orders')).toEqual({ category: 'orders', email: false, inApp: true });
  });

  test('switching in-app off leaves email on', async () => {
    const res = await putPref(user, { category: 'refunds', inApp: false });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ category: 'refunds', email: true, inApp: false });
  });

  test('a later change to one setting keeps the other setting as it was', async () => {
    await putPref(user, { category: 'orders', email: false });

    const res = await putPref(user, { category: 'orders', inApp: false });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: false, inApp: false });
  });

  test('settings can be switched back on', async () => {
    await putPref(user, { category: 'orders', email: false, inApp: false });

    const res = await putPref(user, { category: 'orders', email: true, inApp: true });

    expect(res.body).toMatchObject({ email: true, inApp: true });
  });

  test('saving the same category twice keeps one row', async () => {
    await putPref(user, { category: 'orders', email: false });
    await putPref(user, { category: 'orders', email: true });

    expect(await prefRows(user, 'orders')).toHaveLength(1);
  });

  test('my choice never changes another user\'s settings', async () => {
    await putPref(user, { category: 'orders', email: false, inApp: false });

    expect(await prefRows(other, 'orders')).toHaveLength(0);
    const list = await request(app).get('/api/notification-preferences').set(asUser(other));
    expect(list.body.find((p) => p.category === 'orders')).toEqual({ category: 'orders', email: true, inApp: true });
  });

  test('a userId in the request body is ignored: the choice is saved for the person logged in', async () => {
    const res = await putPref(user, { category: 'orders', email: false, userId: other.id });

    expect(res.status).toBe(200);
    expect(await prefRows(user, 'orders')).toHaveLength(1);
    expect(await prefRows(other, 'orders')).toHaveLength(0);
  });

  test('an unknown category gives 400 and saves nothing', async () => {
    const res = await putPref(user, { category: 'nonsense', email: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid category');
    expect(await prefRows(user, 'nonsense')).toHaveLength(0);
  });

  test('security emails cannot be switched off (400) and nothing is saved', async () => {
    const res = await putPref(user, { category: 'security', email: false });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Security emails cannot be turned off');
    expect(await prefRows(user, 'security')).toHaveLength(0);
  });

  test('security emails can be switched on (true is accepted)', async () => {
    const res = await putPref(user, { category: 'security', email: true });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ category: 'security', email: true });
  });

  test.each([
    ['a missing category', { email: false }],
    ['email as text', { category: 'orders', email: 'false' }],
    ['inApp as a number', { category: 'orders', inApp: 1 }],
  ])('%s gives 400 and saves nothing', async (label, body) => {
    const res = await putPref(user, body);

    expect(res.status).toBe(400);
    expect(await prefRows(user, 'orders')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// notify(): the function that decides what is delivered
// ---------------------------------------------------------------------------

describe('notify()', () => {
  test('with no saved preferences it creates an in-app notification and sends one email', async () => {
    await notify(user.id, 'orders', 'Order update', 'Your order shipped');

    const notes = await notesOf(user);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ category: 'orders', title: 'Order update', message: 'Your order shipped', read: false });

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: user.email, subject: 'Order update', text: 'Your order shipped' })
    );
  });

  test('with in-app switched off there is no notification but the email still goes out', async () => {
    await setPref(user, 'orders', { inApp: false, email: true });

    await notify(user.id, 'orders', 'Order update', 'Your order shipped');

    expect(await notesOf(user)).toHaveLength(0);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  test('with email switched off the notification is created but no email is sent', async () => {
    await setPref(user, 'orders', { inApp: true, email: false });

    await notify(user.id, 'orders', 'Order update', 'Your order shipped');

    expect(await notesOf(user)).toHaveLength(1);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('with both switched off nothing is delivered', async () => {
    await setPref(user, 'orders', { inApp: false, email: false });

    await notify(user.id, 'orders', 'Order update', 'Your order shipped');

    expect(await notesOf(user)).toHaveLength(0);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('a choice for one category does not affect another category', async () => {
    await setPref(user, 'orders', { inApp: false, email: false });

    await notify(user.id, 'reviews', 'New review received', 'Five stars');

    expect(await notesOf(user, { category: 'reviews' })).toHaveLength(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  test('another user\'s choices do not affect me', async () => {
    await setPref(other, 'orders', { inApp: false, email: false });

    await notify(user.id, 'orders', 'Order update', 'Your order shipped');

    expect(await notesOf(user)).toHaveLength(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  test('security emails are always sent, even if the saved preference says email off', async () => {
    // The preference route refuses this, so the row is created directly.
    await setPref(user, 'security', { email: false, inApp: true });

    await notify(user.id, 'security', 'New login', 'Someone signed in');

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: user.email, subject: 'New login' }));
  });

  test('an email switched off still applies to every category except security', async () => {
    await setPref(user, 'refunds', { email: false, inApp: true });

    await notify(user.id, 'refunds', 'Refund approved', 'Money is on its way');

    expect(sendMail).not.toHaveBeenCalled();
  });

  test('emailOnly sends the email without creating an in-app notification', async () => {
    await notify(user.id, 'account', 'Verify your email', 'Click the link', { emailOnly: true });

    expect(await notesOf(user)).toHaveLength(0);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  test('emailOnly still respects a switched-off email preference', async () => {
    await setPref(user, 'account', { email: false, inApp: true });

    await notify(user.id, 'account', 'Verify your email', 'Click the link', { emailOnly: true });

    expect(await notesOf(user)).toHaveLength(0);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('an unknown user is ignored quietly: no notification, no email, no error', async () => {
    await expect(notify(MISSING_ID, 'orders', 'Order update', 'Your order shipped')).resolves.toBeUndefined();

    expect(await prisma.notification.count({})).toBe(0);
    expect(sendMail).not.toHaveBeenCalled();
  });

  test('a failing email never throws: the error is logged and the notification is still saved', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    sendMail.mockRejectedValueOnce(new Error('SMTP down'));

    try {
      await expect(notify(user.id, 'orders', 'Order update', 'Your order shipped')).resolves.toBeUndefined();

      expect(await notesOf(user)).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalledWith('Notification failed (non-fatal):', 'SMTP down');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// End to end: a real action, a saved preference, and what is delivered
// ---------------------------------------------------------------------------

describe('preferences applied to a real action (a new review)', () => {
  let seller;
  let buyer;
  let product;
  let order;

  beforeEach(async () => {
    seller = await createUser({ isSeller: true });
    buyer = await createUser();
    const category = await createCategory();
    product = await createProduct(seller, category);
    order = await prisma.order.create({
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
  });

  const postReview = () =>
    request(app).post(`/api/products/${product.id}/reviews`).set(asUser(buyer)).send({ orderId: order.id, rating: 5 });

  test('with defaults the seller gets both the in-app notification and the email', async () => {
    const res = await postReview();

    expect(res.status).toBe(201);
    expect(await notesOf(seller, { category: 'reviews' })).toHaveLength(1);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: seller.email, subject: 'New review received' }));
  });

  test('a seller who switches off in-app review notifications gets none, but still gets the email', async () => {
    const saved = await putPref(seller, { category: 'reviews', inApp: false });
    expect(saved.status).toBe(200);

    const res = await postReview();

    expect(res.status).toBe(201);
    expect(await prisma.review.count({})).toBe(1);
    expect(await notesOf(seller, { category: 'reviews' })).toHaveLength(0);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  test('a seller who switches off review emails gets no email, but still gets the in-app notification', async () => {
    const saved = await putPref(seller, { category: 'reviews', email: false });
    expect(saved.status).toBe(200);

    const res = await postReview();

    expect(res.status).toBe(201);
    expect(await notesOf(seller, { category: 'reviews' })).toHaveLength(1);
    expect(sendMail).not.toHaveBeenCalled();
  });
});