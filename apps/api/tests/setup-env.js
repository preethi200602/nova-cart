const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env.test'), override: true, quiet: true });

// Safety: tests wipe tables, so they must never run against the development database.
const url = process.env.DATABASE_URL || '';
if (!url.includes('nova_cart_test')) {
  throw new Error('Refusing to run tests: DATABASE_URL must point at the nova_cart_test database');
}

process.env.NODE_ENV = 'test';

// Keep test output readable: notify.js logs an email preview link.
console.log = () => {};
