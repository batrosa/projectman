import { unzipSync } from "fflate";

const MAX_TEXT_CHARS = 70000;
const MAX_SHEET_ROWS = 800;

export async function extractMaterialText(file) {
  const filename = String(file?.filename || "").trim();
  const contentType = String(file?.contentType || "").toLowerCase();
  const buffer = Buffer.from(file?.base64 || "", "base64");
  const ext = extensionOf(filename);
  const warnings = [];

  if (!buffer.length) {
    return { text: "", parser: "empty", warnings: ["Файл пустой или не скачался из хранилища."] };
  }

  try {
    if (ext === "docx" || contentType.includes("wordprocessingml")) {
      return finalize("docx", extractDocx(buffer), warnings);
    }
    if (["xlsx", "xlsm"].includes(ext) || contentType.includes("spreadsheetml")) {
      return finalize("xlsx", extractXlsx(buffer, warnings), warnings);
    }
    if (ext === "xls") {
      return finalize("xls-unsupported", "", ["Старый XLS не поддерживается. Нужен XLSX или ручная проверка."]);
    }
    if (ext === "pdf" || contentType.includes("pdf")) {
      const text = await extractPdf(buffer, warnings);
      return finalize("pdf", text, warnings);
    }
    if (["csv", "txt", "json"].includes(ext) || contentType.startsWith("text/")) {
      return finalize(ext || "text", decodeBuffer(buffer), warnings);
    }
  } catch (error) {
    return {
      text: "",
      parser: ext || contentType || "unknown",
      warnings: [`Не удалось извлечь текст: ${error instanceof Error ? error.message : String(error)}`],
    };
  }

  return finalize("binary-unsupported", "", ["Тип файла пока не поддерживается для автоматического чтения."]);
}

function finalize(parser, text, warnings) {
  const normalized = normalizeWhitespace(text);
  const truncated = normalized.length > MAX_TEXT_CHARS;
  return {
    parser,
    text: truncated ? normalized.slice(0, MAX_TEXT_CHARS) : normalized,
    textLength: normalized.length,
    truncated,
    warnings: truncated ? [...warnings, `Текст обрезан до ${MAX_TEXT_CHARS} символов для анализа.`] : warnings,
  };
}

function extensionOf(filename) {
  const clean = filename.toLowerCase().split("?")[0].split("#")[0];
  const idx = clean.lastIndexOf(".");
  return idx >= 0 ? clean.slice(idx + 1) : "";
}

function extractDocx(buffer) {
  const zip = unzipSync(new Uint8Array(buffer));
  const parts = [
    "word/document.xml",
    // All headers/footers, not just header1/footer1 — real documents split
    // them into first-page/even/default variants (header2.xml, footer3.xml…).
    ...Object.keys(zip)
      .filter(path => /^word\/(header|footer)\d*\.xml$/i.test(path))
      .sort(),
    "word/footnotes.xml",
    "word/endnotes.xml",
    "word/comments.xml",
  ];
  return parts
    .map(path => zip[path] ? xmlText(decodeBytes(zip[path])) : "")
    .filter(Boolean)
    .join("\n\n");
}

function extractXlsx(buffer, warnings = []) {
  const zip = unzipSync(new Uint8Array(buffer));
  const sharedStrings = parseSharedStrings(zip);
  const sheetNames = mapWorkbookSheetNames(zip);
  const sheetPaths = Object.keys(zip)
    .filter(path => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b));

  const blocks = sheetPaths.map((path, idx) => {
    const name = sheetNames.get(path) || `sheet${idx + 1}`;
    if (shouldSkipWorkbookSheet(name)) {
      warnings.push(`Лист «${name}» пропущен`);
      return "";
    }
    const rows = parseSheetRows(decodeBytes(zip[path]), sharedStrings);
    const limited = rows.slice(0, MAX_SHEET_ROWS);
    const rowText = limited.map(row => row.join("\t")).join("\n");
    const suffix = rows.length > limited.length ? `\n...строк обрезано: ${rows.length - limited.length}` : "";
    return `Лист: ${name}\n${rowText}${suffix}`;
  }).filter(Boolean);

  return blocks.join("\n\n");
}

function shouldSkipWorkbookSheet(name) {
  const normalized = String(name || "").trim().toLowerCase();
  return normalized === "инструкция"
    || normalized === "пример заполнения"
    || normalized === "справочник"
    || normalized === "справочник ковенантов";
}

function parseSharedStrings(zip) {
  const file = zip["xl/sharedStrings.xml"];
  if (!file) return [];
  const xml = decodeBytes(file);
  return [...xml.matchAll(/<si[\s\S]*?<\/si>/g)].map(match => xmlText(match[0]));
}

// Maps xl/worksheets/sheetN.xml paths to workbook display names via
// xl/_rels/workbook.xml.rels (sheet r:id → Relationship target). The old
// positional mapping (sheet files sorted by number, names in workbook order)
// mislabels sheets in real files, where file numbering follows creation
// order, not tab order.
function mapWorkbookSheetNames(zip) {
  const names = new Map();
  const workbookFile = zip["xl/workbook.xml"];
  if (!workbookFile) return names;
  const sheetTags = [...decodeBytes(workbookFile).matchAll(/<sheet\b[^>]*>/g)].map(match => match[0]);
  const rels = parseWorkbookRels(zip);
  sheetTags.forEach((tag, position) => {
    const name = attr(tag, "name");
    if (!name) return;
    const target = rels.get(attr(tag, "r:id") || attr(tag, "id"));
    // Fall back to the positional guess only when the rels entry is absent.
    const path = target ? workbookTargetPath(target) : `xl/worksheets/sheet${position + 1}.xml`;
    if (path) names.set(path, name);
  });
  return names;
}

function parseWorkbookRels(zip) {
  const file = zip["xl/_rels/workbook.xml.rels"];
  const rels = new Map();
  if (!file) return rels;
  for (const match of decodeBytes(file).matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(match[0], "Id");
    const target = attr(match[0], "Target");
    if (id && target) rels.set(id, target);
  }
  return rels;
}

function workbookTargetPath(target) {
  const clean = String(target || "").split("#")[0].replace(/^\/+/, "");
  if (!clean) return "";
  return clean.startsWith("xl/") ? clean : `xl/${clean}`;
}

function sheetNumber(path) {
  const match = path.match(/sheet(\d+)\.xml$/i);
  return match ? Number(match[1]) : 0;
}

function parseSheetRows(xml, sharedStrings) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const values = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1] || "";
      const body = cellMatch[2] || "";
      const type = attr(attrs, "t");
      let value = "";
      if (type === "s") {
        const idx = Number(textBetween(body, "v"));
        value = Number.isInteger(idx) ? (sharedStrings[idx] || "") : "";
      } else if (type === "inlineStr") {
        value = xmlText(body);
      } else {
        value = decodeXml(textBetween(body, "v") || xmlText(body));
      }
      const ref = attr(attrs, "r");
      const index = columnIndexFromCellRef(ref);
      if (Number.isInteger(index) && index >= 0) {
        values[index] = cleanCell(value);
      } else {
        values.push(cleanCell(value));
      }
    }
    const normalized = Array.from({ length: values.length }, (_, index) => values[index] || "");
    if (normalized.some(Boolean)) rows.push(trimTrailingEmpty(normalized));
  }
  convertExcelDateSerials(rows);
  return rows;
}

// Cells without t="s"/inlineStr come back as raw <v> numbers, so Excel dates
// surface as serials (46179). Convert serial → ISO YYYY-MM-DD only when the
// column header (first row of the sheet) looks date-ish — a bare integer
// under «Количество» must stay a number.
const DATE_HEADER_RE = /дата|срок|deadline|начало|конец|план|факт/i;

function convertExcelDateSerials(rows) {
  const header = rows[0];
  if (!header) return;
  for (let column = 0; column < header.length; column++) {
    if (!DATE_HEADER_RE.test(header[column])) continue;
    for (let r = 1; r < rows.length; r++) {
      const value = rows[r][column];
      if (!/^\d{5}$/.test(value)) continue;
      const serial = Number(value);
      if (serial >= 40000 && serial <= 60000) rows[r][column] = excelSerialToIsoDate(serial);
    }
  }
}

// Excel serial epoch: day 0 = 1899-12-30 (serial 25569 = 1970-01-01).
function excelSerialToIsoDate(serial) {
  const date = new Date(Math.round((serial - 25569) * 86400 * 1000));
  return Number.isNaN(date.getTime()) ? String(serial) : date.toISOString().slice(0, 10);
}

function columnIndexFromCellRef(ref) {
  const match = String(ref || "").match(/^([A-Z]+)/i);
  return match ? columnLettersToIndex(match[1]) : -1;
}

function columnLettersToIndex(letters) {
  let index = 0;
  for (const char of String(letters || "").toUpperCase()) {
    const code = char.charCodeAt(0);
    if (code < 65 || code > 90) return -1;
    index = index * 26 + (code - 64);
  }
  return index > 0 ? index - 1 : -1;
}

const MAX_PDF_PAGES = 200;
const MIN_PDF_CHARS_PER_PAGE = 20;

async function extractPdf(buffer, warnings = []) {
  // unpdf ships a serverless-safe pdfjs build (no native @napi-rs/canvas, no
  // DOMMatrix/worker requirements), so it extracts text reliably on Vercel —
  // where the previous pdf-parse + pdfjs-dist + native-canvas stack failed to
  // bundle and every PDF came back as "Ошибка".
  const { getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  try {
    const totalPages = Number(pdf.numPages) || 0;
    const pagesToRead = Math.min(totalPages, MAX_PDF_PAGES);
    if (totalPages > MAX_PDF_PAGES) {
      warnings.push(`PDF обрезан до ${MAX_PDF_PAGES} страниц`);
    }
    // Per-page loop (unpdf's extractText always reads every page, so it can't
    // honour the cap). Mirrors unpdf's getPageText: str + EOL per item.
    const pageTexts = [];
    for (let pageNumber = 1; pageNumber <= pagesToRead; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pageTexts.push(content.items
        .filter(item => item.str != null)
        .map(item => item.str + (item.hasEOL ? "\n" : ""))
        .join(""));
    }
    const text = pageTexts.join("\n");
    // A real text layer averages far more than a few characters per page;
    // near-zero output means a scan/photo PDF. Name the reason so the UI can
    // show it instead of a bare «Ошибка» with empty extractionWarnings.
    const averageChars = pagesToRead > 0 ? text.trim().length / pagesToRead : 0;
    if (averageChars < MIN_PDF_CHARS_PER_PAGE) {
      warnings.push("Похоже на скан без текстового слоя — нужен OCR");
    }
    return text;
  } finally {
    // Release the pdfjs document/worker (unpdf exposes pdfjs destroy()).
    try { await pdf.destroy?.(); } catch { /* best-effort cleanup */ }
  }
}

function decodeBytes(value) {
  return new TextDecoder("utf-8").decode(value);
}

function decodeBuffer(buffer) {
  const utf8 = buffer.toString("utf8");
  // A cp1251-encoded file decoded as UTF-8 lights up with U+FFFD replacement
  // chars. When that happens, re-decode as windows-1251 and keep whichever
  // decode is cleaner (fewer replacement chars).
  if (!utf8.includes("\uFFFD")) return utf8;
  try {
    const cp1251 = new TextDecoder("windows-1251").decode(buffer);
    return countReplacementChars(cp1251) < countReplacementChars(utf8) ? cp1251 : utf8;
  } catch {
    return utf8;
  }
}

function countReplacementChars(text) {
  return (String(text).match(/\uFFFD/g) || []).length;
}

function xmlText(xml) {
  return decodeXml(String(xml)
    // Track-changes deletions are removed content — drop them entirely so the
    // agent never reads text the author already struck out.
    .replace(/<w:del\b[\s\S]*?<\/w:del>/g, "")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<\/a:p>/g, "\n")
    .replace(/<\/t>/g, "")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, "")
    // A newline immediately before a cell tab came from the cell's own
    // closing </w:p> — collapse it so table cells stay on one row.
    .replace(/\n\t/g, "\t"));
}

function textBetween(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`);
  const match = String(xml).match(re);
  return match ? match[1] : "";
}

function attr(attrs, name) {
  const match = String(attrs).match(new RegExp(`\\b${name}="([^"]*)"`));
  return match ? decodeXml(match[1]) : "";
}

function decodeXml(value) {
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function cleanCell(value) {
  return normalizeWhitespace(value).replace(/\t/g, " ").slice(0, 500);
}

function trimTrailingEmpty(values) {
  const out = [...values];
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/ +\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/ {2,}/g, " ")
    .trim();
}
