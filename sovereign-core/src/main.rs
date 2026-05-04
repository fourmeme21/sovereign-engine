//! sovereign-core — SE OS v3.0 Rust binary entry point
//!
//! Kullanım:
//!   sovereign-core healthcheck          → exit 0 (sistem sağlıklı)
//!   sovereign-core policy    < input    → PolicyResult JSON, exit 0/1/2/99
//!   sovereign-core execute   < input    → ExecutionResult JSON, exit 0/1/99
//!
//! Exit kodları (ARCHITECTURE.md §3.3 / §3.4):
//!   0  = PERMIT / success
//!   1  = BLOCK | DENY / failed + rolled_back
//!   2  = ASK_HUMAN
//!   99 = ERROR (parse hatası, bilinmeyen mod, dahili hata)
//!
//! Fail-closed garantisi:
//!   Herhangi bir hata → DENY + LOG — asla PERMIT değil.
//!
//! ─── SENTEZ KARARLARI (Session 4) ────────────────────────────────────────────
//!
//!  DEĞİŞİKLİK 1: fn main() → fn main() -> ExitCode
//!    Rapor 2 §2: "std::process::exit() tüm destructors'ları atlar."
//!    ExitCode dönüşü Rust'ın ownership/lifetime sistemiyle temiz kapanış sağlar.
//!    Etki: process::exit() normal akıştan kaldırıldı, sadece fatal_panic'te kalır.
//!
//!  DEĞİŞİKLİK 2: read_to_string → BufReader + serde_json::from_reader
//!    Her iki rapor hemfikir (Rapor 1 §1, Rapor 2 §1).
//!    BufReader: kısa okuma operasyonlarını önler, büyük payload'ları güvenle okur.
//!    from_reader: akış halinde parse — tüm veriyi önce String'e almak gerekmez.
//!
//!  DEĞİŞİKLİK 3: stdout().flush() zorunlu
//!    Rapor 1 §1, Rapor 2 §1: "Buffer nedeniyle TypeScript tarafı veriyi alamayabilir."
//!    Her JSON yanıtından sonra flush() çağrısı zorunludur.
//!
//!  DEĞİŞİKLİK 4: Healthcheck — 4 pre-flight kontrolü (TODO)
//!    Rapor 2 §9: entropy + dosya erişimi + monotonik saat + bellek kontrolü.
//!    Bu kontroller şu an stub — Faz 3'te implement edilecek.

use std::io::{self, BufReader, Write};
use std::process::ExitCode;

mod policy_kernel;
mod execution_gate;

use sovereign_types::{Decision, ExecutionRequest};

// ─── EXIT KODLARI ────────────────────────────────────────────────────────────
// u8 — ExitCode::from() u8 alır, i32 değil.

const EXIT_PERMIT:    u8 = 0;   // PERMIT / success
const EXIT_BLOCK:     u8 = 1;   // BLOCK | DENY / failed
const EXIT_ASK_HUMAN: u8 = 2;   // ASK_HUMAN
const EXIT_ERROR:     u8 = 99;  // Dahili hata / parse hatası

// ─── MAIN ────────────────────────────────────────────────────────────────────

/// main → ExitCode (Rapor 2 §2, Sentez Kararı 1)
///
/// process::exit() normal akışta KULLANILMAZ.
/// Rust'ın ownership sistemi ExitCode dönüşüyle tüm kaynakları temizler.
fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("");

    match mode {
        "healthcheck" => run_healthcheck(),
        "policy"      => run_policy(),
        "execute"     => run_execute(),
        _ => {
            // FP-R1: binary crash → non-zero exit — TypeScript BINARY_CRASH + DENY yakalar
            eprintln!(
                "SOVEREIGN_CORE ERROR: Bilinmeyen mod: \"{mode}\". \
                 Kullanım: sovereign-core [healthcheck|policy|execute]"
            );
            ExitCode::from(EXIT_ERROR)
        }
    }
}

// ─── HEALTHCHECK ─────────────────────────────────────────────────────────────

/// FP-R4: Startup healthcheck — exit 0 dışında sistem başlamaz.
///
/// TypeScript başlangıçta bu modu çalıştırır.
/// Binary eksikse veya permission yoksa → non-zero exit → TypeScript fail-closed tetikler.
///
/// Pre-flight kontrolleri (Rapor 2 §9 — Faz 3'te implement edilecek):
///
///   [1] ENTROPY: İşletim sistemi CSPRNG hazır mı?
///       TODO Faz 3:
///         use rand::RngCore;
///         let mut buf = [0u8; 32];
///         rand::thread_rng().fill_bytes(&mut buf);
///         // Hata → exit 99: "ENTROPY_NOT_READY"
///
///   [2] DOSYA ERİŞİMİ: Audit log yazılabilir, JWT secret okunabilir mi?
///       TODO Faz 3:
///         std::fs::OpenOptions::new().append(true).open("audit.log")?;
///         let secret = std::env::var("JWT_SECRET")
///             .map_err(|_| "JWT_SECRET env eksik")?;
///         // Hata → exit 99: "FILE_ACCESS_DENIED"
///
///   [3] MONOTONİK SAAT: CLOCK_BOOTTIME çalışıyor mu?
///       TODO Faz 3:
///         use nix::time::{clock_gettime, ClockId};
///         clock_gettime(ClockId::CLOCK_BOOTTIME)?;
///         // Hata → exit 99: "CLOCK_UNAVAILABLE"
///
///   [4] BELLEK: Yeterli serbest bellek var mı?
///       TODO Faz 3: /proc/meminfo okuyarak minimum eşik kontrolü.
///         // Hata → exit 99: "INSUFFICIENT_MEMORY"
fn run_healthcheck() -> ExitCode {
    // Şu an sadece temel binary sağlık yanıtı — Faz 3'te 4 kontrol aktif olacak
    let response = serde_json::json!({
        "status":  "OK",
        "version": env!("CARGO_PKG_VERSION"),
        "binary":  "sovereign-core",
        "preflight": {
            "entropy":     "TODO:Faz3",
            "file_access": "TODO:Faz3",
            "clock":       "TODO:Faz3",
            "memory":      "TODO:Faz3"
        }
    });

    flush_stdout(&response.to_string());
    ExitCode::SUCCESS
}

// ─── POLICY ──────────────────────────────────────────────────────────────────

/// Policy Kernel akışı.
///
/// stdin → BufReader → serde_json::from_reader (Sentez Kararı 2) →
/// schema_version kontrol (FP-V1) → policy_kernel::evaluate →
/// flush_stdout (Sentez Kararı 3) → ExitCode
fn run_policy() -> ExitCode {
    // Sentez Kararı 2: BufReader + from_reader
    // Rapor 1 §1: "BufReader kullanımı kısa okuma operasyonlarını önler."
    // Rapor 2 §1: "Büyük payload DoS koruması için streaming parse zorunlu."
    let stdin = io::stdin();
    let reader = BufReader::new(stdin.lock());

    // FP-R2: Malformed JSON — exit 99, TypeScript INVALID_JSON loglar
    let decision: Decision = match serde_json::from_reader(reader) {
        Ok(d)  => d,
        Err(e) => {
            let out = sovereign_types::error_output(
                "INVALID_JSON",
                &format!("JSON parse hatası: {e}"),
                "Geçerli bir Decision JSON gönderin. ARCHITECTURE.md §2.1'e bakın.",
            );
            flush_stdout(&out);
            return ExitCode::from(EXIT_ERROR);
        }
    };

    // FP-V1: schema_version uyumsuzluğu → sessiz kırılmayı önle
    if decision.schema_version != "1.0" {
        let out = sovereign_types::error_output(
            "INVALID_SCHEMA",
            &format!(
                "Desteklenmeyen schema_version: \"{}\". Beklenen: \"1.0\".",
                decision.schema_version
            ),
            "Decision Object'te schema_version: \"1.0\" kullanın.",
        );
        flush_stdout(&out);
        return ExitCode::from(EXIT_BLOCK);
    }

    let result = policy_kernel::evaluate(&decision);

    let exit_code: u8 = match result.decision.as_str() {
        "PERMIT"    => EXIT_PERMIT,
        "ASK_HUMAN" => EXIT_ASK_HUMAN,
        _           => EXIT_BLOCK, // BLOCK | DENY — fail-closed (Rapor 2 §3)
    };

    match serde_json::to_string(&result) {
        Ok(json) => flush_stdout(&json),
        Err(e) => {
            // Serialization hatası — fail-closed
            let out = sovereign_types::error_output(
                "UNKNOWN",
                &format!("PolicyResult serialization hatası: {e}"),
                "Dahili hata. Logları inceleyin.",
            );
            flush_stdout(&out);
            return ExitCode::from(EXIT_ERROR);
        }
    }

    ExitCode::from(exit_code)
}

// ─── EXECUTE ─────────────────────────────────────────────────────────────────

/// Execution Gate akışı.
///
/// stdin → BufReader → from_reader →
/// execution_gate::execute → flush_stdout → ExitCode
fn run_execute() -> ExitCode {
    let stdin = io::stdin();
    let reader = BufReader::new(stdin.lock());

    // FP-R2: Malformed JSON
    let request: ExecutionRequest = match serde_json::from_reader(reader) {
        Ok(r)  => r,
        Err(e) => {
            let out = sovereign_types::error_output(
                "INVALID_JSON",
                &format!("JSON parse hatası: {e}"),
                "Geçerli bir ExecutionRequest JSON gönderin. ARCHITECTURE.md §3.4'e bakın.",
            );
            flush_stdout(&out);
            return ExitCode::from(EXIT_ERROR);
        }
    };

    let result = execution_gate::execute(&request);
    let exit_code: u8 = if result.success { EXIT_PERMIT } else { EXIT_BLOCK };

    match serde_json::to_string(&result) {
        Ok(json) => flush_stdout(&json),
        Err(e) => {
            eprintln!("SOVEREIGN_CORE ERROR: ExecutionResult serialization hatası: {e}");
            return ExitCode::from(EXIT_ERROR);
        }
    }

    ExitCode::from(exit_code)
}

// ─── YARDIMCI FONKSİYONLAR ───────────────────────────────────────────────────

/// stdout'a JSON yazar ve flush'lar (Sentez Kararı 3).
///
/// ZORUNLU: Rapor 1 §1, Rapor 2 §1 — "Buffer nedeniyle TypeScript tarafı
/// veriyi alamayabilir; stdout().flush() kritik bir öneme sahiptir."
///
/// Flush hatası → stderr'e logla. Veri iletilmedi demektir;
/// TypeScript timeout'u ile fail-closed tetikler.
fn flush_stdout(s: &str) {
    let stdout = io::stdout();
    let mut out = stdout.lock();
    if let Err(e) = write!(out, "{s}") {
        eprintln!("SOVEREIGN_CORE ERROR: stdout yazma hatası: {e}");
    }
    if let Err(e) = out.flush() {
        eprintln!("SOVEREIGN_CORE ERROR: stdout flush hatası: {e}");
    }
}
