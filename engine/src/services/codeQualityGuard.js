// codeQualityGuard.ts
// Amaç:    Chat'in ürettiği kodu 3 katmandan geçirerek 90+ kalite skoru garantiler
// Bağlı:   aiProxy.ts → /chat handler → applyCodeQualityGuard()
// Karar:   TB-12 — Session 33 / TB-13 — Session 34 / TB-16 — Session [N]
// Dokunma: JUDGE_MODEL değiştirilmek istenirse env var'a bak, sabit değiştirme
//          PASS_THRESHOLD ve MAX_ITERATIONS eşik değerleri — değiştirmeden önce test_matrix kontrol et
//          judgeCode() sıfır context ile çalışır — önceki mesaj geçmişi KESİNLİKLE verilmez
//
// TB-16 değişiklikleri:
//   - generateCode() kaldırıldı — chat'in rawReply'ı direkt judge'a verilir
//   - judgeCode() artık JUDGE_MODEL (haiku) kullanır — üretici modelden bağımsız
//   - FAIL durumunda regenerateCode() sonnet'e violations göndererek düzelttirir
//   - Env: JUDGE_MODEL (varsayılan: claude-haiku-4-5-20251001)
//   - Env: GENERATOR_MODEL (varsayılan: AI_MODEL)
import { runSovereignLint } from './sovereignLint.js';
// ─── SABITLER ────────────────────────────────────────────────────────────────
const MAX_ITERATIONS = 3;
const PASS_THRESHOLD = 12;
// TB-16: Judge bağımsız model — üretici modelden farklı olmalı
// Edge: JUDGE_MODEL env eksikse haiku'ya düşer — aynı modelle judge yapılmaz
const JUDGE_MODEL = process.env['JUDGE_MODEL'] ?? 'claude-haiku-4-5-20251001';
const GENERATOR_MODEL = process.env['GENERATOR_MODEL'] ?? process.env['AI_MODEL'] ?? 'claude-sonnet-4-5';
// ─── KATMAN 1: ZERO-CONTEXT JUDGE ────────────────────────────────────────────
// Amaç:    Chat çıktısını üretici modelden bağımsız olarak değerlendirir
// Bağlı:   runCodeQualityGuard() — lint geçtikten sonra çağrılır
// Karar:   TB-13, TB-16
// Dokunma: System prompt değiştirilecekse JUDGE_SYSTEM_PROMPT sabitine bak
//          originalPrompt eklendi — judge niyet-kod eşleşmesini de kontrol eder
//
// Zero-context garantisi:
//   - model: JUDGE_MODEL (haiku) — üretici model (sonnet) değil
//   - messages: sadece [{ role: 'user', content: originalPrompt + code }]
//   - geçmiş mesajlar KESİNLİKLE verilmez
//
// Edge case'ler:
//   1. JSON yerine markdown fence → parseJudgeVerdict temizler
//   2. Geçerli JSON üretilmez → fail-closed (passed: false, score: 0)
//   3. passed: true ama confidence < 0.5 → escalated: true olur
//   4. API timeout / hata → fail-closed fallback
//   5. JUDGE_MODEL = GENERATOR_MODEL → konsola uyarı yaz, devam et
const JUDGE_SYSTEM_PROMPT = `Sen bağımsız bir kod denetçisisin.
Sana kullanıcının isteği ve üretilen kod verilecek.
Bu kodu aşağıdaki kriterlere göre değerlendir.

KRİTER 1 — NİYET UYUMU:
Kod kullanıcının istediği şeyi yapıyor mu?
Eksik veya fazladan işlev var mı?

KRİTER 2 — SOVEREIGN MİMARİ AKIŞI:
Kod validate → policy → execute akışını kırıyor mu?
fail-closed prensibi ihlal ediliyor mu?
execution_token gerektiği halde atlandı mı?
DENY döndürülüyor ama soft steer/redirect mesajı yok mu?

KRİTER 3 — KOD KALİTESİ:
Fonksiyon boyutu max 20 satır mı?
Niyet yorumu bloğu var mı? (Amaç: / Bağlı:)
Edge case ele alınmış mı (en az 3)?
Sahte veri (Math.random, hardcode) var mı?
Test coverage: happy + edge + failure

KRİTER 4 — GÜVENLİK (SSC-1..8):
SQL enjeksiyonu riski?
Hardcode secret?
Doğrulanmamış girdi?
any tipi?
Sessiz catch?
eval / new Function?
Sahiplik kontrolü eksik?
Auth endpoint rate limit yok?

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
- confidence: şüphe varsa 0.6 altı ver
- JSON dışında tek karakter bile yazma`;
async function judgeCode(client, originalPrompt, code) {
    // Edge: aynı model kullanılıyorsa uyar — TB-16 prensibi
    if (JUDGE_MODEL === GENERATOR_MODEL) {
        console.warn('[judgeCode] ⚠️ JUDGE_MODEL === GENERATOR_MODEL — bağımsızlık zayıf. ' +
            'JUDGE_MODEL env variable farklı bir modele ayarlanmalı.');
    }
    try {
        const response = await client.messages.create({
            model: JUDGE_MODEL,
            max_tokens: 512,
            system: JUDGE_SYSTEM_PROMPT,
            messages: [{
                    role: 'user',
                    // TB-16: originalPrompt eklendi — niyet-kod eşleşmesi kontrol edilebilsin
                    content: `KULLANICI İSTEĞİ:\n${originalPrompt}\n\nÜRETİLEN KOD:\n${code}`,
                }],
        });
        const block = response.content.find(b => b.type === 'text');
        const raw = block ? block.text.trim() : '';
        return parseJudgeVerdict(raw);
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[judgeCode] API hatası — fail-closed fallback:', msg);
        return {
            passed: false,
            score: 0,
            confidence: 0,
            failed_checks: [`Judge API hatası: ${msg.slice(0, 100)}`],
            todos: [],
        };
    }
}
function parseJudgeVerdict(raw) {
    try {
        const clean = raw.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(clean);
        return {
            passed: Boolean(parsed.passed),
            score: typeof parsed.score === 'number' ? Math.min(100, Math.max(0, parsed.score)) : 0,
            confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0,
            failed_checks: Array.isArray(parsed.failed_checks) ? parsed.failed_checks : [],
            todos: Array.isArray(parsed.todos) ? parsed.todos : [],
        };
    }
    catch {
        return {
            passed: false,
            score: 0,
            confidence: 0,
            failed_checks: ['Judge yanıtı parse edilemedi — ham: ' + raw.slice(0, 100)],
            todos: [],
        };
    }
}
// ─── KATMAN 2: YENİDEN ÜRETİM (sadece FAIL durumunda) ───────────────────────
// Amaç:    Judge FAIL verdiyse sonnet'e violations göndererek düzelttirir
// Bağlı:   runCodeQualityGuard() — judge FAIL → bu fonksiyon çağrılır
// Karar:   TB-16
// Dokunma: GENERATOR_MODEL değiştirilmek istenirse env var'a bak
//
// Edge case'ler:
//   1. API hatası → orijinal kod korunur, escalated: true
//   2. Düzeltilmiş kod boş gelirse → orijinal kod korunur
const REGENERATION_SYSTEM_PROMPT = `Sen Sovereign Engine OS'un kod üretim motorusun.
Sana önceki kod üretiminin hataları verilecek.
Bu hataları düzelterek kodu yeniden üret.

SOVEREIGN STANDARTLARI (zorunlu):
1. Tek fonksiyon max 20 satır — geçerse böl
2. Her dosyanın başında niyet yorumu bloğu:
   // Amaç:    [ne iş yapar]
   // Bağlı:   [hangi modüle bağlı]
   // Karar:   [session kararı varsa]
   // Dokunma: [değiştirilmeden önce ne kontrol edilmeli]
3. Edge case yorumu — en az 3 senaryo
4. Math.random() / hardcode ID / placeholder yasak
5. Test: happy path + edge + failure — üçü zorunlu
6. SSC-1..8 güvenlik kuralları
7. fail-closed: şüpheli durumda DENY
8. Her DENY bir soft steer mesajı içermeli

ÇIKTI FORMATI:
Sadece kod döndür — açıklama metni, markdown fence, ek yorum ekleme.`;
async function regenerateCode(client, originalPrompt, previousCode, violationReport) {
    try {
        const response = await client.messages.create({
            model: GENERATOR_MODEL,
            max_tokens: 4096,
            system: REGENERATION_SYSTEM_PROMPT,
            messages: [{
                    role: 'user',
                    content: `KULLANICI İSTEĞİ:\n${originalPrompt}\n\nÖNCEKİ KOD:\n${previousCode}\n\n---\nDÜZELTİLMESİ GEREKEN HATALAR:\n${violationReport}`,
                }],
        });
        const block = response.content.find(b => b.type === 'text');
        return block ? block.text.trim() : previousCode;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn('[regenerateCode] API hatası — önceki kod korunuyor:', msg);
        return previousCode;
    }
}
// ─── KATMAN 3: VİOLATION RAPORU ─────────────────────────────────────────────
function buildViolationReport(lintResult, judgeVerdict) {
    const lines = [
        `Lint skoru: ${lintResult.score}/13 — geçiş için ${PASS_THRESHOLD} gerekli`,
    ];
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
    if (judgeVerdict && !judgeVerdict.passed) {
        lines.push(`\nJudge skoru: ${judgeVerdict.score}/100 (confidence: ${judgeVerdict.confidence})`);
        judgeVerdict.failed_checks.forEach(c => lines.push(`  ❌ ${c}`));
        judgeVerdict.todos.forEach(t => lines.push(`  📝 ${t}`));
    }
    return lines.join('\n');
}
// ─── ANA GUARD FONKSİYONU ────────────────────────────────────────────────────
// Akış (TB-16):
//   1. rawReply'ı al — yeniden üretim yok
//   2. Lint — deterministik kural kontrolü
//   3. Lint PASS → judge (haiku, zero-context, originalPrompt dahil)
//   4. Judge PASS → döndür
//   5. Judge FAIL → violations raporu → regenerateCode (sonnet) → 2'ye dön
//   6. MAX_ITERATIONS aşılırsa → escalated: true
export async function runCodeQualityGuard(ctx) {
    let code = ctx.rawReply;
    let lintResult = { score: 0, maxScore: 13, passed: false, violations: [], warns: [], summary: '' };
    let judgeVerdict = null;
    let iterations = 0;
    while (iterations < MAX_ITERATIONS) {
        iterations++;
        // Katman lint: deterministik kural kontrolü
        lintResult = runSovereignLint(code, ctx.filename);
        if (lintResult.passed) {
            // Katman judge: haiku ile bağımsız semantik değerlendirme
            // Gerekçe: lint fail → zaten yeniden üretilecek, judge API maliyeti gereksiz
            judgeVerdict = await judgeCode(ctx.client, ctx.originalPrompt, code);
        }
        const bothPassed = lintResult.passed && (judgeVerdict?.passed ?? false);
        if (bothPassed)
            break;
        // Son iterasyona geldik — döngüden çık, escalate et
        if (iterations >= MAX_ITERATIONS)
            break;
        // Violations raporu → sonnet düzeltir
        const violationReport = buildViolationReport(lintResult, judgeVerdict);
        code = await regenerateCode(ctx.client, ctx.originalPrompt, code, violationReport);
        judgeVerdict = null;
    }
    const passed = lintResult.passed && (judgeVerdict?.passed ?? false);
    const escalated = !passed;
    // Low confidence: passed: true ama judge emin değil → escalate
    const lowConfidence = judgeVerdict?.passed === true && (judgeVerdict?.confidence ?? 1) < 0.5;
    return {
        code,
        lintResult,
        judgeVerdict,
        iterations,
        passed: passed && !lowConfidence,
        escalated: escalated || lowConfidence,
    };
}
//# sourceMappingURL=codeQualityGuard.js.map