// Sessions: short-lived access tokens plus rotating refresh tokens.
// Refresh tokens are random codes. Only their SHA-256 fingerprint is stored.
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { hashToken } = require('./tokens');

// Read at call time so they can be changed per environment.
function accessTtl() {
  return process.env.ACCESS_TOKEN_TTL || '15m';
}
function refreshDays() {
  return Number(process.env.REFRESH_TOKEN_DAYS) || 7;
}

function signAccessToken(user) {
  return jwt.sign({ id: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: accessTtl() });
}

async function issueRefreshToken(prisma, userId) {
  const token = crypto.randomBytes(48).toString('hex');
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + refreshDays() * 24 * 60 * 60 * 1000),
    },
  });
  return token;
}

async function revokeAllRefreshTokens(prisma, userId) {
  await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

// Swaps a refresh token for a new one. Returns { error } or { userId, token }.
// Unknown, expired and already-used tokens all give the same error on purpose.
async function rotateRefreshToken(prisma, presented) {
  const record = await prisma.refreshToken.findUnique({ where: { tokenHash: hashToken(presented) } });
  if (!record) return { error: 'Invalid refresh token' };

  if (record.revokedAt) {
    // A used token came back. Someone may have copied it, so end every session for this user.
    await revokeAllRefreshTokens(prisma, record.userId);
    return { error: 'Invalid refresh token' };
  }

  if (record.expiresAt <= new Date()) return { error: 'Invalid refresh token' };

  // Claim the token. If two requests race, only one of them wins.
  const claimed = await prisma.refreshToken.updateMany({
    where: { id: record.id, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  if (claimed.count !== 1) return { error: 'Invalid refresh token' };

  const token = await issueRefreshToken(prisma, record.userId);
  return { userId: record.userId, token };
}

module.exports = { accessTtl, signAccessToken, issueRefreshToken, rotateRefreshToken, revokeAllRefreshTokens };
