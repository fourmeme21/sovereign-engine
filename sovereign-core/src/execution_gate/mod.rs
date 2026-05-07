//! Execution Gate — SE OS v3.0 Faz 4
//!
//! Akış:
//!   1. İdempotency: decision.id daha önce işlendiyse cache'den dön
//!   2. JWT_SECRET env oku (secrecy ile)
//!   3. execution_token doğrula (HS256, jwt-simple)
//!   4. bundle_id + ISO 8601 timestamp üret
//!   5. audit_hash hesapla — SHA-256 hash chain (serde_jcs canonical)
//!   6. ExecutionResult üret, cache'e kaydet
//!
//! Fail-closed garantisi:
//!   JWT_SECRET eksik | token geçersiz | iç hata → success: false
//!   Asla panic, asla PERMIT → hatalı akış.

use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use jwt_simple::prelude::*;
use moka::sync::Cache;
use secrecy::{ExposeSecret, SecretString};
use sha2::{Digest, Sha256};

use sovereign_types::{ExecutionRequest, ExecutionResult};

// ─── IDEMPOTENCY CACHE ───────────────────────────────────────────────────────
//
// decision.id → ExecutionResult
// TTL: 5 dakika (300s) — policy_kernel execution_token süresiyle uyumlu
// Max capacity: 1_000 — solo operator ölçeği (ARCHITECTURE.md §8 teknik borç)
// Arka plan thread: moka otomatik TTL eviction yapar, execution path'e latency yok.

static IDEMPOTENCY_CACHE: OnceLock<Cache<String, ExecutionResult>> = OnceLock::new();

fn idempotency_cache() -> &'static Cache<String, ExecutionResult> {
    IDEMPOTENCY_CACHE.get_or_init(|| {
        Cache::builder()
            .time_to_live(Duration::from_secs(300))
            .max_capacity(1_000)
            .build()
    })
}

// ─── PUBLIC ENTRY POINT ──────────────────────────────────────────────────────

/// Execution Gate giriş noktası — main.rs `run_execute()` tarafından çağrılır.
pub fn execute(request: &ExecutionRequest) -> ExecutionResult {
    let decision_id = request.decision.id.clone();

    // [1] İdempotency: aynı decision daha önce işlendiyse cache'den dön
    if let Some(cached) = idempotency_cache().get(&decision_id) {
        return cached;
    }

    // [2] JWT_SECRET — secrecy ile oku, log'a sızdırma
    let secret = match std::env::var("JWT_SECRET") {
        Ok(s) => SecretString::new(s.into()),
        Err(_) => {
            return fail_result(&decision_id, "JWT_SECRET env değişkeni eksik", false);
        }
    };

    // [3] execution_token doğrulama (HS256)
    if let Err(msg) = validate_jwt(&request.execution_token, secret.expose_secret()) {
        return fail_result(&decision_id, &msg, false);
    }

    // [4] Bundle ID + timestamp
    let timestamp = utc_now_iso8601();
    let bundle_id = generate_bundle_id(&decision_id, &timestamp);

    // [5] Audit hash chain
    let audit_hash = compute_audit_hash(request, &bundle_id, &timestamp);

    let result = ExecutionResult {
        bundle_id,
        decision_id: decision_id.clone(),
        success: true,
        rolled_back: None,
        audit_hash,
        timestamp,
        error: None,
    };

    // [6] Cache'e kaydet — tekrar eden request'ler idempotent sonuç alır
    idempotency_cache().insert(decision_id, result.clone());

    result
}

// ─── JWT DOĞRULAMA ───────────────────────────────────────────────────────────

/// HS256 token doğrulama.
///
/// jwt-simple "none" algoritma saldırısını API düzeyinde engeller (Karar #9).
/// Geçersiz/süresi dolmuş token → Err(mesaj) → fail-closed.
fn validate_jwt(token: &str, secret: &str) -> Result<(), String> {
    let key = HS256Key::from_bytes(secret.as_bytes());
    key.verify_token::<NoCustomClaims>(token, None)
        .map(|_| ())
        .map_err(|e| format!("JWT_INVALID: {e}"))
}

// ─── HATA SONUCU ─────────────────────────────────────────────────────────────

/// Fail-closed execution sonucu.
///
/// Hata durumunda da audit_hash üretilir — hash chain bütünlüğü korunur.
fn fail_result(decision_id: &str, error: &str, rolled_back: bool) -> ExecutionResult {
    let timestamp = utc_now_iso8601();
    let bundle_id = generate_bundle_id(decision_id, &timestamp);
    let audit_hash = compute_simple_hash(&format!("FAIL:{decision_id}:{error}:{timestamp}"));

    ExecutionResult {
        bundle_id,
        decision_id: decision_id.to_string(),
        success: false,
        rolled_back: Some(rolled_back),
        audit_hash,
        timestamp,
        error: Some(error.to_string()),
    }
}

// ─── AUDIT HASH CHAIN ────────────────────────────────────────────────────────

/// SHA-256 imzalı log girişi.
///
/// Hash girdisi (sırayla):
///   [1] önceki kaydın audit_hash'i (varsa) — chain bağlantısı
///   [2] canonical JSON(decision)           — RFC 8785 / serde_jcs, deterministik
///   [3] bundle_id                          — bu execution'a özgü
///   [4] timestamp                          — zaman damgası
///
/// Hash chain: her kayıt öncekini referans alır → geçmişe dönük değişiklik tespiti.
fn compute_audit_hash(request: &ExecutionRequest, bundle_id: &str, timestamp: &str) -> String {
    let mut hasher = Sha256::new();

    if let Some(prev_hash) = &request.decision.audit_hash {
        hasher.update(prev_hash.as_bytes());
    }

    // Canonical JSON — Rust ↔ TypeScript hash tutarlılığı için zorunlu (Karar #8)
    if let Ok(canonical) = serde_jcs::to_string(&request.decision) {
        hasher.update(canonical.as_bytes());
    }

    hasher.update(bundle_id.as_bytes());
    hasher.update(timestamp.as_bytes());

    to_hex(hasher.finalize().as_slice())
}

fn compute_simple_hash(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    to_hex(hasher.finalize().as_slice())
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ─── BUNDLE ID ───────────────────────────────────────────────────────────────

/// "bundle-{ilk 16 hex char}" formatında tekil ID.
/// uuid crate eklenmeden SHA-256'dan türetilir; decision_id+timestamp çarpışmayı önler.
fn generate_bundle_id(decision_id: &str, timestamp: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(decision_id.as_bytes());
    hasher.update(timestamp.as_bytes());
    let hex = to_hex(hasher.finalize().as_slice());
    format!("bundle-{}", &hex[..16])
}

// ─── TIMESTAMP ───────────────────────────────────────────────────────────────
// chrono bağımlılığı eklenmedi — std::time + manuel Gregorian hesaplama.
// Doğruluk: 1970-2099 aralığında hatasız (SE OS kullanım ömrü için yeterli).

fn utc_now_iso8601() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    unix_to_iso8601(secs)
}

fn unix_to_iso8601(mut secs: u64) -> String {
    let ss = secs % 60; secs /= 60;
    let mm = secs % 60; secs /= 60;
    let hh = secs % 24; secs /= 24;

    let mut days = secs;
    let mut year = 1970u32;
    loop {
        let diy = days_in_year(year);
        if days < diy { break; }
        days -= diy;
        year += 1;
    }

    let leap = is_leap(year);
    let month_days: [u64; 12] = [
        31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ];
    let mut month = 1u32;
    for dm in &month_days {
        if days < *dm { break; }
        days -= dm;
        month += 1;
    }
    let day = days + 1;

    format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

fn days_in_year(year: u32) -> u64 {
    if is_leap(year) { 366 } else { 365 }
}

fn is_leap(year: u32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

// ─── TESTLER ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_unix_to_iso8601_epoch() {
        assert_eq!(unix_to_iso8601(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn test_unix_to_iso8601_known_date() {
        // 2024-01-01T00:00:00Z = 1704067200
        assert_eq!(unix_to_iso8601(1_704_067_200), "2024-01-01T00:00:00Z");
    }

    #[test]
    fn test_generate_bundle_id_format() {
        let id = generate_bundle_id("test-decision-id", "2024-01-01T00:00:00Z");
        assert!(id.starts_with("bundle-"));
        assert_eq!(id.len(), "bundle-".len() + 16);
    }

    #[test]
    fn test_to_hex_length() {
        let hash = compute_simple_hash("test");
        assert_eq!(hash.len(), 64); // SHA-256 = 32 byte = 64 hex char
    }

    #[test]
    fn test_idempotency_cache_init() {
        let cache = idempotency_cache();
        assert_eq!(cache.entry_count(), 0);
    }

    #[test]
    fn test_fail_result_structure() {
        let r = fail_result("dec-123", "JWT_INVALID: test", false);
        assert!(!r.success);
        assert_eq!(r.decision_id, "dec-123");
        assert_eq!(r.rolled_back, Some(false));
        assert!(r.error.is_some());
        assert_eq!(r.audit_hash.len(), 64);
    }
}
