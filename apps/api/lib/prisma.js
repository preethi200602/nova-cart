const { PrismaClient } = require('@prisma/client');

// One shared database client for the whole app.
const prisma = new PrismaClient();

module.exports = { prisma };
