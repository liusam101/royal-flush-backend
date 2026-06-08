// ══════════════════════════════════════════════════════════════════════════
// Payment Routes — Stripe Checkout
// POST /api/payment/checkout  — create session, return redirect URL
// POST /api/payment/webhook   — handle checkout.session.completed
// GET  /api/payment/verify/:id — verify + credit if webhook missed
// ══════════════════════════════════════════════════════════════════════════
const express = require('express');
const router  = express.Router();
const { authMiddleware, updateChips, getUser } = require('./auth');

// Lazy init — Stripe throws at module load if key is missing
let _stripe = null;
function getStripe() {
  if (!_stripe) {
    if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY not set');
    _stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
  return _stripe;
}
const db = require('./db');

const SITE_URL = process.env.SITE_URL || 'https://royal-flush-frontend.vercel.app';

// All purchasable packages — must match frontend GOLD_PACKAGES / CHIP_PACKAGES
const PACKAGES = {
  'gold-5':   { usd: 5,   gold: 50000,   royal: 5,   label: 'Starter Pack' },
  'gold-10':  { usd: 10,  gold: 110000,  royal: 10,  label: 'Bronze Pack' },
  'gold-20':  { usd: 20,  gold: 250000,  royal: 20,  label: 'Silver Pack' },
  'gold-50':  { usd: 50,  gold: 700000,  royal: 50,  label: 'Gold Pack' },
  'gold-100': { usd: 100, gold: 1500000, royal: 100, label: 'Platinum Pack' },
  'rc-25':    { usd: 25,  gold: 250000,  royal: 25,  label: 'Entry Pack' },
  'rc-50':    { usd: 50,  gold: 550000,  royal: 50,  label: 'Standard Pack' },
  'rc-100':   { usd: 100, gold: 1200000, royal: 100, label: 'Premium Pack' },
  'rc-250':   { usd: 250, gold: 3200000, royal: 250, label: 'Elite Pack' },
  'rc-500':   { usd: 500, gold: 7000000, royal: 500, label: 'VIP Pack' },
};

// ── Idempotent credit helper ────────────────────────────────────────────────
// Returns true if chips were credited, false if already processed.
async function creditSession(sessionId, userId, pkg) {
  try {
    // INSERT fails with 23505 if session already processed (PRIMARY KEY constraint)
    await db.query(
      `INSERT INTO payments (session_id, user_id, amount_usd, gold_chips, royal_chips, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, userId, pkg.usd, pkg.gold, pkg.royal, Date.now()]
    );
  } catch(e) {
    if (e.code === '23505') return false; // duplicate — already credited
    throw e;
  }
  try {
    await updateChips(userId, pkg.royal, pkg.gold);
  } catch(e) {
    // Roll back the INSERT so Stripe can retry and re-process cleanly
    await db.query('DELETE FROM payments WHERE session_id=$1', [sessionId]).catch(() => {});
    throw e;
  }
  console.log(`[Payment] ${userId} credited ${pkg.gold} gold + ${pkg.royal} royal (session ${sessionId})`);
  return true;
}

// ── POST /api/payment/checkout ─────────────────────────────────────────────
router.post('/checkout', authMiddleware, async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ error: 'Payment not configured.' });
    }
    const { packageId } = req.body;
    const pkg = PACKAGES[packageId];
    if (!pkg) return res.status(400).json({ error: 'Invalid package.' });

    const user = await getUser(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found.' });

    const session = await getStripe().checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: pkg.usd * 100,
          product_data: {
            name: pkg.label,
            description: `${pkg.gold.toLocaleString()} Gold Chips + ${pkg.royal} Royal Chips`,
            images: [],
          },
        },
        quantity: 1,
      }],
      metadata: {
        userId:     req.user.id,
        packageId,
        goldChips:  String(pkg.gold),
        royalChips: String(pkg.royal),
      },
      customer_email: user.email,
      success_url: `${SITE_URL}/rf.html?payment=success&sid={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${SITE_URL}/rf.html?payment=cancel`,
      expires_at:  Math.floor(Date.now() / 1000) + 1800, // 30 min
    });

    res.json({ ok: true, url: session.url });
  } catch(e) {
    console.error('[Payment] checkout error:', e.message);
    res.status(500).json({ error: 'Could not create checkout session.' });
  }
});

// ── POST /api/payment/webhook ──────────────────────────────────────────────
// Must receive raw body — set up in server.js before express.json()
router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = getStripe().webhooks.constructEvent(
      req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch(e) {
    console.error('[Webhook] Signature failed:', e.message);
    return res.status(400).send(`Webhook Error: ${e.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    if (session.payment_status === 'paid') {
      const { userId, packageId } = session.metadata;
      const pkg = PACKAGES[packageId];
      if (userId && pkg) {
        try {
          await creditSession(session.id, userId, pkg);
        } catch(e) {
          console.error('[Webhook] Credit failed:', e.message);
          return res.status(500).json({ error: 'Credit failed' });
        }
      }
    }
  }

  res.json({ received: true });
});

// ── GET /api/payment/verify/:sessionId ────────────────────────────────────
// Called when user returns from Stripe — credits chips if webhook was slow.
router.get('/verify/:sessionId', authMiddleware, async (req, res) => {
  try {
    if (!process.env.STRIPE_SECRET_KEY) return res.json({ ok: false });

    const session = await getStripe().checkout.sessions.retrieve(req.params.sessionId);
    if (session.payment_status !== 'paid') {
      return res.json({ ok: false, status: session.payment_status });
    }
    if (session.metadata.userId !== req.user.id) {
      return res.status(403).json({ error: 'Session mismatch.' });
    }

    const pkg = PACKAGES[session.metadata.packageId];
    if (!pkg) return res.status(400).json({ error: 'Unknown package.' });

    const credited = await creditSession(session.id, req.user.id, pkg);
    res.json({ ok: true, credited, gold: pkg.gold, royal: pkg.royal, usd: pkg.usd, label: pkg.label });
  } catch(e) {
    console.error('[Payment] verify error:', e.message);
    res.status(500).json({ error: 'Verification failed.' });
  }
});

module.exports = router;
