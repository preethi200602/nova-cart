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

    const user = await prisma.user.create({
      data: { email, password: hashedPassword, name },
    });

    res.status(201).json({ id: user.id, email: user.email, name: user.name });
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

    console.log(`Password reset link: http://localhost:3000/reset-password?token=${resetToken}`);

    res.json({ message: 'If that email exists, a reset link has been sent.' });
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

      // Decrement stock atomically for each item; bail out if any fails
      for (const item of sellerItems) {
        const success = await decrementStock(item.productId, item.quantity);
        if (!success) {
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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
