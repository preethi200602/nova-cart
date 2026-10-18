module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/setup-env.js'],
  moduleNameMapper: {
    '^razorpay$': '<rootDir>/tests/mocks/razorpay.js',
    '^nodemailer$': '<rootDir>/tests/mocks/nodemailer.js',
  },
  testTimeout: 20000,
};
