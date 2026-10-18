// Stand-in for the Razorpay SDK so tests never call the real service.
class Razorpay {
  constructor() {
    this.orders = {
      create: async ({ amount, currency, receipt }) => ({
        id: 'order_test_' + Math.random().toString(36).slice(2, 12),
        amount,
        currency,
        receipt,
      }),
    };
  }
}

module.exports = Razorpay;
