// Helpers for email tokens and links.
const crypto = require('crypto');

// Tokens are stored as a SHA-256 hash. Only the email contains the real token,
// so a leaked database cannot be used to verify accounts or reset passwords.
function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Base address used in email links. Read at call time so it can be changed per environment.
function appUrl() {
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

module.exports = { hashToken, appUrl };
