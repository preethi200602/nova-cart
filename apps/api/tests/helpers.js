const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { prisma } = require('../server');

let counter = 0;

async function createUser(overrides = {}) {
  counter += 1;
  return prisma.user.create({
    data: {
      email: `user${counter}-${Date.now()}@test.local`,
      password: await bcrypt.hash('Password123!', 4),
      name: `User ${counter}`,
      emailVerified: true,
      ...overrides,
    },
  });
}

function tokenFor(user) {
  return jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
}

function asUser(user) {
  return { Authorization: `Bearer ${tokenFor(user)}` };
}

async function resetDb() {
  const tables = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  if (tables.length === 0) return;
  const list = tables.map((t) => `"${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

module.exports = { createUser, tokenFor, asUser, resetDb };
