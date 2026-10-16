const express = require('express');
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const requireAuth = require('./middleware/auth');
const crypto = require('crypto');
const requireAdmin = require('./middleware/requireAdmin');
const requireSeller = require('./middleware/requireSeller');
const { Prisma } = require('@prisma/client');
const Razorpay = require('razorpay');
const { notify } = require('./notify');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const app = express();
app.use(express.json());

const prisma = new PrismaClient();

async function syncStockState(productId, { notifySeller = true } = {}) {
  try {
    const rows = await prisma.$queryRaw`
      UPDATE "Product"
      SET state = CASE
            WHEN state = 'active' AND stock <= 0 THEN 'out_of_stock'
            ELSE 'active'
          END,
          "updatedAt" = NOW()
      WHERE id = ${productId}
        AND ((state = 'active' AND stock <= 0) OR (state = 'out_of_stock' AND stock > 0))
      RETURNING "sellerId", name, state
    `;

    if (notifySeller && rows.length > 0 && rows[0].state === 'out_of_stock') {
      await notify(
        rows[0].sellerId,
        'seller',
        'Product out of stock',
        `"${rows[0].name}" is now out of stock and cannot be bought until you restock it.`
      );
    }
  } catch (err) {
    console.error('syncStockState failed', err);
  }
}

async function syncStockState(productId, { notifySeller = true } = {}) {
  try {
    const rows = await prisma.$queryRaw`
      UPDATE "Product"
      SET state = CASE
            WHEN state = 'active' AND stock <= 0 THEN 'out_of_stock'
            ELSE 'active'
          END,
          "updatedAt" = NOW()
      WHERE id = ${productId}
        AND ((state = 'active' AND stock <= 0) OR (state = 'out_of_stock' AND stock > 0))
      RETURNING "sellerId", name, state
    `;

    if (notifySeller && rows.length > 0 && rows[0].state === 'out_of_stock') {
      await notify(
        rows[0].sellerId,
        'seller',
        'Product out of stock',
        `"${rows[0].name}" is now out of stock and cannot be bought until you restock it.`
      );
    }
  } catch (err) {
    console.error('syncStockState failed', err);
  }
}

async function syncStockState(productId, { notifySeller = true } = {}) {
  try {
    const rows = await prisma.$queryRaw`
      UPDATE "Product"
      SET state = CASE
            WHEN state = 'active' AND stock <= 0 THEN 'out_of_stock'
            ELSE 'active'
          END,
          "updatedAt" = NOW()
      WHERE id = ${productId}
        AND ((state = 'active' AND stock <= 0) OR (state = 'out_of_stock' AND stock > 0))
      RETURNING "sellerId", name, state
    `;

    if (notifySeller && rows.length > 0 && rows[0].state === 'out_of_stock') {
      await notify(
        rows[0].sellerId,
        'seller',
        'Product out of stock',
        `"${rows[0].name}" is now out of stock and cannot be bought until you restock it.`
      );
    }
  } catch (err) {
    console.error('syncStockState failed', err);
  }
}

async function decrementStock(productId, quantity) {
  const result = await prisma.product.updateMany({
    where: {
      id: productId,
      stock: { gte: quantity },
    },
    data: {
      stock: { decrement: quantity },
    },
  });

  if (result.count > 0) await syncStockState(productId);

  return result.count > 0;
}

const ORDER_TRANSITIONS = {
  payment_pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['refund_requested'],
  refund_requested: ['refunded'],
  cancelled: [],
  refunded: [],
};

function canTransition(fromStatus, toStatus) {
  return ORDER_TRANSITIONS[fromStatus]?.includes(toStatus) || false;
}

app.use(require('cors')());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

        const verificationToken = crypto.randomBytes(32).toString('hex');
    const verificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const user = await prisma.user.create({
      data: { email, password: hashedPassword, name, verificationToken, verificationTokenExpiry },
    });

    notify(
      user.id,
      'security',
      'Verify your email address',
      `Welcome to Nova-Cart! Please verify your email to activate your account (link valid for 24 hours): http://localhost:3000/verify-email?token=${verificationToken}`,
      { emailOnly: true }
    );

    res.status(201).json({
      id: user.id,
      email: user.email,
      name: user.name,
      message: 'Account created. Please check your email to verify your address.',
    });
  
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

      if (!user.emailVerified) {
      return res.status(403).json({
        error: 'Please verify your email before logging in. Check your inbox for the verification link.',
      });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '1h' });

    res.json({ token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});
app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ id: user.id, email: user.email, name: user.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});
app.put('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const { name } = req.body;

    const updatedUser = await prisma.user.update({
      where: { id: req.userId },
      data: { name },
    });

    res.json({ id: updatedUser.id, email: updatedUser.email, name: updatedUser.name });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      return res.json({ message: 'If that email exists, a reset link has been sent.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 15 * 60 * 1000);

    await prisma.user.update({
      where: { email },
      data: { resetToken, resetTokenExpiry },
    });


        notify(
      user.id,
      'security',
      'Password reset requested',
      `Use this link to reset your password (valid for 15 minutes): http://localhost:3000/reset-password?token=${resetToken}`,
      { emailOnly: true }
    );

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/auth/verify-email', async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }

    const user = await prisma.user.findFirst({
      where: {
        verificationToken: token,
        verificationTokenExpiry: { gt: new Date() },
      },
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired verification link' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: true, verificationToken: null, verificationTokenExpiry: null },
    });

    await notify(user.id, 'account', 'Email verified', 'Welcome to Nova-Cart! Your account is now active.');

    res.json({ message: 'Email verified successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/auth/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (user && !user.emailVerified) {
      const verificationToken = crypto.randomBytes(32).toString('hex');
      const verificationTokenExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

      await prisma.user.update({
        where: { id: user.id },
        data: { verificationToken, verificationTokenExpiry },
      });

      notify(
        user.id,
        'security',
        'Verify your email address',
        `Here is your new verification link (valid for 24 hours): http://localhost:3000/verify-email?token=${verificationToken}`,
        { emailOnly: true }
      );
    }

    res.json({ message: 'If that account exists and is unverified, a new link has been sent.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    const user = await prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExpiry: { gt: new Date() },
      },
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    res.json({ message: 'Password has been reset successfully.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});
app.post('/api/seller/apply', requireAuth, async (req, res) => {
  try {
    const { businessName, description, categoryFocus, contactDetails } = req.body;

    if (!businessName || !description || !categoryFocus || !contactDetails) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const existing = await prisma.sellerApplication.findUnique({
      where: { userId: req.userId },
    });

    if (existing) {
      return res.status(409).json({ error: 'You have already submitted a seller application' });
    }

    const application = await prisma.sellerApplication.create({
      data: {
        userId: req.userId,
        businessName,
        description,
        categoryFocus,
        contactDetails,
      },
    });

    res.status(201).json(application);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});
app.get('/api/seller/application', requireAuth, async (req, res) => {
  try {
    const application = await prisma.sellerApplication.findUnique({
      where: { userId: req.userId },
    });

    if (!application) {
      return res.status(404).json({ error: 'No application found' });
    }

    res.json(application);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/admin/seller-applications', requireAuth, requireAdmin, async (req, res) => {
  try {
    const applications = await prisma.sellerApplication.findMany({
      where: { status: 'pending' },
      include: { user: { select: { email: true, name: true } } },
    });
    res.json(applications);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/admin/seller-applications/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    const application = await prisma.sellerApplication.update({
      where: { id: req.params.id },
      data: { status: 'approved' },
    });

    await prisma.user.update({
      where: { id: application.userId },
      data: { isSeller: true },
    });

    await prisma.store.create({
      data: {
        userId: application.userId,
        storeName: application.businessName,
      },
    });

        await notify(
      application.userId,
      'seller',
      'Your seller application was approved',
      'Congratulations! Your store is set up. You can now list products from your seller dashboard.'
    );

    res.json({ message: 'Application approved', application });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/admin/seller-applications/:id/reject', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rejectionReason } = req.body;

    const application = await prisma.sellerApplication.update({
      where: { id: req.params.id },
      data: { status: 'rejected', rejectionReason },
    });

        await notify(
      application.userId,
      'seller',
      'Your seller application was not approved',
      `Unfortunately your application was rejected.${rejectionReason ? ' Reason: ' + rejectionReason : ''}`
    );

    res.json({ message: 'Application rejected', application });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/seller/store', requireAuth, requireSeller, async (req, res) => {
  try {
    const store = await prisma.store.findUnique({ where: { userId: req.userId } });
    res.json(store);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/seller/store', requireAuth, requireSeller, async (req, res) => {
  try {
    const { storeName, banner, description, policies } = req.body;

    const store = await prisma.store.update({
      where: { userId: req.userId },
      data: { storeName, banner, description, policies },
    });

    res.json(store);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

function cleanProductInput(body, existing) {
  const data = {};
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  if (body.name !== undefined) {
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name.length < 1 || name.length > 120) return { error: 'Name must be 1 to 120 characters' };
    data.name = name;
  }
  if (body.description !== undefined) {
    const description = typeof body.description === 'string' ? body.description.trim() : '';
    if (description.length < 1 || description.length > 5000) {
      return { error: 'Description must be 1 to 5000 characters' };
    }
    data.description = description;
  }
  if (body.price !== undefined) {
    if (!isNum(body.price) || body.price <= 0 || body.price > 10000000) {
      return { error: 'Price must be a positive number' };
    }
    data.price = body.price;
  }
  if (body.salePrice !== undefined) {
    if (body.salePrice === null) {
      data.salePrice = null;
    } else if (!isNum(body.salePrice) || body.salePrice <= 0) {
      return { error: 'Sale price must be a positive number or null' };
    } else {
      data.salePrice = body.salePrice;
    }
  }
  if (body.stock !== undefined) {
    if (!Number.isInteger(body.stock) || body.stock < 0 || body.stock > 1000000) {
      return { error: 'Stock must be a whole number, 0 or more' };
    }
    data.stock = body.stock;
  }
  if (body.categoryId !== undefined) {
    if (typeof body.categoryId !== 'string' || !body.categoryId) return { error: 'Invalid categoryId' };
    data.categoryId = body.categoryId;
  }
  if (body.tags !== undefined) {
    if (body.tags !== null && (typeof body.tags !== 'string' || body.tags.length > 200)) {
      return { error: 'Tags must be text up to 200 characters' };
    }
    data.tags = body.tags || null;
  }
  if (body.images !== undefined) {
    if (
      !Array.isArray(body.images) ||
      body.images.length > 10 ||
      body.images.some((i) => typeof i !== 'string' || i.length > 500)
    ) {
      return { error: 'Images must be a list of up to 10 URLs' };
    }
    data.images = body.images;
  }
  if (body.state !== undefined) {
    if (!['draft', 'active'].includes(body.state)) return { error: 'State must be draft or active' };
    data.state = body.state;
  }

  const finalPrice = data.price !== undefined ? data.price : existing ? existing.price : null;
  const finalSale = data.salePrice !== undefined ? data.salePrice : existing ? existing.salePrice : null;
  if (finalSale !== null && finalPrice !== null && finalSale >= finalPrice) {
    return { error: 'Sale price must be lower than the price' };
  }

  return { data };
}

app.post('/api/products', requireAuth, requireSeller, async (req, res) => {
  try {
    const body = req.body || {};

    if (!body.name || !body.description || !body.price || !body.categoryId) {
      return res.status(400).json({ error: 'name, description, price, and categoryId are required' });
    }

    const cleaned = cleanProductInput(body, null);
    if (cleaned.error) return res.status(400).json({ error: cleaned.error });

    const category = await prisma.category.findUnique({ where: { id: cleaned.data.categoryId } });
    if (!category) {
      return res.status(400).json({ error: 'Invalid categoryId' });
    }

    const product = await prisma.product.create({
      data: { ...cleaned.data, sellerId: req.userId },
    });

    res.status(201).json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/seller/products', requireAuth, requireSeller, async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: { sellerId: req.userId },
      include: { category: true },
    });
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/products/:id', requireAuth, requireSeller, async (req, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    if (product.sellerId !== req.userId) {
      return res.status(403).json({ error: 'You can only edit your own products' });
    }
    if (product.state === 'removed') {
      return res.status(403).json({ error: 'This product was removed by an admin and cannot be edited' });
    }

    const cleaned = cleanProductInput(req.body || {}, product);
    if (cleaned.error) return res.status(400).json({ error: cleaned.error });

    if (cleaned.data.categoryId) {
      const category = await prisma.category.findUnique({ where: { id: cleaned.data.categoryId } });
      if (!category) return res.status(400).json({ error: 'Invalid categoryId' });
    }

    if (Object.keys(cleaned.data).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    await prisma.product.update({
      where: { id: req.params.id },
      data: cleaned.data,
    });

    await syncStockState(req.params.id, { notifySeller: false });
    const updated = await prisma.product.findUnique({ where: { id: req.params.id } });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/products/:id/deactivate', requireAuth, requireSeller, async (req, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }
    if (product.sellerId !== req.userId) {
      return res.status(403).json({ error: 'You can only manage your own products' });
    }
    if (product.state === 'removed') {
      return res.status(409).json({ error: 'This product was already removed by an admin' });
    }

    const updated = await prisma.product.update({
      where: { id: req.params.id },
      data: { state: 'archived' },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/products/:id', async (req, res) => {
  try {
    const product = await prisma.product.findUnique({
      where: { id: req.params.id },
      include: {
        category: true,
        seller: {
          select: {
            id: true,
            name: true,
            store: true,
          },
        },
        reviews: {
          include: {
            buyer: { select: { name: true } },
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!product || !['active', 'out_of_stock'].includes(product.state)) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

async function categoryWithDescendants(categoryId) {
  const rows = await prisma.$queryRaw`
    WITH RECURSIVE tree AS (
      SELECT id FROM "Category" WHERE id = ${categoryId}
      UNION
      SELECT c.id FROM "Category" c JOIN tree t ON c."parentId" = t.id
    )
    SELECT id FROM tree
  `;
  return rows.map((r) => r.id);
}

app.get('/api/products', async (req, res) => {
  try {
    const { q, category, minPrice, maxPrice, seller, sort } = req.query;

    const pageNum = Math.max(parseInt(req.query.page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;

    const parsedMin = parseFloat(minPrice);
    const parsedMax = parseFloat(maxPrice);
    const min = Number.isFinite(parsedMin) ? parsedMin : null;
    const max = Number.isFinite(parsedMax) ? parsedMax : null;

    const parsedRating = parseFloat(req.query.minRating);
    const minRating = Number.isFinite(parsedRating) ? Math.min(Math.max(parsedRating, 0), 5) : null;
    const inStock = req.query.inStock === 'true';

    const categoryIds = category ? await categoryWithDescendants(String(category)) : null;
    const sellerId = seller ? String(seller) : null;
    const search = typeof q === 'string' ? q.trim() : '';
    const likePattern = search ? '%' + search.replace(/[\\%_]/g, '\\$&') + '%' : null;

    const categoryFilter = categoryIds
      ? categoryIds.length > 0
        ? Prisma.sql`AND p."categoryId" IN (${Prisma.join(categoryIds)})`
        : Prisma.sql`AND FALSE`
      : Prisma.empty;

    const searchFilter = search
      ? Prisma.sql`AND (
          similarity(p.name, ${search}) > 0.15
          OR similarity(p.description, ${search}) > 0.1
          OR p.name ILIKE ${likePattern}
          OR p.tags ILIKE ${likePattern}
        )`
      : Prisma.empty;

    const fromSql = Prisma.sql`
      FROM "Product" p
      JOIN "Category" c ON c.id = p."categoryId"
      LEFT JOIN (
        SELECT "productId",
               COUNT(*)::int AS "reviewCount",
               ROUND(AVG(rating)::numeric, 1)::float8 AS "avgRating"
        FROM "Review"
        GROUP BY "productId"
      ) r ON r."productId" = p.id
    `;

    const whereSql = Prisma.sql`
      WHERE p.state IN ('active', 'out_of_stock')
      ${categoryFilter}
      ${sellerId ? Prisma.sql`AND p."sellerId" = ${sellerId}` : Prisma.empty}
      ${min !== null ? Prisma.sql`AND p.price >= ${min}` : Prisma.empty}
      ${max !== null ? Prisma.sql`AND p.price <= ${max}` : Prisma.empty}
      ${inStock ? Prisma.sql`AND p.stock > 0` : Prisma.empty}
      ${minRating !== null ? Prisma.sql`AND r."avgRating" >= ${minRating}` : Prisma.empty}
      ${searchFilter}
    `;

    let orderSql = search
      ? Prisma.sql`relevance DESC, p."createdAt" DESC, p.id`
      : Prisma.sql`p."createdAt" DESC, p.id`;
    if (sort === 'price_asc') orderSql = Prisma.sql`p.price ASC, p."createdAt" DESC, p.id`;
    if (sort === 'price_desc') orderSql = Prisma.sql`p.price DESC, p."createdAt" DESC, p.id`;
    if (sort === 'newest') orderSql = Prisma.sql`p."createdAt" DESC, p.id`;
    if (sort === 'most_reviewed') {
      orderSql = Prisma.sql`COALESCE(r."reviewCount", 0) DESC, r."avgRating" DESC NULLS LAST, p."createdAt" DESC, p.id`;
    }
    if (sort === 'rating') {
      orderSql = Prisma.sql`r."avgRating" DESC NULLS LAST, COALESCE(r."reviewCount", 0) DESC, p."createdAt" DESC, p.id`;
    }

    const relevanceSql = search ? Prisma.sql`, similarity(p.name, ${search}) AS relevance` : Prisma.empty;

    const products = await prisma.$queryRaw`
      SELECT
        p.*,
        json_build_object('id', c.id, 'name', c.name, 'parentId', c."parentId") AS category,
        COALESCE(r."reviewCount", 0) AS "reviewCount",
        r."avgRating" AS "avgRating"
        ${relevanceSql}
      ${fromSql}
      ${whereSql}
      ORDER BY ${orderSql}
      LIMIT ${limitNum} OFFSET ${skip}
    `;

    const [countRow] = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS count
      ${fromSql}
      ${whereSql}
    `;

    res.json({
      products,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: countRow.count,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/sellers/:sellerId/products', async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: {
        sellerId: req.params.sellerId,
        state: { in: ['active', 'out_of_stock'] },
      },
      include: { category: true },
    });
    res.json(products);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/sellers/:sellerId/rating', async (req, res) => {
  try {
    const reviews = await prisma.review.findMany({
      where: { product: { sellerId: req.params.sellerId } },
      select: { rating: true },
    });

    if (reviews.length === 0) {
      return res.json({ averageRating: null, totalReviews: 0 });
    }

    const sum = reviews.reduce((total, r) => total + r.rating, 0);
    const averageRating = Math.round((sum / reviews.length) * 10) / 10;

    res.json({ averageRating, totalReviews: reviews.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/reviews/:id/response', requireAuth, requireSeller, async (req, res) => {
  try {
    const { sellerResponse } = req.body;

    if (!sellerResponse) {
      return res.status(400).json({ error: 'sellerResponse is required' });
    }

    const review = await prisma.review.findUnique({
      where: { id: req.params.id },
      include: { product: true },
    });

    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    if (review.product.sellerId !== req.userId) {
      return res.status(403).json({ error: 'You can only respond to reviews on your own products' });
    }

    const updatedReview = await prisma.review.update({
      where: { id: req.params.id },
      data: { sellerResponse },
    });

    res.json(updatedReview);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.delete('/api/admin/reviews/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const review = await prisma.review.findUnique({ where: { id: req.params.id } });

    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    await prisma.review.delete({ where: { id: req.params.id } });

    res.json({ message: 'Review removed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/cart', requireAuth, async (req, res) => {
  try {
    let cart = await prisma.cart.findUnique({
      where: { buyerId: req.userId },
      include: { items: { include: { product: { include: { seller: { select: { id: true, name: true } } } } } } },
    });

    if (!cart) {
      cart = await prisma.cart.create({
        data: { buyerId: req.userId },
        include: { items: { include: { product: true } } },
      });
    }

    res.json(cart);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/cart/items', requireAuth, async (req, res) => {
  try {
    const { productId, quantity } = req.body;

    if (!productId || !quantity || quantity < 1) {
      return res.status(400).json({ error: 'productId and a positive quantity are required' });
    }

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || product.state !== 'active') {
      return res.status(400).json({ error: 'Product not available' });
    }

    let cart = await prisma.cart.findUnique({ where: { buyerId: req.userId } });
    if (!cart) {
      cart = await prisma.cart.create({ data: { buyerId: req.userId } });
    }

    const existingItem = await prisma.cartItem.findFirst({
      where: { cartId: cart.id, productId },
    });

    let item;
    if (existingItem) {
      item = await prisma.cartItem.update({
        where: { id: existingItem.id },
        data: { quantity: existingItem.quantity + quantity },
      });
    } else {
      item = await prisma.cartItem.create({
        data: { cartId: cart.id, productId, quantity },
      });
    }

    res.status(201).json(item);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/cart/items/:id', requireAuth, async (req, res) => {
  try {
    const { quantity } = req.body;

    if (!quantity || quantity < 1) {
      return res.status(400).json({ error: 'A positive quantity is required' });
    }

    const item = await prisma.cartItem.findUnique({
      where: { id: req.params.id },
      include: { cart: true },
    });

    if (!item || item.cart.buyerId !== req.userId) {
      return res.status(404).json({ error: 'Cart item not found' });
    }

    const updated = await prisma.cartItem.update({
      where: { id: req.params.id },
      data: { quantity },
    });

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.delete('/api/cart/items/:id', requireAuth, async (req, res) => {
  try {
    const item = await prisma.cartItem.findUnique({
      where: { id: req.params.id },
      include: { cart: true },
    });

    if (!item || item.cart.buyerId !== req.userId) {
      return res.status(404).json({ error: 'Cart item not found' });
    }

    await prisma.cartItem.delete({ where: { id: req.params.id } });

    res.json({ message: 'Item removed' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/checkout', requireAuth, async (req, res) => {
  try {
    const { deliveryAddress } = req.body;

    if (!deliveryAddress) {
      return res.status(400).json({ error: 'deliveryAddress is required' });
    }

    const cart = await prisma.cart.findUnique({
      where: { buyerId: req.userId },
      include: { items: { include: { product: true } } },
    });

    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    // Re-check every item is still valid before touching anything
    for (const item of cart.items) {
      if (item.product.state !== 'active') {
        return res.status(400).json({ error: `${item.product.name} is no longer available` });
      }
      if (item.product.stock < item.quantity) {
        return res.status(400).json({ error: `Not enough stock for ${item.product.name}` });
      }
    }

    // Group cart items by seller
    const itemsBySeller = {};
    for (const item of cart.items) {
      const sellerId = item.product.sellerId;
      if (!itemsBySeller[sellerId]) itemsBySeller[sellerId] = [];
      itemsBySeller[sellerId].push(item);
    }

    const createdOrders = [];

    for (const sellerId of Object.keys(itemsBySeller)) {
      const sellerItems = itemsBySeller[sellerId];

            // Check stock is sufficient (actual decrement happens on payment confirmation, not here)
      for (const item of sellerItems) {
        if (item.product.stock < item.quantity) {
          return res.status(409).json({ error: `${item.product.name} just went out of stock. Please update your cart.` });
        }
      }

      const subtotal = sellerItems.reduce((sum, item) => {
        const price = item.product.salePrice || item.product.price;
        return sum + price * item.quantity;
      }, 0);

      const order = await prisma.order.create({
        data: {
          buyerId: req.userId,
          sellerId,
          deliveryAddress,
          subtotal,
          status: 'payment_pending',
          items: {
            create: sellerItems.map((item) => ({
              productId: item.productId,
              quantity: item.quantity,
              price: item.product.salePrice || item.product.price,
            })),
          },
        },
        include: { items: true },
      });

      createdOrders.push(order);
    }

    // Clear the cart now that orders are created
    await prisma.cartItem.deleteMany({ where: { cartId: cart.id } });

    res.status(201).json({ message: 'Orders created', orders: createdOrders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: { buyerId: req.userId },
      include: { items: { include: { product: { select: { name: true, images: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/orders/:id/create-payment', requireAuth, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });

    if (!order || order.buyerId !== req.userId) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'payment_pending') {
      return res.status(400).json({ error: 'This order is not awaiting payment' });
    }

    const razorpayOrder = await razorpay.orders.create({
      amount: Math.round(order.subtotal * 100),
      currency: 'INR',
      receipt: order.id,
    });

    res.json({
      razorpayOrderId: razorpayOrder.id,
      amount: razorpayOrder.amount,
      currency: razorpayOrder.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/seller/orders', requireAuth, requireSeller, async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: { sellerId: req.userId },
      include: { items: { include: { product: { select: { name: true, images: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/admin/orders', requireAuth, requireAdmin, async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      include: {
        buyer: { select: { id: true, name: true, email: true } },
        seller: { select: { id: true, name: true, email: true } },
        items: { include: { product: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/products/:id/reviews', requireAuth, async (req, res) => {
  try {
    const { orderId, rating, comment } = req.body;
    const productId = req.params.id;

    if (!orderId || !rating || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'orderId and a rating between 1 and 5 are required' });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order || order.buyerId !== req.userId) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'delivered') {
      return res.status(400).json({ error: 'You can only review products from delivered orders' });
    }

    const productInOrder = order.items.some((item) => item.productId === productId);
    if (!productInOrder) {
      return res.status(400).json({ error: 'This product was not part of that order' });
    }

    const review = await prisma.review.create({
      data: {
        productId,
        orderId,
        buyerId: req.userId,
        rating,
        comment: comment || null,
      },
    });

      await notify(
      order.sellerId,
      'reviews',
      'New review received',
      `A buyer left a ${rating}-star review on one of your products.`
    );

    res.status(201).json(review);
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'You have already reviewed this product for this order' });
    }
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/orders/:id/confirm-payment', requireAuth, async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });

    if (!order || order.buyerId !== req.userId) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'payment_pending') {
      return res.status(400).json({ error: 'This order is not awaiting payment' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

      console.log('EXPECTED:', expectedSignature);
      console.log('RECEIVED:', razorpay_signature);

    if (expectedSignature !== razorpay_signature) {
      await prisma.transaction.create({
        data: { orderId: order.id, type: 'payment_failed', amount: order.subtotal },
      });
      return res.status(400).json({ error: 'Payment verification failed' });
    }

        for (const item of order.items) {
      const success = await decrementStock(item.productId, item.quantity);
      if (!success) {
        return res.status(409).json({
          error: `Payment verified, but ${item.productId} is now out of stock. Please contact support for a refund.`,
        });
      }
    }

    const feePercent = parseFloat(process.env.PLATFORM_FEE_PERCENT) / 100;
    const platformFee = Math.round(order.subtotal * feePercent * 100) / 100;
    const payoutAmount = Math.round((order.subtotal - platformFee) * 100) / 100;

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'confirmed',
        platformFee,
        payoutAmount,
      },
    });

    await prisma.transaction.createMany({
      data: [
        { orderId: order.id, type: 'payment', amount: order.subtotal },
        { orderId: order.id, type: 'platform_fee', amount: platformFee },
        { orderId: order.id, type: 'payout', amount: payoutAmount },
      ],
    });

        await notify(
      order.buyerId,
      'orders',
      'Order confirmed',
      `Your payment of ₹${order.subtotal} was received and your order is confirmed.`
    );
    await notify(
      order.sellerId,
      'orders',
      'New order received',
      `You have a new paid order worth ₹${order.subtotal}. Please start preparing it.`
    );

    res.json({ message: 'Payment confirmed', order: updatedOrder });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/orders/:id/request-refund', requireAuth, async (req, res) => {
  try {
    const { reason } = req.body;

    const order = await prisma.order.findUnique({ where: { id: req.params.id } });

    if (!order || order.buyerId !== req.userId) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'delivered') {
      return res.status(400).json({ error: 'Only delivered orders can be refunded' });
    }

    const RETURN_WINDOW_DAYS = 7;
    const deliveredDate = new Date(order.deliveredAt);
    const daysSinceDelivery = (Date.now() - deliveredDate.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceDelivery > RETURN_WINDOW_DAYS) {
      return res.status(400).json({ error: 'Return window has expired' });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: {
        status: 'refund_requested',
        refundRequestedAt: new Date(),
        refundReason: reason || null,
      },
    });

        await notify(
      order.sellerId,
      'refunds',
      'Refund requested',
      `A buyer requested a refund on order ${order.id.slice(0, 8)}.${reason ? ' Reason: ' + reason : ''} Please review it.`
    );

    res.json({ message: 'Refund requested', order: updatedOrder });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/orders/:id/approve-refund', requireAuth, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    const isOwningSeller = order.sellerId === req.userId;
    const isAdmin = user.isAdmin;

    if (!isOwningSeller && !isAdmin) {
      return res.status(403).json({ error: 'Not authorized to approve this refund' });
    }

    if (order.status !== 'refund_requested') {
      return res.status(400).json({ error: 'This order has no pending refund request' });
    }

    for (const item of order.items) {
      await prisma.product.update({
        where: { id: item.productId },
        data: { stock: { increment: item.quantity } },
      });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: { status: 'refunded' },
    });

      await prisma.transaction.createMany({
      data: [
        { orderId: order.id, type: 'refund', amount: -order.subtotal },
        { orderId: order.id, type: 'platform_fee', amount: 0 - (order.platformFee || 0) },
        { orderId: order.id, type: 'payout', amount: 0 - (order.payoutAmount || 0) },
      ],
    });

    await notify(order.buyerId, 'refunds', 'Refund approved', `Your refund of ₹${order.subtotal} for order ${order.id.slice(0, 8)} was approved.`);
    await notify(order.sellerId, 'refunds', 'Refund processed', `A refund on order ${order.id.slice(0, 8)} was approved and the stock has been restored.`);

    res.json({ message: 'Refund approved', order: updatedOrder });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/orders/:id/reject-refund', requireAuth, async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason) {
      return res.status(400).json({ error: 'A rejection reason is required' });
    }

    const order = await prisma.order.findUnique({ where: { id: req.params.id } });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    const isOwningSeller = order.sellerId === req.userId;

    if (!isOwningSeller && !user.isAdmin) {
      return res.status(403).json({ error: 'Not authorized to reject this refund' });
    }

    if (order.status !== 'refund_requested') {
      return res.status(400).json({ error: 'This order has no pending refund request' });
    }

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: { status: 'delivered', refundRejectionReason: reason },
    });

    await notify(
      order.buyerId,
      'refunds',
      'Refund request rejected',
      `Your refund request for order ${order.id.slice(0, 8)} was rejected. Reason: ${reason}`
    );
    await notify(
      order.sellerId,
      'refunds',
      'Refund rejected',
      `The refund request on order ${order.id.slice(0, 8)} was rejected.`
    );

    res.json({ message: 'Refund rejected', order: updatedOrder });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/orders/:id/status', requireAuth, async (req, res) => {
  try {
    const { status, trackingInfo } = req.body;

    const order = await prisma.order.findUnique({ where: { id: req.params.id } });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    const isOwningSeller = order.sellerId === req.userId;
    const isAdmin = user.isAdmin;

    if (!isOwningSeller && !isAdmin) {
      return res.status(403).json({ error: 'Not authorized to update this order' });
    }

        const SETTABLE_HERE = ['processing', 'shipped', 'delivered'];
    if (!SETTABLE_HERE.includes(status)) {
      return res.status(400).json({
        error: `"${status}" cannot be set here. Use the dedicated cancel or refund endpoints instead.`,
      });
    }

    if (!canTransition(order.status, status)) {
      return res.status(400).json({
        error: `Cannot move order from "${order.status}" to "${status}"`,
      });
    }

    const data = { status };
    if (status === 'shipped' && trackingInfo) {
      data.trackingInfo = trackingInfo;
    }
    if (status === 'delivered') {
      data.deliveredAt = new Date();
    }

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data,
    });

        if (status === 'shipped') {
      await notify(
        order.buyerId,
        'orders',
        'Your order has shipped',
        `Your order is on its way.${trackingInfo ? ' Tracking: ' + trackingInfo : ''}`
      );
    }

    if (status === 'delivered') {
      await notify(
        order.buyerId,
        'orders',
        'Your order was delivered',
        'Your order has been delivered. We hope you love it! Please consider leaving a review.'
      );
    }

    res.json({ message: 'Order status updated', order: updatedOrder });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/orders/:id/cancel', requireAuth, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const isOwningBuyer = order.buyerId === req.userId;
    const isOwningSeller = order.sellerId === req.userId;

    if (!isOwningBuyer && !isOwningSeller) {
      return res.status(403).json({ error: 'Not authorized to cancel this order' });
    }

    if (!canTransition(order.status, 'cancelled')) {
      return res.status(400).json({
        error: `Cannot cancel an order that is already "${order.status}"`,
      });
    }

    if (order.status !== 'payment_pending') {
      for (const item of order.items) {
        await prisma.product.update({
          where: { id: item.productId },
          data: { stock: { increment: item.quantity } },
        });
      }
    }

    const updatedOrder = await prisma.order.update({
      where: { id: order.id },
      data: { status: 'cancelled' },
    });

    await notify(order.buyerId, 'orders', 'Order cancelled', `Order ${order.id.slice(0, 8)} has been cancelled.`);
    await notify(order.sellerId, 'orders', 'Order cancelled', `Order ${order.id.slice(0, 8)} for your store has been cancelled.`);

    if (order.status !== 'payment_pending') {
      await prisma.transaction.createMany({
        data: [
          { orderId: order.id, type: 'refund', amount: -order.subtotal },
          { orderId: order.id, type: 'platform_fee', amount: 0 - (order.platformFee || 0) },
          { orderId: order.id, type: 'payout', amount: 0 - (order.payoutAmount || 0) },
        ],
      });
    }
    res.json({ message: 'Order cancelled', order: updatedOrder });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/orders/:id/transactions', requireAuth, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });

    if (!order || (order.buyerId !== req.userId && order.sellerId !== req.userId)) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const transactions = await prisma.transaction.findMany({
      where: { orderId: req.params.id },
      orderBy: { createdAt: 'asc' },
    });

    res.json(transactions);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

const NOTIFICATION_CATEGORIES = ['account', 'orders', 'refunds', 'seller', 'reviews', 'security'];

app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const notifications = await prisma.notification.findMany({
      where: { userId: req.userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    res.json(notifications);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/notifications/unread-count', requireAuth, async (req, res) => {
  try {
    const count = await prisma.notification.count({
      where: { userId: req.userId, read: false },
    });
    res.json({ unread: count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/notifications/read-all', requireAuth, async (req, res) => {
  try {
    await prisma.notification.updateMany({
      where: { userId: req.userId, read: false },
      data: { read: true },
    });
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/notifications/:id/read', requireAuth, async (req, res) => {
  try {
    const notification = await prisma.notification.findUnique({ where: { id: req.params.id } });

    if (!notification || notification.userId !== req.userId) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    const updated = await prisma.notification.update({
      where: { id: req.params.id },
      data: { read: true },
    });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/notification-preferences', requireAuth, async (req, res) => {
  try {
    const saved = await prisma.notificationPreference.findMany({ where: { userId: req.userId } });

    const preferences = NOTIFICATION_CATEGORIES.map((category) => {
      const pref = saved.find((p) => p.category === category);
      return {
        category,
        email: pref ? pref.email : true,
        inApp: pref ? pref.inApp : true,
      };
    });

    res.json(preferences);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/notification-preferences', requireAuth, async (req, res) => {
  try {
    const { category, email, inApp } = req.body;

    if (!NOTIFICATION_CATEGORIES.includes(category)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    if (category === 'security' && email === false) {
      return res.status(400).json({ error: 'Security emails cannot be turned off' });
    }

    const data = {};
    if (typeof email === 'boolean') data.email = email;
    if (typeof inApp === 'boolean') data.inApp = inApp;

    const pref = await prisma.notificationPreference.upsert({
      where: { userId_category: { userId: req.userId, category } },
      update: data,
      create: { userId: req.userId, category, ...data },
    });

    res.json(pref);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

const PAID_KEPT_STATUSES = ['confirmed', 'processing', 'shipped', 'delivered', 'refund_requested'];
const FULFILLED_STATUSES = ['shipped', 'delivered', 'refund_requested', 'refunded'];
const PERIOD_UNITS = { day: 'day', week: 'week', month: 'month' };

const ANALYTICS_CACHE_TTL_MS = 5 * 60 * 1000;
const ANALYTICS_CACHE_MAX = 500;
const analyticsCacheStore = new Map();

function analyticsCache(req, res, next) {
  const key = `${req.userId}:${req.originalUrl}`;
  const hit = analyticsCacheStore.get(key);

  if (hit && hit.expires > Date.now()) {
    res.set('X-Cache', 'HIT');
    return res.status(200).json(hit.body);
  }

  res.set('X-Cache', 'MISS');
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 200) {
      if (analyticsCacheStore.size >= ANALYTICS_CACHE_MAX) {
        analyticsCacheStore.delete(analyticsCacheStore.keys().next().value);
      }
      analyticsCacheStore.set(key, { body, expires: Date.now() + ANALYTICS_CACHE_TTL_MS });
    }
    return originalJson(body);
  };
  next();
}

function ratio(part, whole) {
  return whole === 0 ? null : Math.round((part / whole) * 1000) / 10;
}

app.get('/api/seller/analytics/overview', requireAuth, requireSeller, analyticsCache, async (req, res) => {
  try {
    const [row] = await prisma.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE status <> 'payment_pending')::int AS placed,
        COUNT(*) FILTER (WHERE status IN (${Prisma.join(FULFILLED_STATUSES)}))::int AS fulfilled,
        COUNT(*) FILTER (WHERE "deliveredAt" IS NOT NULL)::int AS delivered,
        COUNT(*) FILTER (WHERE "deliveredAt" IS NOT NULL AND "refundRequestedAt" IS NOT NULL)::int AS returned,
        COALESCE(ROUND((SUM(subtotal) FILTER (WHERE status IN (${Prisma.join(PAID_KEPT_STATUSES)})))::numeric, 2), 0)::float8 AS revenue,
        COALESCE(ROUND((SUM("payoutAmount") FILTER (WHERE status IN (${Prisma.join(PAID_KEPT_STATUSES)})))::numeric, 2), 0)::float8 AS payouts
      FROM "Order"
      WHERE "sellerId" = ${req.userId}
    `;

    res.json({
      revenue: row.revenue,
      payouts: row.payouts,
      ordersPlaced: row.placed,
      fulfilmentRatePercent: ratio(row.fulfilled, row.placed),
      returnRatePercent: ratio(row.returned, row.delivered),
      deliveredOrders: row.delivered,
      returnRequests: row.returned,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/seller/analytics/revenue', requireAuth, requireSeller, analyticsCache, async (req, res) => {
  try {
    const unit = Object.hasOwn(PERIOD_UNITS, req.query.period) ? PERIOD_UNITS[req.query.period] : 'day';
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);

    const rows = await prisma.$queryRaw`
      SELECT
        date_trunc(${Prisma.raw(`'${unit}'`)}, "createdAt") AS period,
        COUNT(*)::int AS orders,
        COALESCE(ROUND(SUM(subtotal)::numeric, 2), 0)::float8 AS revenue
      FROM "Order"
      WHERE "sellerId" = ${req.userId}
        AND status IN (${Prisma.join(PAID_KEPT_STATUSES)})
        AND "createdAt" >= (NOW() AT TIME ZONE 'UTC') - (${days}::int * INTERVAL '1 day')
      GROUP BY 1
      ORDER BY 1
    `;

    res.json({ period: unit, days, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/seller/analytics/top-products', requireAuth, requireSeller, analyticsCache, async (req, res) => {
  try {
    const sortBy = req.query.sort === 'units' ? 'units' : 'revenue';
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 5, 1), 50);

    const rows = await prisma.$queryRaw`
      SELECT
        p.id AS "productId",
        p.name,
        SUM(oi.quantity)::int AS units,
        COALESCE(ROUND(SUM(oi.price * oi.quantity)::numeric, 2), 0)::float8 AS revenue
      FROM "OrderItem" oi
      JOIN "Order" o ON o.id = oi."orderId"
      JOIN "Product" p ON p.id = oi."productId"
      WHERE o."sellerId" = ${req.userId}
        AND o.status IN (${Prisma.join(PAID_KEPT_STATUSES)})
      GROUP BY p.id, p.name
      ORDER BY ${Prisma.raw(sortBy)} DESC, p.name ASC
      LIMIT ${limit}
    `;

    res.json({ sortedBy: sortBy, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/admin/analytics/overview', requireAuth, requireAdmin, analyticsCache, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);

    const [orders] = await prisma.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE status <> 'payment_pending')::int AS placed,
        COUNT(*) FILTER (WHERE status IN (${Prisma.join(FULFILLED_STATUSES)}))::int AS shipped,
        COUNT(*) FILTER (WHERE "deliveredAt" IS NOT NULL)::int AS delivered,
        COUNT(*) FILTER (WHERE "deliveredAt" IS NOT NULL AND "refundRequestedAt" IS NOT NULL)::int AS returned,
        COALESCE(ROUND((SUM(subtotal) FILTER (WHERE status IN (${Prisma.join(PAID_KEPT_STATUSES)})))::numeric, 2), 0)::float8 AS gmv,
        COALESCE(ROUND((SUM("platformFee") FILTER (WHERE status IN (${Prisma.join(PAID_KEPT_STATUSES)})))::numeric, 2), 0)::float8 AS "platformFees"
      FROM "Order"
    `;

    const [pay] = await prisma.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE type = 'payment')::int AS succeeded,
        COUNT(*) FILTER (WHERE type = 'payment_failed')::int AS failed
      FROM "Transaction"
    `;

    const [active] = await prisma.$queryRaw`
      SELECT
        COUNT(DISTINCT "buyerId")::int AS buyers,
        COUNT(DISTINCT "sellerId")::int AS sellers
      FROM "Order"
      WHERE status <> 'payment_pending'
        AND "createdAt" >= (NOW() AT TIME ZONE 'UTC') - (${days}::int * INTERVAL '1 day')
    `;

    res.json({
      gmv: orders.gmv,
      platformFeeRevenue: orders.platformFees,
      funnel: {
        placed: orders.placed,
        shipped: orders.shipped,
        delivered: orders.delivered,
        returned: orders.returned,
      },
      failedPaymentRatePercent: ratio(pay.failed, pay.succeeded + pay.failed),
      paymentsSucceeded: pay.succeeded,
      paymentsFailed: pay.failed,
      active: { days, buyers: active.buyers, sellers: active.sellers },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/admin/analytics/top-sellers', requireAuth, requireAdmin, analyticsCache, async (req, res) => {
  try {
    const sortBy = req.query.sort === 'orders' ? 'orders' : 'revenue';
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 5, 1), 50);

    const rows = await prisma.$queryRaw`
      SELECT
        u.id AS "sellerId",
        u.name,
        COUNT(*)::int AS orders,
        COALESCE(ROUND(SUM(o.subtotal)::numeric, 2), 0)::float8 AS revenue,
        COALESCE(ROUND(SUM(o."platformFee")::numeric, 2), 0)::float8 AS "platformFees"
      FROM "Order" o
      JOIN "User" u ON u.id = o."sellerId"
      WHERE o.status IN (${Prisma.join(PAID_KEPT_STATUSES)})
      GROUP BY u.id, u.name
      ORDER BY ${Prisma.raw(sortBy)} DESC, u.name ASC
      LIMIT ${limit}
    `;

    res.json({ sortedBy: sortBy, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/admin/analytics/top-categories', requireAuth, requireAdmin, analyticsCache, async (req, res) => {
  try {
    const sortBy = req.query.sort === 'units' ? 'units' : 'revenue';
    const limit = Math.min(Math.max(parseInt(req.query.limit) || 5, 1), 50);

    const rows = await prisma.$queryRaw`
      SELECT
        c.id AS "categoryId",
        c.name,
        pc.name AS "parentName",
        SUM(oi.quantity)::int AS units,
        COALESCE(ROUND(SUM(oi.price * oi.quantity)::numeric, 2), 0)::float8 AS revenue
      FROM "OrderItem" oi
      JOIN "Order" o ON o.id = oi."orderId"
      JOIN "Product" p ON p.id = oi."productId"
      JOIN "Category" c ON c.id = p."categoryId"
      LEFT JOIN "Category" pc ON pc.id = c."parentId"
      WHERE o.status IN (${Prisma.join(PAID_KEPT_STATUSES)})
      GROUP BY c.id, c.name, pc.name
      ORDER BY ${Prisma.raw(sortBy)} DESC, c.name ASC
      LIMIT ${limit}
    `;

    res.json({ sortedBy: sortBy, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/admin/analytics/active-users', requireAuth, requireAdmin, analyticsCache, async (req, res) => {
  try {
    const unit = Object.hasOwn(PERIOD_UNITS, req.query.period) ? PERIOD_UNITS[req.query.period] : 'day';
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 365);

    const rows = await prisma.$queryRaw`
      SELECT
        date_trunc(${Prisma.raw(`'${unit}'`)}, "createdAt") AS period,
        COUNT(DISTINCT "buyerId")::int AS buyers,
        COUNT(DISTINCT "sellerId")::int AS sellers
      FROM "Order"
      WHERE status <> 'payment_pending'
        AND "createdAt" >= (NOW() AT TIME ZONE 'UTC') - (${days}::int * INTERVAL '1 day')
      GROUP BY 1
      ORDER BY 1
    `;

    res.json({ period: unit, days, data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/categories', async (req, res) => {
  try {
    const all = await prisma.category.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, parentId: true },
    });

    const byParent = new Map();
    for (const c of all) {
      if (!byParent.has(c.parentId)) byParent.set(c.parentId, []);
      byParent.get(c.parentId).push(c);
    }

    const build = (parentId) =>
      (byParent.get(parentId) || []).map((c) => ({ id: c.id, name: c.name, children: build(c.id) }));

    res.json({ categories: build(null) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/admin/categories', requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const parentId = body.parentId ? String(body.parentId) : null;

    if (name.length < 1 || name.length > 60) {
      return res.status(400).json({ error: 'Name must be 1 to 60 characters' });
    }

    if (parentId) {
      const parent = await prisma.category.findUnique({ where: { id: parentId } });
      if (!parent) return res.status(400).json({ error: 'Parent category not found' });
    }

    const duplicate = await prisma.category.findFirst({
      where: { name: { equals: name, mode: 'insensitive' }, parentId },
    });
    if (duplicate) {
      return res.status(409).json({ error: 'A category with this name already exists here' });
    }

    const category = await prisma.category.create({ data: { name, parentId } });
    res.status(201).json(category);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/admin/categories/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const category = await prisma.category.findUnique({ where: { id: req.params.id } });
    if (!category) return res.status(404).json({ error: 'Category not found' });

    const data = {};

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name.length < 1 || name.length > 60) {
        return res.status(400).json({ error: 'Name must be 1 to 60 characters' });
      }
      data.name = name;
    }

    if (body.parentId !== undefined) {
      const newParentId = body.parentId ? String(body.parentId) : null;

      if (newParentId) {
        const all = await prisma.category.findMany({ select: { id: true, parentId: true } });
        if (!all.some((c) => c.id === newParentId)) {
          return res.status(400).json({ error: 'Parent category not found' });
        }

        const blocked = new Set([category.id]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const c of all) {
            if (c.parentId && blocked.has(c.parentId) && !blocked.has(c.id)) {
              blocked.add(c.id);
              grew = true;
            }
          }
        }
        if (blocked.has(newParentId)) {
          return res.status(400).json({ error: 'A category cannot be moved under itself or its own subcategory' });
        }
      }
      data.parentId = newParentId;
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const finalName = data.name !== undefined ? data.name : category.name;
    const finalParentId = data.parentId !== undefined ? data.parentId : category.parentId;

    const duplicate = await prisma.category.findFirst({
      where: {
        name: { equals: finalName, mode: 'insensitive' },
        parentId: finalParentId,
        NOT: { id: category.id },
      },
    });
    if (duplicate) {
      return res.status(409).json({ error: 'A category with this name already exists here' });
    }

    const updated = await prisma.category.update({ where: { id: category.id }, data });
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.delete('/api/admin/categories/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const category = await prisma.category.findUnique({
      where: { id: req.params.id },
      include: { _count: { select: { children: true, products: true } } },
    });
    if (!category) return res.status(404).json({ error: 'Category not found' });

    if (category._count.children > 0) {
      return res.status(409).json({ error: 'Move or delete its subcategories first' });
    }
    if (category._count.products > 0) {
      return res.status(409).json({ error: 'Move its products to another category first' });
    }

    await prisma.category.delete({ where: { id: category.id } });
    res.json({ message: 'Category deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

const PRODUCT_STATES = ['draft', 'active', 'out_of_stock', 'archived', 'removed'];

app.get('/api/admin/products', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { state, seller, q } = req.query;
    const pageNum = Math.max(parseInt(req.query.page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);

    const where = {};
    if (typeof state === 'string' && PRODUCT_STATES.includes(state)) where.state = state;
    if (typeof seller === 'string' && seller) where.sellerId = seller;
    if (typeof q === 'string' && q.trim()) where.name = { contains: q.trim(), mode: 'insensitive' };

    const [products, total] = await Promise.all([
      prisma.product.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
        include: {
          category: true,
          seller: { select: { id: true, name: true, email: true } },
        },
      }),
      prisma.product.count({ where }),
    ]);

    res.json({ products, pagination: { page: pageNum, limit: limitNum, total } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/admin/products/:id/remove', requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 5 || reason.length > 500) {
      return res.status(400).json({ error: 'A reason of 5 to 500 characters is required' });
    }

    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (product.state === 'removed') {
      return res.status(409).json({ error: 'Product is already removed' });
    }

    const updated = await prisma.product.update({
      where: { id: product.id },
      data: { state: 'removed', moderationReason: reason, moderatedAt: new Date() },
    });

    await notify(
      product.sellerId,
      'seller',
      'Product removed',
      `Your product "${product.name}" was removed by an admin. Reason: ${reason}`
    );

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/admin/products/:id/restore', requireAuth, requireAdmin, async (req, res) => {
  try {
    const product = await prisma.product.findUnique({ where: { id: req.params.id } });
    if (!product) return res.status(404).json({ error: 'Product not found' });
    if (product.state !== 'removed') {
      return res.status(409).json({ error: 'Product is not removed' });
    }

    const updated = await prisma.product.update({
      where: { id: product.id },
      data: { state: 'draft', moderationReason: null, moderatedAt: null },
    });

    await notify(
      product.sellerId,
      'seller',
      'Product restored',
      `Your product "${product.name}" was restored as a draft. You can review it and publish it again.`
    );

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
