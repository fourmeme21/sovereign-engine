import { describe, it, expect, beforeEach } from 'vitest';
import { ExampleNotesAdapter } from '../example/adapter.js';
import { MockEnvironment } from './mock-environment.js';

/**
 * adapter.test.ts — Minimum test suite şablonu
 *
 * Her adapter bu testleri geçmeli.
 * Kendi adapter'ını test ederken ExampleNotesAdapter → kendi adapter'ınla değiştir.
 */

const mockCtx = {
  actor_id:   'user-001',
  actor_role: 'admin',
  session_id: 'sess-001',
  bundle_id:  'bundle-abcdef123456',
  timestamp:  '2026-05-08T00:00:00Z',
};

describe('DomainAdapter — kontrat testleri', () => {
  let db: MockEnvironment;
  let adapter: ExampleNotesAdapter;

  beforeEach(() => {
    db = new MockEnvironment();
    adapter = new ExampleNotesAdapter(db);
  });

  // ── KİMLİK ────────────────────────────────────────────────────────────────

  it('name ve version dolu', () => {
    expect(adapter.name).toBeTruthy();
    expect(adapter.version).toBeTruthy();
  });

  // ── CONFIG ────────────────────────────────────────────────────────────────

  it('getConfig() geçerli değer döndürür', () => {
    const config = adapter.getConfig();
    expect(config.categories.length).toBeGreaterThan(0);
    expect(config.locked_states).toBeDefined();
    expect(config.non_negative_fields).toBeDefined();
    expect(config.privileged_roles).toBeDefined();
  });

  it('categories /^[A-Z_]+$/ formatında', () => {
    const config = adapter.getConfig();
    for (const cat of config.categories) {
      expect(cat).toMatch(/^[A-Z_]+$/);
    }
  });

  it('getConfig() her çağrıda aynı sonucu döndürür — saf fonksiyon', () => {
    expect(adapter.getConfig()).toEqual(adapter.getConfig());
  });

  // ── VALIDATE CONTRACT ─────────────────────────────────────────────────────

  it('validateContract() true döner', async () => {
    expect(await adapter.validateContract()).toBe(true);
  });

  // ── CREATE ────────────────────────────────────────────────────────────────

  it('create_note başarılı', async () => {
    const result = await adapter.execute(
      'create_note',
      { title: 'Test Not', content: 'İçerik', owner_id: 'user-001' },
      mockCtx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
  });

  it('create_note — boş title → başarısız', async () => {
    const result = await adapter.execute(
      'create_note',
      { title: '', content: 'İçerik', owner_id: 'user-001' },
      mockCtx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  // ── UPDATE ────────────────────────────────────────────────────────────────

  it('update_note başarılı', async () => {
    // Önce oluştur
    const created = await adapter.execute(
      'create_note',
      { title: 'Eski Başlık', content: 'İçerik', owner_id: 'user-001' },
      mockCtx,
    );
    const note = created.output as { id: string };

    const result = await adapter.execute(
      'update_note',
      { note_id: note.id, title: 'Yeni Başlık' },
      mockCtx,
    );
    expect(result.success).toBe(true);
    expect((result.output as { title: string }).title).toBe('Yeni Başlık');
  });

  it('update_note — olmayan ID → başarısız', async () => {
    const result = await adapter.execute(
      'update_note',
      { note_id: 'olmayan-id', title: 'Yeni' },
      mockCtx,
    );
    expect(result.success).toBe(false);
  });

  // ── DELETE ────────────────────────────────────────────────────────────────

  it('delete_note başarılı', async () => {
    const created = await adapter.execute(
      'create_note',
      { title: 'Silinecek', content: '', owner_id: 'user-001' },
      mockCtx,
    );
    const note = created.output as { id: string };

    const result = await adapter.execute('delete_note', { note_id: note.id }, mockCtx);
    expect(result.success).toBe(true);

    // Artık DB'de yok
    expect(db.get(note.id)).toBeNull();
  });

  it('delete_note — olmayan ID → başarısız', async () => {
    const result = await adapter.execute('delete_note', { note_id: 'yok' }, mockCtx);
    expect(result.success).toBe(false);
  });

  // ── ROLLBACK ──────────────────────────────────────────────────────────────

  it('update rollback — önceki state geri gelir', async () => {
    const created = await adapter.execute(
      'create_note',
      { title: 'Orijinal', content: 'İçerik', owner_id: 'user-001' },
      mockCtx,
    );
    const note = created.output as { id: string; title: string };

    const backup = await adapter.readState('update_note', { note_id: note.id });
    await adapter.execute('update_note', { note_id: note.id, title: 'Değiştirildi' }, mockCtx);

    // Rollback
    await adapter.rollback('update_note', { note_id: note.id }, backup);

    const restored = db.get(note.id) as { title: string };
    expect(restored.title).toBe('Orijinal');
  });

  // ── BİLİNMEYEN AKSİYON ───────────────────────────────────────────────────

  it('bilinmeyen aksiyon → başarısız, panic yok', async () => {
    const result = await adapter.execute('unknown_action', {}, mockCtx);
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
