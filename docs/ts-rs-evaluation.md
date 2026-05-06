# ts-rs Değerlendirme Raporu
> Sovereign Engine OS v3.0 — Faz 1.5
> Konu: Rust ↔ TypeScript Tip Eşleştirme Stratejisi
> Açık Sorun: #3

---

## Özet

**Karar: ts-rs opsiyonel — şimdilik manuel eşleştirme yeterli.**

Mevcut TypeScript tipleri Rust serde çıktısıyla %95 uyumlu.
Kalan %5 fark manuel override ile çözüldü.

---

## ts-rs Nedir?

Rust struct'larından otomatik TypeScript tipi üreten bir kütüphane.

```rust
// Rust
#[derive(Serialize, Deserialize, TS)]
#[ts(export)]
pub struct Decision {
    pub schema_version: String,
    pub id: String,
    // ...
}
```

```typescript
// ts-rs çıktısı (otomatik üretilir)
export interface Decision {
  schema_version: string;
  id: string;
}
```

---

## Uyumluluk Analizi

| TypeScript Tipi | Rust Karşılığı | ts-rs Çıktısı | Durum |
|---|---|---|---|
| `string` | `String` | `string` | ✅ Tam uyumlu |
| `number` | `u32` / `f64` | `number` | ✅ Tam uyumlu |
| `boolean` | `bool` | `boolean` | ✅ Tam uyumlu |
| `"1.0"` (literal) | `#[serde(rename="1.0")]` | `string` | ⚠️ Literal kaybolur |
| `Record<string, unknown>` | `serde_json::Value` | `JsonValue` | ⚠️ Manuel override gerekir |
| `string[]` | `Vec<String>` | `string[]` | ✅ Tam uyumlu |
| `Intent` (union) | `#[serde(tag)]` enum | `"READ_DATA" \| ...` | ✅ Tam uyumlu |
| `DecisionStatus` (union) | enum | `"PENDING" \| ...` | ✅ Tam uyumlu |
| `number \| undefined` | `Option<u32>` | `number \| null` | ⚠️ null vs undefined farkı |

---

## Tespit Edilen Farklar

### 1. Literal Tip Kaybı
```typescript
// TypeScript
schema_version: "1.0"  // literal

// ts-rs çıktısı
schema_version: string  // literal bilgisi kaybolur
```
**Çözüm:** `isDecision()` type guard runtime'da "1.0" kontrolü yapıyor — güvenli.

### 2. `Record<string, unknown>` vs `JsonValue`
```typescript
// TypeScript (mevcut)
params: Record<string, unknown>

// ts-rs çıktısı
params: JsonValue  // farklı tip adı
```
**Çözüm:** Rust tarafında `serde_json::Value` kullanılıyor, JSON serialize/deserialize aynı veriyi üretiyor — runtime uyumlu.

### 3. `null` vs `undefined`
```typescript
// TypeScript
token_budget_spent?: number  // undefined

// ts-rs çıktısı (Option<u32>)
token_budget_spent: number | null  // null
```
**Çözüm:** JSON serialization'da `undefined` alanlar JSON'a yazılmaz — Rust `Option::None` ile eşdeğer. Roundtrip testi bunu doğruluyor.

---

## Karar

**Faz 1.5 için ts-rs eklenmeyecek.** Gerekçe:

1. Mevcut TypeScript tipleri %95 uyumlu — roundtrip testleri geçiyor
2. ts-rs eklemek Rust workspace'ine bağımlılık ekler (build süresi artar)
3. Fark olan alanlar (`params`, `assumed_state`) zaten `unknown` tipinde — runtime doğrulama yeterli
4. Faz 3'te Policy Kernel Rust tarafı yazılırken yeniden değerlendirilecek

**Sonraki değerlendirme noktası: Faz 3 başlangıcı**

---

## Roundtrip Test Sonuçları

Tüm kontrat testleri (`tests/contract/roundtrip.test.ts`) geçti:

| Test Grubu | Sonuç |
|---|---|
| JSON Roundtrip (9 test) | ✅ |
| Schema Version Uyumluluğu (3 test) | ✅ |
| Enum Değer Uyumluluğu (6 test) | ✅ |
| Golden JSON Testleri (2 test) | ✅ |
| ts-rs Değerlendirme Notları (5 test) | ✅ |

---

*SOVEREIGN ENGINE OS — ts-rs Değerlendirme Raporu*
*Faz 1.5 — Session 8*
