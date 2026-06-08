// adapter.sandbox.ts
// Amaç:    vm.Script() sandbox'ında çalışan self-contained adapter şablonu
// Bağlı:   aiProxy.ts → runAdapterExecution() → vm.Script sandbox
// Karar:   TB-17 — Generation Engine adapter üretimi
// Dokunma: Sandbox kısıtları runAdapterExecution() FORBIDDEN_PATTERNS ile belirlenir.
//          import / require / fetch / process.env YASAK — dış bağımlılık eklenirse
//          adapter validateContract geçemez, DENY döner.
//          execute() içine Supabase bağlantısı KOYMA — context.db_client kullan.

// ─── SANDBOX KİTAPLIĞI ────────────────────────────────────────────────────────
// Sandbox'ta sadece bunlar var:
//   console, setTimeout, clearTimeout, Promise, JSON, Math
//   Date, Error, Array, Object, String, Number, Boolean, Map, Set
//
// YASAK: import, require, fetch, process, fs, axios, eval, new Function
//        global, globalThis, __dirname, __filename, child_process

// ─── TİPLER (inline — import yok) ────────────────────────────────────────────

interface ExecutionContext {
  bundle_id:    string;     // Unique işlem ID'si
  user_id:      string;     // Kararı veren kullanıcı
  timestamp:    string;     // ISO 8601
  session_id?:  string;     // Aktif session ID (opsiyonel)
}

interface ActionResult {
  success:  boolean;
  output?:  unknown;        // Başarıda dönen veri
  backup?:  unknown;        // Rollback için önceki state
  error?:   string;         // Hata mesajı (güvenli, kullanıcıya gösterilebilir)
}

interface DomainConfig {
  locked_states:       string[];   // Değiştirilemez alanlar (örn: 'created_at', 'owner_id')
  non_negative_fields: string[];   // Negatif olamaz (örn: 'amount', 'stock')
  privileged_roles:    string[];   // Yüksek yetki gerektiren roller
  categories:          string[];   // Bu adapter'ın desteklediği kategoriler — /^[A-Z_]+$/
}

// ─── ADAPTER SINIFI ───────────────────────────────────────────────────────────
// Bu sınıf DOĞRUDAN kopyalanmaz — projeye özgü doldurulur.
// Generation Engine bu şablonu master plan + ARCHITECTURE.md'ye göre özelleştirir.
//
// Edge case'ler:
//   1. execute() bilinmeyen action gelirse → success: false, DENY
//   2. validateContract() false dönerse → adapter yüklenmez
//   3. rollback() hata fırlatırsa → log yaz, sessiz geç (best effort)
//   4. params tip uyumsuzluğu → try/catch ile yakala, success: false
//   5. context.user_id eksikse → sahiplik kontrolü yapılamaz → DENY

class ProjectAdapter {
  readonly name:    string = 'PROJECT_ADAPTER_NAME';  // TODO: proje adıyla değiştir
  readonly version: string = '1.0.0';

  // Adapter konfigürasyonu — projeye özgü doldurulur
  getConfig(): DomainConfig {
    return {
      // Değiştirilemez alanlar — bu alanlara yazma girişimi DENY döner
      locked_states: ['created_at', 'owner_id'],

      // Negatif olamaz — bu alanlar için negatif değer DENY döner
      non_negative_fields: ['amount', 'quantity'],

      // Yüksek yetki gerektiren roller
      privileged_roles: ['admin', 'system'],

      // Bu adapter'ın işleyebildiği Decision kategorileri
      // Değer /^[A-Z_]+$/ formatında olmalı
      categories: [
        'READ_RESOURCE',
        'WRITE_RESOURCE',
        'DELETE_RESOURCE',
        // TODO: Projeye özgü kategoriler buraya eklenir
        // Örnek: 'APPROVE_ORDER', 'CANCEL_ORDER', 'ASSIGN_TASK'
      ],
    };
  }

  // Mevcut state'i okur — validation için pre-flight read
  // Dış DB çağrısı yapılamaz — context üzerinden gelen state kullanılır
  // Karar: validate → policy → execute sırasını kırma
  async readState(
    actionName: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    // TODO: action'a göre mevcut state döndür
    // Örnek: update/delete işlemlerinde mevcut kaydı döndür, create'de null
    void actionName; void params; // lint susturucu — kullanılmadan önce sil
    return null;
  }

  // Kararı uygula — ana iş mantığı buraya
  async execute(
    actionName: string,
    params:     Record<string, unknown>,
    context:    ExecutionContext,
  ): Promise<ActionResult> {
    try {
      switch (actionName) {
        // TODO: Projeye özgü action'ları buraya ekle
        // Örnek pattern:
        //   case 'create_order': return this.createOrder(params, context);
        //   case 'approve_order': return this.approveOrder(params, context);
        //   case 'cancel_order': return this.cancelOrder(params, context);

        default:
          // fail-closed: bilinmeyen action → DENY
          return {
            success: false,
            error:   `Bilinmeyen aksiyon: "${actionName}" — bu adapter desteklemiyor.`,
          };
      }
    } catch (err: unknown) {
      // SSC-5: iç hata mesajını direkt dönderme — güvenli mesaj üret
      const safeMsg = err instanceof Error ? err.message.slice(0, 100) : 'Beklenmeyen hata';
      console.error(`[${this.name}] execute() hatası:`, safeMsg);
      return { success: false, error: safeMsg };
    }
  }

  // Geri al — execute başarılıysa backup'tan önceki state'e dön
  async rollback(
    actionName: string,
    params:     Record<string, unknown>,
    backup:     unknown,
  ): Promise<void> {
    // TODO: action'a göre rollback mantığı
    // Örnek:
    //   create → oluşturulan kaydı sil
    //   update → backup'taki değerlere geri dön
    //   delete → backup'taki kaydı geri yükle
    void actionName; void params; void backup;
    console.warn(`[${this.name}] rollback() henüz implement edilmedi — ${actionName}`);
  }

  // Adapter geçerli mi kontrol et — false dönerse adapter yüklenmez
  async validateContract(): Promise<boolean> {
    const config = this.getConfig();

    // Temel kontratlar
    if (!this.name || !this.version) {
      console.error(`[validateContract] name/version eksik`);
      return false;
    }

    if (!Array.isArray(config.categories) || config.categories.length === 0) {
      console.error(`[validateContract] categories boş`);
      return false;
    }

    // Kategori format kontrolü: /^[A-Z_]+$/
    const catPattern = /^[A-Z_]+$/;
    for (const cat of config.categories) {
      if (!catPattern.test(cat)) {
        console.error(`[validateContract] Geçersiz kategori: "${cat}"`);
        return false;
      }
    }

    // execute() ve rollback() implement edilmiş mi?
    if (typeof this.execute !== 'function' || typeof this.rollback !== 'function') {
      console.error(`[validateContract] execute() veya rollback() eksik`);
      return false;
    }

    return true;
  }

  // ── ÖZEL METODLAR ──────────────────────────────────────────────────────────
  // Her action için ayrı private metod — max 20 satır disiplini
  // Örnek:
  //
  // private createOrder(
  //   params:  Record<string, unknown>,
  //   context: ExecutionContext,
  // ): ActionResult {
  //   const { product_id, quantity, owner_id } = params;
  //
  //   if (!product_id || typeof product_id !== 'string') {
  //     return { success: false, error: 'product_id zorunlu' };
  //   }
  //   if (typeof quantity !== 'number' || quantity <= 0) {
  //     return { success: false, error: 'quantity pozitif sayı olmalı' };
  //   }
  //
  //   // Gerçek işlem — sandbox'ta sadece in-memory state
  //   const order = {
  //     id:         `order-${context.bundle_id.slice(0, 8)}`,
  //     product_id,
  //     quantity,
  //     owner_id,
  //     created_at: context.timestamp,
  //     status:     'pending',
  //   };
  //
  //   return { success: true, output: order };
  // }
}

// ─── EXPORT — sandbox bunu okur ───────────────────────────────────────────────
// runAdapterExecution() şunu arar:
//   sandboxExports['default'] veya Object.values(sandboxExports)[0]
// CommonJS export formatı kullan — ESM import/export yasak

exports.default = ProjectAdapter;
