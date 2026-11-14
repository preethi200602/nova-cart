// routes/cart.js - moved out of server.js word for word by scripts/move-area.js
const express = require('express');
const requireAuth = require('../middleware/auth');
const { validate } = require('../validate');
const schemas = require('../schemas');
const { prisma } = require('../lib/prisma');

const router = express.Router();

router.get('/api/cart', requireAuth, async (req, res) => {
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

router.post('/api/cart/items', requireAuth, validate(schemas.addCartItemSchema), async (req, res) => {
  try {
    const { productId, quantity } = req.body;

    if (!productId || !quantity || quantity < 1) {
      return res.status(400).json({ error: 'productId and a positive quantity are required' });
    }

    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product || product.state !== 'active') {
      return res.status(400).json({ error: 'Product not available' });
    }

    if (product.sellerId === req.userId) {
      return res.status(400).json({ error: 'You cannot buy your own products' });
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

router.put('/api/cart/items/:id', requireAuth, validate(schemas.updateCartItemSchema), async (req, res) => {
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

router.delete('/api/cart/items/:id', requireAuth, async (req, res) => {
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

module.exports = router;
