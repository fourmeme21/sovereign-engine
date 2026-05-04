//! Policy Kernel — SE OS v3.0
//!
//! ARCHITECTURE.md §3.3
//!
//! Sorumluluk:
//!   - Hard lock listesini uygular (değiştirilemez — TypeScript katmanından erişilemez)
//!   - Domain kurallarını değerlendirir (Faz 3'te implemente edilecek)
//!   - domain_rules boşsa → default DENY (fail-closed)
//!
//! Hard Lock Listesi (ARCHITECTURE.md §3.3 — değiştirilemez):
//!   HL-1  IMMUTABLE_STATE         — Kilitli duruma yazma girişimi
//!   HL-2  NON_POSITIVE_VALUE      — Sayısal alan ≤ 0
//!   HL-3  HUMAN_APPROVAL_REQUIRED — risk_level = CRITICAL
//!   HL-4  NOT_RESOURCE_OWNER      — Yetkisiz yazma (Faz 3'te DomainConfig ile tamamlanacak)

use sovereign_types::{Decision, PolicyResult};

/// Kilitli durum listesi — bu durumlardaki kararlara WRITE/EXECUTE yasak (CORE.md §7).
const IMMUTABLE_STATUSES: &[&str] = &["COMPLETED", "REJECTED", "ROLLED_BACK"];

/// Hard lock tetiklendiğinde atanan öncelik değeri.
const HARD_LOCK_PRIORITY: u32 = 999;

// ─── ANA DEĞERLEME FONKSİYONU ────────────────────────────────────────────────

/// Policy Kernel ana giriş noktası.
///
/// Sıra önemlidir — hard locklar her zaman domain kurallarından önce çalışır.
/// Herhangi bir hard lock DENY/ASK_HUMAN dönerse domain kurallarına geçilmez.
///
/// Fail-closed: domain_rules henüz tanımlı değilse → DENY.
pub fn evaluate(decision: &Decision) -> PolicyResult {
    // ── HL-1: IMMUTABLE_STATE ────────────────────────────────────────────────
    // COMPLETED / REJECTED / ROLLED_BACK kayıtlara yazma yasak (CORE.md §7)
    if IMMUTABLE_STATUSES.contains(&decision.status.as_str()) {
        return hard_lock_deny(
            "IMMUTABLE_STATE",
            &format!(
                "Karar \"{}\" durumunda — bu duruma yazma yasak. \
                 Yeni bir karar oluşturun.",
                decision.status
            ),
        );
    }

    // ── HL-2: NON_POSITIVE_VALUE ─────────────────────────────────────────────
    // session_number > 0 zorunlu (ARCHITECTURE.md §2.1 kısıtları)
    // TODO: Faz 3 — DomainConfig.getNonNegativeFields() ile diğer numeric alanlar da kontrol edilecek
    if decision.metadata.session_number == 0 {
        return hard_lock_deny(
            "NON_POSITIVE_VALUE",
            "metadata.session_number 0'dan büyük olmalı. \
             Geçerli bir session_number ile Decision Object'i yeniden gönderin.",
        );
    }

    // ── HL-3: HUMAN_APPROVAL_REQUIRED ────────────────────────────────────────
    // risk_level = CRITICAL → insan onayı zorunlu (ARCHITECTURE.md §3.3)
    if decision.context.risk_level == "CRITICAL" {
        return PolicyResult {
            decision: "ASK_HUMAN".to_string(),
            priority: HARD_LOCK_PRIORITY,
            error_code: Some("HUMAN_APPROVAL_REQUIRED".to_string()),
            redirect: Some(
                "CRITICAL risk seviyesindeki karar insan onayı gerektiriyor. \
                 Dashboard üzerinden onaylayın veya reddedin."
                    .to_string(),
            ),
            execution_token: None,
        };
    }

    // ── HL-4: NOT_RESOURCE_OWNER ─────────────────────────────────────────────
    // Yetkisiz kaynak erişimi — Faz 3'te DomainConfig.privileged_roles ile tamamlanacak.
    // TODO: Faz 3 — aşağıdaki stub'ı gerçek implementasyonla değiştir:
    //
    //   let authorized = domain_config
    //       .privileged_roles
    //       .contains(&decision.context.actor_role);
    //
    //   if !authorized && requires_ownership(decision) {
    //       return hard_lock_deny("NOT_RESOURCE_OWNER", "...");
    //   }

    // ── DOMAIN RULES ─────────────────────────────────────────────────────────
    // ARCHITECTURE.md §3.3: domain_rules boşsa → default DENY (fail-closed)
    //
    // Faz 3'te bu blok DomainConfig ile doldurulacak:
    //   let domain_result = domain_rules::evaluate(decision, &domain_config);
    //   if domain_result.permit { return permit(execution_token); }
    //   return domain_result.policy_result;
    //
    // Şu an domain rules tanımsız → fail-closed DENY:
    hard_lock_deny(
        "POLICY_NOT_IMPLEMENTED",
        "Domain kuralları henüz tanımlı değil. \
         Faz 3 tamamlandığında Policy Kernel aktif olacak. \
         ROADMAP.md Faz 3'e bakın.",
    )
}

// ─── YARDIMCI FONKSİYONLAR ───────────────────────────────────────────────────

/// Hard lock tetiklendiğinde dönen DENY yanıtı.
///
/// Soft steer kuralı: redirect boş olamaz (AI_AGENT.md §Güvenlik Katmanı).
fn hard_lock_deny(error_code: &str, redirect: &str) -> PolicyResult {
    PolicyResult {
        decision: "DENY".to_string(),
        priority: HARD_LOCK_PRIORITY,
        error_code: Some(error_code.to_string()),
        redirect: Some(redirect.to_string()),
        execution_token: None,
    }
}
