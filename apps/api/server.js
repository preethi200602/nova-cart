const express = require('express');
require('dotenv').config({ quiet: true });
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
const { validate } = require('./validate');
const schemas = require('./schemas');
const { hashToken, appUrl } = require('./tokens');
const { signAccessToken, issueRefreshToken, rotateRefreshToken, revokeAllRefreshTokens } = require('./sessions');

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const app = express();
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const pino = require('pino');
const pinoHttp = require('pino-http');
const { randomUUID } = require('crypto');

const isProduction = process.env.NODE_ENV === 'production';
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    censor: '[hidden]',
  },
  ...(isProduction || process.env.NODE_ENV === 'test' ? {} : { transport: { target: 'pino-pretty' } }),
});

app.use(
  pinoHttp({
    logger,
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const id =
        typeof incoming === 'string' && incoming.length > 0 && incoming.length <= 100 ? incoming : randomUUID();
      res.setHeader('X-Request-Id', id);
      return id;
    },
    autoLogging: { ignore: (req) => req.url === '/health' },
  })
);

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : false);

const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:3000,http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
  cors({
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.includes(origin)),
    credentials: true,
  })
);
app.use(express.json({ limit: '100kb' }));

const limiterMessage = { error: 'Too many requests, please try again later' };
const makeLimiter = (options) =>
  rateLimit({
    windowMs: 15 * 60 * 1000,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: limiterMessage,
    ...options,
  });

app.use('/api', makeLimiter({ limit: Number(process.env.GENERAL_RATE_LIMIT) || 1000 }));
app.use('/api/auth/login', makeLimiter({ limit: Number(process.env.LOGIN_RATE_LIMIT) || 10, skipSuccessfulRequests: true }));
app.use('/api/auth/refresh', makeLimiter({ limit: Number(process.env.REFRESH_RATE_LIMIT) || 30 }));
app.use(
  [
    '/api/auth/register',
    '/api/auth/forgot-password',
    '/api/auth/reset-password',
    '/api/auth/resend-verification',
    '/api/auth/verify-email',
  ],
  makeLimiter({ limit: Number(process.env.ACCOUNT_RATE_LIMIT) || 10 })
);
app.use(['/api/orders/:id/create-payment', '/api/orders/:id/confirm-payment'], makeLimiter({ limit: Number(process.env.PAYMENT_RATE_LIMIT) || 30 }));

const prisma = new PrismaClient();

const RETURN_WINDOW_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;

function payoutEligibleAt(order) {
  return order.deliveredAt ? new Date(new Date(order.deliveredAt).getTime() + RETURN_WINDOW_DAYS * DAY_MS) : null;
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


const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ]);

app.get('/health', async (req, res) => {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 2000);
    res.json({ status: 'ok', database: 'up', uptimeSeconds: Math.round(process.uptime()) });
  } catch (err) {
    req.log.error(err);
    res.status(503).json({ status: 'degraded', database: 'down' });
  }
});

app.post('/api/auth/register', validate(schemas.registerSchema), async (req, res) => {
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
      data: { email, password: hashedPassword, name, verificationToken: hashToken(verificationToken), verificationTokenExpiry },
    });

    notify(
      user.id,
      'security',
      'Verify your email address',
      `Welcome to Nova-Cart! Please verify your email to activate your account (link valid for 24 hours): ${appUrl()}/verify-email?token=${verificationToken}`,
      { emailOnly: true }
    );

    res.status(201).json({
      id: user.id,
      email: user.email,
      name: user.name,
      message: 'Account created. Please check your email to verify your address.',
    });
  
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/auth/login', validate(schemas.loginSchema), async (req, res) => {
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

    const token = signAccessToken(user);
    const refreshToken = await issueRefreshToken(prisma, user.id);

    res.json({ token, refreshToken });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/auth/refresh', validate(schemas.refreshSchema), async (req, res) => {
  try {
    const result = await rotateRefreshToken(prisma, req.body.refreshToken);
    if (result.error) {
      return res.status(401).json({ error: result.error });
    }

    const user = await prisma.user.findUnique({ where: { id: result.userId } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    res.json({ token: signAccessToken(user), refreshToken: result.token });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/auth/logout', validate(schemas.refreshSchema), async (req, res) => {
  try {
    await prisma.refreshToken.updateMany({
      where: { tokenHash: hashToken(req.body.refreshToken), revokedAt: null },
      data: { revokedAt: new Date() },
    });
    res.json({ message: 'Logged out' });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

function cleanPhone(value) {
  const phone = typeof value === 'string' ? value.replace(/[\s-]/g, '') : '';
  return /^\+?[0-9]{7,15}$/.test(phone) ? phone : null;
}

function profileView(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    emailVerified: user.emailVerified,
    isSeller: user.isSeller,
    isAdmin: user.isAdmin,
  };
}

app.get('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(profileView(user));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/auth/me', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const data = {};

    if (body.name !== undefined) {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name.length < 1 || name.length > 80) {
        return res.status(400).json({ error: 'Name must be 1 to 80 characters' });
      }
      data.name = name;
    }

    if (body.phone !== undefined) {
      if (body.phone === null || body.phone === '') {
        data.phone = null;
      } else {
        const phone = cleanPhone(body.phone);
        if (!phone) {
          return res.status(400).json({ error: 'Phone must be 7 to 15 digits, with an optional leading +' });
        }
        data.phone = phone;
      }
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const updatedUser = await prisma.user.update({ where: { id: req.userId }, data });

    res.json(profileView(updatedUser));
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/auth/forgot-password', validate(schemas.forgotPasswordSchema), async (req, res) => {
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
      data: { resetToken: hashToken(resetToken), resetTokenExpiry },
    });


        notify(
      user.id,
      'security',
      'Password reset requested',
      `Use this link to reset your password (valid for 15 minutes): ${appUrl()}/reset-password?token=${resetToken}`,
      { emailOnly: true }
    );

    res.json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/auth/verify-email', validate(schemas.verifyEmailSchema), async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }

    const user = await prisma.user.findFirst({
      where: {
        verificationToken: hashToken(token),
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
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/auth/resend-verification', validate(schemas.resendVerificationSchema), async (req, res) => {
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
        data: { verificationToken: hashToken(verificationToken), verificationTokenExpiry },
      });

      notify(
        user.id,
        'security',
        'Verify your email address',
        `Here is your new verification link (valid for 24 hours): ${appUrl()}/verify-email?token=${verificationToken}`,
        { emailOnly: true }
      );
    }

    res.json({ message: 'If that account exists and is unverified, a new link has been sent.' });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/auth/reset-password', validate(schemas.resetPasswordSchema), async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    const user = await prisma.user.findFirst({
      where: {
        resetToken: hashToken(token),
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

    await revokeAllRefreshTokens(prisma, user.id);

    res.json({ message: 'Password has been reset successfully.' });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});
app.post('/api/seller/apply', requireAuth, validate(schemas.sellerApplySchema), async (req, res) => {
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/seller/store', requireAuth, requireSeller, async (req, res) => {
  try {
    const store = await prisma.store.findUnique({ where: { userId: req.userId } });
    res.json(store);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/seller/store', requireAuth, requireSeller, validate(schemas.storeUpdateSchema), async (req, res) => {
  try {
    const { storeName, banner, description, policies } = req.body;

    const store = await prisma.store.update({
      where: { userId: req.userId },
      data: { storeName, banner, description, policies },
    });

    res.json(store);
  } catch (err) {
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/reviews/:id/response', requireAuth, requireSeller, validate(schemas.sellerResponseSchema), async (req, res) => {
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/cart/items', requireAuth, validate(schemas.addCartItemSchema), async (req, res) => {
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
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/cart/items/:id', requireAuth, validate(schemas.updateCartItemSchema), async (req, res) => {
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
    req.log.error(err);
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
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

const round2 = (n) => Math.round(n * 100) / 100;

function formatAddress(a) {
  return (
    [a.fullName, a.line1, a.line2, a.city, `${a.state} ${a.postalCode}`, a.country].filter(Boolean).join(', ') +
    `. Phone: ${a.phone}`
  );
}

async function resolveDeliveryAddress(userId, body) {
  if (body.addressId !== undefined && body.addressId !== null) {
    const address =
      typeof body.addressId === 'string'
        ? await prisma.address.findFirst({ where: { id: body.addressId, userId } })
        : null;
    if (!address) return { error: 'Saved address not found' };
    return { text: formatAddress(address), addressId: address.id };
  }

  if (body.deliveryAddress !== undefined && body.deliveryAddress !== null) {
    const text = typeof body.deliveryAddress === 'string' ? body.deliveryAddress.trim() : '';
    if (text.length < 5 || text.length > 500) {
      return { error: 'deliveryAddress must be 5 to 500 characters' };
    }
    return { text };
  }

  const fallback = await prisma.address.findFirst({ where: { userId, isDefault: true } });
  if (fallback) return { text: formatAddress(fallback), addressId: fallback.id };

  return { error: 'Provide addressId or deliveryAddress, or save a default address' };
}

function buildCartSummary(items) {
  const issues = [];
  const groups = new Map();

  for (const item of items) {
    const p = item.product;

    if (p.state !== 'active') {
      issues.push({ productId: p.id, name: p.name, problem: 'unavailable' });
    } else if (p.stock < item.quantity) {
      issues.push({
        productId: p.id,
        name: p.name,
        problem: 'insufficient_stock',
        available: p.stock,
        requested: item.quantity,
      });
    }

    if (!groups.has(p.sellerId)) {
      groups.set(p.sellerId, {
        sellerId: p.sellerId,
        sellerName: p.seller ? p.seller.name : null,
        items: [],
        subtotal: 0,
      });
    }

    const unitPrice = p.salePrice || p.price;
    const lineTotal = round2(unitPrice * item.quantity);
    const group = groups.get(p.sellerId);
    group.items.push({
      productId: p.id,
      name: p.name,
      image: (p.images && p.images[0]) || null,
      quantity: item.quantity,
      unitPrice,
      lineTotal,
    });
    group.subtotal = round2(group.subtotal + lineTotal);
  }

  const sellers = [...groups.values()];
  const total = round2(sellers.reduce((sum, g) => sum + g.subtotal, 0));

  return { sellers, total, issues };
}

app.post('/api/checkout/preview', requireAuth, async (req, res) => {
  try {
    const cart = await prisma.cart.findUnique({
      where: { buyerId: req.userId },
      include: {
        items: { include: { product: { include: { seller: { select: { id: true, name: true } } } } } },
      },
    });

    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const summary = buildCartSummary(cart.items);
    const address = await resolveDeliveryAddress(req.userId, req.body || {});

    res.json({
      sellers: summary.sellers,
      total: summary.total,
      orderCount: summary.sellers.length,
      deliveryAddress: address.text || null,
      addressProblem: address.error || null,
      issues: summary.issues,
      canCheckout: summary.issues.length === 0 && !!address.text,
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/checkout', requireAuth, async (req, res) => {
  try {
    const address = await resolveDeliveryAddress(req.userId, req.body || {});
    if (address.error) {
      return res.status(400).json({ error: address.error });
    }

    const cart = await prisma.cart.findUnique({
      where: { buyerId: req.userId },
      include: { items: { include: { product: true } } },
    });

    if (!cart || cart.items.length === 0) {
      return res.status(400).json({ error: 'Cart is empty' });
    }

    const summary = buildCartSummary(cart.items);
    if (summary.issues.length > 0) {
      const first = summary.issues[0];
      const message =
        first.problem === 'unavailable'
          ? `${first.name} is no longer available`
          : `Not enough stock for ${first.name}`;
      return res.status(400).json({ error: message });
    }

    // Stock is decremented on payment confirmation, not here.
    // All orders and the cart clear happen together or not at all.
    const createdOrders = await prisma.$transaction(async (tx) => {
      const orders = [];

      for (const group of summary.sellers) {
        const order = await tx.order.create({
          data: {
            buyerId: req.userId,
            sellerId: group.sellerId,
            deliveryAddress: address.text,
            subtotal: group.subtotal,
            status: 'payment_pending',
            items: {
              create: group.items.map((item) => ({
                productId: item.productId,
                quantity: item.quantity,
                price: item.unitPrice,
              })),
            },
          },
          include: { items: true },
        });
        orders.push(order);
      }

      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      return orders;
    });

    res.status(201).json({ message: 'Orders created', orders: createdOrders });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/orders', requireAuth, async (req, res) => {
  try {
    const orders = await prisma.order.findMany({
      where: { buyerId: req.userId },
      omit: {
        platformFee: true,
        payoutAmount: true,
        payoutStatus: true,
        payoutPaidAt: true,
        payoutReference: true,
        razorpayOrderId: true,
        razorpayPaymentId: true,
      },
      include: { items: { include: { product: { select: { name: true, images: true } } } } },
      orderBy: { createdAt: 'desc' },
    });
    res.json(orders);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

function forBuyer(order) {
  const {
    platformFee,
    payoutAmount,
    payoutStatus,
    payoutPaidAt,
    payoutReference,
    razorpayOrderId,
    razorpayPaymentId,
    ...rest
  } = order;
  return rest;
}

function signaturesMatch(expected, received) {
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/api/orders/:id/create-payment', requireAuth, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });

    if (!order || order.buyerId !== req.userId) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'payment_pending') {
      return res.status(400).json({ error: 'This order is not awaiting payment' });
    }

    const amount = Math.round(order.subtotal * 100);
    let razorpayOrderId = order.razorpayOrderId;

    // One Razorpay order per order: reuse it if it was already created.
    if (!razorpayOrderId) {
      const razorpayOrder = await razorpay.orders.create({
        amount,
        currency: 'INR',
        receipt: order.id,
      });

      await prisma.order.updateMany({
        where: { id: order.id, razorpayOrderId: null },
        data: { razorpayOrderId: razorpayOrder.id },
      });

      const fresh = await prisma.order.findUnique({
        where: { id: order.id },
        select: { razorpayOrderId: true },
      });
      razorpayOrderId = fresh.razorpayOrderId;
    }

    res.json({
      razorpayOrderId,
      amount,
      currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/products/:id/reviews', requireAuth, validate(schemas.reviewSchema), async (req, res) => {
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
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/orders/:id/confirm-payment', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;

    const fieldsOk = [razorpay_order_id, razorpay_payment_id, razorpay_signature].every(
      (v) => typeof v === 'string' && v.length > 0 && v.length <= 200
    );
    if (!fieldsOk) {
      return res
        .status(400)
        .json({ error: 'razorpay_order_id, razorpay_payment_id and razorpay_signature are required' });
    }

    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { items: true },
    });

    if (!order || order.buyerId !== req.userId) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // A repeated request for a payment that already went through is safe.
    if (order.status === 'confirmed' && order.razorpayPaymentId === razorpay_payment_id) {
      return res.json({ message: 'Payment already confirmed', order: forBuyer(order) });
    }

    if (order.status !== 'payment_pending') {
      return res.status(400).json({ error: 'This order is not awaiting payment' });
    }

    // The payment must belong to this order's own Razorpay order.
    if (!order.razorpayOrderId || order.razorpayOrderId !== razorpay_order_id) {
      return res.status(400).json({ error: 'This payment does not belong to this order' });
    }

    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest('hex');

    if (!signaturesMatch(expectedSignature, razorpay_signature)) {
      await prisma.transaction.create({
        data: { orderId: order.id, type: 'payment_failed', amount: order.subtotal },
      });
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    const feePercent = parseFloat(process.env.PLATFORM_FEE_PERCENT) / 100;
    if (!Number.isFinite(feePercent)) {
      console.error('PLATFORM_FEE_PERCENT is missing or not a number');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    const platformFee = Math.round(order.subtotal * feePercent * 100) / 100;
    const payoutAmount = Math.round((order.subtotal - platformFee) * 100) / 100;

    let confirmedOrder = null;
    let outOfStock = false;

    try {
      // Claim the order, take the stock and write the ledger together, or do none of it.
      confirmedOrder = await prisma.$transaction(async (tx) => {
        const claimed = await tx.order.updateMany({
          where: { id: order.id, status: 'payment_pending' },
          data: {
            status: 'confirmed',
            platformFee,
            payoutAmount,
            razorpayPaymentId: razorpay_payment_id,
          },
        });
        if (claimed.count === 0) {
          const e = new Error('Order already processed');
          e.code = 'ALREADY_PROCESSED';
          throw e;
        }

        for (const item of order.items) {
          const taken = await tx.product.updateMany({
            where: { id: item.productId, stock: { gte: item.quantity } },
            data: { stock: { decrement: item.quantity } },
          });
          if (taken.count === 0) {
            const e = new Error('Out of stock');
            e.code = 'OUT_OF_STOCK';
            throw e;
          }
        }

        await tx.transaction.createMany({
          data: [
            { orderId: order.id, type: 'payment', amount: order.subtotal },
            { orderId: order.id, type: 'platform_fee', amount: platformFee },
            { orderId: order.id, type: 'payout', amount: payoutAmount },
          ],
        });

        return tx.order.findUnique({ where: { id: order.id }, include: { items: true } });
      });
    } catch (err) {
      if (err.code === 'ALREADY_PROCESSED') {
        return res.status(409).json({ error: 'This order is already being processed' });
      }
      if (err.code === 'P2002') {
        return res.status(409).json({ error: 'This payment was already used for another order' });
      }
      if (err.code !== 'OUT_OF_STOCK') throw err;
      outOfStock = true;
    }

    if (outOfStock) {
      // The money was taken but the goods are gone: cancel and record the refund owed.
      await prisma.$transaction(async (tx) => {
        const cancelled = await tx.order.updateMany({
          where: { id: order.id, status: 'payment_pending' },
          data: { status: 'cancelled', razorpayPaymentId: razorpay_payment_id },
        });
        if (cancelled.count === 1) {
          await tx.transaction.createMany({
            data: [
              { orderId: order.id, type: 'payment', amount: order.subtotal },
              { orderId: order.id, type: 'refund', amount: -order.subtotal },
            ],
          });
        }
      });

      await notify(
        order.buyerId,
        'refunds',
        'Order cancelled',
        `Your payment of ₹${order.subtotal} was received, but an item went out of stock. The order was cancelled and a refund is due.`
      );

      return res.status(409).json({
        error: 'Payment verified, but an item went out of stock. The order was cancelled and a refund is due.',
      });
    }

    for (const item of order.items) {
      await syncStockState(item.productId);
    }

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

    res.json({ message: 'Payment confirmed', order: forBuyer(confirmedOrder) });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/orders/:id/request-refund', requireAuth, validate(schemas.requestRefundSchema), async (req, res) => {
  try {
    const { reason } = req.body;

    const order = await prisma.order.findUnique({ where: { id: req.params.id } });

    if (!order || order.buyerId !== req.userId) {
      return res.status(404).json({ error: 'Order not found' });
    }

    if (order.status !== 'delivered') {
      return res.status(400).json({ error: 'Only delivered orders can be refunded' });
    }

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

    res.json({ message: 'Refund requested', order: forBuyer(updatedOrder) });
  } catch (err) {
    req.log.error(err);
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
      await syncStockState(item.productId, { notifySeller: false });
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
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/orders/:id/reject-refund', requireAuth, validate(schemas.rejectRefundSchema), async (req, res) => {
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
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/orders/:id/status', requireAuth, validate(schemas.orderStatusSchema), async (req, res) => {
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
    req.log.error(err);
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
        await syncStockState(item.productId, { notifySeller: false });
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
    res.json({
      message: 'Order cancelled',
      order: isOwningBuyer && !isOwningSeller ? forBuyer(updatedOrder) : updatedOrder,
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/orders/:id/transactions', requireAuth, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    const viewer = await prisma.user.findUnique({ where: { id: req.userId }, select: { isAdmin: true } });
    const isAdmin = !!(viewer && viewer.isAdmin);

    if (!order || (order.buyerId !== req.userId && order.sellerId !== req.userId && !isAdmin)) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const sellerSide = isAdmin || order.sellerId === req.userId;

    const transactions = await prisma.transaction.findMany({
      where: {
        orderId: req.params.id,
        ...(sellerSide ? {} : { type: { in: ['payment', 'payment_failed', 'refund'] } }),
      },
      orderBy: { createdAt: 'asc' },
    });

    res.json(transactions);
  } catch (err) {
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/notification-preferences', requireAuth, validate(schemas.notificationPreferenceSchema), async (req, res) => {
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
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
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/seller/dashboard', requireAuth, requireSeller, async (req, res) => {
  try {
    const sellerId = req.userId;

    const [orders] = await prisma.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE status = 'confirmed')::int AS "toProcess",
        COUNT(*) FILTER (WHERE status = 'processing')::int AS "toShip",
        COUNT(*) FILTER (WHERE status = 'refund_requested')::int AS "refundRequests",
        COALESCE(ROUND((SUM(subtotal) FILTER (WHERE status IN (${Prisma.join(PAID_KEPT_STATUSES)})))::numeric, 2), 0)::float8 AS revenue,
        COALESCE(ROUND((SUM("payoutAmount") FILTER (WHERE status IN (${Prisma.join(PAID_KEPT_STATUSES)})))::numeric, 2), 0)::float8 AS payouts
      FROM "Order"
      WHERE "sellerId" = ${sellerId}
    `;

    const [listings] = await prisma.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE state = 'active')::int AS active,
        COUNT(*) FILTER (WHERE state = 'out_of_stock')::int AS "outOfStock",
        COUNT(*) FILTER (WHERE state = 'draft')::int AS drafts
      FROM "Product"
      WHERE "sellerId" = ${sellerId}
    `;

    const [lowStockProducts, recentOrders, recentReviews] = await Promise.all([
      prisma.product.findMany({
        where: { sellerId, state: 'active', stock: { gt: 0, lte: 5 } },
        select: { id: true, name: true, stock: true },
        orderBy: { stock: 'asc' },
        take: 5,
      }),
      prisma.order.findMany({
        where: { sellerId, status: { not: 'payment_pending' } },
        select: { id: true, status: true, subtotal: true, updatedAt: true },
        orderBy: { updatedAt: 'desc' },
        take: 10,
      }),
      prisma.review.findMany({
        where: { product: { sellerId } },
        select: { id: true, rating: true, createdAt: true, product: { select: { name: true } } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
    ]);

    const recentActivity = [
      ...recentOrders.map((o) => ({ type: 'order', id: o.id, status: o.status, amount: o.subtotal, at: o.updatedAt })),
      ...recentReviews.map((r) => ({ type: 'review', id: r.id, rating: r.rating, productName: r.product.name, at: r.createdAt })),
    ]
      .sort((a, b) => b.at - a.at)
      .slice(0, 10);

    res.json({
      revenue: orders.revenue,
      payouts: orders.payouts,
      listings: { active: listings.active, outOfStock: listings.outOfStock, drafts: listings.drafts },
      pendingOrders: { toProcess: orders.toProcess, toShip: orders.toShip, refundRequests: orders.refundRequests },
      lowStockProducts,
      recentActivity,
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/seller/earnings/summary', requireAuth, requireSeller, async (req, res) => {
  try {
    const [row] = await prisma.$queryRaw`
      SELECT
        COUNT(*) FILTER (WHERE status IN (${Prisma.join(PAID_KEPT_STATUSES)}))::int AS orders,
        COALESCE(ROUND((SUM(subtotal) FILTER (WHERE status IN (${Prisma.join(PAID_KEPT_STATUSES)})))::numeric, 2), 0)::float8 AS "grossSales",
        COALESCE(ROUND((SUM("platformFee") FILTER (WHERE status IN (${Prisma.join(PAID_KEPT_STATUSES)})))::numeric, 2), 0)::float8 AS "platformFees",
        COALESCE(ROUND((SUM("payoutAmount") FILTER (WHERE status IN (${Prisma.join(PAID_KEPT_STATUSES)})))::numeric, 2), 0)::float8 AS "netEarnings",
        COALESCE(ROUND((SUM("payoutAmount") FILTER (WHERE status = 'delivered'))::numeric, 2), 0)::float8 AS settled,
        COALESCE(ROUND((SUM("payoutAmount") FILTER (WHERE status IN ('confirmed', 'processing', 'shipped')))::numeric, 2), 0)::float8 AS "inProgress",
        COALESCE(ROUND((SUM("payoutAmount") FILTER (WHERE status = 'refund_requested'))::numeric, 2), 0)::float8 AS "atRisk",
        COALESCE(ROUND((SUM("payoutAmount") FILTER (WHERE status IN (${Prisma.join(PAID_KEPT_STATUSES)}) AND "payoutStatus" = 'paid'))::numeric, 2), 0)::float8 AS "paidOut",
        COUNT(*) FILTER (WHERE status = 'refunded')::int AS "refundedOrders",
        COALESCE(ROUND((SUM(subtotal) FILTER (WHERE status = 'refunded'))::numeric, 2), 0)::float8 AS "refundedSales"
      FROM "Order"
      WHERE "sellerId" = ${req.userId}
    `;

    res.json({
      orders: row.orders,
      grossSales: row.grossSales,
      platformFees: row.platformFees,
      netEarnings: row.netEarnings,
      breakdown: { settled: row.settled, inProgress: row.inProgress, atRisk: row.atRisk },
      payouts: { paid: row.paidOut, unpaid: round2(row.netEarnings - row.paidOut) },
      refunded: { orders: row.refundedOrders, sales: row.refundedSales },
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

const TRANSACTION_TYPES = ['payment', 'platform_fee', 'payout', 'refund', 'payment_failed'];

app.get('/api/seller/earnings/transactions', requireAuth, requireSeller, async (req, res) => {
  try {
    const pageNum = Math.max(parseInt(req.query.page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const skip = (pageNum - 1) * limitNum;
    const type = TRANSACTION_TYPES.includes(req.query.type) ? req.query.type : null;
    const typeFilter = type ? Prisma.sql`AND t.type = ${type}` : Prisma.empty;

    const transactions = await prisma.$queryRaw`
      SELECT t.id, t."orderId", t.type, ROUND(t.amount::numeric, 2)::float8 AS amount, t."createdAt"
      FROM "Transaction" t
      JOIN "Order" o ON o.id = t."orderId"
      WHERE o."sellerId" = ${req.userId}
      ${typeFilter}
      ORDER BY t."createdAt" DESC, t.id
      LIMIT ${limitNum} OFFSET ${skip}
    `;

    const [totals] = await prisma.$queryRaw`
      SELECT COUNT(*)::int AS count, COALESCE(ROUND(SUM(t.amount)::numeric, 2), 0)::float8 AS sum
      FROM "Transaction" t
      JOIN "Order" o ON o.id = t."orderId"
      WHERE o."sellerId" = ${req.userId}
      ${typeFilter}
    `;

    res.json({
      transactions,
      sum: type ? totals.sum : null,
      pagination: { page: pageNum, limit: limitNum, total: totals.count },
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/orders/:id', requireAuth, async (req, res) => {
  try {
    const order = await prisma.order.findUnique({
      where: { id: req.params.id },
      include: { items: { include: { product: { select: { name: true, images: true } } } } },
    });
    const viewer = await prisma.user.findUnique({ where: { id: req.userId }, select: { isAdmin: true } });
    const isAdmin = !!(viewer && viewer.isAdmin);

    if (!order || (order.buyerId !== req.userId && order.sellerId !== req.userId && !isAdmin)) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const viewerRole = isAdmin ? 'admin' : order.sellerId === req.userId ? 'seller' : 'buyer';
    const sellerSide = viewerRole !== 'buyer';

    const [seller, buyer] = await Promise.all([
      prisma.user.findUnique({
        where: { id: order.sellerId },
        select: { id: true, name: true, store: true },
      }),
      sellerSide
        ? prisma.user.findUnique({ where: { id: order.buyerId }, select: { id: true, name: true } })
        : null,
    ]);

    res.json({
      id: order.id,
      status: order.status,
      subtotal: order.subtotal,
      deliveryAddress: order.deliveryAddress,
      trackingInfo: order.trackingInfo,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      deliveredAt: order.deliveredAt,
      refundRequestedAt: order.refundRequestedAt,
      refundReason: order.refundReason,
      refundRejectionReason: order.refundRejectionReason,
      items: order.items.map((i) => ({
        id: i.id,
        productId: i.productId,
        name: i.product ? i.product.name : null,
        image: i.product && i.product.images ? i.product.images[0] || null : null,
        quantity: i.quantity,
        price: i.price,
        lineTotal: Math.round(i.price * i.quantity * 100) / 100,
      })),
      seller,
      ...(sellerSide
        ? {
            buyer,
            platformFee: order.platformFee,
            payoutAmount: order.payoutAmount,
            payoutStatus: order.payoutStatus,
            payoutPaidAt: order.payoutPaidAt,
            payoutReference: order.payoutReference,
          }
        : {}),
      viewerRole,
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

const MAX_ADDRESSES = 10;

const ADDRESS_FIELDS = {
  label: [0, 30],
  fullName: [1, 80],
  line1: [1, 120],
  line2: [0, 120],
  city: [1, 60],
  state: [1, 60],
  postalCode: [3, 12],
  country: [2, 60],
};

function cleanAddressInput(body, partial) {
  const data = {};

  for (const [key, [min, max]] of Object.entries(ADDRESS_FIELDS)) {
    if (body[key] === undefined) {
      if (!partial && min > 0 && key !== 'country') return { error: `${key} is required` };
      continue;
    }
    if (body[key] === null && min === 0) {
      data[key] = null;
      continue;
    }
    const value = typeof body[key] === 'string' ? body[key].trim() : '';
    if (value.length < min || value.length > max) {
      return { error: `${key} must be ${min} to ${max} characters` };
    }
    data[key] = value.length > 0 ? value : null;
  }

  if (body.phone !== undefined) {
    const phone = cleanPhone(body.phone);
    if (!phone) return { error: 'phone must be 7 to 15 digits, with an optional leading +' };
    data.phone = phone;
  } else if (!partial) {
    return { error: 'phone is required' };
  }

  return { data };
}

app.get('/api/addresses', requireAuth, async (req, res) => {
  try {
    const addresses = await prisma.address.findMany({
      where: { userId: req.userId },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'desc' }],
    });
    res.json(addresses);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/addresses', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const cleaned = cleanAddressInput(body, false);
    if (cleaned.error) return res.status(400).json({ error: cleaned.error });

    const created = await prisma.$transaction(async (tx) => {
      const count = await tx.address.count({ where: { userId: req.userId } });
      if (count >= MAX_ADDRESSES) return null;

      const makeDefault = count === 0 || body.isDefault === true;
      if (makeDefault) {
        await tx.address.updateMany({
          where: { userId: req.userId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.address.create({
        data: { ...cleaned.data, userId: req.userId, isDefault: makeDefault },
      });
    });

    if (!created) {
      return res.status(400).json({ error: `You can save up to ${MAX_ADDRESSES} addresses` });
    }

    res.status(201).json(created);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.put('/api/addresses/:id', requireAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const address = await prisma.address.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!address) return res.status(404).json({ error: 'Address not found' });

    if (body.isDefault === false) {
      return res.status(400).json({ error: 'Choose another address as the default instead' });
    }

    const cleaned = cleanAddressInput(body, true);
    if (cleaned.error) return res.status(400).json({ error: cleaned.error });

    const makeDefault = body.isDefault === true && !address.isDefault;
    if (Object.keys(cleaned.data).length === 0 && !makeDefault) {
      return res.status(400).json({ error: 'Nothing to update' });
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (makeDefault) {
        await tx.address.updateMany({
          where: { userId: req.userId, isDefault: true },
          data: { isDefault: false },
        });
      }
      return tx.address.update({
        where: { id: address.id },
        data: { ...cleaned.data, ...(makeDefault ? { isDefault: true } : {}) },
      });
    });

    res.json(updated);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.delete('/api/addresses/:id', requireAuth, async (req, res) => {
  try {
    const address = await prisma.address.findFirst({ where: { id: req.params.id, userId: req.userId } });
    if (!address) return res.status(404).json({ error: 'Address not found' });

    await prisma.$transaction(async (tx) => {
      await tx.address.delete({ where: { id: address.id } });

      if (address.isDefault) {
        const next = await tx.address.findFirst({
          where: { userId: req.userId },
          orderBy: { createdAt: 'desc' },
        });
        if (next) await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    });

    res.json({ message: 'Address deleted' });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

const PAYOUT_SELECT = {
  id: true,
  sellerId: true,
  status: true,
  subtotal: true,
  platformFee: true,
  payoutAmount: true,
  deliveredAt: true,
  payoutStatus: true,
  payoutPaidAt: true,
  payoutReference: true,
  seller: { select: { id: true, name: true } },
};

app.get('/api/admin/payouts', requireAuth, requireAdmin, async (req, res) => {
  try {
    const pageNum = Math.max(parseInt(req.query.page) || 1, 1);
    const limitNum = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 100);
    const payoutStatus = ['pending', 'paid'].includes(req.query.status) ? req.query.status : null;
    const onlyEligible = req.query.eligible === 'true';
    const cutoff = new Date(Date.now() - RETURN_WINDOW_DAYS * DAY_MS);

    const where = { status: { in: PAID_KEPT_STATUSES } };
    if (payoutStatus) where.payoutStatus = payoutStatus;
    if (onlyEligible) {
      where.status = 'delivered';
      where.payoutStatus = 'pending';
      where.deliveredAt = { lt: cutoff };
    }

    const [orders, total, sum] = await Promise.all([
      prisma.order.findMany({
        where,
        select: PAYOUT_SELECT,
        orderBy: [{ deliveredAt: 'asc' }, { createdAt: 'asc' }],
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      prisma.order.count({ where }),
      prisma.order.aggregate({ where, _sum: { payoutAmount: true } }),
    ]);

    const payouts = orders.map((o) => {
      const eligibleAt = payoutEligibleAt(o);
      return {
        ...o,
        eligibleAt,
        eligible: o.status === 'delivered' && o.payoutStatus === 'pending' && !!eligibleAt && eligibleAt.getTime() < Date.now(),
      };
    });

    res.json({
      payouts,
      totalPayoutAmount: round2(sum._sum.payoutAmount || 0),
      pagination: { page: pageNum, limit: limitNum, total },
    });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/admin/orders/:id/mark-payout-paid', requireAuth, requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const reference = typeof body.reference === 'string' ? body.reference.trim() : '';
    if (reference.length > 100) {
      return res.status(400).json({ error: 'Reference must be 100 characters or fewer' });
    }

    const order = await prisma.order.findUnique({ where: { id: req.params.id } });
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (order.payoutStatus === 'paid') {
      return res.status(409).json({ error: 'Payout is already marked as paid' });
    }
    if (order.status !== 'delivered') {
      return res.status(400).json({ error: `Only delivered orders can be paid out (this order is "${order.status}")` });
    }
    if (order.payoutAmount === null || order.payoutAmount === undefined) {
      return res.status(400).json({ error: 'This order has no payout amount' });
    }

    const eligibleAt = payoutEligibleAt(order);
    if (!eligibleAt || eligibleAt.getTime() >= Date.now()) {
      const when = eligibleAt ? eligibleAt.toISOString().slice(0, 10) : 'an unknown date';
      return res.status(400).json({ error: `Payout is held until the return window ends on ${when}` });
    }

    const result = await prisma.order.updateMany({
      where: { id: order.id, status: 'delivered', payoutStatus: 'pending' },
      data: { payoutStatus: 'paid', payoutPaidAt: new Date(), payoutReference: reference || null },
    });
    if (result.count === 0) {
      return res.status(409).json({ error: 'The order changed while processing. Please try again.' });
    }

    await notify(
      order.sellerId,
      'seller',
      'Payout paid',
      `Your payout of ₹${order.payoutAmount.toFixed(2)} for order ${order.id.slice(0, 8)} has been marked as paid.${reference ? ' Reference: ' + reference : ''}`
    );

    const updated = await prisma.order.findUnique({ where: { id: order.id }, select: PAYOUT_SELECT });
    res.json(updated);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

const UNPAID_ORDER_TTL_HOURS = 24;
const EXPIRY_INTERVAL_MS = 15 * 60 * 1000;

async function expireUnpaidOrders() {
  const cutoff = new Date(Date.now() - UNPAID_ORDER_TTL_HOURS * 60 * 60 * 1000);

  const stale = await prisma.order.findMany({
    where: { status: 'payment_pending', createdAt: { lt: cutoff } },
    select: { id: true, buyerId: true },
  });

  let expired = 0;
  for (const order of stale) {
    const result = await prisma.order.updateMany({
      where: { id: order.id, status: 'payment_pending' },
      data: { status: 'cancelled' },
    });
    if (result.count === 1) {
      expired += 1;
      await notify(
        order.buyerId,
        'orders',
        'Order expired',
        `Order ${order.id.slice(0, 8)} was cancelled because payment was not completed within ${UNPAID_ORDER_TTL_HOURS} hours.`
      );
    }
  }

  return expired;
}

app.post('/api/admin/orders/expire-unpaid', requireAuth, requireAdmin, async (req, res) => {
  try {
    const expired = await expireUnpaidOrders();
    res.json({ expired, ttlHours: UNPAID_ORDER_TTL_HOURS });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

let expiryTimer = null;

function startExpiryJob() {
  expiryTimer = setInterval(() => {
    expireUnpaidOrders().catch((err) => console.error('expireUnpaidOrders failed', err));
  }, EXPIRY_INTERVAL_MS);
  expiryTimer.unref();
}

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON in request body' });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large' });
  }
  req.log.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

// Only start listening and background jobs when run directly (node server.js).
// Tests import the app without starting anything.
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  const server = app.listen(PORT, () => logger.info(`API running on port ${PORT}`));
  startExpiryJob();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    if (expiryTimer) clearInterval(expiryTimer);

    const forceExit = setTimeout(() => {
      logger.error('forced exit after 10 seconds');
      process.exit(1);
    }, 10000);
    forceExit.unref();

    server.close(async () => {
      await prisma.$disconnect();
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { app, prisma, expireUnpaidOrders };
