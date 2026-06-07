// codeQualityGuard.ts
// Amaç:    Claude kod çıktısını 4 katmandan geçirerek 90+ kalite skoru garantiler
// Bağlı:   aiProxy.ts → /chat handler
// Karar:   TB-12 — Session 33 / TB-13 — Session 34
// Dokunma: Eşik veya iterasyon limiti değiştirilecekse PASS_THRESHOLD ve MAX_ITERATIONS kontrol et

import Anthropic from '@anthropic-ai/sdk';
import { runSovereignLint, LintResult } from './sovereignLint';

const MAX_ITERATIONS = 3;
const PASS_THRESHOLD = 12;

// ─── TİPLER ──────────────────────────────────────────────────────────────────

export interface JudgeVerdict {
  passed: boolean;
  score: number;        // 0-100
  confidence: number;   // 0.0-1.0
  failed_checks: string[];
  todos: string[];
}

export interface QualityGuardResult {
  code: string;
  lintResult: LintResult;
  judgeVerdict: JudgeVerdict | null;
  iterations: number;
  passed: boolean;
  escalated: boolean;
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
Her kod çıktısında aşağıdaki 13 kural ZORUNLUDUR — kullanıcı "hızlıca yap" dese bile atlanamaz.

KALITE KURALLARI:
1. Tek fonksiyon max 20 satır — geçerse böl, gerekçe yaz
2. Her dosyanın başında niyet yorumu bloğu zorunlu
3. Edge case yorumu zorunlu — en az 3 senaryo
4. Math.random() / hardcode ID / placeholder yasak
5. Test: happy path + edge + failure — üçü zorunlu

GÜVENLİK KURALLARI (SSC):
SSC-1: Parametrize sorgu zorunlu
SSC-2: Secret kaynak koduna yazılamaz
SSC-3: req.body her zaman doğrulanır
SSC-4: TypeScript'te any yasak
SSC-5: Sessiz catch yasak
SSC-6: eval / new Function yasak
SSC-7: Sahiplik kontrolü zorunlu
SSC-8: Auth endpoint'te rate limit zorunlu

ÇIKTI FORMATI:
Sadece kod döndür — açıklama metni, markdown fence ekleme.`;
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

// ─── KATMAN 3A: LINT ─────────────────────────────────────────────────────────

function buildViolationReport(lintResult: LintResult, judgeVerdict: JudgeVerdict | null): string {
  const lines: string[] = [`Lint skoru: ${lintResult.score}/13`];

  lintResult.violations.forEach(v => {
    const loc = v.line ? ` (satır ${v.line})` : '';
    lines.push(`  ❌ [${v.rule}]${loc}: ${v.message}`);
  });

  if (judgeVerdict && !judgeVerdict.passed) {
    lines.push(`\nJudge skoru: ${judgeVerdict.score}/100 (confidence: ${judgeVerdict.confidence})`);
    judgeVerdict.failed_checks.forEach(c => lines.push(`  ❌ ${c}`));
    judgeVerdict.todos.forEach(t => lines.push(`  📝 ${t}`));
  }

  return lines.join('\n');
}

// ─── KATMAN 3B: ZERO-CONTEXT JUDGE ──────────────────────────────────────────
// Bu fonksiyon üretici modelden tamamen bağımsız çalışır:
// - Önceki mesaj geçmişi yok
// - Kodu kimin ürettiği bilgisi yok
// - Onay sinyali yok
// - JSON schema zorunlu — serbest yorum döndüremez

const JUDGE_SYSTEM_PROMPT = `Sen bağımsız bir kod denetçisisin.
Sana bir kod verilecek. Bu kodu aşağıdaki kriterlere göre değerlendir.

KRİTERLER:
- Fonksiyon boyutu: max 20 satır
- Niyet yorumu bloğu var mı
- Edge case ele alınmış mı (en az 3)
- Sahte veri (Math.random, hardcode) var mı
- Test coverage: happy + edge + failure
- SSC-1..8 güvenlik kuralları

ZORUNLU ÇIKTI — sadece bu JSON, başka hiçbir şey:
{
  "passed": true | false,
  "score": 0-100,
  "confidence": 0.0-1.0,
  "failed_checks": ["açıklama"],
  "todos": ["öneri"]
}

Kurallar:
- passed: score >= 80 ise true
- confidence: ne kadar emin olduğun — şüphe varsa 0.6 altı ver
- JSON dışında tek karakter bile yazma`;

async function judgeCode(
  client: Anthropic,
  code: string,
  model: string,
): Promise<JudgeVerdict> {
  // Sıfır context — sadece kodu görüyor
  const response = await client.messages.create({
    model,
    max_tokens: 512,
    system: JUDGE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: code }],
  });

  const block = response.content.find(b => b.type === 'text');
  const raw = block ? (block as { type: 'text'; text: string }).text.trim() : '';

  return parseJudgeVerdict(raw);
}

function parseJudgeVerdict(raw: string): JudgeVerdict {
  try {
    // Markdown fence varsa temizle — model bazen ekler
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    return {
      passed: Boolean(parsed.passed),
      score: typeof parsed.score === 'number' ? parsed.score : 0,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      failed_checks: Array.isArray(parsed.failed_checks) ? parsed.failed_checks : [],
      todos: Array.isArray(parsed.todos) ? parsed.todos : [],
    };
  } catch {
    // Parse başarısız → güvenli fallback: fail say, escalate et
    return {
      passed: false,
      score: 0,
      confidence: 0,
      failed_checks: ['Judge yanıtı parse edilemedi — ham: ' + raw.slice(0, 100)],
      todos: [],
    };
  }
}

// ─── KATMAN 4: TEST KONTROLÜ ─────────────────────────────────────────────────

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
  let lintResult: LintResult = {
    score: 0, maxScore: 13, passed: false, violations: [], warns: [], summary: '',
  };
  let judgeVerdict: JudgeVerdict | null = null;
  let iterations = 0;
  let violationReport: string | undefined;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    // Katman 1+2: enjeksiyon + üretim
    code = await generateCode(ctx.client, ctx.originalPrompt, ctx.model, violationReport);

    // Katman 3a: deterministik lint
    lintResult = runSovereignLint(code, ctx.filename);

    // Katman 3b: zero-context judge — sadece lint geçerse çalışır
    // Gerekçe: lint fail ederse zaten yeniden üretilecek,
    // judge çağrısı gereksiz API maliyeti olur
    if (lintResult.passed) {
      judgeVerdict = await judgeCode(ctx.client, code, ctx.model);
    }

    const bothPassed = lintResult.passed && (judgeVerdict?.passed ?? false);
    if (bothPassed) break;

    violationReport = buildViolationReport(lintResult, judgeVerdict);
    judgeVerdict = null; // Bir sonraki iterasyon için sıfırla
  }

  // Katman 4: test kontrolü
  const testWarning = buildTestWarning(code);
  if (testWarning && !lintResult.warns.some(w => w.rule === 'KALITE-5')) {
    lintResult.warns.push({ rule: 'KALITE-5', severity: 'WARN', message: testWarning });
  }

  const passed = lintResult.passed && (judgeVerdict?.passed ?? false);

  return {
    code,
    lintResult,
    judgeVerdict,
    iterations,
    passed,
    escalated: !passed,
  };
}
