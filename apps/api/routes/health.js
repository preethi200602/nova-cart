// routes/health.js - moved out of server.js word for word by scripts/move-area.js
const express = require('express');
const { prisma } = require('../lib/prisma');

const router = express.Router();

const withTimeout = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms).unref()),
  ]);

router.get('/health', async (req, res) => {
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, 2000);
    res.json({ status: 'ok', database: 'up', uptimeSeconds: Math.round(process.uptime()) });
  } catch (err) {
    req.log.error(err);
    res.status(503).json({ status: 'degraded', database: 'down' });
  }
});

module.exports = router;
