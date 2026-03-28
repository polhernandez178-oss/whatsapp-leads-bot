#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════╗
// ║     BOT VALIDADOR DIGI v6.0 — Baileys Edition (100% Gratis)     ║
// ╠══════════════════════════════════════════════════════════════════╣
// ║  🆓 Sin GreenAPI • Sin límites • Sin pagos                       ║
// ║  📱 Usa Baileys (WhatsApp Web directo)                           ║
// ║  💬 Control total desde Telegram                                 ║
// ╠══════════════════════════════════════════════════════════════════╣
// ║  /start     → Menú principal                                     ║
// ║  /conectar  → Vincular WhatsApp (QR por Telegram)                ║
// ║  /validar N → Buscar N números válidos                           ║
// ║  /estado    → Progreso actual                                    ║
// ║  /parar     → Detener validación                                 ║
// ║  /descargar → Obtener CSV                                        ║
// ║  /desconectar → Cerrar sesión de WhatsApp                        ║
// ╚══════════════════════════════════════════════════════════════════╝

"use strict";

// ================================================================
//  CONFIGURACIÓN
// ================================================================

const TELEGRAM_TOKEN = "8710402523:AAHzR-ZQ8XR_qSJSOzJ6VPFIZYD1HnLoJtA";

const PREFIJOS_DIGI = ["34641", "34642", "34643"];
const BATCH_SIZE = 20;              // Números por lote (Baileys soporta batch)
const DELAY_ENTRE_LOTES_MS = 3000;  // 3s entre lotes (evita ban)
const NOTIFICAR_CADA = 50;          // Notificar cada N válidos
const ARCHIVO_RESULTADOS = "numeros_validados.csv";
const AUTH_DIR = "./auth_session";   // Carpeta de sesión de WhatsApp
const MAX_ERRORES_SEGUIDOS = 15;     // Pausa de seguridad

// ================================================================
//  IMPORTS
// ================================================================

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion,
} = require("@whiskeysockets/baileys");
const TelegramBot = require("node-telegram-bot-api");
const QRCode = require("qrcode");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

// Logger silencioso para Baileys (muy verboso por defecto)
const logger = pino({ level: "silent" });

// ================================================================
//  ESTADO GLOBAL
// ================================================================

let sock = null;           // Conexión WhatsApp
let isConnected = false;   // ¿WhatsApp conectado?
let qrTimeout = null;      // Timeout para QR expirado

const validation = {
    active: false,
    stopRequested: false,
    target: 0,
    scanned: 0,
    valid: 0,
    errors: 0,
    errorsInRow: 0,
    startTime: null,
    chatId: null,
    lastNotify: 0,
    lastError: "",
};

// Set para no repetir números
const alreadyChecked = new Set();
// Cache de nombres de contactos
const contactNames = new Map();

// ================================================================
//  TELEGRAM BOT
// ================================================================

const bot = new TelegramBot(TELEGRAM_TOKEN, {
    polling: {
        params: { timeout: 30 },
    },
});

function send(chatId, text, opts = {}) {
    return bot.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        ...opts,
    }).catch((e) => console.error("[TG] Error enviando:", e.message));
}

// ================================================================
//  WHATSAPP — CONEXIÓN CON BAILEYS
// ================================================================

async function connectWhatsApp(chatId) {
    // Si ya hay conexión activa, cerrarla primero
    if (sock) {
        try { sock.end(); } catch (_) {}
        sock = null;
        isConnected = false;
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
        version,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, logger),
        },
        logger,
        printQRInTerminal: true,
        generateHighQualityLinkPreview: false,
        browser: ["DIGI Validator", "Chrome", "1.0.0"],
        connectTimeoutMs: 60000,
        qrTimeout: 60000,
    });

    // Guardar credenciales cuando se actualicen
    sock.ev.on("creds.update", saveCreds);

    // Capturar nombres de contactos (push names)
    sock.ev.on("contacts.upsert", (contacts) => {
        for (const c of contacts) {
            const num = c.id?.split("@")[0];
            const name = c.notify || c.verifiedName || c.name;
            if (num && name) contactNames.set(num, name);
        }
    });
    sock.ev.on("contacts.update", (updates) => {
        for (const c of updates) {
            const num = c.id?.split("@")[0];
            const name = c.notify || c.verifiedName || c.name;
            if (num && name) contactNames.set(num, name);
        }
    });

    // Manejar actualizaciones de conexión
    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // ── QR recibido → enviarlo a Telegram ──
        if (qr && chatId) {
            clearTimeout(qrTimeout);
            try {
                const qrBuffer = await QRCode.toBuffer(qr, {
                    scale: 8,
                    margin: 2,
                    color: { dark: "#000000", light: "#FFFFFF" },
                });
                await bot.sendPhoto(chatId, qrBuffer, {
                    caption:
                        "📱 *Escanea este QR con WhatsApp*\n\n" +
                        "1️⃣ Abre WhatsApp en tu móvil\n" +
                        "2️⃣ Ajustes → Dispositivos vinculados\n" +
                        "3️⃣ Vincular dispositivo\n" +
                        "4️⃣ Escanea este código\n\n" +
                        "⏳ _Tienes 60 segundos..._",
                    parse_mode: "Markdown",
                });
            } catch (e) {
                console.error("[QR] Error:", e.message);
                send(chatId, "❌ Error generando QR. Intenta de nuevo con /conectar");
            }

            // Timeout si no escanea
            qrTimeout = setTimeout(() => {
                if (!isConnected) {
                    send(chatId, "⏰ QR expirado. Usa /conectar para generar uno nuevo.");
                }
            }, 65000);
        }

        // ── Conexión establecida ──
        if (connection === "open") {
            clearTimeout(qrTimeout);
            isConnected = true;
            const user = sock.user;
            const phone = user?.id?.split(":")[0] || user?.id?.split("@")[0] || "desconocido";
            console.log(`[WA] ✅ Conectado como +${phone}`);
            if (chatId) {
                send(
                    chatId,
                    `✅ *WhatsApp conectado!*\n\n` +
                    `📱 Número: +${phone}\n` +
                    `🟢 Estado: Activo\n\n` +
                    `Ya puedes usar /validar para empezar 🚀`
                );
            }
        }

        // ── Conexión cerrada ──
        if (connection === "close") {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = DisconnectReason;

            console.log(`[WA] Desconectado. Código: ${statusCode}`);

            if (statusCode === reason.loggedOut) {
                // Sesión cerrada → borrar credenciales
                console.log("[WA] Sesión cerrada. Borrando credenciales...");
                try {
                    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
                } catch (_) {}
                if (chatId) {
                    send(chatId, "🔴 *Sesión de WhatsApp cerrada*\n\nUsa /conectar para vincular de nuevo.");
                }
            } else if (statusCode === reason.restartRequired) {
                // Reinicio necesario → reconectar automáticamente
                console.log("[WA] Reinicio necesario. Reconectando...");
                setTimeout(() => connectWhatsApp(chatId), 2000);
            } else if (statusCode === reason.connectionClosed || statusCode === reason.connectionLost) {
                // Conexión perdida → reconectar
                console.log("[WA] Conexión perdida. Reconectando en 5s...");
                setTimeout(() => connectWhatsApp(chatId), 5000);
            } else if (statusCode === reason.timedOut) {
                console.log("[WA] Timeout. Reconectando en 10s...");
                setTimeout(() => connectWhatsApp(chatId), 10000);
            } else {
                // Otro error → intentar reconectar con backoff
                console.log(`[WA] Error ${statusCode}. Reconectando en 15s...`);
                setTimeout(() => connectWhatsApp(chatId), 15000);
            }

            // Si había validación en curso, pausar
            if (validation.active) {
                validation.lastError = `WhatsApp desconectado (${statusCode})`;
                validation.errorsInRow = MAX_ERRORES_SEGUIDOS; // Forzar pausa
            }
        }
    });

    return sock;
}

// ================================================================
//  VERIFICAR NÚMEROS CON BAILEYS
// ================================================================

async function checkNumbers(numbers) {
    if (!sock || !isConnected) {
        return numbers.map(() => null);
    }

    try {
        // Baileys onWhatsApp acepta múltiples JIDs a la vez
        const jids = numbers.map((n) => n + "@s.whatsapp.net");
        const results = await sock.onWhatsApp(...jids);
        
        // Debug: loguear primeros resultados para diagnóstico
        if (validation.scanned < 40) {
            console.log(`[DEBUG] Enviados: ${numbers.slice(0, 3).join(", ")} | Resultados: ${JSON.stringify(results.slice(0, 3))}`);
        }

        // Crear mapa de resultados
        const resultMap = {};
        for (const r of results) {
            // El JID devuelto puede tener formato diferente
            const num = r.jid.split("@")[0];
            resultMap[num] = r.exists;
        }

        // Devolver en el mismo orden que la entrada
        return numbers.map((n) => {
            // Intentar buscar con y sin código de país
            if (resultMap[n] !== undefined) return resultMap[n];
            // A veces Baileys normaliza el número
            for (const [key, val] of Object.entries(resultMap)) {
                if (key.endsWith(n.slice(-9)) || n.endsWith(key.slice(-9))) {
                    return val;
                }
            }
            return false; // Si no aparece en resultados, no tiene WhatsApp
        });
    } catch (e) {
        console.error("[WA] Error en onWhatsApp:", e.message);
        return numbers.map(() => null);
    }
}

// ================================================================
//  UTILIDADES
// ================================================================

async function getWhatsAppName(number) {
    const jid = number + "@s.whatsapp.net";
    try {
        // 1. Buscar en caché de contactos (push name)
        if (contactNames.has(number)) {
            return contactNames.get(number);
        }
        // 2. Intentar perfil de negocio (business accounts)
        if (sock && isConnected) {
            try {
                const biz = await sock.getBusinessProfile(jid);
                if (biz?.profile?.description || biz?.profile?.wid) {
                    // Es cuenta business
                    const name = biz?.profile?.tag || biz?.profile?.description || null;
                    if (name && name.length > 0 && name.length < 80) return name;
                }
            } catch (_) {
                // No es business o no disponible — no es error
            }
        }
        // 3. Buscar en store de contactos del socket
        if (sock?.store?.contacts?.[jid]) {
            const c = sock.store.contacts[jid];
            const name = c.notify || c.verifiedName || c.name || c.pushName;
            if (name) return name;
        }
    } catch (_) {}
    return null; // No se pudo obtener nombre
}

function generateDigiNumber() {
    const prefix = PREFIJOS_DIGI[Math.floor(Math.random() * PREFIJOS_DIGI.length)];
    const suffix = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
    return prefix + suffix;
}

function loadAlreadyValidated() {
    if (!fs.existsSync(ARCHIVO_RESULTADOS)) return;
    try {
        const content = fs.readFileSync(ARCHIVO_RESULTADOS, "utf-8");
        const lines = content.split("\n").slice(1); // Skip header
        for (const line of lines) {
            const parts = line.split(",");
            if (parts.length >= 2) {
                alreadyChecked.add(parts[1].trim().replace(/"/g, ""));
            }
        }
        console.log(`[CSV] Cargados ${alreadyChecked.size} números previos`);
    } catch (_) {}
}

function saveNumber(number, name = "Sin nombre") {
    // Escapar comillas en el nombre
    const safeName = name.replace(/"/g, '""');
    const exists = fs.existsSync(ARCHIVO_RESULTADOS);
    const line = exists ? `\n"${safeName}","${number}"` : `"Nombre","Telefono"\n"${safeName}","${number}"`;
    fs.appendFileSync(ARCHIVO_RESULTADOS, line, "utf-8");
}

function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ================================================================
//  LOOP DE VALIDACIÓN
// ================================================================

async function validationLoop() {
    const { target, chatId } = validation;
    validation.startTime = Date.now();
    validation.scanned = 0;
    validation.valid = 0;
    validation.errors = 0;
    validation.errorsInRow = 0;
    validation.lastNotify = 0;
    validation.lastError = "";
    validation.stopRequested = false;

    console.log(`[VAL] === INICIO: objetivo=${target} ===`);

    // Cargar números ya validados previamente
    loadAlreadyValidated();

    try {
        while (validation.valid < target) {
            // ── Check: parar? ──
            if (validation.stopRequested) {
                console.log("[VAL] Stop solicitado");
                break;
            }

            // ── Check: WhatsApp conectado? ──
            if (!isConnected) {
                send(chatId,
                    "⚠️ *WhatsApp desconectado*\n\n" +
                    "Esperando reconexión... (30s)\n" +
                    "Si no se reconecta, usa /conectar"
                );
                await sleep(30000);
                if (!isConnected) {
                    send(chatId, "🚫 *WhatsApp no se reconectó.* Validación pausada.\nUsa /conectar y luego /validar");
                    break;
                }
                validation.errorsInRow = 0;
                continue;
            }

            // ── Check: demasiados errores seguidos ──
            if (validation.errorsInRow >= MAX_ERRORES_SEGUIDOS) {
                console.log(`[VAL] ${validation.errorsInRow} errores seguidos. Pausa 30s...`);
                send(chatId,
                    `⚠️ *${validation.errorsInRow} errores seguidos*\n` +
                    `Último: \`${validation.lastError.slice(0, 80)}\`\n` +
                    `Pausando 30s...`
                );
                await sleep(30000);
                validation.errorsInRow = 0;

                if (!isConnected) continue;
            }

            // ── Generar lote de números únicos ──
            const batch = [];
            let attempts = 0;
            while (batch.length < BATCH_SIZE && attempts < BATCH_SIZE * 20) {
                attempts++;
                const num = generateDigiNumber();
                if (!alreadyChecked.has(num)) {
                    batch.push(num);
                    alreadyChecked.add(num);
                }
            }

            if (batch.length === 0) {
                await sleep(1000);
                continue;
            }

            // ── Verificar lote con Baileys ──
            const results = await checkNumbers(batch);

            let batchErrors = 0;
            for (let i = 0; i < batch.length; i++) {
                if (validation.stopRequested) break;

                const number = batch[i];
                const result = results[i];

                if (result === null) {
                    // Error de API
                    validation.errors++;
                    validation.errorsInRow++;
                    batchErrors++;
                    continue;
                }

                // Respuesta válida
                validation.scanned++;
                validation.errorsInRow = 0;

                if (result === true) {
                    validation.valid++;
                    // Intentar obtener nombre real
                    let name = null;
                    try {
                        name = await getWhatsAppName(number);
                    } catch (_) {}
                    saveNumber(number, name || "Sin nombre");
                    console.log(`[VAL] ✅ #${validation.valid}: +${number} (${name || "Sin nombre"})`);
                }
            }

            // ── Notificación periódica ──
            if (validation.valid > 0 && validation.valid - validation.lastNotify >= NOTIFICAR_CADA) {
                const elapsed = Date.now() - validation.startTime;
                const speed = (validation.scanned / (elapsed / 1000)).toFixed(1);
                const rate = ((validation.valid / validation.scanned) * 100).toFixed(1);
                const eta = ((target - validation.valid) / validation.valid) * elapsed;

                send(chatId,
                    `🔔 *Progreso*\n\n` +
                    `✅ Válidos: *${validation.valid.toLocaleString()}* / ${target.toLocaleString()}\n` +
                    `🔍 Escaneados: ${validation.scanned.toLocaleString()}\n` +
                    `❌ Errores: ${validation.errors.toLocaleString()}\n` +
                    `⚡ ${speed} núm/s | Tasa: ${rate}%\n` +
                    `⏱️ ${formatTime(elapsed)} | ETA: ${formatTime(eta)}`
                );
                validation.lastNotify = validation.valid;
            }

            // ── Delay anti-ban ──
            await sleep(DELAY_ENTRE_LOTES_MS);
        }
    } catch (e) {
        console.error("[VAL] Error crítico:", e);
        send(chatId, `💥 *Error crítico*\n\n\`${String(e).slice(0, 300)}\``);
    }

    // ── Resumen final ──
    validation.active = false;
    const elapsed = Date.now() - validation.startTime;
    const stopped = validation.stopRequested;

    let emoji, title;
    if (stopped) {
        emoji = "⛔"; title = "Validación detenida";
    } else if (validation.valid >= target) {
        emoji = "🎉"; title = "¡Validación completada!";
    } else {
        emoji = "⚠️"; title = "Validación interrumpida";
    }

    send(chatId,
        `${emoji} *${title}*\n\n` +
        `📊 *Resumen:*\n` +
        `✅ Válidos: ${validation.valid.toLocaleString()}\n` +
        `🔍 Escaneados: ${validation.scanned.toLocaleString()}\n` +
        `❌ Errores: ${validation.errors.toLocaleString()}\n` +
        `⏱️ Tiempo: ${formatTime(elapsed)}\n\n` +
        `Usa /descargar para obtener el CSV 📥`
    );
    console.log(`[VAL] === FIN: ${validation.valid} válidos de ${validation.scanned} escaneados ===`);
}

// ================================================================
//  COMANDOS TELEGRAM
// ================================================================

bot.onText(/\/start/, (msg) => {
    const status = isConnected ? "🟢 Conectado" : "🔴 Desconectado";
    send(msg.chat.id,
        `🤖 *Bot Validador DIGI v6.0*\n` +
        `_Powered by Baileys — 100% Gratis 🆓_\n\n` +
        `📱 WhatsApp: ${status}\n\n` +
        `*Comandos:*\n` +
        `📱 /conectar — Vincular WhatsApp (QR)\n` +
        `▶️ /validar 1000 — Buscar 1.000 números\n` +
        `📊 /estado — Progreso actual\n` +
        `⛔ /parar — Detener validación\n` +
        `📥 /descargar — Obtener CSV\n` +
        `🔌 /desconectar — Cerrar sesión WhatsApp\n\n` +
        `_Prefijos DIGI: 641 · 642 · 643_`
    );
});

bot.onText(/\/conectar/, async (msg) => {
    const chatId = msg.chat.id;

    if (isConnected) {
        const phone = sock?.user?.id?.split(":")[0] || sock?.user?.id?.split("@")[0] || "?";
        send(chatId,
            `✅ *Ya estás conectado*\n\n` +
            `📱 Número: +${phone}\n` +
            `🟢 Estado: Activo\n\n` +
            `Usa /desconectar primero si quieres cambiar de cuenta.`
        );
        return;
    }

    send(chatId, "📱 *Conectando WhatsApp...*\n\nGenerando QR, espera unos segundos...");

    try {
        await connectWhatsApp(chatId);
    } catch (e) {
        console.error("[WA] Error conectando:", e.message);
        send(chatId, `❌ Error conectando: \`${e.message}\`\n\nIntenta de nuevo con /conectar`);
    }
});

bot.onText(/\/validar(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;

    if (!isConnected) {
        send(chatId, "❌ *WhatsApp no conectado*\n\nUsa /conectar primero para vincular tu WhatsApp.");
        return;
    }

    if (validation.active) {
        send(chatId, "⚠️ Ya hay una validación en curso.\n/estado para ver progreso o /parar para detenerla.");
        return;
    }

    const target = Math.max(1, Math.min(100000, parseInt(match?.[1]) || 1000));

    validation.active = true;
    validation.target = target;
    validation.chatId = chatId;

    send(chatId,
        `🚀 *Validación iniciada*\n\n` +
        `🎯 Objetivo: *${target.toLocaleString()}* válidos\n` +
        `📡 Prefijos: 641, 642, 643\n` +
        `📦 Lote: ${BATCH_SIZE} números/consulta\n` +
        `⏱️ Delay: ${DELAY_ENTRE_LOTES_MS / 1000}s entre lotes\n` +
        `🔔 Aviso cada ${NOTIFICAR_CADA} válidos\n\n` +
        `_Esto es 100% gratis con Baileys 🆓_`
    );

    // Ejecutar en background
    validationLoop().catch((e) => {
        console.error("[VAL] Error no capturado:", e);
        validation.active = false;
    });
});

bot.onText(/\/estado/, (msg) => {
    const chatId = msg.chat.id;

    if (!validation.active && validation.scanned === 0) {
        send(chatId, "💤 Sin validación activa.\nUsa /validar 1000 para empezar.");
        return;
    }

    const elapsed = validation.startTime ? Date.now() - validation.startTime : 0;
    const speed = elapsed > 0 ? (validation.scanned / (elapsed / 1000)).toFixed(1) : "0.0";
    const pct = validation.target > 0 ? (validation.valid / validation.target) * 100 : 0;
    const rate = validation.scanned > 0 ? ((validation.valid / validation.scanned) * 100).toFixed(1) : "0.0";

    let etaStr = "calculando...";
    if (validation.valid > 0 && elapsed > 0) {
        const eta = ((validation.target - validation.valid) / validation.valid) * elapsed;
        etaStr = formatTime(eta);
    }

    const bars = Math.floor(pct / 5);
    const bar = "█".repeat(bars) + "░".repeat(20 - bars);
    const statusStr = validation.active ? "🟢 En curso" : "🔴 Detenido";
    const waStatus = isConnected ? "🟢 Conectado" : "🔴 Desconectado";

    let errLine = "";
    if (validation.errors > 0) {
        errLine = `❌ Errores: ${validation.errors.toLocaleString()}\n`;
        if (validation.lastError) {
            errLine += `📌 Último: \`${validation.lastError.slice(0, 60)}\`\n`;
        }
    }

    send(chatId,
        `📊 *Estado de validación*\n\n` +
        `${statusStr} | WhatsApp: ${waStatus}\n` +
        `\`${bar}\` ${pct.toFixed(1)}%\n\n` +
        `✅ Válidos: *${validation.valid.toLocaleString()}* / ${validation.target.toLocaleString()}\n` +
        `🔍 Escaneados: ${validation.scanned.toLocaleString()}\n` +
        `${errLine}` +
        `⚡ Velocidad: ${speed} núm/s\n` +
        `📈 Tasa: ${rate}%\n` +
        `⏱️ Tiempo: ${formatTime(elapsed)}\n` +
        `🏁 ETA: ${etaStr}`
    );
});

bot.onText(/\/parar/, (msg) => {
    if (!validation.active) {
        send(msg.chat.id, "ℹ️ No hay validación en curso.");
        return;
    }
    validation.stopRequested = true;
    send(msg.chat.id, "⛔ *Deteniendo...*\nRecibirás el resumen en un momento.");
});

bot.onText(/\/descargar/, async (msg) => {
    const chatId = msg.chat.id;

    if (!fs.existsSync(ARCHIVO_RESULTADOS)) {
        send(chatId, "❌ No hay resultados. Usa /validar primero.");
        return;
    }

    try {
        const content = fs.readFileSync(ARCHIVO_RESULTADOS, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim()).length - 1;

        if (lines <= 0) {
            send(chatId, "📭 Archivo vacío todavía.");
            return;
        }

        await bot.sendDocument(chatId, ARCHIVO_RESULTADOS, {
            caption: `📋 *${lines.toLocaleString()} números con WhatsApp* ✅`,
            parse_mode: "Markdown",
        });
    } catch (e) {
        send(chatId, `❌ Error: \`${e.message}\``);
    }
});

bot.onText(/\/desconectar/, async (msg) => {
    const chatId = msg.chat.id;

    if (!sock) {
        send(chatId, "ℹ️ No hay sesión activa.");
        return;
    }

    if (validation.active) {
        send(chatId, "⚠️ Hay una validación en curso. Usa /parar primero.");
        return;
    }

    try {
        await sock.logout();
        send(chatId, "🔴 *Sesión de WhatsApp cerrada*\n\nCredenciales eliminadas. Usa /conectar para vincular otra cuenta.");
    } catch (e) {
        send(chatId, `❌ Error: \`${e.message}\`\n\nIntenta de nuevo.`);
    }
});

// ================================================================
//  MAIN — ARRANQUE
// ================================================================

async function main() {
    console.log("╔══════════════════════════════════════════════╗");
    console.log("║   BOT VALIDADOR DIGI v6.0 — Baileys Edition  ║");
    console.log("║   100% Gratis • Sin límites • Sin GreenAPI   ║");
    console.log("╚══════════════════════════════════════════════╝");
    console.log();
    console.log(`  Prefijos: ${PREFIJOS_DIGI.join(", ")}`);
    console.log(`  Batch: ${BATCH_SIZE} | Delay: ${DELAY_ENTRE_LOTES_MS}ms`);
    console.log();

    // Si ya hay sesión guardada, reconectar automáticamente
    if (fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0) {
        console.log("[WA] Sesión previa encontrada. Reconectando...");
        try {
            await connectWhatsApp(null);
        } catch (e) {
            console.error("[WA] Error reconectando:", e.message);
        }
    } else {
        console.log("[WA] Sin sesión previa. Usa /conectar en Telegram.");
    }

    console.log("[TG] 🟢 Bot activo. Escribe /start en Telegram.\n");
}

// Manejar errores no capturados
process.on("uncaughtException", (e) => {
    console.error("[FATAL] Excepción no capturada:", e);
});
process.on("unhandledRejection", (e) => {
    console.error("[FATAL] Promesa rechazada:", e);
});

main().catch(console.error);
