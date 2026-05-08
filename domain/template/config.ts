/**
 * config.ts — Domain kısıt konfigürasyonu şablonu
 *
 * Bu dosyayı kopyala, domain'e özgü değerleri doldur.
 * Policy Kernel Hard Lock'ları bu config'i kullanır.
 */

import type { DomainConfig } from './adapter.js';

/**
 * Şablon konfigürasyon — kendi domain'in için özelleştir.
 *
 * locked_states:       Hiçbir zaman değiştirilemeyen alanlar.
 *                      Örn: kullanıcı ID'si, oluşturulma tarihi, audit trail.
 *
 * non_negative_fields: Değeri ≤ 0 olamayacak alanlar.
 *                      Örn: bakiye, miktar, adet, fiyat.
 *
 * privileged_roles:    Bu aksiyonlar için yetkili roller.
 *                      Örn: "admin", "system", "supervisor".
 *
 * categories:          Bu domain'in desteklediği aksiyon kategorileri.
 *                      /^[A-Z_]+$/ formatında olmalı.
 */
export const templateConfig: DomainConfig = {
  locked_states: [
    'created_at',
    'user_id',
    // TODO: domain'e özgü değişmez alanları ekle
  ],

  non_negative_fields: [
    'amount',
    'balance',
    // TODO: domain'e özgü pozitif zorunlu alanları ekle
  ],

  privileged_roles: [
    'admin',
    'system',
    // TODO: domain'e özgü yetkili rolleri ekle
  ],

  categories: [
    'READ_RESOURCE',
    'WRITE_RESOURCE',
    'DELETE_RESOURCE',
    // TODO: domain'e özgü kategorileri ekle veya çıkar
  ],
};
