const crypto = require('crypto');

/**
 * Vercel Serverless Function: POST /api/verify-payment
 * Verifies the HMAC-SHA256 signature returned by Razorpay Checkout.
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keySecret) {
    return res.status(500).json({
      error: 'RAZORPAY_KEY_SECRET is not configured on Vercel.'
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({ error: 'Missing required payment verification parameters.' });
    }

    const payload = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expectedSignature = crypto
      .createHmac('sha256', keySecret)
      .update(payload)
      .digest('hex');

    const expectedBuffer = Buffer.from(expectedSignature, 'utf8');
    const receivedBuffer = Buffer.from(String(razorpay_signature), 'utf8');

    const isValid =
      expectedBuffer.length === receivedBuffer.length &&
      crypto.timingSafeEqual(expectedBuffer, receivedBuffer);

    if (!isValid) {
      return res.status(400).json({ verified: false, error: 'Invalid payment signature.' });
    }

    return res.status(200).json({
      verified: true,
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id
    });
  } catch (err) {
    console.error('Error verifying Razorpay payment:', err);
    return res.status(500).json({ verified: false, error: 'Internal server error during verification.' });
  }
};
