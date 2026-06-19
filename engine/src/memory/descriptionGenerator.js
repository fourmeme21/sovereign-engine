// engine/src/memory/descriptionGenerator.ts
// Task 0.2 — LLM çağrıları kaldırıldı, basit summary ile değiştirildi
// Önceki durum: generateChunkDescription → her chunk için Claude API (~200ms + $0.002)
// Yeni durum  : saf string işleme → sıfır API çağrısı, <1ms
// ─────────────────────────────────────────────────────────────
// Dosya seviyesi özet — zaten LLM'siz, korundu
// ─────────────────────────────────────────────────────────────
export async function generateFileLevelSummary(filePath, fileContent, astChunks) {
    const totalLines = fileContent.split("\n").length;
    const functionCount = astChunks.filter((c) => c.type === "function").length;
    const classCount = astChunks.filter((c) => c.type === "class").length;
    const todoCount = astChunks.filter((c) => c.hasToDoFixMe).length;
    const imports = fileContent.match(/^import .+/gm) ?? [];
    const topImports = imports.slice(0, 3).join(", ");
    return [
        `${filePath} (${totalLines} satır,`,
        `${functionCount} fonksiyon,`,
        `${classCount} sınıf,`,
        `${todoCount} TODO/FIXME`,
        topImports ? `| imports: ${topImports}` : "",
    ]
        .filter(Boolean)
        .join(" ");
}
// ─────────────────────────────────────────────────────────────
// Chunk seviyesi açıklama — LLM KALDIRILDI
//
// Önceki davranış:
//   ANTHROPIC_API_KEY varsa → claude-sonnet API çağrısı
//   10 dosya x ort. 15 chunk = 150 API çağrısı = ~15 sn + $0.20
//
// Yeni davranış:
//   Her durumda basit string → sıfır API çağrısı
//   Vektör arama kalitesi etkilenmez (embedding içeriği değişmedi)
// ─────────────────────────────────────────────────────────────
export async function generateChunkDescription(chunk) {
    const parts = [];
    // Temel kimlik
    parts.push(`${chunk.type} ${chunk.name}`);
    // Konum
    parts.push(`(satır ${chunk.startLine}–${chunk.endLine})`);
    // Sınıf bağlamı
    if (chunk.enclosingClass) {
        parts.push(`[${chunk.enclosingClass} içinde]`);
    }
    // Modül yolu
    if (chunk.fileModule) {
        parts.push(`| modül: ${chunk.fileModule}`);
    }
    // Import varsa ilk 3'ü ekle
    if (chunk.imports?.length) {
        parts.push(`| imports: ${chunk.imports.slice(0, 3).join(", ")}`);
    }
    // TODO/FIXME uyarısı
    if (chunk.hasToDoFixMe) {
        parts.push("⚠️ TODO/FIXME");
    }
    // İçeriğin ilk 200 karakteri — semantik embedding kalitesi için
    const bodyPreview = chunk.body.slice(0, 200).replace(/\s+/g, " ").trim();
    if (bodyPreview) {
        parts.push(`| ${bodyPreview}`);
    }
    return parts.join(" ");
}
//# sourceMappingURL=descriptionGenerator.js.map