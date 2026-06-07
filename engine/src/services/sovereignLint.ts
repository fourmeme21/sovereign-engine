// sovereignLint.ts
// Amaç:    Claude çıktısını 13 kalite + SSC kuralına göre deterministik olarak puanlar
// Bağlı:   codeQualityGuard.ts → aiProxy.ts
// Karar:   TB-12 — Session 33
// Dokunma: Kural eşiği değiştirilmeden önce codeQualityGuard.ts'deki PASS_THRESHOLD kontrol edilmeli

export interface LintViolation {
  rule: string;
  severity: 'FAIL' | 'WARN';
  file?: string;
  line?: number;
  message: string;
}

export interface LintResult {
  score: number;
  maxScore: number;
  passed: boolean;
  violations: LintViolation[];
  warns: LintViolation[];
  summary: string;
}

// ─── KURAL AĞIRLIKLARI ───────────────────────────────────────────────────────

const PASS_THRESHOLD = 12; // 12/13 = %92 → 90+ hedef
const MAX_FUNCTION_LINES = 20;

// SSC-7 intentional skip — Karar #SSC-7
const INTENTIONAL_WARN_RULES = new Set(['SSC-7']);

// ─── YARDIMCI FONKSİYONLAR ──────────────────────────────────────────────────

function extractLines(code: string): string[] {
  return code.split('\n');
}

function stripComments(line: string): string {
  return line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '').trim();
}

function isFunctionStart(line: string): boolean {
  const stripped = stripComments(line);
  return (
    /^(export\s+)?(async\s+)?function\s+\w+/.test(stripped) ||
    /^(export\s+)?(const|let)\s+\w+\s*=\s*(async\s+)?\(/.test(stripped) ||
    /^(public|private|protected|static)?\s*(async\s+)?\w+\s*\(/.test(stripped)
  );
}

function isArrowSingleLine(line: string): boolean {
  return /=>\s*[^{]/.test(line);
}

// ─── KURAL 1: FONKSİYON BOYUTU ──────────────────────────────────────────────

function checkFunctionSize(lines: string[]): LintViolation[] {
  const violations: LintViolation[] = [];
  let inFunction = false;
  let braceDepth = 0;
  let functionStart = 0;
  let functionName = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (!inFunction && isFunctionStart(line)) {
      if (isArrowSingleLine(line)) continue;
      inFunction = true;
      functionStart = i + 1;
      const match = line.match(/function\s+(\w+)|const\s+(\w+)|(\w+)\s*\(/);
      functionName = match ? (match[1] || match[2] || match[3] || 'anonymous') : 'anonymous';
      braceDepth = 0;
    }

    if (inFunction) {
      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;

      if (braceDepth <= 0 && i > functionStart) {
        const size = i - functionStart + 1;
        if (size > MAX_FUNCTION_LINES) {
          violations.push({
            rule: 'KALITE-1',
            severity: 'FAIL',
            line: functionStart,
            message: `"${functionName}" fonksiyonu ${size} satır — max ${MAX_FUNCTION_LINES} satır. Bölünmeli.`,
          });
        }
        inFunction = false;
      }
    }
  }

  return violations;
}

// ─── KURAL 2: NİYET YORUMU ──────────────────────────────────────────────────

function checkIntentComment(code: string): LintViolation[] {
  const hasAmaç = /\/\/\s*Amaç:/m.test(code);
  const hasBağlı = /\/\/\s*Bağlı:/m.test(code);

  if (!hasAmaç || !hasBağlı) {
    return [{
      rule: 'KALITE-2',
      severity: 'FAIL',
      line: 1,
      message: 'Niyet yorumu bloğu eksik — Amaç: ve Bağlı: alanları zorunlu.',
    }];
  }
  return [];
}

// ─── KURAL 3: EDGE CASE YORUMU ──────────────────────────────────────────────

function checkEdgeCase(code: string): LintViolation[] {
  const hasEdge = /\/\/\s*(edge|Edge|EDGE|kenar|sınır)/m.test(code);
  if (!hasEdge) {
    return [{
      rule: 'KALITE-3',
      severity: 'WARN',
      message: 'Edge case yorumu bulunamadı — en az 3 senaryo bekleniyor.',
    }];
  }
  return [];
}

// ─── KURAL 4: SAHTE VERİ ────────────────────────────────────────────────────

function checkFakeData(lines: string[]): LintViolation[] {
  const violations: LintViolation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/Math\.random\(\)/.test(line)) {
      violations.push({
        rule: 'KALITE-4',
        severity: 'WARN',
        line: i + 1,
        message: 'Math.random() production\'da sahte veri üretir — gerçek değeri nereden alacağız?',
      });
    }
    if (/['"`]TODO:\s*PROD/i.test(line)) continue; // işaretlenmiş, geçer
    if (/hardcode|placeholder|dummy|fake/i.test(line) && !/\/\//m.test(line.split('hardcode')[0])) {
      violations.push({
        rule: 'KALITE-4',
        severity: 'WARN',
        line: i + 1,
        message: 'Hardcode / placeholder tespit edildi — production\'da gerçek değerle değiştirilmeli.',
      });
    }
  }

  return violations;
}

// ─── KURAL 5: TEST VARLIGI ──────────────────────────────────────────────────

function checkTestExists(code: string): LintViolation[] {
  const hasTest =
    /it\(|test\(|describe\(/.test(code) ||
    /\.test\.ts|\.spec\.ts/.test(code);

  if (!hasTest) {
    return [{
      rule: 'KALITE-5',
      severity: 'WARN',
      message: 'Test bulunamadı — happy path + edge + failure zorunlu.',
    }];
  }
  return [];
}

// ─── SSC-1: SQL ENJEKSİYON ──────────────────────────────────────────────────

function checkSSC1(lines: string[]): LintViolation[] {
  const violations: LintViolation[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/`.*\$\{.*\}.*`/.test(lines[i]) && /query|select|insert|update|delete/i.test(lines[i])) {
      violations.push({
        rule: 'SSC-1',
        severity: 'FAIL',
        line: i + 1,
        message: 'Ham string SQL sorgusu — parametrize sorguya dönüştür.',
      });
    }
  }
  return violations;
}

// ─── SSC-2: GİZLİ VERİ ──────────────────────────────────────────────────────

function checkSSC2(lines: string[]): LintViolation[] {
  const violations: LintViolation[] = [];
  const secretPattern = /sk_live_|sk_test_|api_key\s*=\s*['"`][a-zA-Z0-9]{16,}|secret\s*=\s*['"`][a-zA-Z0-9]{16,}/i;

  for (let i = 0; i < lines.length; i++) {
    if (secretPattern.test(lines[i]) && !lines[i].trim().startsWith('//')) {
      violations.push({
        rule: 'SSC-2',
        severity: 'FAIL',
        line: i + 1,
        message: 'Hardcode secret tespit edildi — environment variable kullan.',
      });
    }
  }
  return violations;
}

// ─── SSC-3: GİRDİ DOĞRULAMA ─────────────────────────────────────────────────

function checkSSC3(code: string): LintViolation[] {
  const hasReqBody = /req\.body/.test(code);
  const hasValidation = /safeParse|parse\(|z\.object|joi\.|yup\.|validate\(/.test(code);

  if (hasReqBody && !hasValidation) {
    return [{
      rule: 'SSC-3',
      severity: 'FAIL',
      message: 'req.body kullanılıyor ama validasyon yok — Zod / manuel kontrol zorunlu.',
    }];
  }
  return [];
}

// ─── SSC-4: ANY TİP ─────────────────────────────────────────────────────────

function checkSSC4(lines: string[]): LintViolation[] {
  const violations: LintViolation[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/:\s*any\b/.test(lines[i]) && !/SSC-4-EXEMPT/.test(lines[i])) {
      violations.push({
        rule: 'SSC-4',
        severity: 'WARN',
        line: i + 1,
        message: 'any tipi tespit edildi — tip tanımı ekle veya SSC-4-EXEMPT yorum ekle.',
      });
    }
  }
  return violations;
}

// ─── SSC-5: HATA YÖNETİMİ ───────────────────────────────────────────────────

function checkSSC5(code: string): LintViolation[] {
  const hasSilentCatch = /catch\s*\([^)]*\)\s*\{\s*\}/.test(code);
  const hasRawError = /res\..*err\.message/.test(code);

  if (hasSilentCatch) {
    return [{
      rule: 'SSC-5',
      severity: 'WARN',
      message: 'Sessiz catch bloğu — structured log + güvenli mesaj ekle.',
    }];
  }
  if (hasRawError) {
    return [{
      rule: 'SSC-5',
      severity: 'WARN',
      message: 'İç hata mesajı kullanıcıya dönüyor — güvenli mesaj kullan.',
    }];
  }
  return [];
}

// ─── SSC-6: DYNAMIC EXEC ────────────────────────────────────────────────────

function checkSSC6(lines: string[]): LintViolation[] {
  const violations: LintViolation[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (/\beval\(|new Function\(/.test(lines[i]) && !/SSC-6-EXEMPT/.test(lines[i])) {
      violations.push({
        rule: 'SSC-6',
        severity: 'WARN',
        line: i + 1,
        message: 'eval / new Function tespit edildi — SSC-6-EXEMPT yorumu ekle veya kaldır.',
      });
    }
  }
  return violations;
}

// ─── SSC-7: YETKİLENDİRME (intentional warn) ────────────────────────────────

function checkSSC7(code: string): LintViolation[] {
  const hasProtectedRoute = /from\('.*'\)\.select/.test(code);
  const hasOwnershipCheck = /\.eq\('user_id'|\.eq\("user_id"/.test(code);

  if (hasProtectedRoute && !hasOwnershipCheck) {
    return [{
      rule: 'SSC-7',
      severity: 'WARN', // intentional — Karar #SSC-7, anonymous access korunuyor
      message: 'Sahiplik kontrolü eksik — SSC-7 intentional skip (Karar #SSC-7).',
    }];
  }
  return [];
}

// ─── SSC-8: RATE LIMIT ──────────────────────────────────────────────────────

function checkSSC8(code: string): LintViolation[] {
  const hasAuthRoute = /router\.(post|put)\s*\(\s*['"`]\/(login|register|reset|auth)/.test(code);
  const hasRateLimit = /rateLimit\(|rateLimiter|limiter/.test(code);

  if (hasAuthRoute && !hasRateLimit) {
    return [{
      rule: 'SSC-8',
      severity: 'FAIL',
      message: 'Auth endpoint\'te rate limit yok — express-rate-limit ekle.',
    }];
  }
  return [];
}

// ─── ANA LINT FONKSİYONU ────────────────────────────────────────────────────

export function runSovereignLint(code: string, filename?: string): LintResult {
  const lines = extractLines(code);
  const allViolations: LintViolation[] = [];

  // Kalite kuralları
  allViolations.push(...checkFunctionSize(lines));
  allViolations.push(...checkIntentComment(code));
  allViolations.push(...checkEdgeCase(code));
  allViolations.push(...checkFakeData(lines));
  allViolations.push(...checkTestExists(code));

  // SSC kuralları
  allViolations.push(...checkSSC1(lines));
  allViolations.push(...checkSSC2(lines));
  allViolations.push(...checkSSC3(code));
  allViolations.push(...checkSSC4(lines));
  allViolations.push(...checkSSC5(code));
  allViolations.push(...checkSSC6(lines));
  allViolations.push(...checkSSC7(code));
  allViolations.push(...checkSSC8(code));

  const fails = allViolations.filter(v => v.severity === 'FAIL');
  const warns = allViolations.filter(v => v.severity === 'WARN');

  // Her benzersiz kural bir puan → ihlal varsa düşür
  const failedRules = new Set(fails.map(v => v.rule));
  const warnRules = new Set(warns.map(v => v.rule));

  // SSC-7 her zaman warn — fail listesinden çıkar
  failedRules.forEach(r => { if (INTENTIONAL_WARN_RULES.has(r)) failedRules.delete(r); });

  const score = 13 - failedRules.size;
  const passed = score >= PASS_THRESHOLD;

  const summary = buildSummary(score, failedRules, warnRules, filename);

  return { score, maxScore: 13, passed, violations: fails, warns, summary };
}

function buildSummary(
  score: number,
  failedRules: Set<string>,
  warnRules: Set<string>,
  filename?: string,
): string {
  const label = filename ? `[${filename}] ` : '';
  const status = score >= PASS_THRESHOLD ? '✅ GEÇTİ' : '❌ KALDI';
  const failList = failedRules.size > 0 ? `\nFAIL: ${[...failedRules].join(', ')}` : '';
  const warnList = warnRules.size > 0 ? `\nWARN: ${[...warnRules].join(', ')}` : '';
  return `${label}Sovereign Kalite Skoru: ${score}/13 ${status}${failList}${warnList}`;
}
