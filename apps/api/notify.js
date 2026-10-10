const nodemailer = require('nodemailer');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

let transporterPromise = null;

function getTransporter() {
  if (!transporterPromise) {
    transporterPromise = nodemailer.createTestAccount().then((account) =>
      nodemailer.createTransport({
        host: account.smtp.host,
        port: account.smtp.port,
        secure: account.smtp.secure,
        auth: { user: account.user, pass: account.pass },
      })
    );
  }
  return transporterPromise;
}

async function sendEmail(to, subject, text) {
  const transporter = await getTransporter();
  const info = await transporter.sendMail({
    from: '"Nova-Cart" <no-reply@nova-cart.local>',
    to,
    subject,
    text,
  });
  console.log(`Email preview for ${to}: ${nodemailer.getTestMessageUrl(info)}`);
}

async function notify(userId, category, title, message, options = {}) {
  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return;

    const pref = await prisma.notificationPreference.findUnique({
      where: { userId_category: { userId, category } },
    });

    const inAppEnabled = options.emailOnly ? false : pref ? pref.inApp : true;
    const emailEnabled = category === 'security' ? true : pref ? pref.email : true;

    if (inAppEnabled) {
      await prisma.notification.create({
        data: { userId, category, title, message },
      });
    }

    if (emailEnabled) {
      await sendEmail(user.email, title, message);
    }
  } catch (err) {
    console.error('Notification failed (non-fatal):', err.message);
  }
}

module.exports = { notify };