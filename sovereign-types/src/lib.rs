//! sovereign-types — SE OS v3.0 paylaşılan tip kütüphanesi
//!
//! ARCHITECTURE.md §2 ile birebir eşleşir.
//! Her tip değişikliğinde önce ARCHITECTURE.md güncellenmeli,
//! ardından bu dosya değiştirilmeli (schema_version yönetimi).

use serde::{Deserialize, Serialize};

// ════════════════════════════════════════════════════════════════
//  DECISION OBJECT  (ARCHITECTURE.md §2.1)
// ════════════════════════════════════════════════════════════════

/// Sistemin temel veri birimi. Katman 1'de üretilir, Katman 4'e kadar taşınır.
///
/// `schema_version` zorunlu — Rust binary versiyon eşleşmezse REJECT (FP-V1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Decision {
    /// Zorunlu. Mevcut desteklenen değer: "1.0"
    pub schema_version: String,

    /// UUID v7 — Katman 1 tarafından atanır.
    pub id: String,

    /// ISO 8601 — UTC zorunlu.
    pub created_at: String,

    /// READ_DATA | WRITE_DATA | EXECUTE_ACTION | TRIGGER_EVENT | MODIFY_STATE
    pub intent: String,

    /// Regex: /^[A-Z_]+$/ — domain tarafından tanımlanır.
    pub category: String,

    pub payload: DecisionPayload,
    pub context: DecisionContext,
    pub metadata: DecisionMetadata,

    /// PENDING | VALIDATED | POLICY_APPROVED | EXECUTING | COMPLETED | REJECTED | BLOCKED
    pub status: String,

    /// Hash chain — SHA-256(önceki kayıt). İlk kayıtta None.
    pub audit_hash: Option<String>,
}

/// Decision.payload — iş aksiyonunu tanımlar.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecisionPayload {
    /// Regex: /^[a-z_]+$/ — Katman 1 tarafından doğrulanır.
    pub action_name: String,

    /// Serbest şema — domain adapter tarafından yorumlanır.
    pub params: serde_json::Value,

    /// Yalnızca intent = EXECUTE_ACTION | MODIFY_STATE durumunda geçerli.
    /// Pre-flight read ile gerçek state karşılaştırılır (FP-U5).
    pub assumed_state: Option<serde_json::Value>,
}

/// Decision.context — kim, hangi risk düzeyinde karar veriyor.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecisionContext {
    pub actor_id: String,
    pub actor_role: String,
    pub session_id: String,

    /// LOW | MEDIUM | HIGH | CRITICAL
    /// MODIFY_STATE → zorunlu olarak CRITICAL (ARCHITECTURE.md §2.1 kısıtları)
    pub risk_level: String,

    pub hierarchy_path: Option<Vec<String>>,
}

/// Decision.metadata — AI tarafı bilgileri.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecisionMetadata {
    /// Model adı — örn. "claude-sonnet-4-20250514"
    pub model: String,

    /// > 0 zorunlu (NON_POSITIVE_VALUE hard lock)
    pub session_number: u64,

    /// HIGH | MEDIUM | LOW
    /// HIGH + self_check_passed=false kombinasyonu REJECT (FP-V2)
    pub confidence: String,

    /// HIGH confidence ise true olmalı (FP-V2)
    pub self_check_passed: bool,

    pub token_budget_spent: Option<f64>,
}

// ════════════════════════════════════════════════════════════════
//  POLICY RESULT  (ARCHITECTURE.md §2.4)
// ════════════════════════════════════════════════════════════════

/// Policy Kernel çıktısı. Exit code ile birlikte TypeScript tarafına iletilir.
///
/// PERMIT   → execution_token dolu, exit 0
/// BLOCK    → redirect dolu,       exit 1
/// DENY     → redirect dolu,       exit 1
/// ASK_HUMAN→ redirect dolu,       exit 2
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyResult {
    /// PERMIT | BLOCK | ASK_HUMAN | DENY
    pub decision: String,

    /// > 0 zorunlu. Hard lock = 999 (en yüksek öncelik).
    pub priority: u32,

    /// Hata sınıfı — ARCHITECTURE.md §6 hata taksonomisi.
    pub error_code: Option<String>,

    /// DENY veya BLOCK'ta ZORUNLU. Boş olamaz (soft steer kuralı).
    pub redirect: Option<String>,

    /// Yalnızca PERMIT'te dolu. JWT HS256 — sovereign-core secret ile imzalı.
    /// Faz 3'te implement edilecek.
    pub execution_token: Option<String>,
}

// ════════════════════════════════════════════════════════════════
//  EXECUTION REQUEST  (ARCHITECTURE.md §3.4)
// ════════════════════════════════════════════════════════════════

/// Execution Gate stdin girdisi.
/// Policy Kernel PERMIT verdikten sonra TypeScript bu paketi gönderir.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionRequest {
    pub decision: Decision,

    /// JWT — Policy Kernel tarafından üretildi, Execution Gate doğrular.
    pub execution_token: String,
}

// ════════════════════════════════════════════════════════════════
//  EXECUTION RESULT  (ARCHITECTURE.md §2.5)
// ════════════════════════════════════════════════════════════════

/// Execution Gate çıktısı. Domain Adapter'a iletilir.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionResult {
    /// Bu execution bundle'ın UUID'si.
    pub bundle_id: String,

    pub decision_id: String,

    /// true = COMPLETED, false = REJECTED (+ rollback tetiklendi)
    pub success: bool,

    /// Execution başarısız olduğunda rollback yapıldıysa true.
    pub rolled_back: Option<bool>,

    /// SHA-256 hash — hash chain için önceki kaydın hash'i dahil edilir.
    /// Faz 4'te implement edilecek.
    pub audit_hash: String,

    /// ISO 8601 — UTC
    pub timestamp: String,

    /// Hata mesajı — başarısız execution'larda dolu.
    pub error: Option<String>,
}

// ════════════════════════════════════════════════════════════════
//  YARDIMCI FONKSİYONLAR
// ════════════════════════════════════════════════════════════════

/// Hata durumunda stdout'a yazılacak PolicyResult JSON döner.
///
/// `redirect` boşsa `reason` kullanılır — soft steer kuralı:
/// her DENY bir redirect içermeli, boş olamaz (AI_AGENT.md §Güvenlik Katmanı).
pub fn error_output(error_code: &str, reason: &str, redirect: &str) -> String {
    let redirect_msg = if redirect.is_empty() { reason } else { redirect };

    let result = PolicyResult {
        decision: "DENY".to_string(),
        priority: 0,
        error_code: Some(error_code.to_string()),
        redirect: Some(redirect_msg.to_string()),
        execution_token: None,
    };

    serde_json::to_string(&result).unwrap_or_else(|_| {
        // Serialization bile başarısız olursa minimal geçerli JSON
        format!(
            r#"{{"decision":"DENY","priority":0,"error_code":"{error_code}","redirect":"Serialization hatası — lütfen logları inceleyin."}}"#
        )
    })
}
