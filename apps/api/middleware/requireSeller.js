const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function requireSeller(req, res, next) {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.userId } });

    if (!user || !user.isSeller) {
      return res.status(403).json({ error: 'Seller access required' });
    }

    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong' });
  }
}

module.exports = requireSeller;