// routes/seller-onboarding.js - moved out of server.js word for word by scripts/move-area.js
const express = require('express');
const requireAuth = require('../middleware/auth');
const requireAdmin = require('../middleware/requireAdmin');
const requireSeller = require('../middleware/requireSeller');
const { notify } = require('../notify');
const { validate } = require('../validate');
const schemas = require('../schemas');
const { prisma } = require('../lib/prisma');

const router = express.Router();

router.post('/api/seller/apply', requireAuth, validate(schemas.sellerApplySchema), async (req, res) => {
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

router.get('/api/seller/application', requireAuth, async (req, res) => {
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

router.get('/api/admin/seller-applications', requireAuth, requireAdmin, async (req, res) => {
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

router.post('/api/admin/seller-applications/:id/approve', requireAuth, requireAdmin, async (req, res) => {
  try {
    // One transaction: the application, the seller flag and the store change together or not at all.
    // The claim (status must still be "pending") makes a double click, or two admins at once, safe.
    const approved = await prisma.$transaction(async (tx) => {
      const claimed = await tx.sellerApplication.updateMany({
        where: { id: req.params.id, status: 'pending' },
        data: { status: 'approved' },
      });
      if (claimed.count === 0) return null;

      const application = await tx.sellerApplication.findUnique({ where: { id: req.params.id } });
      await tx.user.update({ where: { id: application.userId }, data: { isSeller: true } });
      await tx.store.create({
        data: { userId: application.userId, storeName: application.businessName },
      });
      return application;
    });

    if (!approved) {
      const current = await prisma.sellerApplication.findUnique({ where: { id: req.params.id } });
      if (!current) return res.status(404).json({ error: 'Application not found' });
      return res.status(409).json({ error: `Application is already ${current.status}` });
    }

    await notify(
      approved.userId,
      'seller',
      'Your seller application was approved',
      'Congratulations! Your store is set up. You can now list products from your seller dashboard.'
    );

    res.json({ message: 'Application approved', application: approved });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

router.post('/api/admin/seller-applications/:id/reject', requireAuth, requireAdmin, validate(schemas.rejectApplicationSchema), async (req, res) => {
  try {
    const rejectionReason = req.body.rejectionReason.trim();

    // Only a "pending" application can be rejected; the check and the change are one step.
    const claimed = await prisma.sellerApplication.updateMany({
      where: { id: req.params.id, status: 'pending' },
      data: { status: 'rejected', rejectionReason },
    });

    const application = await prisma.sellerApplication.findUnique({ where: { id: req.params.id } });
    if (!application) return res.status(404).json({ error: 'Application not found' });
    if (claimed.count === 0) {
      return res.status(409).json({ error: `Application is already ${application.status}` });
    }

    await notify(
      application.userId,
      'seller',
      'Your seller application was not approved',
      `Unfortunately your application was rejected. Reason: ${rejectionReason}`
    );

    res.json({ message: 'Application rejected', application });
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

router.get('/api/seller/store', requireAuth, requireSeller, async (req, res) => {
  try {
    const store = await prisma.store.findUnique({ where: { userId: req.userId } });
    res.json(store);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

router.put('/api/seller/store', requireAuth, requireSeller, validate(schemas.storeUpdateSchema), async (req, res) => {
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

module.exports = router;
