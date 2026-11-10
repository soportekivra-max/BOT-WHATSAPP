const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Session, DAY } = require('./session');

// ---- Configuración (variables de entorno en Render) ----
// ADMIN_PASSWORD  contraseña del panel (usuario: admin)
// DATA_DIR        opcional; por defecto /var/data si existe el disco
const PORT = process.env.PORT || 3000;
const PANEL_PASSWORD = process.env.ADMIN_PASSWORD || process.env.PANEL_PASSWORD || crypto.randomBytes(6).toString('hex');
if (!process.env.ADMIN_PASSWORD && !process.env.PANEL_PASSWORD) console.log('Contrasena temporal del panel (usuario admin): ' + PANEL_PASSWORD);
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/var/data') ? '/var/data' : __dirname);
const SESS_DIR = path.join(DATA_DIR, 'sessions');
fs.mkdirSync(SESS_DIR, { recursive: true });

const app = express();
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.get('/healthz', (req, res) => res.send('ok'));
app.use((req, res, next) => {
  const h = req.headers.authorization || '';
  const [u, ...rest] = Buffer.from(h.replace(/^Basic /, ''), 'base64').toString().split(':');
  if (u === 'admin' && rest.join(':') === PANEL_PASSWORD) return next();
  res.set('WWW-Authenticate', 'Basic realm="Multi Bot"').status(401).send('Acceso restringido');
});

// ---- Importar el bot anterior (un solo número) si existe y aún no hay números ----
(function migrateLegacy() {
  const oldAuth = process.env.AUTH_DIR ? path.resolve(process.env.AUTH_DIR) : path.join(DATA_DIR, 'auth_info');
  const oldCfg = path.join(DATA_DIR, 'config.json');
  if (fs.readdirSync(SESS_DIR).length || !fs.existsSync(path.join(oldAuth, 'creds.json'))) return;
  const id = crypto.randomBytes(4).toString('hex');
  const dir = path.join(SESS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(oldAuth, path.join(dir, 'auth'), { recursive: true });
  let old = {};
  try { old = JSON.parse(fs.readFileSync(oldCfg, 'utf8')); } catch {}
  const keep = ['intervalMinutes', 'scheduledMessage', 'blockedWords', 'blockLinks', 'maxMessagesPerWindow', 'windowSeconds',
    'warningsBeforeKick', 'adminNumbers', 'enabled', 'profileStatus', 'defaultCountryCode', 'broadcastMessage',
    'broadcastDailyLimit', 'broadcastMinDelaySec', 'broadcastMaxDelaySec'];
  const cfg = { name: 'Mi número (bot anterior)', client: 'Yo', createdAt: Date.now(), expiresAt: 0, active: true,
    groupJids: Array.isArray(old.groupJids) ? old.groupJids : old.groupJid ? [old.groupJid] : [] };
  for (const k of keep) if (old[k] !== undefined) cfg[k] = old[k];
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  // Se renombra la sesión vieja para que nunca se usen las dos a la vez.
  fs.renameSync(oldAuth, oldAuth + '_importado');
  console.info('[Multi Bot] Se importó el número del bot anterior con sus grupos y reglas.');
})();

// ---- Sesiones ----
const sessions = new Map();
for (const id of fs.readdirSync(SESS_DIR)) {
  const dir = path.join(SESS_DIR, id);
  if (fs.statSync(dir).isDirectory()) sessions.set(id, new Session(dir, id));
}
// Arranca las conexiones de una en una para no saturar al iniciar.
(async () => { for (const s of sessions.values()) { s.connect(); await new Promise(r => setTimeout(r, 2500)); } })();

// Reloj global: avisos programados y vencimientos de renta.
setInterval(() => {
  for (const s of sessions.values()) {
    if (s.expired && !s.config.expiredNotified) { s.config.expiredNotified = true; s.save(); s.log('⏰ La renta venció: avisos, moderación y envíos quedan en pausa hasta que la renueves.'); }
    s.tickAvisos().catch(e => s.log('Error en avisos: ' + e.message));
  }
}, 60 * 1000);

// ---- Utilidades de panel ----
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const digits = s => String(s || '').replace(/\D/g, '');
const fmtDate = ms => ms ? new Date(ms).toLocaleDateString('es-MX', { timeZone: 'America/Cancun', day: 'numeric', month: 'short', year: 'numeric' }) : 'Sin vencimiento';
const toInputDate = ms => ms ? new Date(ms - 5 * 3600 * 1000).toISOString().slice(0, 10) : '';
// Fecha "AAAA-MM-DD" → fin de ese día en hora de Cancún (UTC-5)
const fromInputDate = v => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v || ''); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], 23, 59, 59) + 5 * 3600 * 1000 : 0; };
const get = (req, res) => { const s = sessions.get(req.params.id); if (!s) res.status(404).send('No existe ese número.'); return s; };

function rentalBadge(s) {
  if (!s.config.active) return '<span class="badge off">Pausado</span>';
  if (!s.config.expiresAt) return '<span class="badge ok">Sin vencimiento</span>';
  const d = s.daysLeft;
  if (d <= 0) return '<span class="badge bad">Vencido</span>';
  if (d <= 3) return `<span class="badge warn">Vence en ${d} día${d === 1 ? '' : 's'}</span>`;
  return `<span class="badge ok">${d} días</span>`;
}
function connBadge(s) {
  const cls = s.isConnected ? 'ok' : s.needsRelink ? 'bad' : s.connection === 'Escanea el QR' ? 'warn' : 'off';
  return `<span class="badge ${cls}">${esc(s.connection)}</span>`;
}

const CSS = `
:root{color-scheme:dark;--bg:#080808;--gold:#E3B04B;--gold-light:#F5D58A;--text:#F5F1E8;--muted:#AAA39A;--line:rgba(227,176,75,.22);}
*{box-sizing:border-box}
html{min-height:100%;background:var(--bg)}
body{font:15px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;background:radial-gradient(ellipse at 50% -18%,rgba(227,176,75,.14),transparent 48%),radial-gradient(ellipse at 100% 40%,rgba(227,176,75,.045),transparent 35%),var(--bg);color:var(--text);max-width:980px;margin:0 auto;padding:34px 20px 60px;}
a{color:var(--gold-light);text-decoration:none}
h1{color:var(--gold-light);font-size:clamp(25px,4vw,36px);font-weight:800;letter-spacing:.045em;margin:0 0 8px;padding:8px 0 10px;text-shadow:0 0 24px rgba(227,176,75,.2);}
h2{font-size:18px;line-height:1.35;color:var(--gold-light);font-weight:750;margin:0 0 15px;}
body>p{color:var(--muted);margin:6px 0 16px;}
section{background:linear-gradient(145deg,rgba(25,25,25,.98),rgba(13,13,13,.98));border:1px solid var(--line);padding:22px;border-radius:18px;margin:16px 0;box-shadow:0 12px 35px rgba(0,0,0,.28),inset 0 1px 0 rgba(255,255,255,.025);}
section>p{color:#C8C0B4}
label{display:block;color:#E8DDC8;font-size:13px;font-weight:650;margin:12px 0 5px;}
input,textarea{width:100%;padding:12px 14px;margin:7px 0 14px;background:#090909;color:var(--text);border:1px solid #39332A;border-radius:11px;font:inherit;outline:none;transition:border-color .2s,box-shadow .2s;}
input:focus,textarea:focus{border-color:var(--gold);box-shadow:0 0 0 3px rgba(227,176,75,.12);background:#0D0C0A;}
input[type=checkbox]{width:auto;accent-color:var(--gold);margin:0 8px 0 0}
input[type=file]{padding:10px;color:var(--muted)}
textarea{resize:vertical;min-height:90px}
button{background:linear-gradient(135deg,var(--gold-light),var(--gold) 65%,#C58A2B);color:#171109;border:1px solid rgba(255,230,170,.5);padding:12px 19px;border-radius:11px;font-family:inherit;font-size:13px;font-weight:750;letter-spacing:.025em;cursor:pointer;box-shadow:0 5px 18px rgba(227,176,75,.13);}
button:disabled{opacity:.42;cursor:not-allowed;box-shadow:none}
button.ghost{background:transparent;color:var(--gold-light);border-color:var(--line);box-shadow:none}
button.danger{background:#ff5c5c;border-color:#ff8a8a;color:#1a0505}
button.warnb{background:#ffb84d;border-color:#ffd08a}
form{margin:0}.inline{display:inline-block;margin:4px 6px 4px 0}
small{color:var(--muted)}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
.row>input{flex:1;min-width:120px}
.badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:700;border:1px solid}
.badge.ok{color:#7be3a0;border-color:rgba(123,227,160,.4);background:rgba(123,227,160,.08)}
.badge.warn{color:#ffd08a;border-color:rgba(255,208,138,.4);background:rgba(255,208,138,.08)}
.badge.bad{color:#ff8a8a;border-color:rgba(255,138,138,.4);background:rgba(255,138,138,.08)}
.badge.off{color:var(--muted);border-color:#3a352d}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:14px 0}
.stat{background:rgba(255,255,255,.025);border:1px solid var(--line);border-radius:14px;padding:12px 14px}
.stat b{display:block;font-size:24px;color:var(--gold-light)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}
.card{display:block;background:rgba(255,255,255,.025);border:1px solid rgba(227,176,75,.16);border-radius:14px;padding:14px;color:var(--text)}
.card h3{margin:0 0 4px;font-size:16px;color:var(--gold-light)}
.card p{margin:4px 0;color:#C8C0B4;font-size:13px}
.grps{margin:8px 0 16px;display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;}
.grp{display:flex;align-items:center;gap:10px;padding:11px 13px;background:rgba(255,255,255,.025);border:1px solid rgba(227,176,75,.13);border-radius:10px;color:#E8E0D2;margin:0;font-weight:500}
.chk{display:flex;align-items:center;font-weight:500}
.log{white-space:pre-wrap;font-size:12px;line-height:1.7;color:#D6CDBE;background:#090909;border:1px solid #30291F;border-radius:12px;padding:14px;max-height:280px;overflow:auto;}
p[role=status]{padding:10px 12px;background:rgba(227,176,75,.07);border:1px solid var(--line);border-radius:10px;}
@media(max-width:600px){body{padding:22px 13px 40px;font-size:14px;}h1{font-size:25px}section{padding:17px;border-radius:15px;margin:12px 0;}h2{font-size:17px}.grps,.cards{grid-template-columns:1fr}}`;

const page = (title, body, refresh = 0) => `<!doctype html><html lang="es"><meta name="viewport" content="width=device-width,initial-scale=1">${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}<title>${esc(title)}</title><style>${CSS}</style>${body}</html>`;

// ---- Panel principal ----
app.get('/', (req, res) => {
  const list = [...sessions.values()].sort((a, b) => (a.config.expiresAt || Infinity) - (b.config.expiresAt || Infinity));
  const connected = list.filter(s => s.isConnected).length;
  const soon = list.filter(s => s.config.active && s.daysLeft !== null && s.daysLeft > 0 && s.daysLeft <= 3).length;
  const expired = list.filter(s => s.expired).length;
  const cards = list.map(s => `<a class="card" href="/s/${s.id}">
      <h3>${esc(s.label)}</h3>
      <p>${s.config.client ? 'Cliente: ' + esc(s.config.client) : '<small>Sin cliente</small>'}${s.config.phone ? ' · +' + esc(s.config.phone) : ''}</p>
      <p>${connBadge(s)} ${rentalBadge(s)}</p>
      <p><small>Vence: ${fmtDate(s.config.expiresAt)} · ${s.config.groupJids.length} grupo(s)</small></p>
    </a>`).join('') || '<p>Todavía no tienes números. Agrega el primero abajo.</p>';
  res.send(page('Multi Bot', `
  <h1>ABSOLUTE DATA · Multi Bot</h1><p>Todos tus números de WhatsApp en un solo panel.</p>
  <div class="stats"><div class="stat"><b>${list.length}</b>Números</div><div class="stat"><b>${connected}</b>Conectados</div><div class="stat"><b>${soon}</b>Por vencer (≤3 días)</div><div class="stat"><b>${expired}</b>Vencidos</div></div>
  <section><h2>Mis números</h2><div class="cards">${cards}</div></section>
  <section><h2>Agregar número</h2>
    <form method="post" action="/sessions">
      <label>Nombre (para identificarlo)</label><input name="name" placeholder="Ej. eSIM 01" required>
      <label>Cliente que lo renta</label><input name="client" placeholder="Ej. Juan Pérez">
      <label>Días de renta (0 = sin vencimiento)</label><input name="days" type="number" min="0" value="30">
      <label>Notas</label><input name="notes" placeholder="Precio, teléfono del cliente, etc.">
      <button>Crear y mostrar QR</button>
    </form>
    <p><small>Después de crearlo, escanea el QR con el teléfono de ese número (WhatsApp → Dispositivos vinculados).</small></p>
  </section>`));
});

app.post('/sessions', (req, res) => {
  const id = crypto.randomBytes(4).toString('hex');
  const dir = path.join(SESS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  const s = new Session(dir, id);
  const days = Math.max(0, Number(req.body.days) || 0);
  Object.assign(s.config, {
    name: String(req.body.name || '').trim().slice(0, 40) || 'Número ' + (sessions.size + 1),
    client: String(req.body.client || '').trim().slice(0, 60),
    notes: String(req.body.notes || '').trim().slice(0, 300),
    createdAt: Date.now(), expiresAt: days ? Date.now() + days * DAY : 0, active: true
  });
  s.save();
  sessions.set(id, s);
  s.log('Número creado.');
  s.connect();
  res.redirect('/s/' + id);
});

// ---- Página de cada número ----
app.get('/s/:id', (req, res) => {
  const s = get(req, res); if (!s) return;
  const c = s.config, b = s.broadcast;
  const waiting = ['Escanea el QR', 'Conectando'].includes(s.connection) && !s.pairingCode;
  const conn = s.isConnected
    ? `<p>✅ Conectado${c.phone ? ' como <b>+' + esc(c.phone) + '</b>' : ''}.</p>`
    : s.qr
      ? `<img style="width:230px;max-width:100%;background:#fff;padding:8px;border-radius:12px" src="${s.qr}"><p><small>WhatsApp → Dispositivos vinculados → Vincular dispositivo. La página se actualiza sola.</small></p>
         <form method="post" action="/s/${s.id}/pairing"><label>O vincula con código (número con código de país, sin +)</label><div class="row"><input name="phone" inputmode="numeric" placeholder="5299..." required><button>Generar código</button></div></form>
         ${s.pairingCode ? `<p role="status">Código de vinculación: <strong style="font-size:1.5em;letter-spacing:.2em">${esc(s.pairingCode)}</strong><br><small>WhatsApp → Dispositivos vinculados → Vincular con número de teléfono.</small></p>` : ''}`
      : `<p>Estado: <b>${esc(s.connection)}</b>${s.lastError ? ` · <small>${esc(s.lastError)}</small>` : ''}</p>
         ${s.needsRelink ? '' : `<form method="post" action="/s/${s.id}/connect" class="inline"><button>Generar QR / Reconectar</button></form>`}`;
  const known = new Set(s.groupList.map(g => g.id));
  const groups = [...s.groupList.map(g => ({ id: g.id, name: g.subject })), ...c.groupJids.filter(id => !known.has(id)).map(id => ({ id, name: id + ' (no disponible ahora)' }))]
    .map(g => `<label class="grp"><input type="checkbox" name="groupJids" value="${esc(g.id)}" ${s.isManagedGroup(g.id) ? 'checked' : ''}> ${esc(g.name)}</label>`).join('') || '<p><small>No hay grupos cargados. Conecta el número y agrégalo a tus grupos.</small></p>';
  const bStatus = { idle: 'Sin envío', running: 'Enviando…', paused: 'En pausa', done: 'Terminado', cancelled: 'Cancelado' }[b.status] || b.status;
  const bActive = ['running', 'paused'].includes(b.status);
  res.send(page(s.label, `
  <p><a href="/">← Todos los números</a></p>
  <h1>${esc(s.label)}</h1>
  <p>${connBadge(s)} ${rentalBadge(s)} ${c.client ? '· ' + esc(c.client) : ''}</p>
  ${!s.rentalOk ? `<p role="status">⏸️ Este número está ${c.active ? 'vencido' : 'pausado'}: no envía avisos, no modera y no manda mensajes a contactos. Sigue conectado para que al renovar funcione al instante.</p>` : ''}

  <section><h2>Renta</h2>
    <p>Vence: <b>${fmtDate(c.expiresAt)}</b>${s.daysLeft !== null ? ` (${s.daysLeft > 0 ? 'faltan ' + s.daysLeft + ' días' : 'vencido'})` : ''}</p>
    <form method="post" action="/s/${s.id}/extend" class="inline"><input type="hidden" name="days" value="30"><button>+30 días</button></form>
    <form method="post" action="/s/${s.id}/extend" class="inline"><input type="hidden" name="days" value="7"><button class="ghost">+7 días</button></form>
    <form method="post" action="/s/${s.id}/toggle" class="inline"><button class="ghost">${c.active ? 'Pausar número' : 'Reactivar número'}</button></form>
    <form method="post" action="/s/${s.id}/rental">
      <label>Nombre</label><input name="name" value="${esc(c.name)}">
      <label>Cliente</label><input name="client" value="${esc(c.client)}">
      <label>Fecha de vencimiento (vacío = sin vencimiento)</label><input name="expiresAt" type="date" value="${toInputDate(c.expiresAt)}">
      <label>Notas</label><textarea name="notes" rows="2">${esc(c.notes)}</textarea>
      <button>Guardar renta</button>
    </form>
  </section>

  <section><h2>Conexión</h2>${conn}
    <form method="post" action="/s/${s.id}/reset" onsubmit="return confirm('¿Desvincular este número y conectar otro? Se conservan grupos, reglas y la renta.')" style="margin-top:12px"><button class="warnb">Desvincular y conectar otro número</button></form>
    <p><small>Úsalo si banean el número o cambias de eSIM. Luego agrega el número nuevo a los grupos y hazlo administrador.</small></p>
  </section>

  <form method="post" action="/s/${s.id}/save">
  <section><h2>Grupos y avisos (${c.groupJids.length})</h2>
    <p><small>Marca los grupos donde este número enviará avisos y moderará.</small></p><div class="grps">${groups}</div>
    <label>Intervalo de avisos (minutos)</label><input name="intervalMinutes" type="number" min="1" value="${c.intervalMinutes}">
    <label>Mensaje automático</label><textarea name="scheduledMessage" rows="3">${esc(c.scheduledMessage)}</textarea>
  </section>
  <section><h2>Moderación</h2>
    <label>Palabras prohibidas (separadas por coma)</label><input name="blockedWords" value="${esc(c.blockedWords.join(', '))}">
    <label class="chk"><input type="checkbox" name="blockLinks" ${c.blockLinks ? 'checked' : ''}> Bloquear enlaces</label>
    <label>Máximo de mensajes por ventana</label><input name="maxMessagesPerWindow" type="number" min="2" value="${c.maxMessagesPerWindow}">
    <label>Ventana en segundos</label><input name="windowSeconds" type="number" min="1" value="${c.windowSeconds}">
    <label>Advertencias antes de expulsar</label><input name="warningsBeforeKick" type="number" min="0" value="${c.warningsBeforeKick}">
    <label>Números protegidos (con código de país, separados por coma)</label><input name="adminNumbers" value="${esc(c.adminNumbers.join(', '))}">
    <label class="chk"><input type="checkbox" name="enabled" ${c.enabled ? 'checked' : ''}> Avisos y moderación activos</label>
    <button>Guardar configuración</button>
  </section>
  </form>

  <section><h2>Mensaje a contactos</h2>
    <p>Estado: <b>${bStatus}</b> · Enviados: ${b.sent} de ${b.total} · Pendientes: ${b.queue.length} · Sin WhatsApp: ${b.notOnWhatsApp} · Fallidos: ${b.failed} · Hoy: ${b.sentToday}/${c.broadcastDailyLimit}</p>
    ${b.lastError ? `<p><small>Último error: ${esc(b.lastError)}</small></p>` : ''}
    ${b.status === 'running' ? `<form method="post" action="/s/${s.id}/broadcast/paused" class="inline"><button>Pausar</button></form>` : ''}
    ${b.status === 'paused' ? `<form method="post" action="/s/${s.id}/broadcast/running" class="inline"><button>Continuar</button></form>` : ''}
    ${bActive ? `<form method="post" action="/s/${s.id}/broadcast/cancelled" class="inline" onsubmit="return confirm('¿Cancelar el envío?')"><button class="danger">Cancelar</button></form>` : `
    <form method="post" action="/s/${s.id}/broadcast/start">
      <label>Archivo de contactos (.vcf o .csv) — opcional</label><input type="file" id="cfile" accept=".vcf,.csv,.txt,text/vcard,text/csv">
      <label>Contactos (uno por línea; “Nombre | +52 998 123 4567” o solo el número)</label>
      <textarea name="contacts" id="ctext" rows="5" placeholder="+52 998 123 4567&#10;Ana | +1 305 555 0123"></textarea><small id="ccount"></small>
      <label>Código de país para números de 10 dígitos sin +</label><input name="defaultCountryCode" value="${esc(c.defaultCountryCode)}" inputmode="numeric">
      <label>Mensaje ({nombre} = nombre del contacto)</label><textarea name="broadcastMessage" rows="4">${esc(c.broadcastMessage)}</textarea>
      <label>Máximo por día</label><input name="broadcastDailyLimit" type="number" min="1" value="${c.broadcastDailyLimit}">
      <label>Pausa entre mensajes (segundos): mínimo y máximo</label>
      <div class="row"><input name="broadcastMinDelaySec" type="number" min="5" value="${c.broadcastMinDelaySec}"><input name="broadcastMaxDelaySec" type="number" min="5" value="${c.broadcastMaxDelaySec}"></div>
      <button onclick="return confirm('¿Empezar el envío?')">Empezar envío</button>
    </form>
    <script>
    (function(){
      var f=document.getElementById('cfile'),t=document.getElementById('ctext'),c=document.getElementById('ccount');
      function count(){var n=(t.value.match(/(?:\\+|00)?\\d[\\d\\s().\\-]{6,}\\d/g)||[]).length;c.textContent=n?('≈ '+n+' números detectados'):'';}
      t.addEventListener('input',count);
      f.addEventListener('change',function(){var file=f.files[0];if(!file)return;var r=new FileReader();r.onload=function(){
        var s=String(r.result);
        if(/BEGIN:VCARD/i.test(s)){var out=[];s.split(/BEGIN:VCARD/i).slice(1).forEach(function(card){var ls=card.replace(/\\r?\\n[ \\t]/g,'').split(/\\r?\\n/);
          var fn=ls.filter(function(l){return /^FN[:;]/i.test(l)})[0];var name=fn?fn.slice(fn.indexOf(':')+1).trim().replace(/[|]/g,' '):'';
          ls.forEach(function(l){if(/^(item\\d+\\.)?TEL[:;]/i.test(l))out.push((name?name+' | ':'')+l.slice(l.lastIndexOf(':')+1).trim());});});
          s=out.join('\\n');}
        t.value=(t.value?t.value+'\\n':'')+s;count();};r.readAsText(file);});
    })();
    </script>`}
  </section>

  <section><h2>Descripción del perfil</h2>
    <form method="post" action="/s/${s.id}/profile"><label>“Info” del número (máx. 139 caracteres)</label>
    <input name="profileStatus" maxlength="139" value="${esc(c.profileStatus)}"><button>Guardar y aplicar</button></form>
  </section>

  <section><h2>Actividad reciente</h2><div class="log">${esc(s.logs.join('\n')) || 'Sin actividad todavía.'}</div></section>

  <section><h2>Eliminar número</h2>
    <p><small>Desvincula el número y borra su configuración del bot. No se puede deshacer.</small></p>
    <form method="post" action="/s/${s.id}/delete" onsubmit="return confirm('¿Eliminar ${esc(s.label).replace(/'/g, '')} del bot? No se puede deshacer.')"><button class="danger">Eliminar número</button></form>
  </section>`, waiting ? 20 : 0));
});

app.post('/s/:id/connect', (req, res) => { const s = get(req, res); if (!s) return; s.stopped = false; s.retries = 0; s.connect(); setTimeout(() => res.redirect('/s/' + s.id), 2500); });
app.post('/s/:id/pairing', async (req, res) => {
  const s = get(req, res); if (!s) return;
  const phone = digits(req.body.phone);
  if (!/^\d{8,15}$/.test(phone)) { s.log('Número inválido para el código: usa de 8 a 15 dígitos con código de país.'); return res.redirect('/s/' + s.id); }
  try { await s.requestPairingCode(phone); s.log('Código de vinculación generado.'); }
  catch (e) { s.log('No se pudo generar el código: ' + e.message); }
  res.redirect('/s/' + s.id);
});
app.post('/s/:id/reset', async (req, res) => { const s = get(req, res); if (!s) return; await s.resetSession(); setTimeout(() => res.redirect('/s/' + s.id), 2000); });

app.post('/s/:id/save', (req, res) => {
  const s = get(req, res); if (!s) return;
  const c = s.config, b = req.body;
  c.groupJids = [].concat(b.groupJids || []).map(String).filter(id => id.endsWith('@g.us'));
  c.intervalMinutes = Math.max(1, Number(b.intervalMinutes) || 60);
  c.scheduledMessage = String(b.scheduledMessage || '');
  c.blockedWords = String(b.blockedWords || '').split(',').map(x => x.trim()).filter(Boolean);
  c.blockLinks = b.blockLinks === 'on';
  c.maxMessagesPerWindow = Math.max(2, Number(b.maxMessagesPerWindow) || 6);
  c.windowSeconds = Math.max(1, Number(b.windowSeconds) || 10);
  c.warningsBeforeKick = Math.max(0, Number(b.warningsBeforeKick) || 0);
  c.adminNumbers = String(b.adminNumbers || '').split(',').map(x => digits(x)).filter(Boolean);
  c.enabled = b.enabled === 'on';
  s.save(); s.log('Configuración guardada.');
  res.redirect('/s/' + s.id);
});

app.post('/s/:id/rental', (req, res) => {
  const s = get(req, res); if (!s) return;
  const c = s.config;
  c.name = String(req.body.name || '').trim().slice(0, 40) || c.name;
  c.client = String(req.body.client || '').trim().slice(0, 60);
  c.notes = String(req.body.notes || '').trim().slice(0, 300);
  c.expiresAt = fromInputDate(req.body.expiresAt);
  if (!s.expired) c.expiredNotified = false;
  s.save(); s.log(`Renta actualizada. Vence: ${fmtDate(c.expiresAt)}.`);
  res.redirect('/s/' + s.id);
});
app.post('/s/:id/extend', (req, res) => {
  const s = get(req, res); if (!s) return;
  s.extend(Math.max(1, Math.min(366, Number(req.body.days) || 30)));
  s.config.expiredNotified = false; s.save();
  res.redirect('/s/' + s.id);
});
app.post('/s/:id/toggle', (req, res) => {
  const s = get(req, res); if (!s) return;
  s.config.active = !s.config.active; s.save();
  s.log(s.config.active ? 'Número reactivado.' : 'Número pausado manualmente.');
  if (s.config.active) s.runBroadcast();
  res.redirect('/s/' + s.id);
});

app.post('/s/:id/broadcast/start', (req, res) => {
  const s = get(req, res); if (!s) return;
  const c = s.config, b = req.body;
  c.defaultCountryCode = digits(b.defaultCountryCode) || '52';
  c.broadcastMessage = String(b.broadcastMessage || '').trim() || c.broadcastMessage;
  c.broadcastDailyLimit = Math.max(1, Number(b.broadcastDailyLimit) || 100);
  c.broadcastMinDelaySec = Math.max(5, Number(b.broadcastMinDelaySec) || 20);
  c.broadcastMaxDelaySec = Math.max(c.broadcastMinDelaySec, Number(b.broadcastMaxDelaySec) || 45);
  s.save();
  s.startBroadcast(b.contacts);
  res.redirect('/s/' + s.id);
});
app.post('/s/:id/broadcast/:status', (req, res) => {
  const s = get(req, res); if (!s) return;
  if (['paused', 'running', 'cancelled'].includes(req.params.status)) s.setBroadcastStatus(req.params.status);
  res.redirect('/s/' + s.id);
});
app.post('/s/:id/profile', async (req, res) => {
  const s = get(req, res); if (!s) return;
  s.config.profileStatus = String(req.body.profileStatus || '').trim().slice(0, 139); s.save();
  await s.applyProfileStatus();
  res.redirect('/s/' + s.id);
});
app.post('/s/:id/delete', async (req, res) => {
  const s = get(req, res); if (!s) return;
  s.stopped = true;
  const sock = s.sock; s.sock = null;
  if (sock) { try { await sock.logout(); } catch {} try { sock.end(undefined); } catch {} }
  await s.stop();
  sessions.delete(s.id);
  fs.rmSync(s.dir, { recursive: true, force: true });
  console.info(`[${s.label}] Número eliminado del bot.`);
  res.redirect('/');
});

app.listen(PORT, '0.0.0.0', () => console.log(`Panel disponible en puerto ${PORT} · ${sessions.size} número(s)`));
