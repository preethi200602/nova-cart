// Stand-in for nodemailer so tests never send or look up real email.
module.exports = {
  createTransport: () => ({ sendMail: async () => ({ messageId: 'test-message' }) }),
  createTestAccount: async () => ({
    user: 'test',
    pass: 'test',
    smtp: { host: 'localhost', port: 1, secure: false },
  }),
  getTestMessageUrl: () => false,
};
