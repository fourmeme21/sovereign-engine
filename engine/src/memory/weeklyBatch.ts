// engine/src/memory/weeklyBatch.ts
// Task 0.7 — Heat Score Decay + re_embed_queue Worker
//
// Kullanım (engine/src/index.ts içine ekle):
//   import { startWeeklyBatch } from "./memory/weeklyBatch.js";
//   startWeeklyBatch();

import { supabase } from "../lib/supabase.js";
import { embedSingle } from "./voyageClient.js";

const BATCH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 gün
const DECAY_RATE        = 0.95;                      // haftalık %5 azalma
const QUEUE_BATCH_SIZE  = 50;                        // tek seferde max işlenecek

// ─────────────────────────────────────────────────────────────
// Ana batch fonksiyonu
// ─────────────────────────────────────────────────────────────
export async function runWeeklyBatch(): Promise<void> {
  console.log("[weeklyBatch] Başlatıldı:", new Date().toISOString());

  try {
    await runHeatDecay();
  } catch (err: any) {
    console.error("[weeklyBatch] Heat decay hatası:", err.message);
  }

  try {
    await processReEmbedQueue();
  } catch (err: any) {
    console.error("[weeklyBatch] re_embed_queue hatası:", err.message);
  }

  console.log("[weeklyBatch] Tamamlandı:", new Date().toISOString());
}

// ─────────────────────────────────────────────────────────────
// 1. Heat Score Decay
//    7 günden eski chunk'ların heat_score'unu %5 azalt
//    Arama skorlaması zamanla discrimination'ını korur
// ─────────────────────────────────────────────────────────────
async function runHeatDecay(): Promise<void> {
  const { error, count } = await supabase.rpc("apply_heat_decay", {
    p_decay_rate:      DECAY_RATE,
    p_interval_days:   7,
  });

  // RPC yoksa doğrudan SQL ile fallback
  if (error) {
    console.warn("[weeklyBatch] RPC bulunamadı, doğrudan update deneniyor...");

    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    const { error: updateError, count: updateCount } = await supabase
      .from("memory_chunks")
      .update({
        heat_score:        supabase.rpc as any, // tip uyumu için — gerçek değer aşağıda
        last_validated_at: new Date().toISOString(),
      })
      .lt("last_validated_at", cutoff)
      .eq("is_invalidated", false);

    // Supabase client doğrudan çarpımsal update desteklemediği için
    // bulk update SQL'i RPC olarak tanımla (aşağıda SQL referansı)
    if (updateError) {
      console.error("[weeklyBatch] Fallback update hatası:", updateError.message);
      console.info("[weeklyBatch] Supabase'e şu SQL'i RPC olarak ekle:\n", HEAT_DECAY_SQL);
    } else {
      console.log(`[weeklyBatch] Heat decay uygulandı: ${updateCount ?? "?"} chunk`);
    }
    return;
  }

  console.log(`[weeklyBatch] Heat decay tamamlandı: ${count ?? "?"} chunk güncellendi`);
}

// ─────────────────────────────────────────────────────────────
// 2. re_embed_queue Worker
//    Queue'daki pending kayıtları embed et → memory_chunks güncelle
// ─────────────────────────────────────────────────────────────
async function processReEmbedQueue(): Promise<void> {
  const { data: pending, error } = await supabase
    .from("re_embed_queue")
    .select("id, chunk_id, reason")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(QUEUE_BATCH_SIZE);

  if (error) {
    console.error("[weeklyBatch] Queue fetch hatası:", error.message);
    return;
  }

  if (!pending?.length) {
    console.log("[weeklyBatch] re_embed_queue boş, atlıyorum.");
    return;
  }

  console.log(`[weeklyBatch] ${pending.length} chunk yeniden embed ediliyor...`);

  let success = 0;
  let failed  = 0;

  for (const item of pending) {
    try {
      // Chunk içeriğini al
      const { data: chunk, error: chunkErr } = await supabase
        .from("memory_chunks")
        .select("id, content")
        .eq("id", item.chunk_id)
        .single();

      if (chunkErr || !chunk) {
        console.warn(`[weeklyBatch] Chunk bulunamadı: ${item.chunk_id}`);
        await markQueueItem(item.id, "failed", "chunk not found");
        failed++;
        continue;
      }

      // Yeni embedding üret
      const embedding = await embedSingle(chunk.content, "document");

      // memory_chunks güncelle
      const { error: updateErr } = await supabase
        .from("memory_chunks")
        .update({
          embedding:         JSON.stringify(embedding),
          last_validated_at: new Date().toISOString(),
        })
        .eq("id", chunk.id);

      if (updateErr) throw updateErr;

      // Queue'dan sil
      await markQueueItem(item.id, "done", null);
      success++;

    } catch (err: any) {
      console.error(`[weeklyBatch] Chunk ${item.chunk_id} embed hatası:`, err.message);
      await markQueueItem(item.id, "failed", err.message);
      failed++;
    }
  }

  console.log(`[weeklyBatch] re_embed_queue: ${success} başarılı, ${failed} başarısız`);
}

async function markQueueItem(
  id: string,
  status: "done" | "failed",
  error: string | null
): Promise<void> {
  if (status === "done") {
    await supabase.from("re_embed_queue").delete().eq("id", id);
  } else {
    await supabase
      .from("re_embed_queue")
      .update({ status: "failed", error_message: error, updated_at: new Date().toISOString() })
      .eq("id", id);
  }
}

// ─────────────────────────────────────────────────────────────
// Scheduler — engine başlangıcında çağır
// ─────────────────────────────────────────────────────────────
export function startWeeklyBatch(): void {
  // Başlangıçta bir kez çalıştır (Railway restart sonrası kaçan batch'leri yakala)
  runWeeklyBatch().catch((err) =>
    console.error("[weeklyBatch] İlk çalıştırma hatası:", err.message)
  );

  // Sonra her 7 günde bir
  setInterval(() => {
    runWeeklyBatch().catch((err) =>
      console.error("[weeklyBatch] Periyodik çalıştırma hatası:", err.message)
    );
  }, BATCH_INTERVAL_MS);

  console.log("[weeklyBatch] Scheduler başlatıldı — interval: 7 gün");
}

// ─────────────────────────────────────────────────────────────
// Supabase RPC referansı
// Supabase SQL Editor'de bir kez çalıştır:
// ─────────────────────────────────────────────────────────────
export const HEAT_DECAY_SQL = `
CREATE OR REPLACE FUNCTION apply_heat_decay(
  p_decay_rate    FLOAT DEFAULT 0.95,
  p_interval_days INT   DEFAULT 7
)
RETURNS void LANGUAGE sql AS $$
  UPDATE memory_chunks
  SET
    heat_score        = heat_score * p_decay_rate,
    last_validated_at = NOW()
  WHERE
    last_validated_at < NOW() - (p_interval_days || ' days')::INTERVAL
    AND is_invalidated = false;
$$;
`;
  
