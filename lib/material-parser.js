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
      return finalize("xlsx", extractXlsx(buffer), warnings);
    }
    if (ext === "xls") {
      return finalize("xls-unsupported", "", ["Старый XLS не поддерживается. Нужен XLSX или ручная проверка."]);
    }
    if (ext === "pdf" || contentType.includes("pdf")) {
      const text = await extractPdf(buffer);
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
    "word/header1.xml",
    "word/footer1.xml",
    "word/footnotes.xml",
    "word/endnotes.xml",
    "word/comments.xml",
  ];
  return parts
    .map(path => zip[path] ? xmlText(decodeBytes(zip[path])) : "")
    .filter(Boolean)
    .join("\n\n");
}

function extractXlsx(buffer) {
  const zip = unzipSync(new Uint8Array(buffer));
  const sharedStrings = parseSharedStrings(zip);
  const workbookNames = parseWorkbookSheetNames(zip);
  const sheetPaths = Object.keys(zip)
    .filter(path => /^xl\/worksheets\/sheet\d+\.xml$/i.test(path))
    .sort((a, b) => sheetNumber(a) - sheetNumber(b));

  const blocks = sheetPaths.map((path, idx) => {
    const name = workbookNames[idx] || `sheet${idx + 1}`;
    if (shouldSkipWorkbookSheet(name)) return "";
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

function parseWorkbookSheetNames(zip) {
  const file = zip["xl/workbook.xml"];
  if (!file) return [];
  const xml = decodeBytes(file);
  return [...xml.matchAll(/<sheet\b[^>]*\bname="([^"]+)"/g)].map(match => decodeXml(match[1]));
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
  return rows;
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

async function extractPdf(buffer) {
  // unpdf ships a serverless-safe pdfjs build (no native @napi-rs/canvas, no
  // DOMMatrix/worker requirements), so it extracts text reliably on Vercel —
  // where the previous pdf-parse + pdfjs-dist + native-canvas stack failed to
  // bundle and every PDF came back as "Ошибка".
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: true });
  if (Array.isArray(text)) return text.join("\n");
  return typeof text === "string" ? text : "";
}

function decodeBytes(value) {
  return new TextDecoder("utf-8").decode(value);
}

function decodeBuffer(buffer) {
  return buffer.toString("utf8");
}

function xmlText(xml) {
  return decodeXml(String(xml)
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/a:p>/g, "\n")
    .replace(/<\/t>/g, "")
    .replace(/<br\s*\/?>/g, "\n")
    .replace(/<[^>]+>/g, ""));
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
