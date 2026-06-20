# Dockerfile
# Amac:    sovereign-engine production image — Rust Policy Kernel + Node.js engine
# Bagli:   sovereign-core/ (Rust binary), src/policy/kernel-bridge.ts (KERNEL_BINARY yolu)
# Karar:   Karar #74 (Dockerfile'da Rust toolchain yoktu — TB-28 kok nedeni), Karar #75 (multi-stage build)
# Dokunma: Bu dosya degistirilmeden once src/policy/kernel-bridge.ts KERNEL_BINARY sabiti kontrol edilmeli
#          (su an: __dirname/../../sovereign-core/sovereign-policy-kernel -> /app/sovereign-core/sovereign-policy-kernel)

# ── STAGE 1: Rust binary derleme ────────────────────────────────────────────
# musl-tabanli Alpine kullanilir — runtime image'i (node:22-alpine) da musl,
# glibc-tabanli rust:slim ile derlenirse binary calismaz (Edge case: ABI uyumsuzlugu)
FROM rust:1-alpine AS rust-builder

RUN apk add --no-cache musl-dev

WORKDIR /build
COPY sovereign-core/ ./sovereign-core/
WORKDIR /build/sovereign-core

# Derleme basarisiz olursa build burada durur — sessizce eski image'a dusulmez
RUN cargo build --release

# ── STAGE 2: Node.js runtime + derlenmis binary ─────────────────────────────
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install && npm install tsx @supabase/supabase-js

COPY tsconfig*.json ./
COPY src/ ./src/
COPY engine/ ./engine/

# Sadece derlenmis binary kopyalanir — Rust toolchain final image'a tasinmaz
COPY --from=rust-builder /build/sovereign-core/target/release/sovereign-policy-kernel ./sovereign-core/sovereign-policy-kernel
RUN chmod +x ./sovereign-core/sovereign-policy-kernel

EXPOSE 8080

CMD ["npx", "tsx", "src/server/index.ts"]
