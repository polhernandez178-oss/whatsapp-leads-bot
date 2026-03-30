#!/usr/bin/env node
// Bot Validador DIGI v10 — Solo DIGI
"use strict";

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, makeCacheableSignalKeyStore, fetchLatestBaileysVersion } = require("@whiskeysockets/baileys");
const TelegramBot = require("node-telegram-bot-api");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");

// ── CONFIG ──
const TOKEN = "8710402523:AAHzR-ZQ8XR_qSJSOzJ6VPFIZYD1HnLoJtA";
const AUTH = "./auth_session";
const CSV = "numeros_validados.csv";
const BATCH = 20;
const DELAY = 3000;
const NOTIFY = 50;
const MAX_ERR = 15;
const QR_MS = 60000;
const MAX_RECONN = 5;

// ── PREFIJOS DIGI ──
const PREFIJOS = ["34614", "34624", "34641", "34642", "34643"];

// ── ESTADO ──
const log = pino({ level: "silent" });
let sock = null, connected = false, connecting = false;
let qrTimer = null, qrMsgId = null, qrStart = null, connMsgId = null;
let qrN = 0, reconnN = 0, reconnTimer = null, connChat = null;

const val = { on: false, stop: false, target: 0, scanned: 0, valid: 0, skip: 0, err: 0, errRow: 0, start: null, chat: null, lastN: 0, lastErr: "", mode: "leads" };
const checked = new Set();
const names = new Map();
const waitAmt = new Map();

// ── TELEGRAM ──
const bot = new TelegramBot(TOKEN, { polling: true });
bot.on("polling_error", e => { if (e.code !== "ETELEGRAM" || !e.message?.includes("409")) console.error("[TG]", e.code || e.message); });
bot.on("error", e => console.error("[TG]", e.message));

const send = (id, txt, ex = {}) => id ? bot.sendMessage(id, txt, { parse_mode: "Markdown", ...ex }).catch(() => null) : Promise.resolve(null);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const timeout = (p, ms, fb = null) => { let t; return Promise.race([p, new Promise(r => { t = setTimeout(() => r(fb), ms); })]).finally(() => clearTimeout(t)); };
const fmtTime = ms => { if (!ms || ms < 0) return "—"; const s = Math.floor(ms/1000), h = Math.floor(s/3600), m = Math.floor(s%3600/60); return h ? `${h}h ${m}m` : m ? `${m}m ${s%60}s` : `${s%60}s`; };

// ── TECLADOS ──
const kb = {
    main: () => ({ reply_markup: { inline_keyboard: [
        [{ text: "📱 Conectar WhatsApp", callback_data: "connect" }],
        [{ text: "🚀 Validar DIGI", callback_data: "validate" }],
        [{ text: "📊 Estado", callback_data: "status" }, { text: "📥 CSV", callback_data: "download" }],
        [{ text: "🔌 Desconectar", callback_data: "disconnect" }],
    ]}}),
    cancel: () => ({ inline_keyboard: [[{ text: "❌ Cancelar", callback_data: "cancel_qr" }]] }),
    amount: () => ({ reply_markup: { inline_keyboard: [
        [{ text: "2.000", callback_data: "n_2000" }, { text: "4.000", callback_data: "n_4000" }],
        [{ text: "6.000", callback_data: "n_6000" }, { text: "8.000", callback_data: "n_8000" }],
        [{ text: "🔟 10.000", callback_data: "n_10000" }],
        [{ text: "✏️ Personalizada", callback_data: "n_custom" }],
        [{ text: "🔙 Menú", callback_data: "main" }],
    ]}}),
    mode: n => ({ reply_markup: { inline_keyboard: [
        [{ text: "👥 Leads", callback_data: `go_leads_${n}` }],
        [{ text: "⭐ Dedicados (con nombre)", callback_data: `go_dedicados_${n}` }],
        [{ text: "🔙 Cantidad", callback_data: "validate" }],
    ]}}),
    running: () => ({ reply_markup: { inline_keyboard: [[{ text: "📊 Estado", callback_data: "status" }, { text: "⛔ PARAR", callback_data: "stop" }]] }}),
    done: () => ({ reply_markup: { inline_keyboard: [
        [{ text: "📥 CSV", callback_data: "download" }, { text: "🚀 Nueva", callback_data: "validate" }],
        [{ text: "🏠 Menú", callback_data: "main" }],
    ]}}),
};

// ── GENERAR NÚMERO DIGI ──
function genNum() {
    const pfx = PREFIJOS[Math.floor(Math.random() * PREFIJOS.length)];
    const suf = String(Math.floor(Math.random() * 1e6)).padStart(6, "0");
    return pfx + suf;
}

// ── CSV ──
function loadCSV() {
    if (!fs.existsSync(CSV)) return;
    try {
        const lines = fs.readFileSync(CSV, "utf-8").split("\n").slice(1);
        for (const l of lines) { const p = l.split(","); if (p.length >= 2) checked.add(p[1].trim().replace(/"/g, "")); }
        console.log(`[CSV] ${checked.size} previos`);
    } catch (_) {}
}

function saveNum(num, name = "Sin nombre") {
    try {
        const exists = fs.existsSync(CSV);
        fs.appendFileSync(CSV, exists ? `\n"${name.replace(/"/g, '""')}","${num}"` : `"Nombre","Telefono"\n"${name.replace(/"/g, '""')}","${num}"`, "utf-8");
    } catch (_) {}
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
    try { const r = await timeout(fetchLatestBaileysVersion(), 10000, null); ver = r?.version; }
    catch (_) { ver = undefined; }

    try {
        const opts = { auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, log) }, logger: log, printQRInTerminal: false, browser: ["DIGI Bot", "Chrome", "22.0"], connectTimeoutMs: 45000, defaultQueryTimeoutMs: 25000, keepAliveIntervalMs: 15000, emitOwnEvents: false, generateHighQualityLinkPreview: false };
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
            qrN++;
            // Reiniciar timer cada QR nuevo
            qrStart = Date.now();
            clearTimeout(qrTimer);
            qrTimer = setTimeout(() => {
                if (!connected && qrStart) {
                    const c = chat, m = qrMsgId;
                    destroy();
                    if (c && m) editCaption(c, m, "⏰ *Tiempo agotado*\n\nPulsa 📱 *Conectar* de nuevo.", kb.main().reply_markup);
                    else if (c) send(c, "⏰ *QR expirado.* Pulsa 📱 Conectar.", kb.main());
                }
            }, QR_MS);

            QRCode.toBuffer(qr, { scale: 8 }).then(async buf => {
                if (!chat) return;
                // Borrar mensaje previo (QR anterior o "Conectando...")
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

            // ── CASO 1: Sesión cerrada desde WhatsApp (loggedOut) ──
            if (code === DisconnectReason.loggedOut) {
                try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (_) {}
                sock = null;
                const t = "🔴 *Sesión cerrada*\nUsa 📱 Conectar para vincular.";
                if (chat && savedQr) editCaption(chat, savedQr, t, kb.main().reply_markup);
                else if (chat) send(chat, t, kb.main());
                return;
            }

            // ── Verificar si hay credenciales guardadas ──
            const hasCreds = fs.existsSync(AUTH) && (() => {
                try { return fs.readdirSync(AUTH).length > 0; } catch (_) { return false; }
            })();

            // ── CASO 2: Sin credenciales = nunca se vinculó ──
            if (!hasCreds) {
                sock = null;
                const t = "🔴 *Sin sesión guardada.*\nPulsa 📱 Conectar.";
                if (chat && savedQr) editCaption(chat, savedQr, t, kb.main().reply_markup);
                else if (chat) send(chat, t, kb.main());
                return;
            }

            // ── CASO 3: Hay credenciales → SIEMPRE reconectar ──
            // Esto incluye el ciclo normal post-QR (scan → close → reopen)
            reconnN++;
            if (reconnN > MAX_RECONN) {
                destroy();
                if (chat) send(chat, `⚠️ *No reconectó tras ${MAX_RECONN} intentos.*\nPulsa 📱 Conectar.`, kb.main());
                return;
            }

            // Post-QR: reconectar rápido (2s). Ya conectado: backoff exponencial.
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
        const r = await timeout(sock.onWhatsApp(...nums.map(n => `${n}@s.whatsapp.net`)), 20000, null);
        if (!r) throw new Error("Timeout");
        return nums.map(n => { const f = r.find(x => x.jid.startsWith(n)); return f ? f.exists === true : false; });
    } catch (e) { val.lastErr = e.message; return nums.map(() => null); }
}

async function getName(num) {
    if (!sock || !connected) return null;
    const jid = `${num}@s.whatsapp.net`;
    const c = names.get(jid); if (c) return c;
    try { const b = await timeout(sock.getBusinessProfile(jid), 5000, null); if (b?.profile?.tag) return b.profile.tag; if (b?.description) return b.description.split("\n")[0].slice(0, 40); } catch (_) {}
    try { if (sock.store?.contacts?.[jid]) { const c = sock.store.contacts[jid]; return c.notify || c.verifiedName || c.name || null; } } catch (_) {}
    return null;
}

// ── VALIDACIÓN ──
async function runValidation() {
    val.start = Date.now(); val.scanned = 0; val.valid = 0; val.skip = 0; val.err = 0; val.errRow = 0; val.lastN = 0; val.lastErr = ""; val.stop = false;
    loadCSV();
    let dcWait = 0;

    try {
        while (val.valid < val.target) {
            if (val.stop) break;

            if (!connected) {
                dcWait++;
                if (dcWait > 3) { send(val.chat, "🚫 *WhatsApp no reconectó.*\nUsa 📱 Conectar.", kb.main()); break; }
                send(val.chat, `⚠️ Esperando reconexión... (${dcWait}/3)`);
                let w = 0; while (!connected && w < 30000 && !val.stop) { await sleep(3000); w += 3000; }
                if (!connected) continue;
                dcWait = 0; val.errRow = 0; continue;
            }
            dcWait = 0;

            if (val.errRow >= MAX_ERR) {
                send(val.chat, `⚠️ *${val.errRow} errores seguidos*\nPausando 30s...`);
                await sleep(30000); val.errRow = 0;
                if (!connected) continue;
            }

            const batch = [];
            let att = 0;
            while (batch.length < BATCH && att < BATCH * 20) { att++; const n = genNum(); if (!checked.has(n)) { batch.push(n); checked.add(n); } }
            if (!batch.length) { await sleep(1000); continue; }

            const res = await checkNums(batch);

            for (let i = 0; i < batch.length; i++) {
                if (val.stop || val.valid >= val.target) break;
                if (res[i] === null) { val.err++; val.errRow++; continue; }
                val.scanned++; val.errRow = 0;

                if (res[i]) {
                    let name = null;
                    try { name = await timeout(getName(batch[i]), 8000, null); } catch (_) {}

                    if (val.mode === "dedicados") {
                        if (name && name !== "Sin nombre") { val.valid++; saveNum(batch[i], name); }
                        else val.skip++;
                    } else { val.valid++; saveNum(batch[i], name || "Sin nombre"); }
                }
            }

            if (val.valid > 0 && val.valid - val.lastN >= NOTIFY) {
                const el = Date.now() - val.start;
                const spd = (val.scanned / (el / 1000)).toFixed(1);
                const rate = ((val.valid / val.scanned) * 100).toFixed(1);
                const eta = ((val.target - val.valid) / val.valid) * el;
                send(val.chat,
                    `🔔 *Progreso DIGI*\n\n✅ ${val.valid.toLocaleString()} / ${val.target.toLocaleString()}\n🔍 ${val.scanned.toLocaleString()} escaneados` +
                    (val.skip ? `\n⏭️ ${val.skip.toLocaleString()} sin nombre` : "") +
                    `\n⚡ ${spd}/s • ${rate}%\n⏱️ ${fmtTime(el)} | ETA: ${fmtTime(eta)}`,
                    kb.running()
                );
                val.lastN = val.valid;
            }
            await sleep(DELAY);
        }
    } catch (e) { send(val.chat, `💥 *Error:* \`${String(e).slice(0, 200)}\``, kb.done()); }

    val.on = false;
    const el = Date.now() - val.start;
    const icon = val.stop ? "⛔" : val.valid >= val.target ? "🎉" : "⚠️";
    const title = val.stop ? "Detenida" : val.valid >= val.target ? "¡Completada!" : "Interrumpida";
    send(val.chat,
        `${icon} *${title}*\n\n📡 DIGI 🟢 | ${val.mode === "dedicados" ? "⭐ Dedicados" : "👥 Leads"}\n` +
        `✅ ${val.valid.toLocaleString()} válidos\n🔍 ${val.scanned.toLocaleString()} escaneados` +
        (val.skip ? `\n⏭️ ${val.skip.toLocaleString()} sin nombre` : "") +
        `\n❌ ${val.err.toLocaleString()} errores\n⏱️ ${fmtTime(el)}`,
        kb.done()
    );
}

function startVal(chat, target, mode) {
    if (!connected) { send(chat, "❌ *WhatsApp no conectado*\nUsa 📱 Conectar.", kb.main()); return; }
    if (val.on) { send(chat, "⚠️ Ya hay validación en curso.", kb.running()); return; }
    val.on = true; val.target = target; val.chat = chat; val.mode = mode;
    send(chat,
        `🚀 *Validación DIGI iniciada*\n\n${mode === "dedicados" ? "⭐ Dedicados (solo con nombre)" : "👥 Leads (todos)"}\n` +
        `🎯 ${target.toLocaleString()} números\n📡 Prefijos DIGI: 614, 624, 641, 642, 643`,
        kb.running()
    );
    runValidation().catch(e => { val.on = false; send(chat, `💥 \`${e.message}\``, kb.done()); });
}

// ── ESTADO ──
function sendStatus(chat) {
    if (!val.on && !val.scanned) { send(chat, `💤 Sin validación.\n📱 ${connected ? "🟢 Conectado" : "🔴 Desconectado"}`, kb.main()); return; }
    const el = val.start ? Date.now() - val.start : 0;
    const pct = val.target ? (val.valid / val.target) * 100 : 0;
    const spd = el > 0 ? (val.scanned / (el / 1000)).toFixed(1) : "0";
    const bars = Math.floor(Math.min(pct, 100) / 5);
    const bar = "█".repeat(bars) + "░".repeat(20 - bars);
    let eta = "—"; if (val.valid > 0 && el > 0) eta = fmtTime(((val.target - val.valid) / val.valid) * el);
    send(chat,
        `📊 *Estado DIGI*\n\n${val.on ? "🟢 Activa" : "🔴 Parada"} | 📱 ${connected ? "🟢" : "🔴"}\n` +
        `\`${bar}\` ${pct.toFixed(1)}%\n\n` +
        `✅ ${val.valid.toLocaleString()} / ${val.target.toLocaleString()}\n🔍 ${val.scanned.toLocaleString()}` +
        (val.skip ? `\n⏭️ ${val.skip.toLocaleString()} sin nombre` : "") +
        (val.err ? `\n❌ ${val.err.toLocaleString()} errores` : "") +
        `\n⚡ ${spd}/s | ⏱️ ${fmtTime(el)} | ETA: ${eta}`,
        val.on ? kb.running() : kb.done()
    );
}

async function sendCSV(chat) {
    if (!fs.existsSync(CSV)) { send(chat, "❌ Sin resultados aún.", kb.main()); return; }
    try {
        const n = fs.readFileSync(CSV, "utf-8").split("\n").filter(l => l.trim()).length - 1;
        if (n <= 0) { send(chat, "📭 Vacío.", kb.main()); return; }
        await bot.sendDocument(chat, CSV, { caption: `📋 *${n.toLocaleString()} números DIGI* ✅`, parse_mode: "Markdown" });
    } catch (e) { send(chat, `❌ \`${e.message}\``, kb.main()); }
}

// ── CALLBACKS ──
bot.on("callback_query", async q => {
    const chat = q.message.chat.id, d = q.data;
    bot.answerCallbackQuery(q.id).catch(() => {});

    if (d === "main") { send(chat, `🤖 *Bot DIGI v10*\n📱 ${connected ? "🟢 Conectado" : "🔴 Desconectado"}`, kb.main()); return; }

    if (d === "cancel_qr") { const m = qrMsgId; destroy(); if (m) editCaption(chat, m, "❌ *Cancelado*\nPulsa 📱 Conectar.", kb.main().reply_markup); else send(chat, "❌ *Cancelado*", kb.main()); return; }

    if (d === "connect") {
        if (connected) { send(chat, `✅ *Ya conectado* (+${sock?.user?.id?.split(":")[0] || "?"})`, kb.main()); return; }
        if (connecting) { send(chat, "⏳ *Conectando...*"); return; }
        const m = await send(chat, "📱 *Conectando...*\n⏳ Generando QR...");
        connMsgId = m?.message_id || null;
        connectWA(chat).catch(e => { connecting = false; if (connMsgId) { bot.deleteMessage(chat, connMsgId).catch(() => {}); connMsgId = null; } send(chat, `❌ \`${e.message}\``, kb.main()); });
        return;
    }

    if (d === "validate") {
        if (!connected) { send(chat, "❌ Conecta WhatsApp primero.", kb.main()); return; }
        if (val.on) { send(chat, "⚠️ Validación en curso.", kb.running()); return; }
        send(chat, "🎯 *¿Cuántos números DIGI?*", kb.amount()); return;
    }

    if (d.startsWith("n_") && d !== "n_custom") {
        const n = parseInt(d.slice(2));
        send(chat, `*${n.toLocaleString()} números DIGI* — Elige modo:\n\n👥 *Leads*: Todos los válidos\n⭐ *Dedicados*: Solo con nombre`, kb.mode(n)); return;
    }

    if (d === "n_custom") {
        const prev = waitAmt.get(chat); if (prev) clearTimeout(prev);
        waitAmt.set(chat, setTimeout(() => { waitAmt.delete(chat); send(chat, "⏰ Tiempo agotado.", kb.main()); }, 60000));
        send(chat, "✏️ Escribe la cantidad (1 - 100.000):"); return;
    }

    if (d.startsWith("go_")) {
        const [, mode, n] = d.split("_").reduce((a, v, i) => { if (i === 1) a[1] = v; if (i === 2) a[2] = parseInt(v); return a; }, [null, "", 0]);
        // Parse more carefully
        const parts = d.split("_");
        const goMode = parts[1]; // "leads" or "dedicados"
        const goN = parseInt(parts[2]);
        if (!goN || !["leads", "dedicados"].includes(goMode)) { send(chat, "❌ Error. Reinicia.", kb.main()); return; }
        startVal(chat, goN, goMode); return;
    }

    if (d === "status") { sendStatus(chat); return; }
    if (d === "stop") { if (!val.on) { send(chat, "ℹ️ Sin validación.", kb.main()); return; } val.stop = true; send(chat, "⛔ *Deteniendo...*"); return; }
    if (d === "download") { sendCSV(chat); return; }

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
    `🤖 *Bot DIGI v10*\n_Solo DIGI 🟢_\n\n` +
    `📱 ${connected ? "🟢 Conectado" : "🔴 Desconectado"}\n\n` +
    `Prefijos: 614, 624, 641, 642, 643`,
    kb.main()
));

bot.onText(/\/conectar/, async m => {
    const c = m.chat.id;
    if (connected) { send(c, `✅ Ya conectado (+${sock?.user?.id?.split(":")[0] || "?"})`, kb.main()); return; }
    if (connecting) { send(c, "⏳ Conectando..."); return; }
    const msg = await send(c, "📱 Conectando...");
    connMsgId = msg?.message_id || null;
    connectWA(c).catch(e => { connecting = false; send(c, `❌ \`${e.message}\``, kb.main()); });
});

bot.onText(/\/validar(?:\s+(\d+))?/, (m, match) => {
    const c = m.chat.id;
    if (!connected) { send(c, "❌ Conecta primero.", kb.main()); return; }
    if (val.on) { send(c, "⚠️ En curso.", kb.running()); return; }
    const n = match?.[1] ? Math.max(1, Math.min(100000, parseInt(match[1]))) : null;
    if (n) send(c, `*${n.toLocaleString()} DIGI* — Modo:`, kb.mode(n));
    else send(c, "🎯 *¿Cuántos?*", kb.amount());
});

bot.onText(/\/estado/, m => sendStatus(m.chat.id));
bot.onText(/\/parar/, m => { if (!val.on) { send(m.chat.id, "ℹ️ Nada activo.", kb.main()); return; } val.stop = true; send(m.chat.id, "⛔ Deteniendo..."); });
bot.onText(/\/descargar/, m => sendCSV(m.chat.id));
bot.onText(/\/desconectar/, async m => {
    const c = m.chat.id;
    if (!sock && !connecting) { send(c, "ℹ️ Sin sesión.", kb.main()); return; }
    if (val.on) { send(c, "⚠️ Para primero.", kb.running()); return; }
    try { if (sock) await sock.logout(); } catch (_) {} destroy();
    try { fs.rmSync(AUTH, { recursive: true, force: true }); } catch (_) {}
    send(c, "🔴 *Sesión cerrada.*", kb.main());
});

// ── CANTIDAD PERSONALIZADA ──
bot.on("message", m => {
    const c = m.chat.id;
    if (!waitAmt.has(c) || m.text?.startsWith("/")) return;
    const n = parseInt(m.text);
    if (isNaN(n) || n < 1) { send(c, "❌ Número no válido."); return; }
    const amt = Math.min(100000, n);
    clearTimeout(waitAmt.get(c)); waitAmt.delete(c);
    send(c, `*${amt.toLocaleString()} DIGI* — Modo:`, kb.mode(amt));
});

// ── SHUTDOWN ──
function shutdown(sig) {
    console.log(`[${sig}] Cerrando...`);
    if (val.on) val.stop = true;
    destroy();
    try { bot.stopPolling(); } catch (_) {}
    process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", e => console.error("[FATAL]", e.message));
process.on("unhandledRejection", r => console.error("[FATAL]", r));

// ── MAIN ──
async function main() {
    console.log("═══ Bot DIGI v10 — Solo DIGI ═══");
    console.log(`Prefijos: ${PREFIJOS.map(p => p.slice(2)).join(", ")}`);
    const has = fs.existsSync(AUTH) && (() => { try { return fs.readdirSync(AUTH).length > 0; } catch (_) { return false; } })();
    if (has) { console.log("Reconectando..."); connectWA(null).catch(() => { connecting = false; }); }
    else console.log("Sin sesión. Esperando /conectar...");
    console.log("✅ Listo");
}
main().catch(e => console.error("[MAIN]", e));
