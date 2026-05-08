/**
 * mock-environment.ts — Test ortamı
 *
 * Adapter testlerinde gerçek DB/API yerine bu mock kullanılır.
 * Üretimde KULLANILMAZ.
 */

export interface MockStore {
  [key: string]: unknown;
}

/**
 * In-memory mock store — adapter testleri için
 */
export class MockEnvironment {
  private store: MockStore = {};
  private callLog: { method: string; args: unknown[] }[] = [];

  /** Başlangıç verisi yükle */
  seed(data: MockStore): void {
    this.store = { ...data };
  }

  /** Kayıt oku */
  get(key: string): unknown {
    this.callLog.push({ method: 'get', args: [key] });
    return this.store[key] ?? null;
  }

  /** Kayıt yaz */
  set(key: string, value: unknown): void {
    this.callLog.push({ method: 'set', args: [key, value] });
    this.store[key] = value;
  }

  /** Kayıt sil */
  delete(key: string): boolean {
    this.callLog.push({ method: 'delete', args: [key] });
    const existed = key in this.store;
    delete this.store[key];
    return existed;
  }

  /** Tüm store'u döndür — test assertion için */
  snapshot(): MockStore {
    return { ...this.store };
  }

  /** Çağrı geçmişi — kaç kez çağrıldı kontrolü için */
  getCalls(method?: string) {
    if (method) return this.callLog.filter(c => c.method === method);
    return [...this.callLog];
  }

  /** Sıfırla — beforeEach'te kullan */
  reset(): void {
    this.store = {};
    this.callLog = [];
  }
}

/** Singleton mock — testler arasında paylaşım için */
export const mockEnv = new MockEnvironment();
