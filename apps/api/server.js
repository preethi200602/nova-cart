const express = require('express');
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const requireAuth = require('./middleware/auth');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const prisma = new PrismaClient();

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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
