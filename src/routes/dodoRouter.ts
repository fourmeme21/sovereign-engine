import { Router, Request, Response } from 'express'
import DodoPayments from 'dodopayments'
import { Webhook } from 'standardwebhooks'
import { createClient } from '@supabase/supabase-js'

const router = Router()

const supabase = createClient(
  process.env['SUPABASE_URL']!,
  process.env['SUPABASE_SERVICE_KEY']!
)

const dodo = new DodoPayments({
  bearerToken: process.env['DODO_PAYMENTS_API_KEY']!,
  environment: (process.env['DODO_PAYMENTS_ENVIRONMENT'] as 'live_mode' | 'test_mode') ?? 'live_mode',
})

const PRODUCT_TIER_MAP: Record<string, string> = {
  [process.env['DODO_PRODUCT_SOLO']!]: 'solo',
  [process.env['DODO_PRODUCT_PRO']!]:  'pro',
  [process.env['DODO_PRODUCT_TEAM']!]: 'team',
}

// ─── CHECKOUT ────────────────────────────────────────────────
router.post('/checkout', async (req: Request, res: Response) => {
  try {
    const { productId, userEmail } = req.body

    if (!productId || !PRODUCT_TIER_MAP[productId]) {
      return res.status(400).json({ error: 'Geçersiz productId' })
    }
    if (!userEmail) {
      return res.status(400).json({ error: 'userEmail zorunlu' })
    }

    const session = await dodo.checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: { email: userEmail, name: userEmail },
      return_url: `${process.env['APP_URL'] ?? 'https://sovereign-engine.app'}/payment-success`,
    })

    return res.json({ checkoutUrl: (session as any).checkout_url })
  } catch (err: any) {
    console.error('[dodoRouter] checkout error:', err)
    return res.status(500).json({ error: 'Checkout oluşturulamadı' })
  }
})

// ─── WEBHOOK ─────────────────────────────────────────────────
router.post('/webhook', async (req: Request, res: Response) => {
  const webhookSecret = process.env['DODO_WEBHOOK_SECRET']!
  const wh = new Webhook(webhookSecret)

  try {
    const rawBody = (req as any).rawBody as string
    const webhookHeaders = {
      'webhook-id':        (req.headers['webhook-id'] as string)        ?? '',
      'webhook-signature': (req.headers['webhook-signature'] as string) ?? '',
      'webhook-timestamp': (req.headers['webhook-timestamp'] as string) ?? '',
    }

    const payload = await wh.verify(rawBody, webhookHeaders) as any
    const eventType: string = payload.event_type ?? payload.type ?? ''
    const data = payload.data ?? payload

    console.log('[dodoRouter] webhook event:', eventType)

    switch (eventType) {
      case 'subscription.active': {
        const customerId = data.customer?.customer_id ?? data.customer_id
        const productId  = data.product_id ?? data.items?.[0]?.product_id
        const tier       = PRODUCT_TIER_MAP[productId] ?? 'solo'
        await supabase
          .from('users')
          .update({ tier, dodo_customer_id: customerId, subscription_status: 'active' })
          .eq('email', data.customer?.email ?? '')
        break
      }
      case 'subscription.renewed': {
        const customerId = data.customer?.customer_id ?? data.customer_id
        await supabase
          .from('users')
          .update({ subscription_status: 'active' })
          .eq('dodo_customer_id', customerId)
        break
      }
      case 'subscription.cancelled':
      case 'subscription.expired': {
        const customerId = data.customer?.customer_id ?? data.customer_id
        await supabase
          .from('users')
          .update({ tier: 'free', subscription_status: 'cancelled' })
          .eq('dodo_customer_id', customerId)
        break
      }
      case 'subscription.on_hold': {
        const customerId = data.customer?.customer_id ?? data.customer_id
        await supabase
          .from('users')
          .update({ subscription_status: 'on_hold' })
          .eq('dodo_customer_id', customerId)
        break
      }
      default:
        console.log('[dodoRouter] unhandled event:', eventType)
    }

    return res.json({ received: true })
  } catch (err: any) {
    console.error('[dodoRouter] webhook verify failed:', err.message)
    return res.status(400).json({ error: 'Webhook doğrulanamadı' })
  }
})

// ─── PORTAL ──────────────────────────────────────────────────
router.get('/portal', async (req: Request, res: Response) => {
  try {
    const { email } = req.query

    if (!email) {
      return res.status(400).json({ error: 'email query param zorunlu' })
    }

    const { data: dbUser } = await supabase
      .from('users')
      .select('dodo_customer_id')
      .eq('email', email)
      .single()

    if (!dbUser?.dodo_customer_id) {
      return res.status(404).json({ error: 'Aktif abonelik bulunamadı' })
    }

    const portalUrl = `https://billing.dodopayments.com/portal?customer_id=${dbUser.dodo_customer_id}`
    return res.json({ portalUrl })
  } catch (err: any) {
    console.error('[dodoRouter] portal error:', err)
    return res.status(500).json({ error: 'Portal açılamadı' })
  }
})

export default router
