// Comando .bin: consulta información PÚBLICA de un BIN (primeros 6-8 dígitos):
// banco emisor, marca, tipo, nivel y país. No genera tarjetas ni consulta datos de personas.
const fs = require('fs');
const path = require('path');

const cache = new Map();          // bin -> { data, at }
const lastUse = new Map();        // usuario -> timestamp
const CACHE_MS = 30 * 24 * 60 * 60 * 1000;  // 30 días
const USER_COOLDOWN_MS = 5000;              // 1 consulta cada 5 s por usuario
let cacheFile = null;

function initBinCache(dataDir) {
  cacheFile = path.join(dataDir, 'bin-cache.json');
  try {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(cacheFile, 'utf8')))) cache.set(k, v);
  } catch {}
}
const saveCache = () => { if (cacheFile) try { fs.writeFileSync(cacheFile, JSON.stringify(Object.fromEntries(cache))); } catch {} };

const tr = { debit: 'Débito', credit: 'Crédito', charge: 'Charge', DEBIT: 'Débito', CREDIT: 'Crédito' };
const cap = s => s ? String(s).charAt(0).toUpperCase() + String(s).slice(1).toLowerCase() : '';
const flag = a2 => a2 && /^[A-Z]{2}$/i.test(a2) ? String.fromCodePoint(...[...a2.toUpperCase()].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '';

async function fromBinlist(bin) {
  const r = await fetch(`https://lookup.binlist.net/${bin}`, { headers: { 'Accept-Version': '3' }, signal: AbortSignal.timeout(8000) });
  if (r.status === 404) return null;
  if (r.status === 429) throw new Error('LIMIT');
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  return {
    scheme: j.scheme, type: j.type, level: j.brand, prepaid: j.prepaid,
    bank: j.bank?.name, bankUrl: j.bank?.url, bankPhone: j.bank?.phone, bankCity: j.bank?.city,
    country: j.country?.name, countryCode: j.country?.alpha2, currency: j.country?.currency
  };
}

// Opcional: si pones HANDYAPI_KEY en Render (plan gratis en handyapi.com), se usa como respaldo.
async function fromHandy(bin) {
  if (!process.env.HANDYAPI_KEY) throw new Error('LIMIT');
  const r = await fetch(`https://data.handyapi.com/bin/${bin}`, { headers: { 'x-api-key': process.env.HANDYAPI_KEY }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.Status && j.Status !== 'SUCCESS') return null;
  return {
    scheme: j.Scheme, type: j.Type, level: j.CardTier, prepaid: undefined,
    bank: j.Issuer, country: j.Country?.Name, countryCode: j.Country?.A2
  };
}

async function lookupBin(bin) {
  const hit = cache.get(bin);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  let data;
  try { data = await fromBinlist(bin); }
  catch (e) {
    if (e.message !== 'LIMIT' && !process.env.HANDYAPI_KEY) throw e;
    data = await fromHandy(bin);
  }
  cache.set(bin, { data, at: Date.now() }); saveCache();
  return data;
}

function formatBin(bin, d) {
  if (!d) return `🔎 BIN ${bin}\nNo se encontró información para este BIN.`;
  const lines = [`🏦 *BIN ${bin}*`];
  if (d.bank) lines.push(`Banco: ${d.bank}`);
  if (d.scheme) lines.push(`Marca: ${String(d.scheme).toUpperCase()}`);
  if (d.type) lines.push(`Tipo: ${tr[d.type] || cap(d.type)}`);
  if (d.level) lines.push(`Nivel: ${d.level}`);
  if (d.prepaid !== undefined && d.prepaid !== null) lines.push(`Prepagada: ${d.prepaid ? 'Sí' : 'No'}`);
  if (d.country) lines.push(`País: ${flag(d.countryCode)} ${d.country}${d.countryCode ? ` (${d.countryCode.toUpperCase()})` : ''}`);
  if (d.currency) lines.push(`Moneda: ${d.currency}`);
  if (d.bankCity) lines.push(`Ciudad: ${d.bankCity}`);
  if (d.bankPhone) lines.push(`Teléfono del banco: ${d.bankPhone}`);
  if (d.bankUrl) lines.push(`Web del banco: ${d.bankUrl}`);
  if (lines.length === 1) lines.push('Sin detalles disponibles.');
  return lines.join('\n');
}

// Devuelve el texto de respuesta, o null si el mensaje no es un comando .bin
async function handleBinCommand(text, userKey) {
  const m = /^\s*[.!/]bin\b\s*(.*)$/i.exec(text || '');
  if (!m) return null;
  const raw = m[1].replace(/[\s-]/g, '');
  if (!raw) return 'Uso: *.bin 457173* (los primeros 6 a 8 dígitos).';
  if (!/^\d+$/.test(raw)) return 'El BIN solo lleva números. Ejemplo: *.bin 457173*';
  if (raw.length > 8) return '⚠️ Envía solo los primeros 6 a 8 dígitos (el BIN). Nunca compartas el número completo de una tarjeta.';
  if (raw.length < 6) return 'El BIN debe tener de 6 a 8 dígitos. Ejemplo: *.bin 457173*';
  const now = Date.now();
  if (now - (lastUse.get(userKey) || 0) < USER_COOLDOWN_MS) return '⏳ Espera unos segundos antes de otra consulta.';
  lastUse.set(userKey, now);
  try {
    return formatBin(raw, await lookupBin(raw));
  } catch (e) {
    if (e.message === 'LIMIT') return '⏳ Se alcanzó el límite de consultas gratis por ahora. Intenta en un rato.';
    return '❌ No se pudo consultar el BIN en este momento. Intenta más tarde.';
  }
}

module.exports = { initBinCache, handleBinCommand, formatBin };
