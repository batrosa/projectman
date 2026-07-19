import { describe, it, expect } from "vitest";
import { zipSync } from "fflate";
import { extractMaterialText } from "./material-parser.js";

describe("extractMaterialText", () => {
  it("extracts plain text from a .md file", async () => {
    const base64 = Buffer.from("# Заметка\nПривет мир").toString("base64");
    const result = await extractMaterialText({ filename: "note.md", contentType: "text/markdown", base64 });
    expect(result.parser).toBe("md");
    expect(result.text).toContain("Привет мир");
  });

  it("returns a warning for an empty file", async () => {
    const result = await extractMaterialText({ filename: "empty.pdf", contentType: "application/pdf", base64: "" });
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});

// --- In-test Office/PDF builders (keeps fixtures reviewable as source) ---

const encoder = new TextEncoder();

function zipBase64(files) {
  return Buffer.from(zipSync(
    Object.fromEntries(Object.entries(files).map(([path, text]) => [path, encoder.encode(text)]))
  )).toString("base64");
}

function docxBase64(documentXml, extras = {}) {
  return zipBase64({ "word/document.xml": documentXml, ...extras });
}

function xlsxBase64(sheets, sharedStringsXml = null) {
  const files = {
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="${sheet.rId}"/>`)
      .join("")}</sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((sheet) => `<Relationship Id="${sheet.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${sheet.target}"/>`)
      .join("")}</Relationships>`,
  };
  for (const sheet of sheets) files[`xl/${sheet.target}`] = sheet.xml;
  if (sharedStringsXml) files["xl/sharedStrings.xml"] = sharedStringsXml;
  return zipBase64(files);
}

function inlineRow(cells) {
  return `<row>${cells
    .map((cell, index) => `<c r="${String.fromCharCode(65 + index)}1" t="inlineStr"><is><t>${cell}</t></is></c>`)
    .join("")}</row>`;
}

// Minimal single-font PDF with a correct xref table. `text` empty = no text
// layer at all (a scan).
function buildPdf(pageCount, { text = "" } = {}) {
  const objects = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  for (let i = 0; i < pageCount; i++) {
    const pageNum = 3 + i * 2;
    const stream = text ? `BT /F1 12 Tf 72 720 Td (${text}) Tj ET` : "";
    objects[pageNum] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${pageNum + 1} 0 R >>`;
    objects[pageNum + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i < objects.length; i++) {
    offsets[i] = pdf.length;
    pdf += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objects.length; i++) pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1").toString("base64");
}

// Cyrillic-only windows-1251 encoder for the mojibake fallback test.
function cp1251Base64(text) {
  const bytes = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 128) bytes.push(code);
    else if (code === 0x0401) bytes.push(0xA8); // Ё
    else if (code === 0x0451) bytes.push(0xB8); // ё
    else if (code >= 0x0410 && code <= 0x044F) bytes.push(code - 0x0410 + 0xC0);
    else bytes.push(0x3F);
  }
  return Buffer.from(bytes).toString("base64");
}

describe("docx extraction details", () => {
  it("keeps table cells tab-separated instead of merging them", async () => {
    const base64 = docxBase64(`<?xml version="1.0"?>
<w:document><w:body><w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>Задача</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Срок</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>Смета</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>01.05.2026</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl></w:body></w:document>`);
    const result = await extractMaterialText({ filename: "table.docx", contentType: "", base64 });
    expect(result.text).toContain("Задача\tСрок");
    expect(result.text).toContain("Смета\t01.05.2026");
  });

  it("reads every header/footer part, not just header1/footer1", async () => {
    const base64 = docxBase64(
      `<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Основной текст</w:t></w:r></w:p></w:body></w:document>`,
      {
        "word/header2.xml": `<w:hdr><w:p><w:r><w:t>Верхний колонтитул второй страницы</w:t></w:r></w:p></w:hdr>`,
        "word/footer3.xml": `<w:ftr><w:p><w:r><w:t>Нижний колонтитул третьей страницы</w:t></w:r></w:p></w:ftr>`,
      }
    );
    const result = await extractMaterialText({ filename: "parts.docx", contentType: "", base64 });
    expect(result.text).toContain("Основной текст");
    expect(result.text).toContain("Верхний колонтитул второй страницы");
    expect(result.text).toContain("Нижний колонтитул третьей страницы");
  });

  it("drops track-changes deletions from the extracted text", async () => {
    const base64 = docxBase64(`<?xml version="1.0"?>
<w:document><w:body>
<w:p><w:r><w:t>Видимый текст</w:t></w:r></w:p>
<w:p><w:del><w:r><w:delText>Удалённый кусок</w:delText></w:r></w:del></w:p>
</w:body></w:document>`);
    const result = await extractMaterialText({ filename: "tracked.docx", contentType: "", base64 });
    expect(result.text).toContain("Видимый текст");
    expect(result.text).not.toContain("Удалённый кусок");
  });
});

describe("xlsx extraction details", () => {
  it("converts Excel date serials only under date-ish column headers", async () => {
    const base64 = xlsxBase64([{
      name: "План",
      rId: "rId1",
      target: "worksheets/sheet1.xml",
      xml: `<?xml version="1.0"?><worksheet><sheetData>
<row><c r="A1" t="inlineStr"><is><t>Задача</t></is></c><c r="B1" t="inlineStr"><is><t>Дата начала</t></is></c><c r="C1" t="inlineStr"><is><t>Количество</t></is></c></row>
<row><c r="A2" t="inlineStr"><is><t>Смета</t></is></c><c r="B2"><v>46179</v></c><c r="C2"><v>46180</v></c></row>
<row><c r="A3" t="inlineStr"><is><t>Отчёт</t></is></c><c r="B3"><v>99999</v></c><c r="C3"><v>7</v></c></row>
</sheetData></worksheet>`,
    }]);
    const result = await extractMaterialText({ filename: "dates.xlsx", contentType: "", base64 });
    // Serial under «Дата начала» → ISO date; same-ish number under
    // «Количество» and an out-of-range serial stay raw.
    expect(result.text).toContain("Смета\t2026-06-06\t46180");
    expect(result.text).toContain("Отчёт\t99999\t7");
  });

  it("maps sheet names through workbook rels and warns about skipped sheets", async () => {
    // File numbering deliberately disagrees with tab order: sheet1.xml is the
    // second tab («Инструкция»), sheet2.xml the first («Дорожная карта»).
    const base64 = xlsxBase64([
      { name: "Дорожная карта", rId: "rId1", target: "worksheets/sheet2.xml", xml: `<?xml version="1.0"?><worksheet><sheetData>${inlineRow(["Этап 1"])}</sheetData></worksheet>` },
      { name: "Инструкция", rId: "rId2", target: "worksheets/sheet1.xml", xml: `<?xml version="1.0"?><worksheet><sheetData>${inlineRow(["Не читай меня"])}</sheetData></worksheet>` },
    ]);
    const result = await extractMaterialText({ filename: "rels.xlsx", contentType: "", base64 });
    expect(result.text).toContain("Лист: Дорожная карта");
    expect(result.text).toContain("Этап 1");
    expect(result.text).not.toContain("Не читай меня");
    expect(result.text).not.toContain("Лист: Инструкция");
    expect(result.warnings).toContain("Лист «Инструкция» пропущен");
  });
});

describe("text encodings", () => {
  it("re-decodes cp1251 text that utf-8 mangles into replacement chars", async () => {
    const base64 = cp1251Base64("Привет из старой кодировки");
    const result = await extractMaterialText({ filename: "legacy.md", contentType: "text/markdown", base64 });
    expect(result.text).toContain("Привет из старой кодировки");
    expect(result.text).not.toContain("�");
  });
});

describe("pdf extraction details", () => {
  it("warns about a scanned PDF without a text layer", async () => {
    const result = await extractMaterialText({ filename: "scan.pdf", contentType: "application/pdf", base64: buildPdf(3) });
    expect(result.text).toBe("");
    expect(result.warnings).toContain("Похоже на скан без текстового слоя — нужен OCR");
  });

  it("does not warn for a PDF with a real text layer", async () => {
    const base64 = buildPdf(2, { text: "Hello PDF page with a genuine text layer" });
    const result = await extractMaterialText({ filename: "text.pdf", contentType: "application/pdf", base64 });
    expect(result.text).toContain("Hello PDF page with a genuine text layer");
    expect(result.warnings).not.toContain("Похоже на скан без текстового слоя — нужен OCR");
  });

  it("caps extraction at 200 pages and says so", async () => {
    const base64 = buildPdf(250, { text: "Hello PDF page with a genuine text layer" });
    const result = await extractMaterialText({ filename: "huge.pdf", contentType: "application/pdf", base64 });
    expect(result.warnings).toContain("PDF обрезан до 200 страниц");
    expect(result.text).toContain("Hello PDF page with a genuine text layer");
  });
});
