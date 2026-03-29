#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════╗
// ║     BOT VALIDADOR DIGI v7.0 — Baileys + Botones Interactivos    ║
// ╠══════════════════════════════════════════════════════════════════╣
// ║  🆓 Sin GreenAPI • Sin límites • Sin pagos                       ║
// ║  📱 Baileys (WhatsApp Web directo)                               ║
// ║  🎛️ Menú con botones inline en Telegram                          ║
// ║  👤 Modo Leads Dedicados: solo con nombre real                   ║
// ╚══════════════════════════════════════════════════════════════════╝

"use strict";

// ================================================================
//  CONFIGURACIÓN
// ================================================================

const TELEGRAM_TOKEN = "8710402523:AAHzR-ZQ8XR_qSJSOzJ6VPFIZYD1HnLoJtA";

const PREFIJOS_DIGI = ["34641", "34642", "34643"];
const BATCH_SIZE = 20;
const DELAY_ENTRE_LOTES_MS = 3000;
const NOTIFICAR_CADA = 50;
const ARCHIVO_RESULTADOS = "numeros_validados.csv";
const AUTH_DIR = "./auth_session";
const MAX_ERRORES_SEGUIDOS = 15;

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

const logger = pino({ level: "silent" });

// ================================================================
//  ESTADO GLOBAL
// ================================================================

let sock = null;
let isConnected = false;
let qrTimeout = null;

const validation = {
    active: false,
    stopRequested: false,
    target: 0,
    scanned: 0,
    valid: 0,
    skippedNoName: 0,   // Solo para modo dedicado
    errors: 0,
    errorsInRow: 0,
    startTime: null,
    chatId: null,
    lastNotify: 0,
    lastError: "",
    mode: "leads",       // "leads" o "dedicados"
};

const alreadyChecked = new Set();
const contactNames = new Map();

// ================================================================
//  TELEGRAM BOT
// ================================================================

const bot = new TelegramBot(TELEGRAM_TOKEN, {
    polling: { params: { timeout: 30 } },
});

function send(chatId, text, opts = {}) {
    return bot.sendMessage(chatId, text, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        ...opts,
    }).catch((e) => console.error("[TG] Error enviando:", e.message));
}

// ================================================================
//  BOTONES — MENÚS INLINE
// ================================================================

function mainMenuKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📱 Conectar WhatsApp", callback_data: "cmd_conectar" }],
                [{ text: "🚀 Iniciar Validación", callback_data: "menu_validar" }],
                [
                    { text: "📊 Estado", callback_data: "cmd_estado" },
                    { text: "📥 Descargar CSV", callback_data: "cmd_descargar" },
                ],
                [
                    { text: "🔌 Desconectar", callback_data: "cmd_desconectar" },
                ],
            ],
        },
    };
}

function cantidadKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "2.000", callback_data: "cant_2000" },
                    { text: "4.000", callback_data: "cant_4000" },
                ],
                [
                    { text: "6.000", callback_data: "cant_6000" },
                    { text: "8.000", callback_data: "cant_8000" },
                ],
                [
                    { text: "🔟 10.000", callback_data: "cant_10000" },
                ],
                [
                    { text: "✏️ Cantidad personalizada", callback_data: "cant_custom" },
                ],
                [
                    { text: "🔙 Menú principal", callback_data: "menu_main" },
                ],
            ],
        },
    };
}

function modeKeyboard(cantidad) {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: "👥 Leads (todos los válidos)", callback_data: `mode_leads_${cantidad}` }],
                [{ text: "⭐ Leads Dedicados (solo con nombre)", callback_data: `mode_dedicados_${cantidad}` }],
                [{ text: "🔙 Cambiar cantidad", callback_data: "menu_validar" }],
            ],
        },
    };
}

function validatingKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: "📊 Ver estado", callback_data: "cmd_estado" },
                    { text: "⛔ PARAR", callback_data: "cmd_parar" },
                ],
            ],
        },
    };
}

function postValidationKeyboard() {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📥 Descargar CSV", callback_data: "cmd_descargar" }],
                [{ text: "🚀 Nueva validación", callback_data: "menu_validar" }],
                [{ text: "🏠 Menú principal", callback_data: "menu_main" }],
            ],
        },
    };
}

// ================================================================
//  WHATSAPP — CONEXIÓN CON BAILEYS
// ================================================================

async function connectWhatsApp(chatId) {
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

    sock.ev.on("creds.update", saveCreds);

    // Capturar nombres de contactos
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

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && chatId) {
            clearTimeout(qrTimeout);
            try {
                const qrBuffer = await QRCode.toBuffer(qr, {
                    scale: 8, margin: 2,
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

            qrTimeout = setTimeout(() => {
                if (!isConnected) {
                    send(chatId, "⏰ QR expirado. Usa /conectar para generar uno nuevo.");
                }
            }, 65000);
        }

        if (connection === "open") {
            clearTimeout(qrTimeout);
            isConnected = true;
            const user = sock.user;
            const phone = user?.id?.split(":")[0] || user?.id?.split("@")[0] || "desconocido";
            console.log(`[WA] ✅ Conectado como +${phone}`);
            if (chatId) {
                send(chatId,
                    `✅ *WhatsApp conectado!*\n\n` +
                    `📱 Número: +${phone}\n` +
                    `🟢 Estado: Activo\n\n` +
                    `Ya puedes iniciar la validación 🚀`,
                    mainMenuKeyboard()
                );
            }
        }

        if (connection === "close") {
            isConnected = false;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const reason = DisconnectReason;
            console.log(`[WA] Desconectado. Código: ${statusCode}`);

            if (statusCode === reason.loggedOut) {
                console.log("[WA] Sesión cerrada. Borrando credenciales...");
                try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
                if (chatId) send(chatId, "🔴 *Sesión de WhatsApp cerrada*\n\nUsa /conectar para vincular de nuevo.");
            } else if (statusCode === reason.restartRequired) {
                setTimeout(() => connectWhatsApp(chatId), 2000);
            } else if (statusCode === reason.connectionClosed || statusCode === reason.connectionLost) {
                setTimeout(() => connectWhatsApp(chatId), 5000);
            } else if (statusCode === reason.timedOut) {
                setTimeout(() => connectWhatsApp(chatId), 10000);
            } else {
                setTimeout(() => connectWhatsApp(chatId), 15000);
            }

            if (validation.active) {
                validation.lastError = `WhatsApp desconectado (${statusCode})`;
                validation.errorsInRow = MAX_ERRORES_SEGUIDOS;
            }
        }
    });

    return sock;
}

// ================================================================
//  VERIFICAR NÚMEROS CON BAILEYS
// ================================================================

async function checkNumbers(numbers) {
    if (!sock || !isConnected) return numbers.map(() => null);

    try {
        const jids = numbers.map((n) => n + "@s.whatsapp.net");
        const results = await sock.onWhatsApp(...jids);

        if (validation.scanned < 40) {
            console.log(`[DEBUG] Enviados: ${numbers.slice(0, 3).join(", ")} | Resultados: ${JSON.stringify(results.slice(0, 3))}`);
        }

        const resultMap = {};
        for (const r of results) {
            const num = r.jid.split("@")[0];
            resultMap[num] = r.exists;
        }

        return numbers.map((n) => {
            if (resultMap[n] !== undefined) return resultMap[n];
            for (const [key, val] of Object.entries(resultMap)) {
                if (key.endsWith(n.slice(-9)) || n.endsWith(key.slice(-9))) return val;
            }
            return false;
        });
    } catch (e) {
        console.error("[WA] Error en onWhatsApp:", e.message);
        return numbers.map(() => null);
    }
}

// ================================================================
//  OBTENER NOMBRE DE WHATSAPP
// ================================================================

async function getWhatsAppName(number) {
    const jid = number + "@s.whatsapp.net";
    try {
        // 1. Cache de contactos (push name)
        if (contactNames.has(number)) return contactNames.get(number);

        // 2. Perfil de negocio
        if (sock && isConnected) {
            try {
                const biz = await sock.getBusinessProfile(jid);
                if (biz?.profile?.description || biz?.profile?.wid) {
                    const name = biz?.profile?.tag || biz?.profile?.description || null;
                    if (name && name.length > 0 && name.length < 80) return name;
                }
            } catch (_) {}
        }

        // 3. Store de contactos
        if (sock?.store?.contacts?.[jid]) {
            const c = sock.store.contacts[jid];
            const name = c.notify || c.verifiedName || c.name || c.pushName;
            if (name) return name;
        }
    } catch (_) {}
    return null;
}

// ================================================================
//  UTILIDADES
// ================================================================

function generateDigiNumber() {
    const prefix = PREFIJOS_DIGI[Math.floor(Math.random() * PREFIJOS_DIGI.length)];
    const suffix = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
    return prefix + suffix;
}

function loadAlreadyValidated() {
    if (!fs.existsSync(ARCHIVO_RESULTADOS)) return;
    try {
        const content = fs.readFileSync(ARCHIVO_RESULTADOS, "utf-8");
        const lines = content.split("\n").slice(1);
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
    const { target, chatId, mode } = validation;
    validation.startTime = Date.now();
    validation.scanned = 0;
    validation.valid = 0;
    validation.skippedNoName = 0;
    validation.errors = 0;
    validation.errorsInRow = 0;
    validation.lastNotify = 0;
    validation.lastError = "";
    validation.stopRequested = false;

    const modeLabel = mode === "dedicados" ? "⭐ LEADS DEDICADOS (solo con nombre)" : "👥 LEADS (todos)";
    console.log(`[VAL] === INICIO: objetivo=${target} | modo=${mode} ===`);

    loadAlreadyValidated();

    try {
        while (validation.valid < target) {
            if (validation.stopRequested) {
                console.log("[VAL] Stop solicitado");
                break;
            }

            if (!isConnected) {
                send(chatId,
                    "⚠️ *WhatsApp desconectado*\n\n" +
                    "Esperando reconexión... (30s)\n" +
                    "Si no se reconecta, usa /conectar"
                );
                await sleep(30000);
                if (!isConnected) {
                    send(chatId, "🚫 *WhatsApp no se reconectó.* Validación pausada.\nUsa /conectar y luego inicia de nuevo.");
                    break;
                }
                validation.errorsInRow = 0;
                continue;
            }

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

            // Generar lote
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

            if (batch.length === 0) { await sleep(1000); continue; }

            // Verificar lote
            const results = await checkNumbers(batch);

            for (let i = 0; i < batch.length; i++) {
                if (validation.stopRequested) break;
                if (validation.valid >= target) break;

                const number = batch[i];
                const result = results[i];

                if (result === null) {
                    validation.errors++;
                    validation.errorsInRow++;
                    continue;
                }

                validation.scanned++;
                validation.errorsInRow = 0;

                if (result === true) {
                    // Obtener nombre
                    let name = null;
                    try { name = await getWhatsAppName(number); } catch (_) {}

                    if (mode === "dedicados") {
                        // MODO DEDICADOS: solo guardar si tiene nombre
                        if (name && name !== "Sin nombre") {
                            validation.valid++;
                            saveNumber(number, name);
                            console.log(`[VAL] ⭐ #${validation.valid}: +${number} → ${name}`);
                        } else {
                            validation.skippedNoName++;
                            console.log(`[VAL] ⏭️ +${number} válido pero sin nombre → descartado`);
                        }
                    } else {
                        // MODO LEADS: guardar todos
                        validation.valid++;
                        saveNumber(number, name || "Sin nombre");
                        console.log(`[VAL] ✅ #${validation.valid}: +${number} (${name || "Sin nombre"})`);
                    }
                }
            }

            // Notificación periódica
            if (validation.valid > 0 && validation.valid - validation.lastNotify >= NOTIFICAR_CADA) {
                const elapsed = Date.now() - validation.startTime;
                const speed = (validation.scanned / (elapsed / 1000)).toFixed(1);
                const rate = ((validation.valid / validation.scanned) * 100).toFixed(1);
                const eta = ((target - validation.valid) / validation.valid) * elapsed;

                let extraInfo = "";
                if (mode === "dedicados" && validation.skippedNoName > 0) {
                    extraInfo = `⏭️ Descartados (sin nombre): ${validation.skippedNoName.toLocaleString()}\n`;
                }

                send(chatId,
                    `🔔 *Progreso*\n\n` +
                    `✅ Válidos: *${validation.valid.toLocaleString()}* / ${target.toLocaleString()}\n` +
                    `🔍 Escaneados: ${validation.scanned.toLocaleString()}\n` +
                    `${extraInfo}` +
                    `❌ Errores: ${validation.errors.toLocaleString()}\n` +
                    `⚡ ${speed} núm/s | Tasa: ${rate}%\n` +
                    `⏱️ ${formatTime(elapsed)} | ETA: ${formatTime(eta)}`,
                    validatingKeyboard()
                );
                validation.lastNotify = validation.valid;
            }

            await sleep(DELAY_ENTRE_LOTES_MS);
        }
    } catch (e) {
        console.error("[VAL] Error crítico:", e);
        send(chatId, `💥 *Error crítico*\n\n\`${String(e).slice(0, 300)}\``);
    }

    // Resumen final
    validation.active = false;
    const elapsed = Date.now() - validation.startTime;
    const stopped = validation.stopRequested;

    let emoji, title;
    if (stopped) { emoji = "⛔"; title = "Validación detenida"; }
    else if (validation.valid >= target) { emoji = "🎉"; title = "¡Validación completada!"; }
    else { emoji = "⚠️"; title = "Validación interrumpida"; }

    const modeStr = mode === "dedicados" ? "⭐ Leads Dedicados" : "👥 Leads";
    let extraFinal = "";
    if (mode === "dedicados") {
        extraFinal = `⏭️ Descartados (sin nombre): ${validation.skippedNoName.toLocaleString()}\n`;
    }

    send(chatId,
        `${emoji} *${title}*\n\n` +
        `🏷️ Modo: ${modeStr}\n` +
        `📊 *Resumen:*\n` +
        `✅ Válidos guardados: ${validation.valid.toLocaleString()}\n` +
        `🔍 Escaneados: ${validation.scanned.toLocaleString()}\n` +
        `${extraFinal}` +
        `❌ Errores: ${validation.errors.toLocaleString()}\n` +
        `⏱️ Tiempo: ${formatTime(elapsed)}`,
        postValidationKeyboard()
    );
    console.log(`[VAL] === FIN: ${validation.valid} válidos de ${validation.scanned} escaneados ===`);
}

// ================================================================
//  INICIAR VALIDACIÓN
// ================================================================

function startValidation(chatId, target, mode) {
    if (!isConnected) {
        send(chatId, "❌ *WhatsApp no conectado*\n\nUsa /conectar primero.", mainMenuKeyboard());
        return;
    }
    if (validation.active) {
        send(chatId, "⚠️ Ya hay una validación en curso.", validatingKeyboard());
        return;
    }

    validation.active = true;
    validation.target = target;
    validation.chatId = chatId;
    validation.mode = mode;

    const modeLabel = mode === "dedicados"
        ? "⭐ *LEADS DEDICADOS*\n_Solo números con nombre real_"
        : "👥 *LEADS*\n_Todos los números válidos_";

    send(chatId,
        `🚀 *Validación iniciada*\n\n` +
        `${modeLabel}\n\n` +
        `🎯 Objetivo: *${target.toLocaleString()}* válidos\n` +
        `📡 Prefijos: 641, 642, 643\n` +
        `📦 Lote: ${BATCH_SIZE} números/consulta\n` +
        `🔔 Aviso cada ${NOTIFICAR_CADA} válidos\n\n` +
        `_100% gratis con Baileys 🆓_`,
        validatingKeyboard()
    );

    validationLoop().catch((e) => {
        console.error("[VAL] Error no capturado:", e);
        validation.active = false;
    });
}

// ================================================================
//  ESTADO PARA CALLBACKS
// ================================================================

// Para cantidad personalizada: guardar el chatId que espera un número
const waitingCustomAmount = new Set();

// ================================================================
//  CALLBACK QUERIES (BOTONES)
// ================================================================

bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    // Responder al callback para quitar el "loading" del botón
    bot.answerCallbackQuery(query.id).catch(() => {});

    // ── MENÚ PRINCIPAL ──
    if (data === "menu_main") {
        const status = isConnected ? "🟢 Conectado" : "🔴 Desconectado";
        send(chatId,
            `🤖 *Bot Validador DIGI v7.0*\n` +
            `_Powered by Baileys — 100% Gratis 🆓_\n\n` +
            `📱 WhatsApp: ${status}\n` +
            `_Prefijos DIGI: 641 · 642 · 643_`,
            mainMenuKeyboard()
        );
        return;
    }

    // ── CONECTAR ──
    if (data === "cmd_conectar") {
        if (isConnected) {
            const phone = sock?.user?.id?.split(":")[0] || sock?.user?.id?.split("@")[0] || "?";
            send(chatId,
                `✅ *Ya estás conectado*\n\n📱 Número: +${phone}\n🟢 Estado: Activo\n\n` +
                `Usa 🔌 Desconectar si quieres cambiar de cuenta.`,
                mainMenuKeyboard()
            );
            return;
        }
        send(chatId, "📱 *Conectando WhatsApp...*\n\nGenerando QR, espera unos segundos...");
        try {
            await connectWhatsApp(chatId);
        } catch (e) {
            send(chatId, `❌ Error conectando: \`${e.message}\`\n\nIntenta de nuevo.`, mainMenuKeyboard());
        }
        return;
    }

    // ── MENÚ SELECCIONAR CANTIDAD ──
    if (data === "menu_validar") {
        if (!isConnected) {
            send(chatId, "❌ *WhatsApp no conectado*\n\nConecta primero:", mainMenuKeyboard());
            return;
        }
        if (validation.active) {
            send(chatId, "⚠️ Ya hay una validación en curso.", validatingKeyboard());
            return;
        }
        send(chatId,
            "🎯 *¿Cuántos números válidos quieres encontrar?*\n\n" +
            "Elige una cantidad o escribe una personalizada:",
            cantidadKeyboard()
        );
        return;
    }

    // ── CANTIDAD FIJA ──
    if (data.startsWith("cant_") && data !== "cant_custom") {
        const cantidad = parseInt(data.replace("cant_", ""));
        send(chatId,
            `📋 *${cantidad.toLocaleString()} números* — Elige el modo:\n\n` +
            `👥 *Leads*: Guarda todos los válidos (con o sin nombre)\n\n` +
            `⭐ *Leads Dedicados*: Solo guarda los que tienen nombre real en WhatsApp. Si no tiene nombre → se descarta.`,
            modeKeyboard(cantidad)
        );
        return;
    }

    // ── CANTIDAD PERSONALIZADA ──
    if (data === "cant_custom") {
        waitingCustomAmount.add(chatId);
        send(chatId,
            "✏️ *Escribe la cantidad de números* que quieres encontrar:\n\n" +
            "_Ejemplo: 500, 3000, 15000..._\n" +
            "_Mínimo: 1 | Máximo: 100.000_"
        );
        return;
    }

    // ── MODO SELECCIONADO → INICIAR ──
    if (data.startsWith("mode_leads_") || data.startsWith("mode_dedicados_")) {
        const parts = data.split("_");
        const mode = parts[1]; // "leads" o "dedicados"
        const cantidad = parseInt(parts[2]);
        startValidation(chatId, cantidad, mode);
        return;
    }

    // ── ESTADO ──
    if (data === "cmd_estado") {
        sendEstado(chatId);
        return;
    }

    // ── PARAR ──
    if (data === "cmd_parar") {
        if (!validation.active) {
            send(chatId, "ℹ️ No hay validación en curso.", mainMenuKeyboard());
            return;
        }
        validation.stopRequested = true;
        send(chatId, "⛔ *Deteniendo...*\nRecibirás el resumen en un momento.");
        return;
    }

    // ── DESCARGAR ──
    if (data === "cmd_descargar") {
        sendDescargar(chatId);
        return;
    }

    // ── DESCONECTAR ──
    if (data === "cmd_desconectar") {
        if (!sock) {
            send(chatId, "ℹ️ No hay sesión activa.", mainMenuKeyboard());
            return;
        }
        if (validation.active) {
            send(chatId, "⚠️ Hay una validación en curso. Párala primero.", validatingKeyboard());
            return;
        }
        try {
            await sock.logout();
            send(chatId, "🔴 *Sesión de WhatsApp cerrada*\n\nCredenciales eliminadas.", mainMenuKeyboard());
        } catch (e) {
            send(chatId, `❌ Error: \`${e.message}\``, mainMenuKeyboard());
        }
        return;
    }
});

// ================================================================
//  FUNCIONES COMPARTIDAS (botones + comandos texto)
// ================================================================

function sendEstado(chatId) {
    if (!validation.active && validation.scanned === 0) {
        send(chatId, "💤 Sin validación activa.", mainMenuKeyboard());
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
    const modeStr = validation.mode === "dedicados" ? "⭐ Dedicados" : "👥 Leads";

    let errLine = "";
    if (validation.errors > 0) {
        errLine = `❌ Errores: ${validation.errors.toLocaleString()}\n`;
        if (validation.lastError) errLine += `📌 Último: \`${validation.lastError.slice(0, 60)}\`\n`;
    }

    let skipLine = "";
    if (validation.mode === "dedicados" && validation.skippedNoName > 0) {
        skipLine = `⏭️ Descartados (sin nombre): ${validation.skippedNoName.toLocaleString()}\n`;
    }

    const kb = validation.active ? validatingKeyboard() : postValidationKeyboard();

    send(chatId,
        `📊 *Estado de validación*\n\n` +
        `${statusStr} | WhatsApp: ${waStatus}\n` +
        `🏷️ Modo: ${modeStr}\n` +
        `\`${bar}\` ${pct.toFixed(1)}%\n\n` +
        `✅ Válidos: *${validation.valid.toLocaleString()}* / ${validation.target.toLocaleString()}\n` +
        `🔍 Escaneados: ${validation.scanned.toLocaleString()}\n` +
        `${skipLine}` +
        `${errLine}` +
        `⚡ Velocidad: ${speed} núm/s\n` +
        `📈 Tasa: ${rate}%\n` +
        `⏱️ Tiempo: ${formatTime(elapsed)}\n` +
        `🏁 ETA: ${etaStr}`,
        kb
    );
}

async function sendDescargar(chatId) {
    if (!fs.existsSync(ARCHIVO_RESULTADOS)) {
        send(chatId, "❌ No hay resultados. Inicia una validación primero.", mainMenuKeyboard());
        return;
    }
    try {
        const content = fs.readFileSync(ARCHIVO_RESULTADOS, "utf-8");
        const lines = content.split("\n").filter((l) => l.trim()).length - 1;
        if (lines <= 0) {
            send(chatId, "📭 Archivo vacío todavía.", mainMenuKeyboard());
            return;
        }
        await bot.sendDocument(chatId, ARCHIVO_RESULTADOS, {
            caption: `📋 *${lines.toLocaleString()} números con WhatsApp* ✅`,
            parse_mode: "Markdown",
        });
    } catch (e) {
        send(chatId, `❌ Error: \`${e.message}\``, mainMenuKeyboard());
    }
}

// ================================================================
//  COMANDOS TEXTO (mantener compatibilidad)
// ================================================================

bot.onText(/\/start/, (msg) => {
    const status = isConnected ? "🟢 Conectado" : "🔴 Desconectado";
    send(msg.chat.id,
        `🤖 *Bot Validador DIGI v7.0*\n` +
        `_Powered by Baileys — 100% Gratis 🆓_\n\n` +
        `📱 WhatsApp: ${status}\n` +
        `_Prefijos DIGI: 641 · 642 · 643_\n\n` +
        `Usa los botones o escribe comandos:`,
        mainMenuKeyboard()
    );
});

bot.onText(/\/conectar/, async (msg) => {
    const chatId = msg.chat.id;
    if (isConnected) {
        const phone = sock?.user?.id?.split(":")[0] || sock?.user?.id?.split("@")[0] || "?";
        send(chatId, `✅ *Ya estás conectado*\n📱 +${phone}`, mainMenuKeyboard());
        return;
    }
    send(chatId, "📱 *Conectando WhatsApp...*\nGenerando QR...");
    try { await connectWhatsApp(chatId); } catch (e) {
        send(chatId, `❌ Error: \`${e.message}\``, mainMenuKeyboard());
    }
});

bot.onText(/\/validar(?:\s+(\d+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    if (!isConnected) {
        send(chatId, "❌ *WhatsApp no conectado*\nUsa /conectar primero.", mainMenuKeyboard());
        return;
    }
    if (validation.active) {
        send(chatId, "⚠️ Ya hay validación en curso.", validatingKeyboard());
        return;
    }
    const target = match?.[1] ? Math.max(1, Math.min(100000, parseInt(match[1]))) : null;
    if (target) {
        // Si dan número directo, preguntar modo
        send(chatId,
            `📋 *${target.toLocaleString()} números* — Elige el modo:`,
            modeKeyboard(target)
        );
    } else {
        // Sin número: mostrar menú de cantidad
        send(chatId, "🎯 *¿Cuántos números válidos quieres?*", cantidadKeyboard());
    }
});

bot.onText(/\/estado/, (msg) => sendEstado(msg.chat.id));

bot.onText(/\/parar/, (msg) => {
    if (!validation.active) {
        send(msg.chat.id, "ℹ️ No hay validación en curso.", mainMenuKeyboard());
        return;
    }
    validation.stopRequested = true;
    send(msg.chat.id, "⛔ *Deteniendo...*\nRecibirás el resumen en un momento.");
});

bot.onText(/\/descargar/, (msg) => sendDescargar(msg.chat.id));

bot.onText(/\/desconectar/, async (msg) => {
    const chatId = msg.chat.id;
    if (!sock) { send(chatId, "ℹ️ No hay sesión activa.", mainMenuKeyboard()); return; }
    if (validation.active) { send(chatId, "⚠️ Para primero la validación.", validatingKeyboard()); return; }
    try {
        await sock.logout();
        send(chatId, "🔴 *Sesión cerrada*", mainMenuKeyboard());
    } catch (e) { send(chatId, `❌ Error: \`${e.message}\``, mainMenuKeyboard()); }
});

// ── CAPTURAR MENSAJES DE TEXTO para cantidad personalizada ──
bot.on("message", (msg) => {
    const chatId = msg.chat.id;
    if (!waitingCustomAmount.has(chatId)) return;
    if (msg.text?.startsWith("/")) return; // Ignorar comandos

    const num = parseInt(msg.text);
    if (isNaN(num) || num < 1) {
        send(chatId, "❌ Escribe un número válido. Ejemplo: `5000`");
        return;
    }

    const cantidad = Math.min(100000, num);
    waitingCustomAmount.delete(chatId);

    send(chatId,
        `📋 *${cantidad.toLocaleString()} números* — Elige el modo:`,
        modeKeyboard(cantidad)
    );
});

// ================================================================
//  MAIN
// ================================================================

async function main() {
    console.log("╔══════════════════════════════════════════════╗");
    console.log("║   BOT VALIDADOR DIGI v7.0 — Botones + Modes  ║");
    console.log("║   100% Gratis • Sin límites • Sin GreenAPI    ║");
    console.log("╚══════════════════════════════════════════════╝");
    console.log();
    console.log(`  Prefijos: ${PREFIJOS_DIGI.join(", ")}`);
    console.log(`  Batch: ${BATCH_SIZE} | Delay: ${DELAY_ENTRE_LOTES_MS}ms`);
    console.log(`  Modos: Leads (todos) | Dedicados (solo con nombre)`);
    console.log();

    if (fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0) {
        console.log("[WA] Sesión previa encontrada. Reconectando...");
        try { await connectWhatsApp(null); } catch (e) {
            console.error("[WA] Error reconectando:", e.message);
        }
    } else {
        console.log("[WA] Sin sesión previa. Usa /start en Telegram.");
    }

    console.log("[TG] 🟢 Bot activo. Escribe /start en Telegram.\n");
}

process.on("uncaughtException", (e) => console.error("[FATAL] Excepción:", e));
process.on("unhandledRejection", (e) => console.error("[FATAL] Promesa rechazada:", e));

main().catch(console.error);
