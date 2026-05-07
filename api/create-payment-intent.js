// api/create-payment-intent.js
// Vercel Serverless Function — runs on Vercel's servers, never exposed to the browser.
// Stripe secret key stays here (server-side only via environment variable).

const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

module.exports = async function handler(req, res) {
  // CORS headers (needed if frontend is on a different domain)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { items, email, name } = req.body;

    // ── Pricing catalog (keep in sync with frontend CATALOG) ──────────────
    const PRICES = {
      website:     { amount: 40000, name: 'Custom Website',      type: 'one_time'  }, // $400
      chatbot:     { amount: 20000, name: 'AI Chatbot / Agent',  type: 'one_time'  }, // $200
      maintenance: { amount: 10000, name: 'Monthly Maintenance', type: 'recurring' }, // $100/mo
    };

    // Validate items
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No items provided' });
    }
    for (const id of items) {
      if (!PRICES[id]) return res.status(400).json({ error: `Unknown item: ${id}` });
    }

    // Validate email
    if (!email || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const oneTimeItems   = items.filter(id => PRICES[id].type === 'one_time');
    const recurringItems = items.filter(id => PRICES[id].type === 'recurring');

    // ── Create or retrieve Stripe Customer ────────────────────────────────
    let customer;
    const existingCustomers = await stripe.customers.list({ email, limit: 1 });
    if (existingCustomers.data.length > 0) {
      customer = existingCustomers.data[0];
    } else {
      customer = await stripe.customers.create({ email, name });
    }

    let paymentIntentClientSecret = null;
    let subscriptionClientSecret  = null;

    // ── One-time payment (PaymentIntent) ──────────────────────────────────
    if (oneTimeItems.length > 0) {
      const amount      = oneTimeItems.reduce((sum, id) => sum + PRICES[id].amount, 0);
      const description = oneTimeItems.map(id => PRICES[id].name).join(', ');

      const paymentIntent = await stripe.paymentIntents.create({
        amount,
        currency: 'usd',
        customer: customer.id,
        receipt_email: email,
        description,
        metadata: {
          items: oneTimeItems.join(','),
          customer_name: name,
        },
        automatic_payment_methods: { enabled: true },
      });

      paymentIntentClientSecret = paymentIntent.client_secret;
    }

    // ── Recurring subscription ─────────────────────────────────────────────
    if (recurringItems.length > 0) {
      const subscriptionItems = await Promise.all(
        recurringItems.map(async (id) => {
          const price = await stripe.prices.create({
            unit_amount: PRICES[id].amount,
            currency: 'usd',
            recurring: { interval: 'month' },
            product_data: { name: PRICES[id].name },
          });
          return { price: price.id };
        })
      );

      const subscription = await stripe.subscriptions.create({
        customer: customer.id,
        items: subscriptionItems,
        payment_behavior: 'default_incomplete',
        payment_settings: { save_default_payment_method: 'on_subscription' },
        expand: ['latest_invoice.payment_intent'],
        metadata: { items: recurringItems.join(',') },
        trial_period_days: 30,
      });

      subscriptionClientSecret =
        subscription.latest_invoice.payment_intent.client_secret;
    }

    return res.status(200).json({
      paymentIntentClientSecret,
      subscriptionClientSecret,
      customerId: customer.id,
    });

  } catch (err) {
    console.error('Stripe error:', err);
    return res.status(500).json({ error: err.message });
  }
};
