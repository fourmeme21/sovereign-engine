// =============================================================================
// Sovereign Engine OS — Policy Kernel
// =============================================================================
// Görev   : Hard Lock + Domain Kural + JWT Token Üretimi
// Giriş   : stdin — Decision JSON (status: VALIDATED)
// Çıkış   : stdout — PolicyResult JSON
// Exit    : 0=PERMIT, 1=DENY/BLOCK, 2=ASK_HUMAN, 99=ERROR
//
// ⚠️  Validation Engine zaten R1-R9 kurallarını çalıştırdı.
//     Bu kernel sadece Hard Lock + JWT sorumludur.
//     Validation kuralları burada tekrar edilmez.
//
// Sentez  : Rapor 1 (HardLockConfig esnekliği)
//         + Rapor 2 (stdin from_reader pattern)
//         + Rapor 3 (RFC 8785, chrono, deny_unknown_fields, stdin().lock())
//         + SE OS (Decision şeması birebir, TypeScript tutarlılığı)
// =============================================================================

use chrono::Utc;
use hex;
use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use serde::{Deserialize, Serialize};
use serde_json_canonicalizer::to_vec as canonical_to_vec;
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use thiserror::Error;

// =============================================================================
// 1. HATA TİPLERİ
// =============================================================================

#[derive(Error, Debug)]
pub enum PolicyError {
    #[error("Girdi okuma hatası: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON parse hatası: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("JWT hatası: {0}")]
    Jwt(#[from] jsonwebtoken::errors::Error),

    #[error("Hard Lock ihlali: {0}")]
    HardLockViolation(String),

    #[error("Çevre değişkeni eksik: {0}")]
    MissingEnv(String),

    #[error("Kriptografik hata: {0}")]
    Crypto(String),
}

// =============================================================================
// 2. SE OS DECISION OBJECT — TypeScript decision.ts ile birebir eşleşme
//    Validation Engine geçmişten gelen VALIDATED Decision alınır.
// =============================================================================

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]  // Mass assignment saldırısı engeli (Rapor 3)
pub struct Decision {
    pub schema_version: String,       // "1.0" zorunlu
    pub id: String,                   // UUID v7
    pub created_at: String,           // ISO 8601
    pub intent: Intent,
    pub category: String,             // /^[A-Z_]+$/
    pub payload: DecisionPayload,
    pub context: DecisionContext,
    pub metadata: DecisionMetadata,
    pub status: DecisionStatus,       // VALIDATED olmak zorunda
    pub audit_hash: Option<String>,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Intent {
    ReadData,
    WriteData,
    ExecuteAction,
    TriggerEvent,
    ModifyState,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum RiskLevel {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum DecisionStatus {
    Pending,
    Validated,
    PolicyApproved,
    Executing,
    Completed,
    Rejected,
    Blocked,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct DecisionPayload {
    pub action_name: String,
    pub params: serde_json::Value,
    pub assumed_state: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct DecisionContext {
    pub actor_id: String,
    pub actor_role: String,
    pub session_id: String,
    pub risk_level: RiskLevel,
    pub hierarchy_path: Option<Vec<String>>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct DecisionMetadata {
    pub model: String,
    pub session_number: u32,
    pub confidence: String,
    pub self_check_passed: bool,
    pub token_budget_spent: Option<u32>,
}

// =============================================================================
// 3. POLICY RESULT — TypeScript policy.ts ile birebir eşleşme
// =============================================================================

#[derive(Debug, Serialize, PartialEq, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PolicyDecision {
    Permit,
    Block,
    AskHuman,
    Deny,
}

#[derive(Debug, Serialize, PartialEq, Clone)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum PolicyErrorCode {
    ImmutableState,          // HL-1
    NonPositiveValue,        // HL-2
    HumanApprovalRequired,   // HL-3
    NotResourceOwner,        // HL-4
    InvalidStatus,           // VALIDATED dışında geldi
    InvalidSchemaVersion,    // "1.0" değil
    JwtError,                // Token üretim hatası
    UnknownError,
}

#[derive(Debug, Serialize)]
pub struct PolicyResult {
    pub decision: PolicyDecision,
    pub priority: u32,
    pub error_code: Option<PolicyErrorCode>,
    pub redirect: Option<String>,       // DENY/BLOCK → zorunlu (soft steer)
    pub execution_token: Option<String>, // PERMIT → JWT HS256
}

// =============================================================================
// 4. JWT CLAIMS — TypeScript execution-token.ts ile birebir eşleşme
// =============================================================================

#[derive(Debug, Serialize, Deserialize)]
pub struct ExecutionTokenClaims {
    pub decision_id: String,   // Decision.id
    pub policy_hash: String,   // SHA-256(canonical(decision))
    pub actor_id: String,      // context.actor_id
    pub action_name: String,   // payload.action_name
    pub issued_at: i64,        // Unix timestamp
    pub exp: i64,              // issued_at + 30
    pub scope: String,         // "{category}:{action_name}"
}

// =============================================================================
// 5. HARD LOCK KONFİGÜRASYONU
//    Sadece SOVEREIGN_ACTOR_ID güncelleyebilir.
// =============================================================================

pub struct HardLockConfig {
    pub sovereign_actor_id: String,
    pub immutable_statuses: Vec<DecisionStatus>,
}

impl HardLockConfig {
    pub fn load() -> Result<Self, PolicyError> {
        let sovereign_actor_id = std::env::var("SOVEREIGN_ACTOR_ID")
            .map_err(|_| PolicyError::MissingEnv("SOVEREIGN_ACTOR_ID".into()))?;

        Ok(HardLockConfig {
            sovereign_actor_id,
            immutable_statuses: vec![
                DecisionStatus::Completed,
                DecisionStatus::Rejected,
                DecisionStatus::Blocked,
            ],
        })
    }
}

// =============================================================================
// 6. HARD LOCK KURALLARI (HL-1 → HL-4)
//    Validation Engine R1-R9 zaten çalıştı — tekrar edilmez.
//    Bu kurallar sadece Policy Kernel'a özgüdür.
// =============================================================================

pub fn evaluate_hard_locks(
    decision: &Decision,
    config: &HardLockConfig,
) -> Option<PolicyResult> {

    // HL-1: IMMUTABLE_STATE — kilitli duruma yazma yasak
    // VALIDATED dışında gelen → reddedilir
    if decision.status != DecisionStatus::Validated {
        if config.immutable_statuses.contains(&decision.status) {
            return Some(PolicyResult {
                decision:        PolicyDecision::Block,
                priority:        100,
                error_code:      Some(PolicyErrorCode::ImmutableState),
                redirect:        Some(format!(
                    "Decision {:?} durumunda — değiştirilemez. Yeni bir Decision oluşturun.",
                    decision.status
                )),
                execution_token: None,
            });
        }
        // VALIDATED dışında başka durum (PENDING, EXECUTING vb.)
        return Some(PolicyResult {
            decision:        PolicyDecision::Deny,
            priority:        90,
            error_code:      Some(PolicyErrorCode::InvalidStatus),
            redirect:        Some(
                "Policy Kernel yalnızca VALIDATED durumundaki Decision'ları kabul eder."
                    .into(),
            ),
            execution_token: None,
        });
    }

    // Schema version kontrolü
    if decision.schema_version != "1.0" {
        return Some(PolicyResult {
            decision:        PolicyDecision::Deny,
            priority:        95,
            error_code:      Some(PolicyErrorCode::InvalidSchemaVersion),
            redirect:        Some(
                "schema_version '1.0' olmalıdır. ARCHITECTURE.md §2.1'e bakın.".into(),
            ),
            execution_token: None,
        });
    }

    // HL-2: NON_POSITIVE_VALUE — session_number ≤ 0 yasak
    // (Validation Engine R7 zaten PENDING kontrol etti, burada metadata kalitesi)
    if decision.metadata.session_number == 0 {
        return Some(PolicyResult {
            decision:        PolicyDecision::Block,
            priority:        100,
            error_code:      Some(PolicyErrorCode::NonPositiveValue),
            redirect:        Some(
                "session_number sıfır olamaz. CORE.md §8 — NON-NEGATIVE alanlar.".into(),
            ),
            execution_token: None,
        });
    }

    // HL-3: HUMAN_APPROVAL_REQUIRED — risk_level=CRITICAL → ASK_HUMAN
    if decision.context.risk_level == RiskLevel::Critical {
        return Some(PolicyResult {
            decision:        PolicyDecision::AskHuman,
            priority:        80,
            error_code:      Some(PolicyErrorCode::HumanApprovalRequired),
            redirect:        Some(
                "risk_level=CRITICAL — insan onayı zorunludur. İşlemi manuel olarak onaylayın."
                    .into(),
            ),
            execution_token: None,
        });
    }

    // HL-4: NOT_RESOURCE_OWNER — sadece sovereign_actor_id dışındaki herkes kısıtlı
    // Write/Execute/ModifyState için sahiplik kontrolü
    let requires_ownership = matches!(
        decision.intent,
        Intent::WriteData | Intent::ExecuteAction | Intent::ModifyState
    );

    if requires_ownership {
        let is_sovereign = decision.context.actor_id == config.sovereign_actor_id;

        if !is_sovereign {
            // Actor sovereign değilse ama actor_role operator ise izin ver
            // Sovereign olmayan kullanıcılar için kısıtlı erişim
            let is_operator = decision.context.actor_role == "operator"
                || decision.context.actor_role == "system";

            if !is_operator {
                return Some(PolicyResult {
                    decision:        PolicyDecision::Deny,
                    priority:        70,
                    error_code:      Some(PolicyErrorCode::NotResourceOwner),
                    redirect:        Some(format!(
                        "actor_id '{}' bu işlem için yetkili değil. \
                         Sistem sahibiyle iletişime geçin.",
                        decision.context.actor_id
                    )),
                    execution_token: None,
                });
            }
        }
    }

    None // Hard Lock tetiklenmedi — domain kurallara geç
}

// =============================================================================
// 7. CANONICAL HASH — RFC 8785 (Rapor 3 + Session 4 kararı)
//    policy_hash = SHA-256(canonical_json(decision))
// =============================================================================

pub fn generate_canonical_hash(decision: &Decision) -> Result<String, PolicyError> {
    // Sadece kararın özünü hash'le (metadata hariç)
    let core = serde_json::json!({
        "id":           &decision.id,
        "intent":       &decision.intent,
        "category":     &decision.category,
        "action_name":  &decision.payload.action_name,
        "actor_id":     &decision.context.actor_id,
        "risk_level":   &decision.context.risk_level,
        "schema_version": &decision.schema_version,
    });

    let canonical_bytes = canonical_to_vec(&core)
        .map_err(|e| PolicyError::Crypto(format!("RFC 8785 kanonikleştirme hatası: {}", e)))?;

    let mut hasher = Sha256::new();
    hasher.update(&canonical_bytes);
    let result = hasher.finalize();

    Ok(format!("sha256:{}", hex::encode(result)))
}

// =============================================================================
// 8. JWT TOKEN ÜRETİMİ — HS256, 30 saniye expiry
//    "none" algoritması Header::new(Algorithm::HS256) ile engellenir
// =============================================================================

pub fn generate_execution_token(
    decision: &Decision,
    policy_hash: &str,
    jwt_secret: &str,
) -> Result<String, PolicyError> {
    if jwt_secret.is_empty() {
        return Err(PolicyError::MissingEnv(
            "JWT_SECRET boş olamaz".into(),
        ));
    }

    let now = Utc::now().timestamp();
    let exp = now + 30; // TOCTOU koruması: 30 saniye

    let claims = ExecutionTokenClaims {
        decision_id: decision.id.clone(),
        policy_hash: policy_hash.to_string(),
        actor_id:    decision.context.actor_id.clone(),
        action_name: decision.payload.action_name.clone(),
        issued_at:   now,
        exp,
        scope: format!("{}:{}", decision.category, decision.payload.action_name),
    };

    // Algorithm::HS256 zorunlu — "none" kesinlikle yasak
    let header = Header::new(Algorithm::HS256);
    let key    = EncodingKey::from_secret(jwt_secret.as_bytes());

    encode(&header, &claims, &key).map_err(PolicyError::Jwt)
}

// =============================================================================
// 9. EXIT KODU
// =============================================================================

pub fn exit_code(decision: &PolicyDecision) -> i32 {
    match decision {
        PolicyDecision::Permit   => 0,
        PolicyDecision::AskHuman => 2,
        _                        => 1,
    }
}

// =============================================================================
// 10. ANA AKIŞ
// =============================================================================

pub fn run() -> Result<i32, PolicyError> {
    // Çevre değişkenleri
    let jwt_secret = std::env::var("JWT_SECRET")
        .map_err(|_| PolicyError::MissingEnv("JWT_SECRET".into()))?;

    let config = HardLockConfig::load()?;

    // stdin'den Decision oku — stdin().lock() race condition önler (Rapor 3)
    let mut input_buffer = String::new();
    {
        let mut stdin = io::stdin().lock();
        stdin.read_to_string(&mut input_buffer)?;
    }

    if input_buffer.trim().is_empty() {
        return Err(PolicyError::HardLockViolation("Boş stdin".into()));
    }

    // Decision parse et
    let decision: Decision = serde_json::from_str(&input_buffer)?;

    // Hard Lock kontrol
    let result = if let Some(blocked) = evaluate_hard_locks(&decision, &config) {
        blocked
    } else {
        // Hard Lock yok → PERMIT + JWT üret
        let policy_hash   = generate_canonical_hash(&decision)?;
        let token         = generate_execution_token(&decision, &policy_hash, &jwt_secret)?;

        PolicyResult {
            decision:        PolicyDecision::Permit,
            priority:        10,
            error_code:      None,
            redirect:        None,
            execution_token: Some(token),
        }
    };

    // stdout'a yaz — tek satır JSON
    let output = serde_json::to_string(&result)?;
    let mut stdout = io::stdout();
    stdout.write_all(output.as_bytes())?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;

    Ok(exit_code(&result.decision))
}

// =============================================================================
// 11. main()
// =============================================================================

fn main() {
    match run() {
        Ok(code) => std::process::exit(code),
        Err(e)   => {
            eprintln!("{}", serde_json::json!({
                "status":  "ERROR",
                "message": e.to_string()
            }));
            std::process::exit(99);
        }
    }
}

// =============================================================================
// 12. UNIT TESTLER
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_decision(status: DecisionStatus, risk: RiskLevel, intent: Intent) -> Decision {
        Decision {
            schema_version: "1.0".into(),
            id:             "01952f3e-7b2a-7000-8000-000000000001".into(),
            created_at:     "2026-05-06T08:00:00.000Z".into(),
            intent,
            category:       "USER_MANAGEMENT".into(),
            payload: DecisionPayload {
                action_name:   "create_user".into(),
                params:        serde_json::json!({ "username": "alice" }),
                assumed_state: None,
            },
            context: DecisionContext {
                actor_id:       "operator-1".into(),
                actor_role:     "operator".into(),
                session_id:     "session-8".into(),
                risk_level:     risk,
                hierarchy_path: None,
            },
            metadata: DecisionMetadata {
                model:              "claude-sonnet-4-6".into(),
                session_number:     8,
                confidence:         "HIGH".into(),
                self_check_passed:  true,
                token_budget_spent: None,
            },
            status,
            audit_hash: None,
        }
    }

    fn config() -> HardLockConfig {
        HardLockConfig {
            sovereign_actor_id: "sovereign-1".into(),
            immutable_statuses: vec![
                DecisionStatus::Completed,
                DecisionStatus::Rejected,
                DecisionStatus::Blocked,
            ],
        }
    }

    // HL-1: Kilitli durum → BLOCK
    #[test]
    fn test_hl1_completed_blocked() {
        let d = make_decision(DecisionStatus::Completed, RiskLevel::Low, Intent::WriteData);
        let r = evaluate_hard_locks(&d, &config()).unwrap();
        assert_eq!(r.decision, PolicyDecision::Block);
        assert_eq!(r.error_code, Some(PolicyErrorCode::ImmutableState));
    }

    #[test]
    fn test_hl1_rejected_blocked() {
        let d = make_decision(DecisionStatus::Rejected, RiskLevel::Low, Intent::WriteData);
        let r = evaluate_hard_locks(&d, &config()).unwrap();
        assert_eq!(r.decision, PolicyDecision::Block);
    }

    // HL-2: session_number = 0 → BLOCK
    #[test]
    fn test_hl2_zero_session() {
        let mut d = make_decision(DecisionStatus::Validated, RiskLevel::Low, Intent::WriteData);
        d.metadata.session_number = 0;
        let r = evaluate_hard_locks(&d, &config()).unwrap();
        assert_eq!(r.decision, PolicyDecision::Block);
        assert_eq!(r.error_code, Some(PolicyErrorCode::NonPositiveValue));
    }

    // HL-3: CRITICAL risk → ASK_HUMAN
    #[test]
    fn test_hl3_critical_ask_human() {
        let d = make_decision(DecisionStatus::Validated, RiskLevel::Critical, Intent::WriteData);
        let r = evaluate_hard_locks(&d, &config()).unwrap();
        assert_eq!(r.decision, PolicyDecision::AskHuman);
        assert_eq!(r.error_code, Some(PolicyErrorCode::HumanApprovalRequired));
    }

    // HL-4: Yetkisiz aktör → DENY
    #[test]
    fn test_hl4_unauthorized_actor() {
        let mut d = make_decision(DecisionStatus::Validated, RiskLevel::Medium, Intent::WriteData);
        d.context.actor_id   = "unknown-user".into();
        d.context.actor_role = "guest".into();
        let r = evaluate_hard_locks(&d, &config()).unwrap();
        assert_eq!(r.decision, PolicyDecision::Deny);
        assert_eq!(r.error_code, Some(PolicyErrorCode::NotResourceOwner));
    }

    // Geçerli Decision → None (PERMIT'e geçecek)
    #[test]
    fn test_valid_decision_no_hard_lock() {
        let d = make_decision(DecisionStatus::Validated, RiskLevel::Medium, Intent::WriteData);
        let r = evaluate_hard_locks(&d, &config());
        assert!(r.is_none());
    }

    // Sovereign her zaman geçer
    #[test]
    fn test_sovereign_always_permitted() {
        let mut d = make_decision(DecisionStatus::Validated, RiskLevel::Medium, Intent::ModifyState);
        d.context.actor_id   = "sovereign-1".into();
        d.context.actor_role = "operator".into();
        let r = evaluate_hard_locks(&d, &config());
        assert!(r.is_none());
    }

    // Canonical hash deterministik
    #[test]
    fn test_canonical_hash_deterministic() {
        let d  = make_decision(DecisionStatus::Validated, RiskLevel::Low, Intent::ReadData);
        let h1 = generate_canonical_hash(&d).unwrap();
        let h2 = generate_canonical_hash(&d).unwrap();
        assert_eq!(h1, h2);
        assert!(h1.starts_with("sha256:"));
    }

    // Schema version yanlış → DENY
    #[test]
    fn test_invalid_schema_version() {
        let mut d = make_decision(DecisionStatus::Validated, RiskLevel::Low, Intent::ReadData);
        d.schema_version = "2.0".into();
        let r = evaluate_hard_locks(&d, &config()).unwrap();
        assert_eq!(r.decision, PolicyDecision::Deny);
        assert_eq!(r.error_code, Some(PolicyErrorCode::InvalidSchemaVersion));
    }

    // redirect her DENY/BLOCK'ta dolu olmalı (soft steer)
    #[test]
    fn test_all_blocking_decisions_have_redirect() {
        let cases = vec![
            make_decision(DecisionStatus::Completed, RiskLevel::Low, Intent::WriteData),
            make_decision(DecisionStatus::Validated, RiskLevel::Critical, Intent::WriteData),
        ];
        for d in cases {
            let r = evaluate_hard_locks(&d, &config()).unwrap();
            assert!(r.redirect.is_some(), "redirect boş olamaz: {:?}", r.decision);
            assert!(!r.redirect.as_ref().unwrap().is_empty());
        }
    }
}
