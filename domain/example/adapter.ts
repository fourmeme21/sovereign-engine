/**
 * domain/example/adapter.ts — Tam çalışan örnek domain
 *
 * "notes" domain'i: basit not CRUD, 3 aksiyon.
 *
 * Aksiyonlar:
 *   create_note  — yeni not oluştur (WRITE_RESOURCE)
 *   update_note  — mevcut notu güncelle (WRITE_RESOURCE)
 *   delete_note  — notu sil (DELETE_RESOURCE, admin)
 *
 * Bu dosyayı referans olarak kullan — kendi adapter'ını buradan türet.
 */

import {
  type DomainAdapter,
  type DomainConfig,
  type ExecutionContext,
  type ActionResult,
  runBaseContractChecks,
} from '../template/adapter.js';
import { MockEnvironment } from '../template/mock-environment.js';

// ─── TİPLER ──────────────────────────────────────────────────────────────────

interface CreateNoteParams {
  title: string;
  content: string;
  owner_id: string;
}

interface UpdateNoteParams {
  note_id: string;
  title?: string;
  content?: string;
}

interface DeleteNoteParams {
  note_id: string;
}

interface Note {
  id: string;
  title: string;
  content: string;
  owner_id: string;
  created_at: string;
  updated_at: string;
}

// ─── EXAMPLE ADAPTER ─────────────────────────────────────────────────────────

export class ExampleNotesAdapter implements DomainAdapter {
  readonly name = 'example-notes';
  readonly version = '1.0.0';

  // Test ortamında MockEnvironment, üretimde gerçek DB inject edilir
  constructor(private readonly db: MockEnvironment = new MockEnvironment()) {}

  getConfig(): DomainConfig {
    return {
      locked_states:       ['created_at', 'owner_id'],
      non_negative_fields: [],
      privileged_roles:    ['admin', 'system'],
      categories:          ['READ_RESOURCE', 'WRITE_RESOURCE', 'DELETE_RESOURCE'],
    };
  }

  async readState(actionName: string, params: unknown): Promise<unknown> {
    const p = params as Record<string, string>;

    if (actionName === 'update_note' || actionName === 'delete_note') {
      return this.db.get(p['note_id']) ?? null;
    }

    return null; // create_note: mevcut state yok
  }

  async execute(
    actionName: string,
    params: unknown,
    context: ExecutionContext,
  ): Promise<ActionResult> {
    try {
      switch (actionName) {
        case 'create_note':   return this.createNote(params as CreateNoteParams, context);
        case 'update_note':   return this.updateNote(params as UpdateNoteParams, context);
        case 'delete_note':   return this.deleteNote(params as DeleteNoteParams);
        default:
          return { success: false, error: `Bilinmeyen aksiyon: ${actionName}` };
      }
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  async rollback(actionName: string, params: unknown, backup: unknown): Promise<void> {
    const p = params as Record<string, string>;

    if (actionName === 'create_note') {
      // Oluşturulan notu sil
      const noteId = p['_created_id'];
      if (noteId) this.db.delete(noteId);
      return;
    }

    if (actionName === 'update_note' || actionName === 'delete_note') {
      // Önceki state'i geri yükle
      if (backup && p['note_id']) {
        this.db.set(p['note_id'], backup);
      }
      return;
    }
  }

  async validateContract(): Promise<boolean> {
    const base = await runBaseContractChecks(this);
    if (!base) return false;

    // Domain'e özgü kontrol: DB erişilebilir mi?
    try {
      this.db.get('__healthcheck__');
      return true;
    } catch {
      console.error(`[${this.name}] validateContract FAIL: DB erişim hatası`);
      return false;
    }
  }

  // ── ÖZEL METODLAR ──────────────────────────────────────────────────────────

  private createNote(params: CreateNoteParams, context: ExecutionContext): ActionResult {
    if (!params.title?.trim()) {
      return { success: false, error: 'title boş olamaz' };
    }

    const note: Note = {
      id:         `note-${context.bundle_id.slice(7, 15)}`,
      title:      params.title,
      content:    params.content ?? '',
      owner_id:   params.owner_id,
      created_at: context.timestamp,
      updated_at: context.timestamp,
    };

    this.db.set(note.id, note);
    return { success: true, output: note };
  }

  private updateNote(params: UpdateNoteParams, context: ExecutionContext): ActionResult {
    const existing = this.db.get(params.note_id) as Note | null;
    if (!existing) {
      return { success: false, error: `Not bulunamadı: ${params.note_id}` };
    }

    const backup = { ...existing };

    const updated: Note = {
      ...existing,
      title:      params.title      ?? existing.title,
      content:    params.content    ?? existing.content,
      updated_at: context.timestamp,
    };

    this.db.set(params.note_id, updated);
    return { success: true, output: updated, backup };
  }

  private deleteNote(params: DeleteNoteParams): ActionResult {
    const existing = this.db.get(params.note_id) as Note | null;
    if (!existing) {
      return { success: false, error: `Not bulunamadı: ${params.note_id}` };
    }

    const backup = { ...existing };
    this.db.delete(params.note_id);
    return { success: true, backup };
  }
}
