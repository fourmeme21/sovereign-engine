/**
 * categories.ts — Kategori tanımı şablonu
 *
 * Her kategori bir aksiyon grubunu temsil eder.
 * Decision.category bu listeden gelmelidir.
 * /^[A-Z_]+$/ formatı zorunlu.
 */

export const TEMPLATE_CATEGORIES = {
  READ_RESOURCE:   'READ_RESOURCE',
  WRITE_RESOURCE:  'WRITE_RESOURCE',
  DELETE_RESOURCE: 'DELETE_RESOURCE',
} as const;

export type TemplateCategoryType = typeof TEMPLATE_CATEGORIES[keyof typeof TEMPLATE_CATEGORIES];

/** Kategori açıklamaları — dokümantasyon ve hata mesajları için */
export const CATEGORY_DESCRIPTIONS: Record<TemplateCategoryType, string> = {
  READ_RESOURCE:   'Kaynak okuma — yan etkisiz',
  WRITE_RESOURCE:  'Kaynak yazma/güncelleme — audit log zorunlu',
  DELETE_RESOURCE: 'Kaynak silme — geri alınamaz, CRITICAL risk zorunlu',
};
