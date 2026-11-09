const express = require('express');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket, useMultiFileAuthState,
  fetchLatestBaileysVersion, Browsers
} = require('@whiskeysockets/baileys');

const app = express();
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.json({ limit: '10mb' }));
const { parseContacts, fillTemplate } = require('./contacts');
const PORT = process.env.PORT || 3000;
const PANEL_PASSWORD = process.env.ADMIN_PASSWORD || process.env.PANEL_PASSWORD || require('crypto').randomBytes(6).toString('hex');
if (!process.env.ADMIN_PASSWORD && !process.env.PANEL_PASSWORD) console.log('Contrasena temporal del panel (usuario admin): ' + PANEL_PASSWORD);
app.get('/healthz', (req, res) => res.send('ok'));
app.use((req, res, next) => {
  const h = req.headers.authorization || '';
  const [u, ...rest] = Buffer.from(h.replace(/^Basic /, ''), 'base64').toString().split(':');
  if (u === 'admin' && rest.join(':') === PANEL_PASSWORD) return next();
  res.set('WWW-Authenticate', 'Basic realm="AD Bot"').status(401).send('Acceso restringido');
});
// La configuración se guarda en el disco persistente si existe (Render: /var/data),
// para que los grupos y reglas no se pierdan en cada deploy.
const DEFAULT_CFG = path.join(__dirname, 'config.json');
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/var/data') ? '/var/data' : __dirname);
const CFG = process.env.CONFIG_PATH ? path.resolve(process.env.CONFIG_PATH) : path.join(DATA_DIR, 'config.json');
if (!fs.existsSync(CFG)) fs.copyFileSync(DEFAULT_CFG, CFG);
const AUTH = process.env.AUTH_DIR ? path.resolve(process.env.AUTH_DIR) : path.join(DATA_DIR, 'auth_info');
let config = JSON.parse(fs.readFileSync(CFG, 'utf8'));
// Migración: de un solo grupo (groupJid) a varios (groupJids).
if (!Array.isArray(config.groupJids)) config.groupJids = config.groupJid ? [config.groupJid] : [];
delete config.groupJid;
config = {
  defaultCountryCode: '52',
  profileStatus: '',
  broadcastMessage: 'Hola {nombre} 👋 Este número es un bot automático. Mi número personal nuevo está en la descripción de este perfil, guárdalo por favor 🙏',
  broadcastDailyLimit: 150,
  broadcastMinDelaySec: 20,
  broadcastMaxDelaySec: 45,
  ...config
};
const isManagedGroup = jid => config.groupJids.includes(jid);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Envío a contactos (cola guardada en disco: si el bot se reinicia o cambias de número, sigue donde se quedó) ----
const BCAST = path.join(DATA_DIR, 'broadcast.json');
const emptyBroadcast = () => ({ status: 'idle', message: '', queue: [], sent: 0, notOnWhatsApp: 0, failed: 0, total: 0, day: '', sentToday: 0, lastError: '' });
let broadcast = fs.existsSync(BCAST) ? { ...emptyBroadcast(), ...JSON.parse(fs.readFileSync(BCAST, 'utf8')) } : emptyBroadcast();
const saveBroadcast = () => fs.writeFileSync(BCAST, JSON.stringify(broadcast));
let broadcastLoopRunning = false;
const today = () => new Date().toLocaleDateString('es-MX', { timeZone: process.env.TZ || 'America/Mexico_City' });

async function runBroadcast() {
  if (broadcastLoopRunning) return;
  broadcastLoopRunning = true;
  try {
    while (broadcast.status === 'running' && broadcast.queue.length) {
      if (!sock || connection !== 'Conectado') { await sleep(30_000); continue; }
      if (broadcast.day !== today()) { broadcast.day = today(); broadcast.sentToday = 0; saveBroadcast(); }
      if (broadcast.sentToday >= config.broadcastDailyLimit) { await sleep(5 * 60_000); continue; }
      const c = broadcast.queue[0];
      try {
        const [res] = await sock.onWhatsApp(c.number);
        if (!res?.exists) {
          broadcast.notOnWhatsApp++;
        } else {
          await sock.sendMessage(res.jid, { text: fillTemplate(broadcast.message, c.name) });
          broadcast.sent++; broadcast.sentToday++;
        }
        broadcast.queue.shift();
      } catch (e) {
        broadcast.lastError = e.message;
        // Si se cayó la conexión, no se descarta el contacto: se reintenta al reconectar.
        if (!sock || connection !== 'Conectado') { saveBroadcast(); continue; }
        broadcast.failed++; broadcast.queue.shift();
        log(`No se pudo enviar a +${c.number}: ${e.message}`);
      }
      if (!broadcast.queue.length) { broadcast.status = 'done'; log(`Envío a contactos terminado: ${broadcast.sent} enviados.`); }
      saveBroadcast();
      const min = config.broadcastMinDelaySec, max = Math.max(min, config.broadcastMaxDelaySec);
      if (broadcast.queue.length) await sleep((min + Math.random() * (max - min)) * 1000);
    }
  } finally {
    broadcastLoopRunning = false;
  }
}

async function applyProfileStatus() {
  if (!sock || connection !== 'Conectado' || !config.profileStatus) return;
  try { await sock.updateProfileStatus(config.profileStatus.slice(0, 139)); log('Descripción del perfil actualizada.'); }
  catch (e) { log('No se pudo actualizar la descripción del perfil: ' + e.message); }
}
let sock, qrDataUrl = '', connection = 'Desconectado';
let sessionRegistered = false;
let pairingCode = '', pairingStatus = '';
let pairingRequestInProgress = false, pairingCodeIssued = false;
let lastPairingAttemptAt = 0, lastConnectAttemptAt = 0, lastManualReconnectAt = 0;
let connectInProgress = false, reconnectTimer = null;
let socketAttempts = 0;
const RETRY_INTERVAL_MS = 60_000;
const MANUAL_RECONNECT_COOLDOWN_MS = 10 * 60 * 1000;
let lastErrorCode = null, lastErrorMessage = '', manualReconnectStatus = '';
let groupList = [], recent = new Map(), warnings = new Map(), logs = [];
const save = () => fs.writeFileSync(CFG, JSON.stringify(config, null, 2));
const log = (s) => { logs.unshift(new Date().toLocaleString('es-MX') + ' — ' + s); logs = logs.slice(0, 100); };
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const digits = s => (s || '').replace(/\D/g, '');
const maskPhoneNumber = number => `${'*'.repeat(Math.max(0, number.length - 4))}${number.slice(-4)}`;
const getErrorCode = error => error?.output?.statusCode ?? error?.statusCode ?? error?.code ?? null;
const getErrorDetails = error => error ? {
  name: error.name || 'Error',
  message: String(error.message || error).slice(0, 400),
  code: getErrorCode(error)
} : null;
const rememberError = error => {
  const details = getErrorDetails(error);
  if (details) {
    lastErrorCode = details.code;
    lastErrorMessage = details.message;
  }
  return details;
};
const requiresManualReconnect = code => [401, 408].includes(Number(code));
const isAdmin = jid => config.adminNumbers.map(digits).includes(digits(jid.split('@')[0]));

function scheduleReconnect(disconnectCode = null) {
  if (requiresManualReconnect(disconnectCode)) {
    console.warn(`[Baileys] Automatic reconnect skipped for error code ${disconnectCode}.`);
    return;
  }
  if (reconnectTimer) return;
  const delay = Math.max(0, RETRY_INTERVAL_MS - (Date.now() - lastConnectAttemptAt));
  console.warn(`[Baileys] Reconnect scheduled in ${Math.ceil(delay / 1000)}s.`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    console.warn('[Baileys] Restarting socket after connection close.');
    connect();
  }, delay);
}

async function connect({ manual = false } = {}) {
  if (connectInProgress || sock) return false;
  const delay = RETRY_INTERVAL_MS - (Date.now() - lastConnectAttemptAt);
  if (!manual && lastConnectAttemptAt && delay > 0) {
    scheduleReconnect();
    return false;
  }

  connectInProgress = true;
  lastConnectAttemptAt = Date.now();
  socketAttempts += 1;
  connection = manual ? 'Reconectando' : 'Conectando';
  console.info(`[Baileys] Starting ${manual ? 'manual ' : ''}socket attempt ${socketAttempts}.`);
  let socket;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH);
    sessionRegistered = Boolean(state.creds.registered);
    const { version, isLatest } = await fetchLatestBaileysVersion(); console.info('[Baileys] version', version.join('.'), 'isLatest', isLatest);
    socket = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), printQRInTerminal: false, browser: Browsers.ubuntu('Chrome') });
    sock = socket;
    socket.ev.on('creds.update', async () => {
      if (sock !== socket) return;
      await saveCreds();
      sessionRegistered = Boolean(state.creds.registered);
      if (sessionRegistered) {
        pairingCode = '';
        pairingCodeIssued = false;
        pairingStatus = 'Esta sesión ya está registrada.';
      }
    });
    socket.ev.on('connection.update', async u => {
      const disconnectError = u.lastDisconnect?.error;
      const disconnectDetails = rememberError(disconnectError);
      console.info('[Baileys] connection.update', JSON.stringify({
        state: u.connection ?? null,
        lastDisconnectError: disconnectDetails,
        hasQr: Boolean(u.qr)
      }));
      if (sock !== socket) return;
      if (u.connection === 'connecting') connection = 'Conectando';
      if (u.qr) { qrDataUrl = await QRCode.toDataURL(u.qr); connection = 'Escanea el QR'; }
      if (u.connection === 'open') {
        connection = 'Conectado';
        sessionRegistered = Boolean(state.creds.registered);
        qrDataUrl = '';
        pairingCode = '';
        if (sessionRegistered) pairingCodeIssued = false;
        pairingStatus = sessionRegistered ? 'Esta sesión ya está registrada.' : '';
        console.info('[Baileys] Socket connected.');
        log('WhatsApp conectado.');
        refreshGroups();
        applyProfileStatus();
        runBroadcast();
      }
      if (u.connection === 'close') {
        connection = 'Desconectado';
        qrDataUrl = '';
        pairingCode = '';
        sock = null;
        const code = getErrorCode(disconnectError);
        console.warn(`[Baileys] Socket closed. disconnectCode=${code ?? 'none'}.`);
        if (requiresManualReconnect(code)) {
          manualReconnectStatus = Number(code) === 401
            ? 'WhatsApp cerró la sesión (error 401): el número se desvinculó o fue baneado. Usa “Desvincular y conectar otro número”.'
            : `No habrá reconexión automática para el error ${code}. Usa “Reconectar ahora” cuando quieras hacer un intento manual.`;
          console.warn(`[Baileys] Automatic socket restart disabled for error code ${code}.`);
          if (Number(code) === 401) log('Sesión cerrada por WhatsApp (401). Si el número fue baneado, conecta otro desde el panel.');
        } else if (pairingCodeIssued || pairingRequestInProgress) {
          pairingStatus = 'El socket se cerró durante la vinculación; no se reiniciará automáticamente.';
          console.warn('[Baileys] Automatic socket restart skipped during or after pairing-code generation.');
        } else if (manual) {
          manualReconnectStatus = 'El intento manual terminó. No se programó otro intento automático.';
          console.warn('[Baileys] Manual socket attempt ended; no automatic retry scheduled.');
        } else {
          pairingStatus = 'Conexión cerrada. Se intentará reconectar como máximo una vez por minuto.';
          scheduleReconnect(code);
        }
      }
    });
    socket.ev.on('groups.update', () => refreshGroups());
    socket.ev.on('messages.upsert', async ({ messages, type }) => {
      if (sock !== socket || type !== 'notify') return;
      for (const m of messages) await moderate(m);
    });
  } catch (e) {
    if (socket && sock === socket) sock = null;
    connection = 'Desconectado';
    const details = rememberError(e);
    console.error('[Baileys] Socket initialization failed:', details);
    log('Error al iniciar: ' + e.message);
    if (requiresManualReconnect(details?.code)) {
      manualReconnectStatus = `No habrá reconexión automática para el error ${details.code}. Usa “Reconectar ahora” cuando quieras hacer un intento manual.`;
      console.warn(`[Baileys] Automatic socket restart disabled for error code ${details.code}.`);
    } else if (manual) {
      manualReconnectStatus = 'El intento manual terminó. No se programó otro intento automático.';
      console.warn('[Baileys] Manual socket attempt ended; no automatic retry scheduled.');
    } else {
      scheduleReconnect(details?.code);
    }
  } finally {
    connectInProgress = false;
  }
}
async function refreshGroups() {
  try { groupList = Object.values(await sock.groupFetchAllParticipating()); }
  catch (e) { log('No se pudieron cargar grupos: ' + e.message); }
}
async function moderate(m) {
  const jid = m.key.remoteJid;
  if (!jid || !jid.endsWith('@g.us') || m.key.fromMe || !config.enabled || !isManagedGroup(jid)) return;
  const sender = m.key.participant || '';
  if (!sender || isAdmin(sender)) return;
  const text = (m.message?.conversation || m.message?.extendedTextMessage?.text || '').toLowerCase();
  const hasLink = /(https?:\/\/|www\.|chat\.whatsapp\.com\/)/i.test(text);
  const blocked = config.blockedWords.some(w => w && text.includes(w.toLowerCase()));
  const now = Date.now();
  const key = jid + ':' + sender;
  const arr = (recent.get(key) || []).filter(t => now - t < config.windowSeconds * 1000);
  arr.push(now); recent.set(key, arr);
  const flood = arr.length > config.maxMessagesPerWindow;
  if (!(blocked || (config.blockLinks && hasLink) || flood)) return;
  const reason = blocked ? 'palabra prohibida' : hasLink ? 'enlace no autorizado' : 'flood/spam';
  try { await sock.sendMessage(jid, { delete: m.key }); } catch (e) { log('No pude borrar mensaje: ' + e.message); }
  const count = (warnings.get(key) || 0) + 1; warnings.set(key, count);
  try {
    if (count > config.warningsBeforeKick) {
      await sock.groupParticipantsUpdate(jid, [sender], 'remove');
      warnings.delete(key);
      log(`Expulsado ${sender} de ${jid}: ${reason}`);
      await sock.sendMessage(jid, { text: `⛔ Usuario expulsado por ${reason}.` });
    } else {
      await sock.sendMessage(jid, { text: `⚠️ @${sender.split('@')[0]}, mensaje eliminado por ${reason}. Una infracción más puede causar expulsión.`, mentions: [sender] });
      log(`Advertencia a ${sender}: ${reason}`);
    }
  } catch (e) { log('Error de moderación. Verifica que el bot sea administrador: ' + e.message); }
}
let lastSent = Date.now();
setInterval(async () => {
  if (!sock || connection !== 'Conectado' || !config.enabled || !config.groupJids.length || !config.scheduledMessage) return;
  if (Date.now() - lastSent < config.intervalMinutes * 60 * 1000) return;
  lastSent = Date.now();
  const groupName = jid => groupList.find(g => g.id === jid)?.subject || jid;
  for (const [i, jid] of [...config.groupJids].entries()) {
    if (i > 0) await sleep(3000 + Math.random() * 4000); // pausa entre grupos para no parecer spam
    if (!sock || connection !== 'Conectado') break;
    try { await sock.sendMessage(jid, { text: config.scheduledMessage }); log(`Mensaje programado enviado a ${groupName(jid)}.`); }
    catch (e) { log(`Error al enviar mensaje programado a ${groupName(jid)}: ${e.message}`); }
  }
}, 60 * 1000);

app.get('/', async (req, res) => {
  const qr = qrDataUrl ? `<img style="width:230px" src="${qrDataUrl}"><p>Escanea desde WhatsApp → Dispositivos vinculados → Vincular dispositivo.</p>` : '<p>No hay QR disponible. Actualiza cuando aparezca “Escanea el QR”.</p>';
  const canRequestPairingCode = Boolean(sock) && connection === 'Escanea el QR' && !sessionRegistered;
  const manualReconnectRemaining = Math.max(0, MANUAL_RECONNECT_COOLDOWN_MS - (Date.now() - lastManualReconnectAt));
  const canReconnectManually = !sock && !connectInProgress && manualReconnectRemaining === 0;
  const manualReconnectWait = manualReconnectRemaining > 0
    ? `<p>Próximo intento manual disponible en ${Math.ceil(manualReconnectRemaining / 60000)} min.</p>`
    : '';
  const reconnectPanel = `<section><h2>Reconexión manual</h2>
  <form method="post" action="/reconnect-now"><button type="submit" ${canReconnectManually ? '' : 'disabled'}>Reconectar ahora</button></form>
  <p>Un intento manual como máximo cada 10 minutos.</p>
  ${manualReconnectWait}${manualReconnectStatus ? `<p role="status">${esc(manualReconnectStatus)}</p>` : ''}</section>`;
  const errorPanel = lastErrorCode !== null || lastErrorMessage
    ? `<section><h2>Último error de conexión</h2><p>Código: ${esc(lastErrorCode ?? 'No disponible')}</p><p>Motivo: ${esc(lastErrorMessage || 'Sin mensaje')}</p></section>`
    : '';
  const pairingPanel = sessionRegistered ? '' : `<section><h2>Vincular por número</h2>
  <p>Escribe el número con código de país, solo dígitos y sin +. También puedes usar el QR.</p>
  <form method="post" action="/pairing-code">
    <label for="phoneNumber">Número de teléfono</label>
    <input id="phoneNumber" name="phoneNumber" type="tel" inputmode="numeric" autocomplete="tel" pattern="[0-9]{8,15}" minlength="8" maxlength="15" placeholder="521..." required>
    <button type="submit" ${canRequestPairingCode ? '' : 'disabled'}>Generar código</button>
  </form>
  ${pairingStatus ? `<p role="status">${esc(pairingStatus)}</p>` : ''}
  ${pairingCode ? `<p role="status">Código de vinculación: <strong style="font-size:1.5em;letter-spacing:.2em">${esc(pairingCode)}</strong></p>` : ''}
  </section>`;
  const knownIds = new Set(groupList.map(g => g.id));
  const groups = [
    ...groupList.map(g => ({ id: g.id, name: g.subject })),
    // Grupos guardados que ya no aparecen (p. ej. WhatsApp aún cargando) siguen visibles para no perderlos al guardar.
    ...config.groupJids.filter(id => !knownIds.has(id)).map(id => ({ id, name: id + ' (no disponible ahora)' }))
  ].map(g => `<label class="grp"><input type="checkbox" name="groupJids" value="${esc(g.id)}" ${isManagedGroup(g.id)?'checked':''}> ${esc(g.name)}</label>`).join('')
    || '<p>No hay grupos cargados.</p>';
  const b = broadcast;
  const statusText = { idle: 'Sin envío', running: 'Enviando…', paused: 'En pausa', done: 'Terminado', cancelled: 'Cancelado' }[b.status] || b.status;
  const bcastButtons = b.status === 'running'
    ? `<form method="post" action="/broadcast/pause" style="display:inline"><button>Pausar</button></form>`
    : b.status === 'paused' ? `<form method="post" action="/broadcast/resume" style="display:inline"><button>Continuar</button></form>` : '';
  const bcastCancel = ['running', 'paused'].includes(b.status)
    ? ` <form method="post" action="/broadcast/cancel" style="display:inline" onsubmit="return confirm('¿Cancelar el envío? Los contactos pendientes se descartan.')"><button style="background:#ff5c5c">Cancelar</button></form>` : '';
  const broadcastPanel = `<section><h2>Mensaje a contactos</h2>
  <p>Estado: <b>${statusText}</b> · Enviados: ${b.sent} de ${b.total} · Pendientes: ${b.queue.length} · Sin WhatsApp: ${b.notOnWhatsApp} · Fallidos: ${b.failed} · Hoy: ${b.sentToday}/${config.broadcastDailyLimit}</p>
  ${b.lastError ? `<p><small>Último error: ${esc(b.lastError)}</small></p>` : ''}
  ${bcastButtons}${bcastCancel}
  ${['running', 'paused'].includes(b.status) ? '' : `<form method="post" action="/broadcast/start" id="bform">
    <label>Archivo de contactos (.vcf o .csv) — opcional</label><input type="file" id="cfile" accept=".vcf,.csv,.txt,text/vcard,text/csv">
    <label>Contactos (uno por línea; puedes poner “Nombre | +52 998 123 4567” o solo el número)</label>
    <textarea name="contacts" id="ctext" rows="6" placeholder="+52 998 123 4567&#10;Ana | +1 305 555 0123&#10;9981234567"></textarea>
    <small id="ccount"></small>
    <label>Código de país para números sin + (10 dígitos)</label><input name="defaultCountryCode" value="${esc(config.defaultCountryCode)}" inputmode="numeric">
    <label>Mensaje ({nombre} se reemplaza por el nombre del contacto si lo tiene)</label><textarea name="broadcastMessage" rows="4">${esc(config.broadcastMessage)}</textarea>
    <label>Máximo de mensajes por día</label><input name="broadcastDailyLimit" type="number" min="1" value="${config.broadcastDailyLimit}">
    <label>Pausa entre mensajes (segundos): mínimo y máximo</label>
    <div style="display:flex;gap:10px"><input name="broadcastMinDelaySec" type="number" min="5" value="${config.broadcastMinDelaySec}"><input name="broadcastMaxDelaySec" type="number" min="5" value="${config.broadcastMaxDelaySec}"></div>
    <button onclick="return confirm('¿Empezar a enviar el mensaje a estos contactos?')">Empezar envío</button>
  </form>
  <script>
  (function(){
    var f=document.getElementById('cfile'),t=document.getElementById('ctext'),c=document.getElementById('ccount');
    function count(){var n=(t.value.match(/(?:\\+|00)?\\d[\\d\\s().\\-]{6,}\\d/g)||[]).length;c.textContent=n?('≈ '+n+' números detectados'):'';}
    t.addEventListener('input',count);
    f.addEventListener('change',function(){var file=f.files[0];if(!file)return;var r=new FileReader();r.onload=function(){
      var s=String(r.result);
      if(/BEGIN:VCARD/i.test(s)){ // vCard → "Nombre | número" por línea
        var out=[];s.split(/BEGIN:VCARD/i).slice(1).forEach(function(card){var ls=card.replace(/\\r?\\n[ \\t]/g,'').split(/\\r?\\n/);
          var fn=ls.filter(function(l){return /^FN[:;]/i.test(l)})[0];var name=fn?fn.slice(fn.indexOf(':')+1).trim().replace(/[|]/g,' '):'';
          ls.forEach(function(l){if(/^(item\\d+\\.)?TEL[:;]/i.test(l))out.push((name?name+' | ':'')+l.slice(l.lastIndexOf(':')+1).trim());});});
        s=out.join('\\n');
      }
      t.value=(t.value?t.value+'\\n':'')+s;count();};r.readAsText(file);});
  })();
  </script>`}
  </section>`;
  const profilePanel = `<section><h2>Descripción del perfil del bot</h2>
  <form method="post" action="/profile-status"><label>Texto del “Info/Descripción” del bot (máx. 139 caracteres). Pon aquí tu número personal.</label>
  <input name="profileStatus" maxlength="139" value="${esc(config.profileStatus)}" placeholder="🤖 Bot · Mi número personal: +52 998 123 4567">
  <button>Guardar y aplicar</button><p><small>Se vuelve a poner sola cada vez que el bot se conecta, también con un número nuevo.</small></p></form></section>`;
  const changeNumberPanel = `<section><h2>Cambiar número del bot</h2>
  <p>Úsalo si banean el número o quieres usar otro. Se borra la sesión actual y aparece un QR nuevo arriba. Grupos, reglas, mensajes y la cola de contactos se conservan.</p>
  <p><small>Después agrega el número nuevo a tus grupos y hazlo administrador.</small></p>
  <form method="post" action="/reset-session" onsubmit="return confirm('¿Desvincular este número y conectar otro?')"><button style="background:#ffb84d">Desvincular y conectar otro número</button></form></section>`;
  res.send(`<!doctype html><html lang="es"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AD WhatsApp Bot</title>
  <style>body{font:16px Arial;background:#09090b;color:#eee;max-width:850px;margin:25px auto;padding:0 16px}h1{color:#2bff88}section{background:#171719;padding:18px;border-radius:14px;margin:14px 0}input,textarea,select{box-sizing:border-box;width:100%;padding:12px;margin:7px 0 14px;background:#222;color:#fff;border:1px solid #555;border-radius:8px}button{background:#2bff88;border:0;padding:12px 18px;border-radius:8px;font-weight:bold}button:disabled{opacity:.5;cursor:not-allowed}small{color:#bbb}.log{white-space:pre-wrap;font-size:13px}.grps{margin:8px 0 16px}.grp{display:flex;align-items:center;gap:10px;padding:10px;border-bottom:1px solid #2a2a2e}.grp input{width:22px;height:22px;margin:0}</style>
  <h1>ABSOLUTE DATA · WhatsApp Bot</h1><p>Estado: <b>${esc(connection)}</b></p>${errorPanel}${reconnectPanel}<section><h2>Conectar número</h2>${qr}</section>${pairingPanel}
  <form method="post" action="/save"><section><h2>Grupos administrados (${config.groupJids.length})</h2><p><small>Marca los grupos donde el bot enviará avisos y moderará. Si un grupo no aparece, conecta WhatsApp y actualiza la página.</small></p><div class="grps">${groups}</div>
  <label>Intervalo de mensajes (minutos)</label><input name="intervalMinutes" type="number" min="1" value="${config.intervalMinutes}">
  <label>Mensaje automático</label><textarea name="scheduledMessage" rows="3">${esc(config.scheduledMessage)}</textarea></section>
  <section><h2>Moderación</h2><label>Palabras prohibidas (separadas por coma)</label><input name="blockedWords" value="${esc(config.blockedWords.join(', '))}">
  <label><input style="width:auto" type="checkbox" name="blockLinks" ${config.blockLinks?'checked':''}> Bloquear enlaces</label>
  <label>Máximo de mensajes por ventana</label><input name="maxMessagesPerWindow" type="number" min="2" value="${config.maxMessagesPerWindow}">
  <label>Ventana en segundos</label><input name="windowSeconds" type="number" min="1" value="${config.windowSeconds}">
  <label>Advertencias antes de expulsar</label><input name="warningsBeforeKick" type="number" min="0" value="${config.warningsBeforeKick}">
  <label>Números administradores protegidos (con código de país, separados por coma)</label><input name="adminNumbers" value="${esc(config.adminNumbers.join(', '))}">
  <label><input style="width:auto" type="checkbox" name="enabled" ${config.enabled?'checked':''}> Bot activo</label><button>Guardar configuración</button></section></form>
  ${broadcastPanel}${profilePanel}${changeNumberPanel}
  <section><h2>Actividad reciente</h2><div class="log">${esc(logs.join('\n')) || 'Sin actividad todavía.'}</div></section>
  <p><small>El bot debe permanecer conectado y ser administrador del grupo para borrar mensajes y expulsar miembros.</small></p></html>`);
});
app.post('/save', (req, res) => {
  config.groupJids = [].concat(req.body.groupJids || []).map(String).filter(id => id.endsWith('@g.us'));
  config.intervalMinutes = Math.max(1, Number(req.body.intervalMinutes) || 60);
  config.scheduledMessage = req.body.scheduledMessage || '';
  config.blockedWords = (req.body.blockedWords || '').split(',').map(x=>x.trim()).filter(Boolean);
  config.blockLinks = req.body.blockLinks === 'on';
  config.maxMessagesPerWindow = Math.max(2, Number(req.body.maxMessagesPerWindow) || 6);
  config.windowSeconds = Math.max(1, Number(req.body.windowSeconds) || 10);
  config.warningsBeforeKick = Math.max(0, Number(req.body.warningsBeforeKick) || 0);
  config.adminNumbers = (req.body.adminNumbers || '').split(',').map(x=>digits(x.trim())).filter(Boolean);
  config.enabled = req.body.enabled === 'on';
  save(); log('Configuración guardada.'); res.redirect('/');
});
app.post('/broadcast/start', (req, res) => {
  if (['running', 'paused'].includes(broadcast.status)) return res.redirect('/');
  config.defaultCountryCode = digits(req.body.defaultCountryCode) || '52';
  config.broadcastMessage = String(req.body.broadcastMessage || '').trim() || config.broadcastMessage;
  config.broadcastDailyLimit = Math.max(1, Number(req.body.broadcastDailyLimit) || 150);
  config.broadcastMinDelaySec = Math.max(5, Number(req.body.broadcastMinDelaySec) || 20);
  config.broadcastMaxDelaySec = Math.max(config.broadcastMinDelaySec, Number(req.body.broadcastMaxDelaySec) || 45);
  save();
  const { contacts, invalid } = parseContacts(String(req.body.contacts || ''), config.defaultCountryCode);
  const own = digits(sock?.user?.id?.split(':')[0]?.split('@')[0]);
  const queue = contacts.filter(c => c.number !== own);
  if (!queue.length) { broadcast.lastError = 'No se encontraron números válidos.'; saveBroadcast(); return res.redirect('/'); }
  broadcast = { ...emptyBroadcast(), status: 'running', message: config.broadcastMessage, queue, total: queue.length, day: today(),
    sentToday: broadcast.day === today() ? broadcast.sentToday : 0 };
  saveBroadcast();
  log(`Envío a contactos iniciado: ${queue.length} números${invalid ? ` (${invalid} inválidos descartados)` : ''}.`);
  runBroadcast();
  res.redirect('/');
});
app.post('/broadcast/pause', (req, res) => {
  if (broadcast.status === 'running') { broadcast.status = 'paused'; saveBroadcast(); log('Envío a contactos en pausa.'); }
  res.redirect('/');
});
app.post('/broadcast/resume', (req, res) => {
  if (broadcast.status === 'paused') { broadcast.status = 'running'; saveBroadcast(); log('Envío a contactos reanudado.'); runBroadcast(); }
  res.redirect('/');
});
app.post('/broadcast/cancel', (req, res) => {
  if (['running', 'paused'].includes(broadcast.status)) { broadcast.status = 'cancelled'; broadcast.queue = []; saveBroadcast(); log('Envío a contactos cancelado.'); }
  res.redirect('/');
});
app.post('/profile-status', async (req, res) => {
  config.profileStatus = String(req.body.profileStatus || '').trim().slice(0, 139);
  save();
  await applyProfileStatus();
  res.redirect('/');
});
app.post('/reset-session', async (req, res) => {
  console.warn('[Baileys] Session reset requested from the panel.');
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  const old = sock;
  sock = null; // los eventos del socket viejo se ignoran a partir de aquí
  if (old) {
    try { await old.logout(); } catch {}
    try { old.end(undefined); } catch {}
  }
  try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (e) { log('No se pudo borrar la sesión: ' + e.message); }
  connection = 'Desconectado'; sessionRegistered = false; qrDataUrl = '';
  pairingCode = ''; pairingCodeIssued = false; pairingRequestInProgress = false; pairingStatus = '';
  lastErrorCode = null; lastErrorMessage = ''; manualReconnectStatus = ''; groupList = [];
  lastConnectAttemptAt = 0; lastPairingAttemptAt = 0;
  log('Sesión borrada. Escanea el QR nuevo o usa “Vincular por número” con el número nuevo.');
  for (let i = 0; i < 20 && connectInProgress; i++) await sleep(500);
  await sleep(1500);
  connect().catch(e => log('Error al iniciar: ' + e.message));
  res.redirect('/');
});
app.post('/reconnect-now', (req, res) => {
  if (sock || connectInProgress) {
    manualReconnectStatus = 'Ya hay una conexión o un intento en curso.';
    return res.redirect('/');
  }

  const remaining = MANUAL_RECONNECT_COOLDOWN_MS - (Date.now() - lastManualReconnectAt);
  if (lastManualReconnectAt && remaining > 0) {
    manualReconnectStatus = `Espera ${Math.ceil(remaining / 60000)} minutos antes de otro intento manual.`;
    return res.redirect('/');
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  lastManualReconnectAt = Date.now();
  manualReconnectStatus = 'Intento manual iniciado.';
  pairingStatus = '';
  connection = 'Reconectando';
  console.info('[Baileys] Manual reconnect requested from the panel.');
  connect({ manual: true });
  res.redirect('/');
});
app.post('/pairing-code', async (req, res) => {
  if (sessionRegistered) {
    pairingCode = '';
    pairingStatus = '';
    return res.redirect('/');
  }

  const phoneNumber = String(req.body.phoneNumber || '').trim();
  if (!/^\d{8,15}$/.test(phoneNumber)) {
    pairingStatus = 'Escribe entre 8 y 15 dígitos, incluido el código de país, sin +.';
    return res.redirect('/');
  }
  if (!sock || connection !== 'Escanea el QR') {
    pairingStatus = 'Espera a que la conexión esté lista para generar el código.';
    return res.redirect('/');
  }

  const remaining = RETRY_INTERVAL_MS - (Date.now() - lastPairingAttemptAt);
  if (lastPairingAttemptAt && remaining > 0) {
    pairingStatus = `Espera ${Math.ceil(remaining / 1000)} segundos antes de solicitar otro código.`;
    return res.redirect('/');
  }

  const activeSocket = sock;
  const maskedPhoneNumber = maskPhoneNumber(phoneNumber);
  console.info(`[Baileys] Pairing request received for ${maskedPhoneNumber}.`);
  lastPairingAttemptAt = Date.now();
  pairingRequestInProgress = true;
  pairingCode = '';
  pairingStatus = '';
  try {
    const code = String(await activeSocket.requestPairingCode(phoneNumber)).toUpperCase();
    pairingCodeIssued = Boolean(code);
    console.info(`[Baileys] Pairing code generated for ${maskedPhoneNumber} (${code.length} characters; value omitted from logs).`);
    if (sock !== activeSocket || sessionRegistered) {
      pairingStatus = 'La sesión cambió mientras se generaba el código. Actualiza el panel.';
      if (sessionRegistered) pairingCodeIssued = false;
    } else if (!/^[A-Z0-9]{8}$/.test(code)) {
      pairingStatus = 'Baileys devolvió un código con formato inesperado.';
    } else {
      pairingCode = code;
      pairingStatus = 'Código generado. Escríbelo en WhatsApp para completar la vinculación.';
      console.info('[Baileys] Existing socket kept; pairing code generation did not restart it.');
    }
  } catch (e) {
    pairingStatus = 'No se pudo generar el código. Comprueba la conexión e inténtalo más tarde.';
    const details = rememberError(e);
    console.error(`[Baileys] Pairing code failed for ${maskedPhoneNumber}:`, details);
    log('Error al generar el código de vinculación: ' + e.message);
    if (!sock && !pairingCodeIssued) scheduleReconnect(details?.code);
  } finally {
    pairingRequestInProgress = false;
  }
  res.redirect('/');
});
app.get('/api/status', (req,res)=>res.json({connection, groups:groupList.map(g=>({id:g.id,name:g.subject})), config}));
app.listen(PORT, '0.0.0.0', () => console.log(`Panel disponible en puerto ${PORT}`));
connect().catch(e => { console.error(e); log('Error al iniciar: '+e.message); });
