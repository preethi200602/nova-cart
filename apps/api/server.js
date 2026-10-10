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

app.post('/api/products', requireAuth, requireSeller, async (req, res) => {
  try {
    const { name, description, price, salePrice, stock, categoryId, tags, images } = req.body;

    if (!name || !description || !price || !categoryId) {
      return res.status(400).json({ error: 'name, description, price, and categoryId are required' });
    }

    const category = await prisma.category.findUnique({ where: { id: categoryId } });
    if (!category) {
      return res.status(400).json({ error: 'Invalid categoryId' });
    }

    const product = await prisma.product.create({
      data: {
        sellerId: req.userId,
        categoryId,
        name,
        description,
        price,
        salePrice: salePrice || null,
        stock: stock || 0,
        tags: tags || null,
        images: images || [],
      },
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

    const { name, description, price, salePrice, stock, categoryId, tags, images, state } = req.body;

    const updated = await prisma.product.update({
      where: { id: req.params.id },
      data: { name, description, price, salePrice, stock, categoryId, tags, images, state },
    });

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

    if (!product) {
      return res.status(404).json({ error: 'Product not found' });
    }

    res.json(product);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/api/products', async (req, res) => {
  try {
    const {
      q,
      category,
      minPrice,
      maxPrice,
      seller,
      sort,
      page = 1,
      limit = 20,
    } = req.query;

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const where = { state: 'active' };

    if (category) where.categoryId = category;
    if (seller) where.sellerId = seller;
    if (minPrice || maxPrice) {
      where.price = {};
      if (minPrice) where.price.gte = parseFloat(minPrice);
      if (maxPrice) where.price.lte = parseFloat(maxPrice);
    }

    let orderBy = { createdAt: 'desc' };
    if (sort === 'price_asc') orderBy = { price: 'asc' };
    if (sort === 'price_desc') orderBy = { price: 'desc' };
    if (sort === 'newest') orderBy = { createdAt: 'desc' };

    let products;
    let total;

    if (q) {
      const searchCondition = Prisma.sql`
        AND (
          similarity(name, ${q}) > 0.15
          OR similarity(description, ${q}) > 0.1
          OR name ILIKE ${'%' + q + '%'}
        )
      `;

      products = await prisma.$queryRaw`
        SELECT *, similarity(name, ${q}) as relevance
        FROM "Product"
        WHERE state = 'active'
        ${category ? Prisma.sql`AND "categoryId" = ${category}` : Prisma.empty}
        ${seller ? Prisma.sql`AND "sellerId" = ${seller}` : Prisma.empty}
        ${minPrice ? Prisma.sql`AND price >= ${parseFloat(minPrice)}` : Prisma.empty}
        ${maxPrice ? Prisma.sql`AND price <= ${parseFloat(maxPrice)}` : Prisma.empty}
        ${searchCondition}
        ORDER BY relevance DESC
        LIMIT ${limitNum} OFFSET ${skip}
      `;
      total = products.length;
    } else {
      [products, total] = await Promise.all([
        prisma.product.findMany({
          where,
          orderBy,
          skip,
          take: limitNum,
          include: { category: true },
        }),
        prisma.product.count({ where }),
      ]);
    }

    res.json({
      products,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.post('/api/products/:id/test-decrement', async (req, res) => {
  const { quantity } = req.body;
  const success = await decrementStock(req.params.id, quantity || 1);

  if (!success) {
    return res.status(400).json({ error: 'Not enough stock' });
  }

  const product = await prisma.product.findUnique({ where: { id: req.params.id } });
  res.json({ message: 'Stock decremented', currentStock: product.stock });
});

app.get('/api/sellers/:sellerId/products', async (req, res) => {
  try {
    const products = await prisma.product.findMany({
      where: {
        sellerId: req.params.sellerId,
        state: 'active',
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

    await prisma.transaction.create({
      data: { orderId: order.id, type: 'refund', amount: -order.subtotal },
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

app.post('/api/test-notify', requireAuth, async (req, res) => {
  await notify(req.userId, 'orders', 'Test notification', 'If you can read this, notifications work!');
  res.json({ message: 'Notification sent' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
