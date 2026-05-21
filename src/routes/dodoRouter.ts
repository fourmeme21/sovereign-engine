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

const TIER_PRODUCT_MAP: Record<string, string> = {
  solo: process.env['DODO_PRODUCT_SOLO']!,
  pro:  process.env['DODO_PRODUCT_PRO']!,
  team: process.env['DODO_PRODUCT_TEAM']!,
}

// ─── CHECKOUT ────────────────────────────────────────────────
router.post('/checkout', async (req: Request, res: Response) => {
  try {
    const { tier, userEmail, productId: rawProductId } = req.body

    const productId = rawProductId ?? TIER_PRODUCT_MAP[tier]

    if (!productId || !PRODUCT_TIER_MAP[productId]) {
      return res.status(400).json({
        error: 'Geçersiz tier veya productId',
        received: { tier, productId: rawProductId },
        valid_tiers: ['solo', 'pro', 'team'],
      })
    }
    if (!userEmail) {
      return res.status(400).json({ error: 'userEmail zorunlu' })
    }

    // user_id'yi webhook'ta kullanmak için metadata'ya ekle
    const { data: profile } = await supabase
      .from('user_profiles')
      .select('id')
      .eq('email', userEmail)
      .single()

    const session = await dodo.checkoutSessions.create({
      product_cart: [{ product_id: productId, quantity: 1 }],
      customer: { email: userEmail, name: userEmail },
      metadata: {
        user_id: profile?.id ?? '',
        tier: PRODUCT_TIER_MAP[productId] ?? tier,
      },
      return_url: `${process.env['APP_URL']}/junior/odeme-basarili`,
    } as any)

    return res.json({ checkoutUrl: (session as any).checkout_url })
  } catch (err: any) {
    console.error('[dodoRouter] checkout error:', err?.message ?? err)
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

      // ── Tek seferlik ödeme veya ilk abonelik ödemesi ─────────
      case 'payment.completed': {
        const userId     = data.metadata?.user_id
        const tier       = data.metadata?.tier ?? PRODUCT_TIER_MAP[data.product_id] ?? 'solo'
        const customerId = data.customer?.customer_id ?? data.customer_id

        if (!userId) {
          console.warn('[dodoRouter] payment.completed: metadata.user_id eksik', data)
          break
        }

        const { error } = await supabase
          .from('user_profiles')
          .update({
            tier,
            dodo_customer_id: customerId,
            subscription_status: 'active',
            updated_at: new Date().toISOString(),
          })
          .eq('id', userId)

        if (error) {
          console.error('[dodoRouter] payment.completed update error:', error)
        } else {
          console.log(`[dodoRouter] payment.completed: user ${userId} → ${tier}`)
        }
        break
      }

      // ── Abonelik aktif (yenileme dışı ilk aktivasyon) ────────
      case 'subscription.active': {
        const customerId = data.customer?.customer_id ?? data.customer_id
        const productId  = data.product_id ?? data.items?.[0]?.product_id
        const tier       = PRODUCT_TIER_MAP[productId] ?? 'solo'

        // Önce customer_id ile dene, yoksa email ile
        const { data: byCustomer } = await supabase
          .from('user_profiles')
          .select('id')
          .eq('dodo_customer_id', customerId)
          .single()

        if (byCustomer) {
          await supabase
            .from('user_profiles')
            .update({ tier, subscription_status: 'active', updated_at: new Date().toISOString() })
            .eq('dodo_customer_id', customerId)
        } else {
          await supabase
            .from('user_profiles')
            .update({ tier, dodo_customer_id: customerId, subscription_status: 'active', updated_at: new Date().toISOString() })
            .eq('email', data.customer?.email ?? '')
        }
        break
      }

      // ── Yenileme ─────────────────────────────────────────────
      case 'subscription.renewed': {
        const customerId = data.customer?.customer_id ?? data.customer_id
        await supabase
          .from('user_profiles')
          .update({ subscription_status: 'active', updated_at: new Date().toISOString() })
          .eq('dodo_customer_id', customerId)
        break
      }

      // ── İptal / süresi doldu ──────────────────────────────────
      case 'subscription.cancelled':
      case 'subscription.expired': {
        const customerId = data.customer?.customer_id ?? data.customer_id
        await supabase
          .from('user_profiles')
          .update({ tier: 'free', subscription_status: 'cancelled', updated_at: new Date().toISOString() })
          .eq('dodo_customer_id', customerId)
        console.log(`[dodoRouter] ${eventType}: customer ${customerId} → free`)
        break
      }

      // ── Beklemede ─────────────────────────────────────────────
      case 'subscription.on_hold': {
        const customerId = data.customer?.customer_id ?? data.customer_id
        await supabase
          .from('user_profiles')
          .update({ subscription_status: 'on_hold', updated_at: new Date().toISOString() })
          .eq('dodo_customer_id', customerId)
        break
      }

      // ── Ödeme başarısız ───────────────────────────────────────
      case 'payment.failed': {
        const customerId = data.customer?.customer_id ?? data.customer_id
        const userId     = data.metadata?.user_id
        console.warn('[dodoRouter] payment.failed:', {
          customerId,
          userId,
          reason: data.failure_reason ?? 'unknown',
        })
        // Tier düşürme yok — kullanıcı retry yapabilir
        // İleride: retry sayacı + email bildirimi eklenebilir
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
      .from('user_profiles')
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
