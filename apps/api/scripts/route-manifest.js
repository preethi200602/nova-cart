// scripts/route-manifest.js - prints every middleware and route in the order Express will run them.
// Read-only. Run it BEFORE and AFTER a change and compare the two outputs: they must be identical.
//   node scripts/route-manifest.js > /tmp/routes-before.txt
// Each handler is shown as name:fingerprint. The fingerprint is a short hash of the handler's source code,
// so a moved route that is byte-for-byte the same gets the same fingerprint.
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'manifest_dummy_key';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'manifest_dummy_secret';

const crypto = require('crypto');
const { app, prisma } = require('../server');

const fingerprint = (fn) => crypto.createHash('sha1').update(String(fn)).digest('hex').slice(0, 8);
const describe = (fn) => `${fn.name || '(anonymous)'}:${fingerprint(fn)}`;

const lines = [];
let routeCount = 0;

function walk(stack) {
  for (const layer of stack) {
    if (layer.route) {
      routeCount += 1;
      const methods = Object.keys(layer.route.methods)
        .filter((m) => layer.route.methods[m])
        .map((m) => m.toUpperCase())
        .join(',');
      const handlers = layer.route.stack.map((l) => describe(l.handle)).join(' > ');
      lines.push(`ROUTE ${methods} ${layer.route.path} [${handlers}]`);
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      walk(layer.handle.stack); // a mounted router: list what is inside it, in order
    } else {
      const where = layer.path || (layer.regexp && String(layer.regexp)) || '';
      lines.push(`USE ${describe(layer.handle)} ${where}`.trimEnd());
    }
  }
}

walk((app.router || app._router).stack);
console.log(`ROUTES ${routeCount}  LAYERS ${lines.length}`);
for (const line of lines) console.log(line);

Promise.resolve(prisma && prisma.$disconnect ? prisma.$disconnect() : null).finally(() => process.exit(0));
