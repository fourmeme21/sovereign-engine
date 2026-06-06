/**
 * engine/src/lib/policyEngine.ts
 *
 * Amaç:    Dashboard /api/apply endpoint'i için policy değerlendirme ve JWT token üretimi.
 *          Hard Lock kuralları (HL-1/2/3) + CLI validation + execution token akışı.
 * Bağlı:   server/index.ts → /api/apply handler
 * Karar:   server/index.ts'ten ayrıldı — tek sorumluluk (Session 11 refactor)
 * Dokunma: Bu dosya değiştirilmeden önce ARCHITECTURE.md §3 (Policy Kernel) okunmalı.
 *          Hard Lock sırası değiştirilemez: HL-1 → HL-2 → HL-3 → CLI → PERMIT
 */

import { execFile }  from 'child_process'
import { promisify } from 'util'
import { v4 as uuid } from 'uuid'
import fs   from 'fs'
import path from 'path'
import jwt  from 'jsonwebtoken'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// TİPLER
// ---------------------------------------------------------------------------

export type Verdict     = 'PERMIT' | 'DENY' | 'ASK_HUMAN'
export type Criticality = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

export interface PatchInput {
  action?:      string
  target?:      string
  criticality?: Criticality
  payload?:     Record<string, unknown>
  session_id?:  string
  agent?:       string
  timestamp?:   string
}

export interface PolicyResult {
  verdict: Verdict
  policy:  string
  reason:  string
  token:   string | null
}

// ---------------------------------------------------------------------------
// HARD LOCK SABİTLERİ
// ---------------------------------------------------------------------------

const IMMUTABLE_RESOURCES = ['system.config', 'audit.log', 'policy.kernel'] as const

// ---------------------------------------------------------------------------
// JWT TOKEN ÜRETİMİ
// ---------------------------------------------------------------------------

/**
 * TOCTOU koruması: 30 saniye expiry.
 * JWT_SECRET dışarıdan alınır — bu fonksiyon secret tutmaz.
 */
export function issueToken(patch: PatchInput, jwtSecret: string): string {
  const decisionId = uuid()
  const now        = Math.floor(Date.now() / 1000)

  const payload = {
    decision_id: decisionId,
    actor_id:    patch.session_id ?? 'unknown',
    action_name: patch.action    ?? 'EXECUTE_ACTION',
    scope:       `${patch.target ?? 'DEFAULT'}:${patch.action ?? 'execute'}`,
    issued_at:   now,
    expires_at:  now + 30,
  }

  return jwt.sign(payload, jwtSecret, { algorithm: 'HS256', expiresIn: 30 })
}

// ---------------------------------------------------------------------------
// CLI VALIDATION (async — execSync kaldırıldı)
// ---------------------------------------------------------------------------

/**
 * CLI validate komutunu async olarak çalıştırır.
 * execSync yerine execFile — event loop bloklanmaz.
 *
 * Edge case'ler:
 *   - CLI dist yoksa → null döner, caller PERMIT'e geçer
 *   - CLI timeout (5s) → null döner, loglama yapılır
 *   - Malformed JSON çıktı → null döner, loglama yapılır
 */
async function runCliValidation(patch: PatchInput): Promise<PolicyResult | null> {
  const cliPath = path.join(process.cwd(), 'dist', 'cli', 'index.js')

  if (!fs.existsSync(cliPath)) return null

  const tmpFile = `/tmp/patch-${uuid()}.json`

  try {
    fs.writeFileSync(tmpFile, JSON.stringify(patch))

    const { stdout } = await execFileAsync(
      'node',
      [cliPath, 'validate', tmpFile],
      { timeout: 5000 },
    )

    const parsed = JSON.parse(stdout)

    return {
      verdict: parsed.verdict    ?? 'PERMIT',
      policy:  parsed.policy_id  ?? 'POL-007',
      reason:  parsed.reason     ?? 'CLI validation passed',
      token:   parsed.execution_token ?? null,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[policyEngine] CLI validation hatası: ${msg}`)
    return null
  } finally {
    // Tmp dosyayı her durumda temizle
    try { fs.unlinkSync(tmpFile) } catch { /* zaten silinmiş olabilir */ }
  }
}

// ---------------------------------------------------------------------------
// ANA DEĞERLENDİRME
// ---------------------------------------------------------------------------

/**
 * Hard Lock → CLI → PERMIT sırası — değiştirilemez.
 *
 * Edge case'ler:
 *   1. IMMUTABLE hedef + MODIFY_STATE → DENY (HL-1)
 *   2. Negatif amount → DENY (HL-2)
 *   3. CRITICAL criticality → ASK_HUMAN (HL-3)
 *   4. CLI mevcut → async validate
 *   5. CLI yok / hata → PERMIT + token
 */
export async function evaluatePatch(
  patch:     PatchInput,
  jwtSecret: string,
): Promise<PolicyResult> {
  const target = patch.target ?? ''

  // HL-1: Immutable state guard
  if (patch.action === 'MODIFY_STATE' && IMMUTABLE_RESOURCES.some(r => target.includes(r))) {
    return {
      verdict: 'DENY',
      policy:  'POL-001 (HL-1)',
      reason:  `HL-1: Immutable resource '${target}' is write-protected`,
      token:   null,
    }
  }

  // HL-2: Non-negative value guard
  const amount = patch.payload?.['amount'] as number | undefined
  if (typeof amount === 'number' && amount < 0) {
    return {
      verdict: 'DENY',
      policy:  'POL-002 (HL-2)',
      reason:  `HL-2: Negative amount (${amount}) rejected`,
      token:   null,
    }
  }

  // HL-3: Critical escalation
  if (patch.criticality === 'CRITICAL') {
    return {
      verdict: 'ASK_HUMAN',
      policy:  'POL-003 (HL-3)',
      reason:  'HL-3: Critical risk level requires human review',
      token:   null,
    }
  }

  // CLI validation (async — event loop bloklanmaz)
  const cliResult = await runCliValidation(patch)
  if (cliResult) {
    return {
      ...cliResult,
      token: cliResult.token ?? issueToken(patch, jwtSecret),
    }
  }

  // Fallback: tüm hard lock'lar geçti, CLI yok → PERMIT
  return {
    verdict: 'PERMIT',
    policy:  'POL-007',
    reason:  'All checks passed - execution token issued',
    token:   issueToken(patch, jwtSecret),
  }
}

// ---------------------------------------------------------------------------
// RISK SKORU HESAPLAMA
// ---------------------------------------------------------------------------

/**
 * Criticality → integer risk skoru.
 * Supabase decisions tablosu için.
 */
export function calcRiskScore(criticality: Criticality | undefined): number {
  switch (criticality) {
    case 'CRITICAL': return 9
    case 'HIGH':     return 7
    case 'MEDIUM':   return 5
    default:         return 2
  }
  }
  
