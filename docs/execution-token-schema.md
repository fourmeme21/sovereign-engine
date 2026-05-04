# Execution Token — JWT Şema Belgesi

> Sovereign Engine OS v3.0
> Referans: ARCHITECTURE.md §2.2
> Son güncelleme: Session 5

---

## Genel Bakış

`execution_token`, Policy Kernel (Katman 3) PERMIT kararı verdiğinde üretilen kısa ömürlü bir JWT'dir.
Execution Gate (Katman 4) bu token olmadan hiçbir işlemi çalıştırmaz.

**Amaç:** TOCTOU (Time-of-Check/Time-of-Use) saldırılarını engellemek.
Policy kararı verildiği an ile execution anı arasındaki pencereyi 30 saniye ile sınırlar.

---

## Token Özellikleri

| Özellik | Değer |
|---|---|
| Algoritma | JWT HS256 |
| Expiry | 30 saniye (`issued_at + 30`) |
| İmzalayan | `sovereign-core` binary içindeki secret |
| Üretici | Policy Kernel (Katman 3 / Rust) |
| Doğrulayıcı | Execution Gate (Katman 4 / Rust) |

---

## Payload Şeması

```typescript
interface ExecutionTokenPayload {
  decision_id: string;   // Decision.id — UUID v7
  policy_hash: string;   // SHA-256(canonical(decision) + policy_result)
  actor_id:    string;   // Decision.context.actor_id
  action_name: string;   // Decision.payload.action_name
  issued_at:   number;   // Unix timestamp (saniye)
  expires_at:  number;   // issued_at + 30
  scope:       string;   // "{category}:{action_name}"
}
```

### Örnek Payload

```json
{
  "decision_id": "01952f3e-7b2a-7000-8000-000000000001",
  "policy_hash": "sha256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
  "actor_id":    "operator-1",
  "action_name": "create_user",
  "issued_at":   1746345600,
  "expires_at":  1746345630,
  "scope":       "USER_MANAGEMENT:create_user"
}
```

---

## policy_hash Hesaplama

`policy_hash`, kararın değiştirilmediğini kanıtlar.

```
policy_hash = SHA-256(
  canonical_json(decision) + canonical_json(policy_result)
)
```

- **Canonical serializasyon:** RFC 8785 (serde_jcs) — anahtar sırası sabittir
- **Birleştirme:** string concatenation, ayraç yok
- **Format:** `"sha256:" + hex(digest)`

> ⚠️ Timestamp veya rastgele değer dahil edilmez — hash deterministik olmalıdır.

---

## Execution Gate Doğrulama Sırası

Token alındığında Execution Gate şu 4 kontrolü **sırayla** yapar.
Herhangi biri başarısız olursa → **DENY + LOG + NO_SIDE_EFFECT**.

```
1. İmza geçerli mi?
   → Geçersizse: INVALID_TOKEN → DENY + LOG

2. expires_at geçmedi mi?
   → now >= expires_at ise: EXPIRED_TOKEN → DENY + LOG (TOCTOU koruması)

3. decision_id eşleşiyor mu?
   → token.decision_id ≠ decision.id ise: INVALID_TOKEN → DENY + LOG

4. policy_hash eşleşiyor mu?
   → Yeniden hesapla, karşılaştır
   → Eşleşmiyorsa: HASH_MISMATCH → DENY + LOG
```

---

## Secret Yönetimi

> ⚠️ Bu alan Faz 3'e kadar tanımsızdır (AÇIK SORUN #1).

| Konu | v3.0 Durumu | Gelecek Riski |
|---|---|---|
| Secret kaynağı | Binary içinde / env değişkeni | Multi-instance'ta paylaşılan store gerekir |
| Rotation | Tanımsız | Secret sızdığında tüm aktif tokenlar geçersiz olmalı |
| Storage | Tanımsız | `.env` dosyasına yazılmalı, `.gitignore`'da olmalı |

**Geçici kural (Faz 3'e kadar):**
- Secret `JWT_SECRET` env değişkeninden okunur
- `.env` dosyasına yazılır
- `.env` `.gitignore`'da tanımlıdır — commit edilmez

---

## Güvenlik Notları

| Kural | Gerekçe |
|---|---|
| `none` algoritması kesinlikle reddedilir | `jwt-simple` yerine `jsonwebtoken` kullanım sebebi |
| 30 saniyelik expiry | TOCTOU penceresini minimize eder |
| policy_hash doğrulaması | Policy kararı ile execution arasında Decision değiştirilemiyor |
| scope kontrolü | Token başka bir aksiyona kullanılamaz |
| Token single-use değil | 30 saniye içinde tekrar kullanılabilir — idempotency bu durumu yönetir |

---

## Hata Kodları

| Kod | Tetikleyici | Sonuç |
|---|---|---|
| `INVALID_TOKEN` | İmza geçersiz veya decision_id eşleşmiyor | DENY + LOG |
| `EXPIRED_TOKEN` | `now >= expires_at` | DENY + LOG |
| `HASH_MISMATCH` | policy_hash yeniden hesaplama uyumsuz | DENY + LOG |

Tüm durumlar: **NO_SIDE_EFFECT** — işlem başlamaz, rollback gerekmez.

---

## İlgili Dosyalar

| Dosya | İçerik |
|---|---|
| `src/types/execution-token.ts` | TypeScript tip tanımı + type guard'lar |
| `sovereign-core/src/policy_kernel/mod.rs` | Token üretimi (Rust) |
| `sovereign-core/src/execution_gate/mod.rs` | Token doğrulama (Rust) |
| `ARCHITECTURE.md §2.2` | Canonical tanım |

---

*SOVEREIGN ENGINE OS — Execution Token JWT Şema Belgesi*
*SE OS v3.0 — Session 5*
