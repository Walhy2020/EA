"use strict";

const CRC_TABLE = (() => {
  const table = [];
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? (0xEDB88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  };
}

function xmlEscape(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function columnName(index) {
  let value = index + 1;
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function relationshipXml(relationships) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    relationships.map((relationship) => (
      `<Relationship Id="${xmlEscape(relationship.id)}" ` +
      `Type="${xmlEscape(relationship.type)}" ` +
      `Target="${xmlEscape(relationship.target)}" ` +
      `TargetMode="${xmlEscape(relationship.targetMode || "External")}"/>`
    )).join("") +
    `</Relationships>`;
}

function cellValue(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value.text !== undefined ? value.text : "";
  }
  return value;
}

function cellHyperlink(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  return String(value.hyperlink || value.url || "").trim();
}

function worksheetXml(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const hyperlinks = [];
  const relationships = [];
  const sheetRows = safeRows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cells = (Array.isArray(row) ? row : []).map((value, colIndex) => {
      const ref = `${columnName(colIndex)}${rowNumber}`;
      const hyperlink = cellHyperlink(value);
      if (hyperlink) {
        const id = `rId${relationships.length + 1}`;
        relationships.push({
          id,
          type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
          target: hyperlink,
          targetMode: "External"
        });
        hyperlinks.push({ ref, id });
      }
      return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(cellValue(value))}</t></is></c>`;
    }).join("");
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join("");

  const hyperlinkXml = hyperlinks.length > 0
    ? `<hyperlinks>${hyperlinks.map((item) => `<hyperlink ref="${item.ref}" r:id="${item.id}"/>`).join("")}</hyperlinks>`
    : "";
  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheetData>${sheetRows}</sheetData>` +
    hyperlinkXml +
    `</worksheet>`;
  return {
    xml,
    relationships
  };
}

function localFileHeader(nameBuffer, dataBuffer, crc, offsetDateTime) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(offsetDateTime.time, 10);
  header.writeUInt16LE(offsetDateTime.date, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(dataBuffer.length, 18);
  header.writeUInt32LE(dataBuffer.length, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralDirectoryHeader(nameBuffer, dataBuffer, crc, offset, offsetDateTime) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(offsetDateTime.time, 12);
  header.writeUInt16LE(offsetDateTime.date, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(dataBuffer.length, 20);
  header.writeUInt32LE(dataBuffer.length, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return header;
}

function endOfCentralDirectory(entryCount, centralSize, centralOffset) {
  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(0, 4);
  footer.writeUInt16LE(0, 6);
  footer.writeUInt16LE(entryCount, 8);
  footer.writeUInt16LE(entryCount, 10);
  footer.writeUInt32LE(centralSize, 12);
  footer.writeUInt32LE(centralOffset, 16);
  footer.writeUInt16LE(0, 20);
  return footer;
}

function zipFiles(files) {
  const chunks = [];
  const centralChunks = [];
  const offsetDateTime = dosDateTime();
  let offset = 0;

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf8");
    const dataBuffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data || ""), "utf8");
    const crc = crc32(dataBuffer);
    const localHeader = localFileHeader(nameBuffer, dataBuffer, crc, offsetDateTime);
    chunks.push(localHeader, nameBuffer, dataBuffer);
    centralChunks.push(centralDirectoryHeader(nameBuffer, dataBuffer, crc, offset, offsetDateTime), nameBuffer);
    offset += localHeader.length + nameBuffer.length + dataBuffer.length;
  }

  const centralOffset = offset;
  const centralSize = centralChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  return Buffer.concat([
    ...chunks,
    ...centralChunks,
    endOfCentralDirectory(files.length, centralSize, centralOffset)
  ]);
}

function safeSheetName(value) {
  const text = String(value || "").replace(/[\[\]:*?/\\]/g, "").trim();
  return (text || "Sheet1").slice(0, 31);
}

function createWorkbookBuffer(rows, options = {}) {
  const sheetName = safeSheetName(options.sheetName || "版本任务");
  const worksheet = worksheetXml(rows);
  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        `</Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
        `<sheets><sheet name="${xmlEscape(sheetName)}" sheetId="1" r:id="rId1"/></sheets>` +
        `</workbook>`
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`
    },
    {
      name: "xl/styles.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>` +
        `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
        `<borders count="1"><border/></borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
        `<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>` +
        `</styleSheet>`
    },
    {
      name: "xl/worksheets/sheet1.xml",
      data: worksheet.xml
    }
  ];
  if (worksheet.relationships.length > 0) {
    files.push({
      name: "xl/worksheets/_rels/sheet1.xml.rels",
      data: relationshipXml(worksheet.relationships)
    });
  }

  return zipFiles(files);
}

module.exports = {
  createWorkbookBuffer
};
