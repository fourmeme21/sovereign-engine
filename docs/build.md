# Sovereign Engine OS — Cross-Platform Derleme Rehberi

> Bu belge `sovereign-core` Rust binary'sinin derlenmesi ve dağıtılması için gerekli adımları açıklar.

---

## Gereksinimler

| Araç | Versiyon | Notlar |
|---|---|---|
| Rust | ≥ 1.75 | `rustup` ile kurulur |
| Cargo | ≥ 1.75 | Rust ile birlikte gelir |
| cross | opsiyonel | Cross-compilation için (`cargo install cross`) |

```bash
# Rust kurulumu (henüz kurulmadıysa)
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"

# Mevcut araçları doğrula
rustc --version
cargo --version
```

---

## Yerel Derleme (Geliştirme)

```bash
cd sovereign-core

# Debug build (hızlı derleme, büyük binary)
cargo build

# Release build (optimize, küçük binary — production)
cargo build --release
```

Çıktı:
- Debug:   `sovereign-core/target/debug/sovereign-core`
- Release: `sovereign-core/target/release/sovereign-core`

---

## Cross-Platform Derleme

### Hedef Platform Listesi

| Platform | Target Triple | Çıktı Dosyası |
|---|---|---|
| Linux x86_64 | `x86_64-unknown-linux-gnu` | `sovereign-core` |
| Linux ARM64 | `aarch64-unknown-linux-gnu` | `sovereign-core` |
| macOS x86_64 | `x86_64-apple-darwin` | `sovereign-core` |
| macOS ARM64 (M1/M2) | `aarch64-apple-darwin` | `sovereign-core` |
| Windows x86_64 | `x86_64-pc-windows-gnu` | `sovereign-core.exe` |

### Target Kurulumu

```bash
# Linux x86_64 (varsayılan)
rustup target add x86_64-unknown-linux-gnu

# Linux ARM64
rustup target add aarch64-unknown-linux-gnu

# macOS x86_64
rustup target add x86_64-apple-darwin

# macOS ARM64
rustup target add aarch64-apple-darwin

# Windows
rustup target add x86_64-pc-windows-gnu
```

### Release Build Komutları

```bash
cd sovereign-core

# Linux x86_64
cargo build --release --target x86_64-unknown-linux-gnu

# Linux ARM64 (cross-compilation gerektirir — aşağıya bak)
cargo build --release --target aarch64-unknown-linux-gnu

# macOS x86_64
cargo build --release --target x86_64-apple-darwin

# macOS ARM64
cargo build --release --target aarch64-apple-darwin

# Windows
cargo build --release --target x86_64-pc-windows-gnu
```

### Linux ARM64 ve Windows için `cross` Kullanımı

Native toolchain yoksa `cross` kullan (Docker gerektirir):

```bash
# cross kurulumu
cargo install cross

# Linux ARM64
cross build --release --target aarch64-unknown-linux-gnu

# Windows
cross build --release --target x86_64-pc-windows-gnu
```

---

## Çıktı Konumları

Derleme sonrası binary:

```
sovereign-core/
└── target/
    └── <target-triple>/
        └── release/
            └── sovereign-core[.exe]
```

TypeScript katmanının beklediği konum (`kernel-bridge.ts`):

```
sovereign-core/sovereign-core        # Linux / macOS
sovereign-core/sovereign-core.exe    # Windows
```

Derleme sonrası kopyalama:

```bash
# Linux / macOS
cp target/x86_64-unknown-linux-gnu/release/sovereign-core ../sovereign-core

# Windows
cp target/x86_64-pc-windows-gnu/release/sovereign-core.exe ../sovereign-core.exe
```

---

## Derleme Doğrulama

```bash
# Binary sağlık kontrolü
./sovereign-core/sovereign-core --version

# JSON stdin/stdout arayüzü testi
echo '{"schema_version":"1.0","id":"test","intent":"READ_DATA"}' \
  | ./sovereign-core/sovereign-core

# Beklenen çıktı: DENY veya PERMIT içeren JSON
```

---

## Bilinen Sorunlar

| Sorun | Durum | Çözüm |
|---|---|---|
| `cargo check` koşulmadı — mod.rs doğrulaması eksik | 🟠 Açık | `cargo check` çalıştır |
| macOS'ta cross-compile için Xcode toolchain gerekebilir | ⚠️ Uyarı | Xcode Command Line Tools kur |
| Windows'ta `mingw-w64` gerekebilir | ⚠️ Uyarı | `cross` kullan veya Windows'ta native derle |

---

## CI/CD Notu

Faz 4+ için önerilen otomatik derleme sırası:

```
1. cargo fmt --check          # format kontrolü
2. cargo clippy -- -D warnings # lint
3. cargo test                  # unit testler
4. cargo build --release --target <platform>
5. Binary doğrulama
```

---

*Sovereign Engine OS — sovereign-core Build Guide*
*Faz 3 — Session 10 — 2026-05-07*
