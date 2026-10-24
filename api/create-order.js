const fs = require('fs');
const path = require('path');

/**
 * Vercel Serverless Function: POST /api/create-order
 * Creates a Razorpay order using server-validated pricing from data.json.
 *
 * Required Vercel Environment Variables:
 *   - RAZORPAY_KEY_ID      (e.g. rzp_test_... or rzp_live_...)
 *   - RAZORPAY_KEY_SECRET  (your Razorpay Key Secret)
 *
 * Optional Vercel Environment Variables:
 *   - RAZORPAY_PAYMENT_MODE : "full" (default) or "advance_60" (charges 60% advance)
 *   - RAZORPAY_GST_PERCENT  : "0" (default, GST on invoice) or "18" (adds 18% GST at checkout)
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  if (!keyId || !keySecret) {
    return res.status(500).json({
      error: 'Razorpay environment variables (RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET) are not configured on Vercel.'
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { serviceId, packageName, quantity = 1, customer = {} } = body;

    const dataPath = path.join(process.cwd(), 'data.json');
    const siteData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

    const service = (siteData.catalog && siteData.catalog.services || []).find(s => s.id === serviceId);
    if (!service || service.quote) {
      return res.status(400).json({ error: 'Invalid or quote-only service selected.' });
    }

    const pkg = (service.pk || []).find(p => p[0] === packageName);
    if (!pkg) {
      return res.status(400).json({ error: 'Invalid package selected for this service.' });
    }

    const qty = Math.max(1, Math.min(50, parseInt(quantity, 10) || 1));
    const basePrice = pkg[1];
    const extraConfig = pkg[4];
    const subtotalInr = extraConfig && extraConfig.add
      ? basePrice + extraConfig.add * (qty - 1)
      : basePrice;

    const paymentMode = (process.env.RAZORPAY_PAYMENT_MODE || 'full').toLowerCase();
    const gstPercent = parseFloat(process.env.RAZORPAY_GST_PERCENT || '0') || 0;

    const advanceFactor = paymentMode === 'advance_60' ? 0.6 : 1;
    const taxableInr = Math.round(subtotalInr * advanceFactor);
    const gstInr = Math.round(taxableInr * (gstPercent / 100));
    const payableInr = taxableInr + gstInr;
    const amountPaise = payableInr * 100;

    const receipt = `cs_${service.id}_${Date.now()}`.slice(0, 40);
    const authHeader = 'Basic ' + Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    const rzpResponse = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authHeader
      },
      body: JSON.stringify({
        amount: amountPaise,
        currency: 'INR',
        receipt,
        notes: {
          service_id: service.id,
          service_title: service.t,
          package_name: pkg[0],
          quantity: String(qty),
          unit: pkg[3] || service.u || '',
          subtotal_inr: String(subtotalInr),
          payment_mode: paymentMode,
          gst_percent: String(gstPercent),
          customer_name: String(customer.name || '').slice(0, 100),
          customer_email: String(customer.email || '').slice(0, 100),
          customer_phone: String(customer.phone || '').slice(0, 30),
          customer_gstin: String(customer.gstin || '').slice(0, 30)
        }
      })
    });

    const rzpData = await rzpResponse.json();
    if (!rzpResponse.ok) {
      return res.status(rzpResponse.status).json({
        error: (rzpData && rzpData.error && rzpData.error.description) || 'Failed to create Razorpay order.'
      });
    }

    return res.status(200).json({
      keyId,
      orderId: rzpData.id,
      amount: rzpData.amount,
      currency: rzpData.currency,
      subtotalInr,
      taxableInr,
      gstInr,
      payableInr,
      paymentMode,
      gstPercent,
      serviceTitle: service.t,
      packageName: pkg[0],
      quantity: qty
    });
  } catch (err) {
    console.error('Error creating Razorpay order:', err);
    return res.status(500).json({ error: 'Internal server error while creating order.' });
  }
};
