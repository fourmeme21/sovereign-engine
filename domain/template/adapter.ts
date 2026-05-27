/**
 * adapter.ts — DomainAdapter interface
 *
 * Her domain bu interface'i implement eder.
 * validateContract() false → adapter sisteme yüklenmez.
 *
 * Kullanım:
 *   1. Bu dosyayı kopyala → domain/your-domain/adapter.ts
 *   2. Her metodu implement et
 *   3. `validateContract()` tüm kontrolleri geçmeli
 *   4. registerPolicy() ile politikaları kaydet (policies.ts)
 *
 * SAP-03 FIX: preFlightRead(decision) eklendi — ValidationEngine entegrasyonu
 * ARCH §3.5 güncelleme notu: execute/validateContract/SystemResponse kod versiyonu
 * benimsendi (daha doğru tasarım — bkz. ARCHITECTURE.md §3.5 versiyon kaydı)
 */

import type { Decision }        from "../../src/types/decision.js";
import type { PreFlightResult } from "../../src/types/preflight.js";

// ─── DOMAIN CONFIG ────────────────────────────────────────────────────────────

/**
 * Domain'e özgü kısıt konfigürasyonu.
 * Policy Kernel Hard Lock'ları bu config'i kullanır.
 */
export interface DomainConfig {
  /** Bu alanlar hiçbir zaman değiştirilemez (HL-1: IMMUTABLE_STATE) */
  locked_states: string[];

  /** Bu alanlarda değer ≤ 0 olamaz (HL-2: NON_POSITIVE_VALUE) */
  non_negative_fields: string[];

  /** Yalnızca bu rollerdeki aktörler yazma yapabilir (HL-4: NOT_RESOURCE_OWNER) */
  privileged_roles: string[];

  /** Domain'in desteklediği action kategorileri — /^[A-Z_]+$/ */
  categories: string[];
}

// ─── EXECUTION CONTEXT ───────────────────────────────────────────────────────

/** execute() çağrısına iletilen sistem bağlamı */
export interface ExecutionContext {
  actor_id:   string;
  actor_role: string;
  session_id: string;
  bundle_id:  string;
  timestamp:  string;
}

// ─── ACTION RESULT ───────────────────────────────────────────────────────────

/** execute() dönüş tipi */
export interface ActionResult {
  success: boolean;
  /** Rollback için kullanılacak önceki state snapshot'ı */
  backup?: unknown;
  /** Başarılı execution çıktısı */
  output?: unknown;
  /** Hata durumunda açıklama */
  error?: string;
}

// ─── DOMAIN ADAPTER INTERFACE ────────────────────────────────────────────────

export interface DomainAdapter {
  // ── KİMLİK ──────────────────────────────────────────────────────────────

  /** Domain adı — unique, lowercase, tire ile ayrılmış. Örn: "kobrabet-bets" */
  readonly name: string;

  /** Semantic versioning. Örn: "1.0.0" */
  readonly version: string;

  // ── KONFİGÜRASYON ───────────────────────────────────────────────────────

  /**
   * Policy Kernel Hard Lock konfigürasyonu.
   * Bu metod her seferinde aynı değeri döndürmeli — saf fonksiyon.
   */
  getConfig(): DomainConfig;

  // ── PRE-FLIGHT — VALİDATION ENGINE ENTEGRASYONU ──────────────────────────

  /**
   * SAP-03 FIX: ValidationEngine.preFlightRead() bu metodu çağırır.
   * assumed_state'in bayatlayıp bayatlamadığını kontrol eder.
   *
   * ARCH §3.5 + ValidationEngine PreFlightProvider interface'i ile uyumlu.
   *
   * @param decision - PENDING durumundaki Decision (assumed_state içerebilir)
   * @returns PreFlightResult — clear:true = execution devam eder
   *                          — clear:false = RE_EVALUATE veya REJECTED
   */
  preFlightRead(decision: Decision): Promise<PreFlightResult>;

  // ── STATE SNAPSHOT — ROLLBACK İÇİN ──────────────────────────────────────

  /**
   * Execution öncesi mevcut state'i okur.
   * execute() öncesi çağrılır — dönen değer rollback() için backup olarak saklanır.
   *
   * preFlightRead'den farkı: bu metod rollback snapshot'ı için,
   * preFlightRead assumed_state freshness kontrolü için kullanılır.
   *
   * @returns Mevcut state snapshot — rollback için saklanır
   * @throws Okuma başarısız olursa → execution iptal
   */
  readState(actionName: string, params: unknown): Promise<unknown>;

  // ── EXECUTION ────────────────────────────────────────────────────────────

  /**
   * Aksiyonu uygular.
   *
   * ZORUNLU: Atomik olmalı — ya tamamen başarılı, ya hiç.
   * Hata → ActionResult.success=false + rollback() çağrılır.
   *
   * @param actionName  DomainConfig.categories ile uyumlu action
   * @param params      Decision.payload.params
   * @param context     Sistem bağlamı (actor, bundle_id, timestamp)
   */
  execute(
    actionName: string,
    params:     unknown,
    context:    ExecutionContext,
  ): Promise<ActionResult>;

  // ── ROLLBACK ─────────────────────────────────────────────────────────────

  /**
   * execute() başarısız olduğunda önceki state'i geri yükler.
   *
   * ZORUNLU: readState()'in döndürdüğü backup kullanılmalı.
   * Rollback başarısız → ROLLBACK_FAIL logla, insan müdahalesi gerektirir.
   *
   * @param backup  readState()'in döndürdüğü snapshot
   */
  rollback(actionName: string, params: unknown, backup: unknown): Promise<void>;

  // ── KONTRAT DOĞRULAMA ────────────────────────────────────────────────────

  /**
   * Adapter'ın sisteme yüklenebilir olduğunu doğrular.
   * Bootstrap sırasında otomatik çağrılır — false → adapter yüklenmez.
   *
   * Kontrol listesi:
   *   ✓ name ve version dolu
   *   ✓ getConfig() geçerli değerler döndürüyor
   *   ✓ categories en az 1 eleman içeriyor
   *   ✓ execute() ve rollback() implement edilmiş
   *   ✓ Domain'e özgü sağlık kontrolleri (DB bağlantısı vb.)
   */
  validateContract(): Promise<boolean>;
}

// ─── KONTRAT YARDIMCISI ──────────────────────────────────────────────────────

/**
 * validateContract() implementasyonlarında kullanılacak temel kontroller.
 * Adapter kendi kontrollerini buna ekleyebilir.
 */
export async function runBaseContractChecks(adapter: DomainAdapter): Promise<boolean> {
  const config = adapter.getConfig();

  if (!adapter.name || !adapter.version) {
    console.error(`[${adapter.name}] validateContract FAIL: name veya version eksik`);
    return false;
  }

  if (!config.categories || config.categories.length === 0) {
    console.error(`[${adapter.name}] validateContract FAIL: categories boş`);
    return false;
  }

  const categoryPattern = /^[A-Z_]+$/;
  for (const cat of config.categories) {
    if (!categoryPattern.test(cat)) {
      console.error(`[${adapter.name}] validateContract FAIL: geçersiz kategori "${cat}"`);
      return false;
    }
  }

  return true;
}
