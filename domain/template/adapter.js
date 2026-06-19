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
// ─── KONTRAT YARDIMCISI ──────────────────────────────────────────────────────
/**
 * validateContract() implementasyonlarında kullanılacak temel kontroller.
 * Adapter kendi kontrollerini buna ekleyebilir.
 */
export async function runBaseContractChecks(adapter) {
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
//# sourceMappingURL=adapter.js.map