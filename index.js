#!/usr/bin/env node
// Bot Validador DIGI v12 — Anti-Ban / Continuo / 1800/h
"use strict";

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const TelegramBot = require("node-telegram-bot-api");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

// ── CONFIG ──
const TOKEN = "8710402523:AAHzR-ZQ8XR_qSJSOzJ6VPFIZYD1HnLoJtA";
const AUTH = "./auth_session";
const LISTS_DIR = "./listas";  // carpeta donde se guardan las listas

// ── ANTI-BAN: parámetros clave ──
const BATCH        = 8;
const DELAY_MIN    = 2500;
const DELAY_MAX    = 6000;
const NOTIFY       = 50;
const MAX_ERR      = 10;
const QR_MS        = 60000;
const MAX_RECONN   = 5;

const REST_EVERY   = 100;
const REST_MS_MIN  = 90000;
const REST_MS_MAX  = 210000;

// Límite horario: 1800 checks/hora
const MAX_PER_HOUR = 1800;

const ERR_PAUSE_MS = 45000;

// ── PREFIJOS DIGI ──
const PREFIJOS = ["34614", "34624", "34641", "34642", "34643"];

// ── ESTADO ──
const log = pino({ level: "silent" });
let sock = null, connected = false, connecting = false;
let qrTimer = null, qrMsgId = null, qrStart = null, connMsgId = null;
let qrN = 0, reconnN = 0, reconnTimer = null, connChat = null;

const val = {
    on: false, stop: false,
    scanned: 0, valid: 0, skip: 0, err: 0, errRow: 0,
    start: null, chat: null, lastN: 0, lastErr: "", mode: "leads",
    batchCount: 0,
    hourStart: null,
    hourCount: 0,
    currentFile: null   // archivo TXT de la sesión actual
};
const checked = new Set();
const names   = new Map();
const waitName = new Map();  // espera nombre de lista tras detener
const usedNames = new Set(); // nombres de lista ya usados

// Crear carpeta de listas si no existe
if (!fs.existsSync(LISTS_DIR)) fs.mkdirSync(LISTS_DIR, { recursive: true });

// Cargar nombres de lista ya usados
try {
    const files = fs.readdirSync(LISTS_DIR);
    for (const f of files) {
        if (f.endsWith(".txt")) usedNames.add(f.replace(/\.txt$/, "").toLowerCase());
    }
} catch (_) {}

// ── TELEGRAM ──
const bot = new TelegramBot(TOKEN, { polling: true });
bot.on("polling_error", e => { if (e.code !== "ETELEGRAM" || !e.message?.includes("409")) console.error("[TG]", e.code || e.message); });
bot.on("error", e => console.error("[TG]", e.message));

const send    = (id, txt, ex = {}) => id ? bot.sendMessage(id, txt, { parse_mode: "Markdown", ...ex }).catch(() => null) : Promise.resolve(null);
const sleep   = ms => new Promise(r => setTimeout(r, ms));
const timeout = (p, ms, fb = null) => { let t; return Promise.race([p, new Promise(r => { t = setTimeout(() => r(fb), ms); })]).finally(() => clearTimeout(t)); };
const fmtTime = ms => { if (!ms || ms < 0) return "—"; const s = Math.floor(ms/1000), h = Math.floor(s/3600), m = Math.floor(s%3600/60); return h ? `${h}h ${m}m` : m ? `${m}m ${s%60}s` : `${s%60}s`; };

const randDelay = () => DELAY_MIN + Math.floor(Math.random() * (DELAY_MAX - DELAY_MIN));
const randRest  = () => REST_MS_MIN + Math.floor(Math.random() * (REST_MS_MAX - REST_MS_MIN));

// ── TECLADOS ──
const kb = {
    main: () => ({ reply_markup: { inline_keyboard: [
        [{ text: "📱 Conectar WhatsApp", callback_data: "new_session" }],
        [{ text: "🚀 Validar DIGI", callback_data: "validate" }],
        [{ text: "📊 Estado", callback_data: "status" }],
        [{ text: "📂 Mis listas", callback_data: "my_lists" }],
        [{ text: "🔌 Desconectar", callback_data: "disconnect" }],
    ]}}),
    cancel: () => ({ inline_keyboard: [[{ text: "❌ Cancelar", callback_data: "cancel_qr" }]] }),
    mode: () => ({ reply_markup: { inline_keyboard: [
        [{ text: "👥 Leads", callback_data: "go_leads" }],
        [{ text: "⭐ Dedicados (con nombre)", callback_data: "go_dedicados" }],
        [{ text: "🔙 Menú", callback_data: "main" }],
    ]}}),
    running: () => ({ reply_markup: { inline_keyboard: [[{ text: "📊 Estado", callback_data: "status" }, { text: "⛔ DETENER", callback_data: "stop" }]] }}),
    done: () => ({ reply_markup: { inline_keyboard: [
        [{ text: "🚀 Nueva validación", callback_data: "validate" }],
        [{ text: "📂 Mis listas", callback_data: "my_lists" }],
        [{ text: "🏠 Menú", callback_data: "main" }],
    ]}}),
};

// ── GENERAR NÚMERO DIGI ──
function genNum() {
    const pfx = PREFIJOS[Math.floor(Math.random() * PREFIJOS.length)];
    const suf = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
    return pfx + suf;
}

// ── GUARDAR NÚMERO EN ARCHIVO TEMPORAL DE SESIÓN ──
function saveNum(num, name, mode) {
    if (!val.currentFile) return;
    try {
        if (mode === "dedicados" && name && name !== "Sin nombre") {
            fs.appendFileSync(val.currentFile, `+${num} | ${name}\n`, "utf-8");
        } else {
            fs.appendFileSync(val.currentFile, `+${num}\n`, "utf-8");
        }
    } catch (_) {}
}

// ── CARGAR NÚMEROS YA CHEQUEADOS (de todas las listas) ──
function loadChecked() {
    checked.clear();
    try {
        const files = fs.readdirSync(LISTS_DIR);
        for (const f of files) {
            if (!f.endsWith(".txt")) continue;
            try {
                const lines = fs.readFileSync(path.join(LISTS_DIR, f), "utf-8").split("\n");
                for (const l of lines) {
                    const match = l.trim().match(/^\+?(\d{10,})/);
                    if (match) checked.add(match[1]);
                }
            } catch (_) {}
        }
    } catch (_) {}
    // También cargar del archivo temporal actual
    if (val.currentFile && fs.existsSync(val.currentFile)) {
        try {
            const lines = fs.readFileSync(val.currentFile, "utf-8").split("\n");
            for (const l of lines) {
                const match = l.trim().match(/^\+?(\d{10,})/);
                if (match) checked.add(match[1]);
            }
        } catch (_) {}
    }
    console.log(`[LOAD] ${checked.size} números previos cargados`);
}

// ── WHATSAPP ──
function destroy() {
    clearTimeout(qrTimer); qrTimer = null;
    clearTimeout(reconnTimer); reconnTimer = null;
    qrMsgId = null; qrStart = null; connMsgId = null; qrN = 0;
    if (sock) { try { sock.ev.removeAllListeners(); sock.end(); } catch (_) { try { sock.ws?.close(); } catch (_) {} } sock = null; }
    connected = false; connecting = false;
}

function editCaption(chat, msg, txt, rm) {
    if (!chat || !msg) return Promise.resolve();
    return bot.editMessageCaption(txt, { chat_id: chat, message_id: msg, parse_mode: "Markdown", reply_markup: rm }).catch(() => send(chat, txt, rm ? { reply_markup: rm } : kb.main()));
}

async function connectWA(chat) {
    if (connecting) { if (chat) send(chat, "⏳ *Ya conectando...*"); return; }
    if (connected && sock) return;
    destroy(); connecting = true; connChat = chat;

    let state, save;
    try { ({ state, saveCreds: save } = await useMultiFileAuthState(AUTH)); } catch (e) {
        connecting = false;
        if (connMsgId) { bot.deleteMessage(chat, connMsgId).catch(() => {}); connMsgId = null; }
        if (chat) send(chat, "❌ Error sesión.", kb.main()); return;
    }

    let ver;
    try { const r = await timeout(fetchLatestBaileysVersion(), 10000, null); ver = r?.version; } catch (_) { ver = undefined; }

    try {
        const opts = {
            auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, log) },
            logger: log, printQRInTerminal: false,
            browser: ["DIGI Bot", "Chrome", "22.0"],
            connectTimeoutMs: 45000, defaultQueryTimeoutMs: 25000,
            keepAliveIntervalMs: 15000, emitOwnEvents: false,
            generateHighQualityLinkPreview: false
        };
        if (ver) opts.version = ver;
        sock = makeWASocket(opts);
    } catch (e) {
        connecting = false;
        if (connMsgId) { bot.deleteMessage(chat, connMsgId).catch(() => {}); connMsgId = null; }
        if (chat) send(chat, "❌ Error conexión.", kb.main()); return;
    }

    sock.ev.on("contacts.upsert", cc => { for (const c of cc) { const n = c.notify || c.verifiedName || c.name; if (n) names.set(c.id, n); } });
    sock.ev.on("contacts.update", cc => { for (const c of cc) { const n = c.notify || c.verifiedName || c.name; if (n) names.set(c.id, n); } });
    sock.ev.on("creds.update", save);

    sock.ev.on("connection.update", up => {
        const { connection, lastDisconnect, qr } = up;

        if (qr) {
            qrN++; qrStart = Date.now(); clearTimeout(qrTimer);
            qrTimer = setTimeout(() => {
                if (!connected && qrStart) {
                    const c = chat, m = qrMsgId; destroy();
                    if (c && m) editCaption(c, m, "⏰ *Tiempo agotado*\n\nPulsa 📱 *Conectar* de nuevo.", kb.main().reply_markup);
                    else if (c) send(c, "⏰ *QR expirado.* Pulsa 📱 Conectar.", kb.main());
                }
            }, QR_MS);

            QRCode.toBuffer(qr, { scale: 8 }).then(async buf => {
                if (!chat) return;
                if (qrMsgId) { bot.deleteMessage(chat, qrMsgId).catch(() => {}); qrMsgId = null; }
                if (connMsgId) { bot.deleteMessage(chat, connMsgId).catch(() => {}); connMsgId = null; }
                const cap = qrN > 1
                    ? `📱 *Nuevo QR (${qrN})* — Escanéalo\n\n1️⃣ WhatsApp → ⋮ → Dispositivos vinculados\n2️⃣ Vincular dispositivo\n3️⃣ Escanea el código`
                    : `📱 *Escanea este QR*\n\n1️⃣ WhatsApp → ⋮ → Dispositivos vinculados\n2️⃣ Vincular dispositivo\n3️⃣ Escanea el código`;
                const m = await bot.sendPhoto(chat, buf, { caption: cap, parse_mode: "Markdown", reply_markup: kb.cancel() }).catch(() => null);
                if (m) qrMsgId = m.message_id;
            }).catch(() => {});
        }

        if (connection === "open") {
            connected = true; connecting = false; reconnN = 0;
            clearTimeout(qrTimer); qrTimer = null;
            const ph = sock?.user?.id?.split(":")[0] || sock?.user?.id?.split("@")[0] || "?";
            const txt = `✅ *WhatsApp conectado*\n📱 +${ph}\n\n_Listo para DIGI 🟢_`;
            if (chat && qrMsgId) { editCaption(chat, qrMsgId, txt, kb.main().reply_markup); qrMsgId = null; }
            else if (chat) { if (connMsgId) { bot.deleteMessage(chat, connMsgId).catch(() => {}); connMsgId = null; } send(chat, txt, kb.main()); }
            qrStart = null;
        }

        if (connection === "close") {
            const was = connected;
            connected = false; connecting = false;
            clearTimeout(qrTimer); qrTimer = null;
            const code = lastDisconnect?.error?.output?.statusCode;
            const reason = lastDisconnect?.error?.message || "desconocido";
            const savedQr = qrMsgId; qrMsgId = null; qrStart = null;

            console.log(`[WA] Close → code=${code} reason=${reason} wasConnected=${was}`);

            if (code === DisconnectReason.loggedOut) {
                try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (_) {}
                sock = null;
                const t = "🔴 *Sesión cerrada*\nUsa 📱 Conectar para vincular.";
                if (chat && savedQr) editCaption(chat, savedQr, t, kb.main().reply_markup);
                else if (chat) send(chat, t, kb.main());
                return;
            }

            const BANNED_CODES = [401, 403, 440, 411, 500];
            if (BANNED_CODES.includes(code)) {
                try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (_) {}
                sock = null;
                const t = "🚫 *Número bloqueado o sesión inválida*\n(código: " + code + ")\n\n📱 Pulsa *Conectar* para vincular otro número.";
                if (chat && savedQr) editCaption(chat, savedQr, t, kb.main().reply_markup);
                else if (chat) send(chat, t, kb.main());
                return;
            }

            const hasCreds = fs.existsSync(AUTH) && (() => { try { return fs.readdirSync(AUTH).length > 0; } catch (_) { return false; } })();

            if (!hasCreds) {
                sock = null;
                const t = "🔴 *Sin sesión guardada.*\nPulsa 📱 Conectar.";
                if (chat && savedQr) editCaption(chat, savedQr, t, kb.main().reply_markup);
                else if (chat) send(chat, t, kb.main());
                return;
            }

            reconnN++;
            if (reconnN > MAX_RECONN) {
                destroy();
                try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (_) {}
                if (chat) send(chat, `⚠️ *No reconectó tras ${MAX_RECONN} intentos.*\n🗑️ Sesión limpiada.\n\n📱 Pulsa *Conectar* para vincular otro número.`, kb.main());
                return;
            }

            const delay = !was ? 2000 : Math.min(5000 * Math.pow(1.5, reconnN - 1), 60000);

            if (!was && savedQr && chat) {
                editCaption(chat, savedQr, "🔄 *QR escaneado — Vinculando...*", kb.main().reply_markup);
            } else if (was && chat) {
                send(chat, `⚠️ Reconectando en ${Math.round(delay / 1000)}s... (${reconnN}/${MAX_RECONN})`);
            }

            try { sock.ev.removeAllListeners(); } catch (_) {} sock = null;
            clearTimeout(reconnTimer);
            reconnTimer = setTimeout(() => { connecting = false; connectWA(chat).catch(() => {}); }, delay);
        }
    });
}

// ── CHECK NÚMEROS ──
async function checkNums(nums) {
    if (!sock || !connected) return nums.map(() => null);
    try {
        const r = await timeout(sock.onWhatsApp(...nums.map(n => `${n}@s.whatsapp.net`)), 25000, null);
        if (!r) throw new Error("Timeout");
        return nums.map(n => { const f = r.find(x => x.jid.startsWith(n)); return f ? f.exists === true : false; });
    } catch (e) { val.lastErr = e.message; return nums.map(() => null); }
}

async function getName(num) {
    if (!sock || !connected) return null;
    const jid = `${num}@s.whatsapp.net`;
    const c = names.get(jid); if (c) return c;
    try { const b = await timeout(sock.getBusinessProfile(jid), 5000, null); if (b?.profile?.tag) return b.profile.tag; if (b?.description) return b.description.split("\n")[0].slice(0, 40); } catch (_) {}
    try { if (sock.store?.contacts?.[jid]) { const ct = sock.store.contacts[jid]; return ct.notify || ct.verifiedName || ct.name || null; } } catch (_) {}
    return null;
}

// ── CONTROL DE VELOCIDAD HORARIA ──
async function rateGuard(checksToAdd) {
    const now = Date.now();
    if (!val.hourStart || now - val.hourStart >= 3600000) {
        val.hourStart = now;
        val.hourCount = 0;
    }
    if (val.hourCount + checksToAdd > MAX_PER_HOUR) {
        const remaining = 3600000 - (now - val.hourStart);
        const wait = Math.max(remaining, 1000);
        send(val.chat, `🛡️ *Límite horario alcanzado* (${val.hourCount}/${MAX_PER_HOUR})\n⏸️ Pausa de ${fmtTime(wait)} para proteger la cuenta...`);
        await sleep(wait);
        val.hourStart = Date.now();
        val.hourCount = 0;
    }
    val.hourCount += checksToAdd;
}

// ── VALIDACIÓN CONTINUA (sin objetivo, corre hasta DETENER) ──
async function runValidation() {
    val.start = Date.now();
    val.scanned = 0; val.valid = 0; val.skip = 0;
    val.err = 0; val.errRow = 0; val.lastN = 0; val.lastErr = "";
    val.stop = false; val.batchCount = 0;
    val.hourStart = Date.now(); val.hourCount = 0;

    // Crear archivo temporal para esta sesión
    val.currentFile = path.join(LISTS_DIR, `_temp_session_${Date.now()}.txt`);

    loadChecked();
    let dcWait = 0;

    try {
        // Corre indefinidamente hasta que el usuario pulse DETENER
        while (!val.stop) {

            // ── Reconexión ──
            if (!connected) {
                dcWait++;
                if (dcWait > 3) { send(val.chat, "🚫 *WhatsApp no reconectó.*\nUsa 📱 Conectar.", kb.main()); break; }
                send(val.chat, `⚠️ Esperando reconexión... (${dcWait}/3)`);
                let w = 0; while (!connected && w < 30000 && !val.stop) { await sleep(3000); w += 3000; }
                if (!connected) continue;
                dcWait = 0; val.errRow = 0; continue;
            }
            dcWait = 0;

            // ── Pausa por errores consecutivos ──
            if (val.errRow >= MAX_ERR) {
                send(val.chat, `⚠️ *${val.errRow} errores seguidos*\n⏸️ Pausando ${fmtTime(ERR_PAUSE_MS)} para enfriar...`);
                await sleep(ERR_PAUSE_MS);
                val.errRow = 0;
                if (!connected) continue;
            }

            // ── Pausa larga periódica (anti-ban) ──
            if (val.batchCount > 0 && val.batchCount % REST_EVERY === 0) {
                const restMs = randRest();
                const el = Date.now() - val.start;
                const rate = val.scanned > 0 ? ((val.valid / val.scanned) * 100).toFixed(1) : "0";
                send(val.chat,
                    `🛡️ *Pausa anti-ban* (lote ${val.batchCount})\n\n` +
                    `✅ ${val.valid.toLocaleString()} válidos\n` +
                    `⚡ Tasa: ${rate}% | ⏱️ ${fmtTime(el)}\n\n` +
                    `💤 Reanuda en ${fmtTime(restMs)}...`,
                    kb.running()
                );
                await sleep(restMs);
                if (val.stop) break;
                val.hourStart = Date.now();
                val.hourCount = 0;
                if (!connected) continue;
            }

            // ── Control de velocidad horaria ──
            await rateGuard(BATCH);
            if (val.stop) break;

            // ── Generar lote sin repetidos ──
            const batch = [];
            let att = 0;
            while (batch.length < BATCH && att < BATCH * 30) {
                att++;
                const n = genNum();
                if (!checked.has(n)) { batch.push(n); checked.add(n); }
            }
            if (!batch.length) { await sleep(2000); continue; }

            // ── Consultar WhatsApp ──
            const res = await checkNums(batch);
            val.batchCount++;

            for (let i = 0; i < batch.length; i++) {
                if (val.stop) break;
                if (res[i] === null) { val.err++; val.errRow++; continue; }
                val.scanned++; val.errRow = 0;

                if (res[i]) {
                    let name = null;
                    try { name = await timeout(getName(batch[i]), 8000, null); } catch (_) {}
                    if (val.mode === "dedicados") {
                        if (name && name !== "Sin nombre") { val.valid++; saveNum(batch[i], name, val.mode); }
                        else val.skip++;
                    } else { val.valid++; saveNum(batch[i], name, val.mode); }
                }
            }

            // ── Notificación de progreso ──
            if (val.valid > 0 && val.valid - val.lastN >= NOTIFY) {
                const el  = Date.now() - val.start;
                const spd = (val.scanned / (el / 1000)).toFixed(2);
                const rate = ((val.valid / val.scanned) * 100).toFixed(1);
                send(val.chat,
                    `🔔 *Progreso DIGI*\n\n✅ ${val.valid.toLocaleString()} válidos\n🔍 ${val.scanned.toLocaleString()} escaneados` +
                    (val.skip ? `\n⏭️ ${val.skip.toLocaleString()} sin nombre` : "") +
                    `\n⚡ ${spd}/s • ${rate}%\n🛡️ ${val.hourCount}/${MAX_PER_HOUR} checks/h\n⏱️ ${fmtTime(el)}`,
                    kb.running()
                );
                val.lastN = val.valid;
            }

            // ── Delay aleatorio entre lotes ──
            await sleep(randDelay());
        }
    } catch (e) { send(val.chat, `💥 *Error:* \`${String(e).slice(0, 200)}\``, kb.done()); }

    val.on = false;
    const el = Date.now() - val.start;

    // Pedir nombre para la lista
    if (val.valid > 0 && val.currentFile && fs.existsSync(val.currentFile)) {
        send(val.chat,
            `⛔ *Validación detenida*\n\n📡 DIGI 🟢 | ${val.mode === "dedicados" ? "⭐ Dedicados" : "👥 Leads"}\n` +
            `✅ ${val.valid.toLocaleString()} válidos\n🔍 ${val.scanned.toLocaleString()} escaneados` +
            (val.skip ? `\n⏭️ ${val.skip.toLocaleString()} sin nombre` : "") +
            `\n❌ ${val.err.toLocaleString()} errores\n⏱️ ${fmtTime(el)}\n\n` +
            `📝 *Escribe un nombre para guardar esta lista:*\n_(El nombre no puede repetirse con listas anteriores)_`
        );
        // Activar espera de nombre
        const prev = waitName.get(val.chat); if (prev) clearTimeout(prev);
        waitName.set(val.chat, setTimeout(() => {
            // Si no contesta en 2 minutos, guardar con nombre automático
            const autoName = `lista_${Date.now()}`;
            finalizarLista(val.chat, autoName);
        }, 120000));
    } else {
        send(val.chat,
            `⛔ *Validación detenida*\n\n` +
            `✅ ${val.valid.toLocaleString()} válidos\n🔍 ${val.scanned.toLocaleString()} escaneados\n⏱️ ${fmtTime(el)}\n\n` +
            `_No se encontraron números válidos para guardar._`,
            kb.done()
        );
        // Limpiar archivo temporal vacío
        if (val.currentFile && fs.existsSync(val.currentFile)) {
            try { fs.unlinkSync(val.currentFile); } catch (_) {}
        }
        val.currentFile = null;
    }
}

function finalizarLista(chat, nombre) {
    clearTimeout(waitName.get(chat));
    waitName.delete(chat);

    if (!val.currentFile || !fs.existsSync(val.currentFile)) {
        send(chat, "❌ No hay datos para guardar.", kb.done());
        val.currentFile = null;
        return;
    }

    // Sanitizar nombre
    const safe = nombre.replace(/[^a-zA-Z0-9áéíóúñÁÉÍÓÚÑ _-]/g, "").trim();
    if (!safe) {
        send(chat, "❌ Nombre no válido. Escribe otro:");
        return;
    }

    // Verificar que no se repita
    if (usedNames.has(safe.toLowerCase())) {
        send(chat, `❌ Ya existe una lista con el nombre *"${safe}"*.\n📝 Escribe otro nombre:`);
        return;
    }

    const finalPath = path.join(LISTS_DIR, `${safe}.txt`);
    try {
        fs.renameSync(val.currentFile, finalPath);
    } catch (_) {
        // Si rename falla (cross-device), copiar
        try {
            fs.copyFileSync(val.currentFile, finalPath);
            fs.unlinkSync(val.currentFile);
        } catch (e) {
            send(chat, `❌ Error al guardar: \`${e.message}\``, kb.done());
            val.currentFile = null;
            return;
        }
    }

    usedNames.add(safe.toLowerCase());
    val.currentFile = null;

    // Contar líneas
    let count = 0;
    try { count = fs.readFileSync(finalPath, "utf-8").split("\n").filter(l => l.trim()).length; } catch (_) {}

    send(chat,
        `✅ *Lista guardada*\n\n📄 *${safe}.txt*\n📊 ${count.toLocaleString()} números\n📂 Carpeta: \`${LISTS_DIR}/\``,
        kb.done()
    );

    // Enviar el archivo
    try {
        bot.sendDocument(chat, finalPath, { caption: `📄 *${safe}* — ${count.toLocaleString()} números DIGI ✅`, parse_mode: "Markdown" }).catch(() => {});
    } catch (_) {}
}

function startVal(chat, mode) {
    if (!connected) { send(chat, "❌ *WhatsApp no conectado*\nUsa 📱 Conectar.", kb.main()); return; }
    if (val.on) { send(chat, "⚠️ Ya hay validación en curso.", kb.running()); return; }
    val.on = true; val.chat = chat; val.mode = mode;
    send(chat,
        `🚀 *Validación DIGI v12 iniciada*\n\n` +
        `${mode === "dedicados" ? "⭐ Dedicados (solo con nombre)" : "👥 Leads (todos)"}\n` +
        `🎯 *Modo continuo* — Corre hasta que pulses DETENER\n` +
        `📡 Prefijos DIGI: 614, 624, 641, 642, 643\n\n` +
        `🛡️ *Modo anti-ban activado*\n` +
        `• Lotes de ${BATCH} números\n` +
        `• Delay ${DELAY_MIN/1000}–${DELAY_MAX/1000}s con jitter\n` +
        `• Pausa larga cada ${REST_EVERY} lotes\n` +
        `• Máx. ${MAX_PER_HOUR} checks/hora`,
        kb.running()
    );
    runValidation().catch(e => { val.on = false; send(chat, `💥 \`${e.message}\``, kb.done()); });
}

// ── ESTADO ──
function sendStatus(chat) {
    if (!val.on && !val.scanned) { send(chat, `💤 Sin validación.\n📱 ${connected ? "🟢 Conectado" : "🔴 Desconectado"}`, kb.main()); return; }
    const el   = val.start ? Date.now() - val.start : 0;
    const spd  = el > 0 ? (val.scanned / (el / 1000)).toFixed(2) : "0";
    send(chat,
        `📊 *Estado DIGI v12*\n\n${val.on ? "🟢 Activa (continua)" : "🔴 Parada"} | 📱 ${connected ? "🟢" : "🔴"}\n\n` +
        `✅ ${val.valid.toLocaleString()} válidos\n🔍 ${val.scanned.toLocaleString()} escaneados` +
        (val.skip ? `\n⏭️ ${val.skip.toLocaleString()} sin nombre` : "") +
        (val.err  ? `\n❌ ${val.err.toLocaleString()} errores` : "") +
        `\n⚡ ${spd}/s | 🛡️ ${val.hourCount}/${MAX_PER_HOUR}/h\n⏱️ ${fmtTime(el)}`,
        val.on ? kb.running() : kb.done()
    );
}

// ── LISTAR LISTAS GUARDADAS ──
function sendMyLists(chat) {
    try {
        const files = fs.readdirSync(LISTS_DIR).filter(f => f.endsWith(".txt") && !f.startsWith("_temp_"));
        if (!files.length) { send(chat, "📂 *No tienes listas guardadas.*", kb.main()); return; }
        let txt = "📂 *Mis listas:*\n\n";
        for (const f of files) {
            let count = 0;
            try { count = fs.readFileSync(path.join(LISTS_DIR, f), "utf-8").split("\n").filter(l => l.trim()).length; } catch (_) {}
            txt += `📄 *${f.replace(".txt", "")}* — ${count.toLocaleString()} números\n`;
        }
        // Crear botones para descargar cada lista
        const buttons = files.map(f => [{ text: `📥 ${f.replace(".txt", "")}`, callback_data: `dl_${f.replace(".txt", "").slice(0, 40)}` }]);
        buttons.push([{ text: "🏠 Menú", callback_data: "main" }]);
        send(chat, txt, { reply_markup: { inline_keyboard: buttons } });
    } catch (e) { send(chat, "❌ Error al listar.", kb.main()); }
}

// ── CALLBACKS ──
bot.on("callback_query", async q => {
    const chat = q.message.chat.id, d = q.data;
    bot.answerCallbackQuery(q.id).catch(() => {});

    if (d === "main") { send(chat, `🤖 *Bot DIGI v12*\n📱 ${connected ? "🟢 Conectado" : "🔴 Desconectado"}`, kb.main()); return; }

    if (d === "cancel_qr") {
        const m = qrMsgId; destroy();
        if (m) editCaption(chat, m, "❌ *Cancelado*\nPulsa 📱 Conectar.", kb.main().reply_markup);
        else send(chat, "❌ *Cancelado*", kb.main()); return;
    }

    // El botón "Conectar WhatsApp" siempre es nueva sesión
    if (d === "new_session") {
        if (val.on) { send(chat, "⚠️ Para la validación primero.", kb.running()); return; }
        destroy();
        try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (_) {}
        reconnN = 0;
        send(chat, "🗑️ *Sesión anterior eliminada.*\n\n📱 Generando QR nuevo...");
        const m = await send(chat, "📱 *Conectando...*\n⏳ Generando QR...");
        connMsgId = m?.message_id || null;
        connectWA(chat).catch(e => { connecting = false; send(chat, `❌ \`${e.message}\``, kb.main()); });
        return;
    }

    if (d === "validate") {
        if (!connected) { send(chat, "❌ Conecta WhatsApp primero.", kb.main()); return; }
        if (val.on) { send(chat, "⚠️ Validación en curso.", kb.running()); return; }
        // Solo preguntar modo: leads o dedicados
        send(chat, "🎯 *Elige el modo de validación:*\n\n👥 *Leads*: Todos los válidos\n⭐ *Dedicados*: Solo con nombre", kb.mode());
        return;
    }

    if (d === "go_leads") { startVal(chat, "leads"); return; }
    if (d === "go_dedicados") { startVal(chat, "dedicados"); return; }

    if (d === "status")   { sendStatus(chat); return; }

    if (d === "stop") {
        if (!val.on) { send(chat, "ℹ️ Sin validación.", kb.main()); return; }
        val.stop = true;
        send(chat, "⛔ *Deteniendo...*");
        return;
    }

    if (d === "my_lists") { sendMyLists(chat); return; }

    // Descargar lista específica
    if (d.startsWith("dl_")) {
        const name = d.slice(3);
        const filePath = path.join(LISTS_DIR, `${name}.txt`);
        if (!fs.existsSync(filePath)) { send(chat, "❌ Lista no encontrada."); return; }
        try {
            const count = fs.readFileSync(filePath, "utf-8").split("\n").filter(l => l.trim()).length;
            await bot.sendDocument(chat, filePath, { caption: `📄 *${name}* — ${count.toLocaleString()} números DIGI ✅`, parse_mode: "Markdown" });
        } catch (e) { send(chat, `❌ \`${e.message}\``); }
        return;
    }

    if (d === "disconnect") {
        if (!sock && !connecting) { send(chat, "ℹ️ Sin sesión.", kb.main()); return; }
        if (val.on) { send(chat, "⚠️ Para la validación primero.", kb.running()); return; }
        try { if (sock) await sock.logout(); } catch (_) {}
        destroy();
        try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (_) {}
        send(chat, "🔴 *Sesión cerrada.*", kb.main()); return;
    }
});

// ── COMANDOS TEXTO ──
bot.onText(/\/start/, m => send(m.chat.id,
    `🤖 *Bot DIGI v12 — Continuo / Anti-Ban*\n_Solo DIGI 🟢_\n\n` +
    `📱 ${connected ? "🟢 Conectado" : "🔴 Desconectado"}\n\n` +
    `Prefijos: 614, 624, 641, 642, 643\n` +
    `🛡️ Anti-ban: lotes ${BATCH}, ${DELAY_MIN/1000}–${DELAY_MAX/1000}s delay, max ${MAX_PER_HOUR}/h\n` +
    `🔄 Modo continuo: corre hasta que pulses DETENER`,
    kb.main()
));

bot.onText(/\/conectar/, async m => {
    const c = m.chat.id;
    // Siempre nueva sesión
    if (val.on) { send(c, "⚠️ Para la validación primero.", kb.running()); return; }
    destroy();
    try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (_) {}
    reconnN = 0;
    send(c, "🗑️ *Sesión anterior eliminada.*\n📱 Generando QR nuevo...");
    const msg = await send(c, "📱 Conectando...");
    connMsgId = msg?.message_id || null;
    connectWA(c).catch(e => { connecting = false; send(c, `❌ \`${e.message}\``, kb.main()); });
});

bot.onText(/\/validar/, (m) => {
    const c = m.chat.id;
    if (!connected) { send(c, "❌ Conecta primero.", kb.main()); return; }
    if (val.on) { send(c, "⚠️ En curso.", kb.running()); return; }
    send(c, "🎯 *Elige modo:*\n\n👥 *Leads*: Todos\n⭐ *Dedicados*: Solo con nombre", kb.mode());
});

bot.onText(/\/estado/,      m => sendStatus(m.chat.id));
bot.onText(/\/parar/,       m => { if (!val.on) { send(m.chat.id, "ℹ️ Nada activo.", kb.main()); return; } val.stop = true; send(m.chat.id, "⛔ Deteniendo..."); });
bot.onText(/\/listas/,      m => sendMyLists(m.chat.id));
bot.onText(/\/desconectar/, async m => {
    const c = m.chat.id;
    if (!sock && !connecting) { send(c, "ℹ️ Sin sesión.", kb.main()); return; }
    if (val.on) { send(c, "⚠️ Para primero.", kb.running()); return; }
    try { if (sock) await sock.logout(); } catch (_) {} destroy();
    try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (_) {}
    send(c, "🔴 *Sesión cerrada.*", kb.main());
});

// ── MENSAJE DE TEXTO: Nombre de lista o comandos ──
bot.on("message", m => {
    const c = m.chat.id;
    if (m.text?.startsWith("/")) return;

    // Si estamos esperando nombre de lista
    if (waitName.has(c)) {
        const nombre = (m.text || "").trim();
        if (!nombre) { send(c, "❌ Escribe un nombre válido:"); return; }
        finalizarLista(c, nombre);
        return;
    }
});

// ── SHUTDOWN ──
function shutdown(sig) {
    console.log(`[${sig}] Cerrando...`);
    if (val.on) val.stop = true;
    destroy();
    try { bot.stopPolling(); } catch (_) {}
    process.exit(0);
}
process.on("SIGINT",             () => shutdown("SIGINT"));
process.on("SIGTERM",            () => shutdown("SIGTERM"));
process.on("uncaughtException",  e  => console.error("[FATAL]", e.message));
process.on("unhandledRejection", r  => console.error("[FATAL]", r));

// ── MAIN ──
async function main() {
    console.log("═══ Bot DIGI v12 — Continuo / Anti-Ban / 1800/h ═══");
    console.log(`Prefijos: ${PREFIJOS.map(p => p.slice(2)).join(", ")}`);
    console.log(`Anti-ban: batch=${BATCH}, delay=${DELAY_MIN/1000}-${DELAY_MAX/1000}s, rest cada ${REST_EVERY} lotes, max ${MAX_PER_HOUR}/h`);
    console.log(`Modo: CONTINUO — corre hasta DETENER`);
    const has = fs.existsSync(AUTH) && (() => { try { return fs.readdirSync(AUTH).length > 0; } catch (_) { return false; } })();
    if (has) { console.log("Reconectando..."); connectWA(null).catch(() => { connecting = false; }); }
    else console.log("Sin sesión. Esperando /conectar...");
    console.log("✅ Listo");
}
main().catch(e => console.error("[MAIN]", e));
