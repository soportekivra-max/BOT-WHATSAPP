// Convierte texto libre, CSV o vCard (.vcf) en una lista de contactos { number, name }.
// Acepta números de cualquier país: +52 998 123 4567, 0034 612 345 678, (998) 123-4567, etc.

const PHONE_RE = /(?:\+|00)?\d[\d\s().\-]{6,}\d/g;

function normalizeNumber(raw, defaultCountryCode = '52') {
  const s = String(raw).trim();
  const international = s.startsWith('+') || s.startsWith('00');
  let d = s.replace(/\D/g, '');
  if (s.startsWith('00')) d = d.slice(2);
  if (!international && d.length === 10) d = String(defaultCountryCode).replace(/\D/g, '') + d;
  if (d.length < 8 || d.length > 15) return null;
  return d;
}

function parseVcf(text) {
  const out = [];
  for (const card of text.split(/BEGIN:VCARD/i).slice(1)) {
    const lines = card.replace(/\r?\n[ \t]/g, '').split(/\r?\n/); // une líneas plegadas
    const fn = lines.find(l => /^FN[:;]/i.test(l));
    const name = fn ? fn.slice(fn.indexOf(':') + 1).trim() : '';
    for (const l of lines) {
      if (/^(item\d+\.)?TEL[:;]/i.test(l)) out.push({ raw: l.slice(l.lastIndexOf(':') + 1), name });
    }
  }
  return out;
}

function parseText(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const phones = line.match(PHONE_RE) || [];
    // Formato "Nombre | número" o "Nombre, número": el nombre es lo que queda sin el teléfono.
    let name = '';
    if (phones.length === 1) {
      name = line.replace(phones[0], '').replace(/["']/g, '').split(/[|,;\t]/).map(x => x.trim()).filter(x => x && !/^\d+$/.test(x))[0] || '';
      if (name.length > 40) name = '';
    }
    for (const p of phones) out.push({ raw: p, name });
  }
  return out;
}

function parseContacts(text, defaultCountryCode = '52') {
  const items = /BEGIN:VCARD/i.test(text) ? parseVcf(text) : parseText(text);
  const seen = new Map();
  let invalid = 0;
  for (const it of items) {
    const number = normalizeNumber(it.raw, defaultCountryCode);
    if (!number) { invalid++; continue; }
    if (!seen.has(number)) seen.set(number, { number, name: it.name || '' });
    else if (!seen.get(number).name && it.name) seen.get(number).name = it.name;
  }
  return { contacts: [...seen.values()], invalid };
}

// "Hola {nombre}" → "Hola Ana"; sin nombre → "Hola"
function fillTemplate(message, name) {
  const first = (name || '').split(/\s+/)[0] || '';
  return message.replace(/\s*\{nombre\}/gi, first ? ' ' + first : '').replace(/^\s+/, '');
}

module.exports = { parseContacts, normalizeNumber, fillTemplate };

