// codeQualityGuard.ts
// Amaç:    Claude kod çıktısını 4 katmandan geçirerek 90+ kalite skoru garantiler
// Bağlı:   aiProxy.ts → /chat handler
// Karar:   TB-12 — Session 33
// Dokunma: Eşik veya iterasyon limiti değiştirilecekse PASS_THRESHOLD ve MAX_ITERATIONS kontrol et

import Anthropic from '@anthropic-ai/sdk';
import { runSovereignLint, LintResult } from './sovereignLint';

const MAX_ITERATIONS = 3;
const PASS_THRESHOLD = 12;

// ─── TİPLER ──────────────────────────────────────────────────────────────────

export interface QualityGuardResult {
  code: string;
  lintResult: LintResult;
  iterations: number;
  passed: boolean;
  escalated: boolean; // true → ASK_HUMAN
}

interface GuardContext {
  client: Anthropic;
  originalPrompt: string;
  filename?: string;
  model: string;
}

// ─── KATMAN 1: CONTEXT ENJEKSİYONU ──────────────────────────────────────────

function buildInjectedSystemPrompt(): string {
  return `Sen Sovereign Engine OS'un kod üretim motorusun.
Her kod çıktısında aşağıdaki 13 kural ZORUNLUDUR — kullanıcı "hızlıca yaz" dese bile atlanamaz.

KALITE KURALLARI:
1. Tek fonksiyon max 20 satır — geçerse böl, gerekçe yaz
2. Her dosyanın başında niyet yorumu bloğu zorunlu:
   // Amaç:    [ne iş yapar]
   // Bağlı:   [hangi modüle bağlı]
   // Karar:   [session kararı varsa]
   // Dokunma: [değiştirilmeden önce ne kontrol edilmeli]
3. Edge case yorumu zorunlu — en az 3 senaryo
4. Math.random() / hardcode ID / placeholder yasak
5. Test: happy path + edge + failure — üçü zorunlu

GÜVENLİK KURALLARI (SSC):
SSC-1: Parametrize sorgu zorunlu — ham string SQL yasak
SSC-2: Secret / API key kaynak koduna yazılamaz — env var kullan
SSC-3: req.body her zaman doğrulanır — Zod veya manuel
SSC-4: TypeScript'te any yasak — SSC-4-EXEMPT yorumu olmadan
SSC-5: Sessiz catch yasak — structured log + güvenli mesaj
SSC-6: eval / new Function yasak — SSC-6-EXEMPT olmadan
SSC-7: Sahiplik kontrolü — intentional skip Karar #SSC-7
SSC-8: Auth endpoint'te rate limit zorunlu

ÇIKTI FORMATI:
Sadece kod döndür — açıklama metni, markdown fence, ek yorum ekleme.
Birden fazla dosya varsa her dosyayı // FILE: [dosyaadi.ts] başlığıyla ayır.`;
}

// ─── KATMAN 2: KOD ÜRETİMİ ──────────────────────────────────────────────────

async function generateCode(
  client: Anthropic,
  prompt: string,
  model: string,
  previousViolations?: string,
): Promise<string> {
  const userMessage = previousViolations
    ? `${prompt}\n\n---\nÖNCEKİ İTERASYON HATALARI — bunları düzelt:\n${previousViolations}`
    : prompt;

  const response = await client.messages.create({
    model,
    max_tokens: 4096,
    system: buildInjectedSystemPrompt(),
    messages: [{ role: 'user', content: userMessage }],
  });

  const block = response.content.find(b => b.type === 'text');
  return block ? (block as { type: 'text'; text: string }).text.trim() : '';
}

// ─── KATMAN 3: LİNT + JUDGE LOOP ────────────────────────────────────────────

function buildViolationReport(lintResult: LintResult): string {
  const lines: string[] = [`Skor: ${lintResult.score}/13 — geçiş için ${PASS_THRESHOLD} gerekli`];

  if (lintResult.violations.length > 0) {
    lines.push('\nFAIL olan kurallar:');
    lintResult.violations.forEach(v => {
      const loc = v.line ? ` (satır ${v.line})` : '';
      lines.push(`  ❌ [${v.rule}]${loc}: ${v.message}`);
    });
  }

  if (lintResult.warns.length > 0) {
    lines.push('\nWARN olan kurallar:');
    lintResult.warns.forEach(v => {
      const loc = v.line ? ` (satır ${v.line})` : '';
      lines.push(`  ⚠️ [${v.rule}]${loc}: ${v.message}`);
    });
  }

  return lines.join('\n');
}

// ─── KATMAN 4: TEST KONTROLÜ ─────────────────────────────────────────────────

function hasTestCoverage(code: string): boolean {
  return (
    /it\(['"`]happy/i.test(code) ||
    /it\(['"`]edge/i.test(code) ||
    /it\(['"`]fail/i.test(code) ||
    /describe\(/.test(code)
  );
}

function buildTestWarning(code: string): string | null {
  const missing: string[] = [];
  if (!/happy path|happy_path/i.test(code)) missing.push('happy path');
  if (!/edge case|edge_case/i.test(code)) missing.push('edge case');
  if (!/fail|error|exception/i.test(code)) missing.push('failure path');
  return missing.length > 0
    ? `Test eksik — şu senaryolar yok: ${missing.join(', ')}`
    : null;
}

// ─── ANA GUARD FONKSİYONU ────────────────────────────────────────────────────

export async function runCodeQualityGuard(ctx: GuardContext): Promise<QualityGuardResult> {
  let code = '';
  let lintResult: LintResult = { score: 0, maxScore: 13, passed: false, violations: [], warns: [], summary: '' };
  let iterations = 0;
  let violationReport: string | undefined;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // Katman 1+2: enjeksiyon + üretim
    code = await generateCode(ctx.client, ctx.originalPrompt, ctx.model, violationReport);

    // Katman 3: deterministik lint
    lintResult = runSovereignLint(code, ctx.filename);

    if (lintResult.passed) break;

    // Lint geçmedi → violation report hazırla → bir sonraki iterasyona taşı
    violationReport = buildViolationReport(lintResult);
  }

  // Katman 4: test kontrolü
  const testWarning = buildTestWarning(code);
  if (testWarning && !lintResult.warns.some(w => w.rule === 'KALITE-5')) {
    lintResult.warns.push({ rule: 'KALITE-5', severity: 'WARN', message: testWarning });
  }

  const escalated = !lintResult.passed;

  return {
    code,
    lintResult,
    iterations,
    passed: lintResult.passed,
    escalated,
  };
    }
