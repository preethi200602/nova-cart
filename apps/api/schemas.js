// Zod schemas for request bodies (batch a: auth, seller application, store).
const { z } = require('zod');

// Helper: required text, trimmed, with clear messages.
const text = (label, max) =>
  z
    .string({ error: `${label} is required and must be text` })
    .trim()
    .min(1, { error: `${label} cannot be empty` })
    .max(max, { error: `${label} must be at most ${max} characters` });

const email = z
  .string({ error: 'Email is required and must be text' })
  .trim()
  .max(254, { error: 'Email is too long' })
  .pipe(z.email({ error: 'Enter a valid email address' }));

// bcrypt only uses the first 72 bytes, so we cap at 72 characters.
const newPassword = z
  .string({ error: 'Password is required and must be text' })
  .min(8, { error: 'Password must be at least 8 characters' })
  .max(72, { error: 'Password must be at most 72 characters' });

const registerSchema = z.object({
  email,
  password: newPassword,
  name: text('Name', 80).optional(),
});

// Login does NOT enforce the 8-character rule, so older accounts can still sign in.
const loginSchema = z.object({
  email,
  password: z
    .string({ error: 'Password is required and must be text' })
    .min(1, { error: 'Password is required' })
    .max(200, { error: 'Password is too long' }),
});

const forgotPasswordSchema = z.object({ email });
const resendVerificationSchema = z.object({ email });

const verifyEmailSchema = z.object({ token: text('Token', 200) });

const resetPasswordSchema = z.object({
  token: text('Token', 200),
  newPassword,
});

const sellerApplySchema = z.object({
  businessName: text('Business name', 100),
  description: text('Description', 2000),
  categoryFocus: text('Category focus', 100),
  contactDetails: text('Contact details', 300),
});

// All fields optional (a partial update). null is not allowed.
const storeUpdateSchema = z.object({
  storeName: text('Store name', 80).optional(),
  banner: z.string({ error: 'Banner must be text' }).trim().max(500, { error: 'Banner must be at most 500 characters' }).optional(),
  description: z.string({ error: 'Description must be text' }).trim().max(2000, { error: 'Description must be at most 2000 characters' }).optional(),
  policies: z.string({ error: 'Policies must be text' }).trim().max(2000, { error: 'Policies must be at most 2000 characters' }).optional(),
});

module.exports = {
  registerSchema,
  loginSchema,
  forgotPasswordSchema,
  resendVerificationSchema,
  verifyEmailSchema,
  resetPasswordSchema,
  sellerApplySchema,
  storeUpdateSchema,
};
