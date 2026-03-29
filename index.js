#!/usr/bin/env node
// ╔══════════════════════════════════════════════════════════════════╗
// ║     BOT VALIDADOR DIGI v9.0 — Baileys + Botones + Filtro       ║
// ╠══════════════════════════════════════════════════════════════════╣
// ║  🆓 Sin GreenAPI • Sin límites • Sin pagos                       ║
// ║  📱 Baileys (WhatsApp Web directo)                               ║
// ║  🎛️ Menú con botones inline en Telegram                          ║
// ║  👤 Modo Leads Dedicados: solo con nombre real                   ║
// ║  🎯 Filtro: Solo DIGI o Todos los prefijos                       ║
// ║  🛡️ Sin bucles de QR • Sin reconexiones infinitas                ║
// ╚══════════════════════════════════════════════════════════════════╝

"use strict";

// ================================================================
//  CONFIGURACIÓN
// ================================================================

const TELEGRAM_TOKEN = "8710402523:AAHzR-ZQ8XR_qSJSOzJ6VPFIZYD1HnLoJtA";

const PREFIJOS_DIGI = ["34641", "34642", "34643", "34644", "34645"];
const PREFIJOS_TODOS = [
    "34610", "34611", "34612", "34613", "34614", "34615", "34616", "34617", "34618", "34619",
    "34620", "34621", "34622", "34623", "34624", "34625", "34626", "34627", "34628", "34629",
    "34630", "34631", "34632", "34633", "34634", "34635", "34636", "34637", "34638", "34639",
    "34640", "34641", "34642", "34643", "34644", "34645", "34646", "34647", "34648", "34649",
    "34650", "34651", "34652", "34653", "34654", "34655", "34656", "34657", "34658", "34659",
    "34660", "34661", "34662", "34663", "34664", "34665", "34666", "34667", "34668", "34669",
    "34670", "34671", "34672", "34673", "34674", "34675", "34676", "34677", "34678", "34679",
    "34680", "34681", "34682", "34683", "34684", "34685", "34686", "34687", "34688", "34689",
    "34690", "34691", "34692", "34693", "34694", "34695", "34696", "34697", "34698", "34699",
    "34711", "34712", "34713", "34714", "34715", "34716", "34717", "34718", "34719",
    "34720", "34721", "34722", "34723", "34724", "34725", "34726", "34727", "34728", "34729",
    "34740", "34741", "34742", "34743", "34744", "34745", "34746", "34747", "34748", "34749",
];
const BATCH_SIZE = 20;
const DELAY_ENTRE_LOTES_MS = 3000;
const NOTIFICAR_CADA = 50;
const ARCHIVO_RESULTADOS = "numeros_validados.csv";
const AUTH_DIR = "./auth_session";
const MAX_ERRORES_SEGUIDOS = 15;

// ── LÍMITES ANTI-BUCLE ──
const MAX_QR_INTENTOS = 3;            // Máximo QR sin escanear antes de parar
const QR_EXPIRY_MS = 60000;           // Tiempo máximo esperando QR (60s)
const MAX_RECONNECT_INTENTOS = 5;     // Máx reconexiones automáticas seguidas
const RECONNECT_DELAY_MS = 5000;      // Delay base entre reconexiones
const RECONNECT_BACKOFF_MULT = 1.5;   // Multiplicador de backoff

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
let isConnecting = false;          // 🛡️ NUEVO: evita múltiples conexiones simultáneas
let qrTimeout = null;
let qrCount = 0;                   // 🛡️ NUEVO: contador de QR generados sin escanear
let reconnectCount = 0;            // 🛡️ NUEVO: contador de reconexiones seguidas
let reconnectTimer = null;         // 🛡️ NUEVO: timer de reconexión (para poder cancelar)
let connectionChatId = null;       // 🛡️ NUEVO: chatId asociado a la conexión actual

const validation = {
    active: false,
    stopRequested: false,
    target: 0,
    scanned: 0,
    valid: 0,
    skippedNoName: 0,
    errors: 0,
    errorsInRow: 0,
    startTime: null,
    chatId: null,
    lastNotify: 0,
    lastError: "",
    mode: "leads",       // "leads" o "dedicados"
    filter: "digi",      // "digi" o "todos"
};

const alreadyChecked = new Set();
const contactNames = new Map();

// ================================================================
//  TELEGRAM BOT (con manejo de errores de polling)
// ================================================================

const bot = new TelegramBot(TELEGRAM_TOKEN, {
    polling: {
        autoStart: true,
        params: { timeout: 30 },
    },
});

// 🛡️ NUEVO: Manejar errores de polling para que no crashee
bot.on("polling_error", (err) => {
    // Solo loguear si no es un timeout normal
    if (err.code !== "ETELEGRAM" || !err.message?.includes("409")) {
        console.error("[TG] Error de polling:", err.code || err.message);
    }
});

bot.on("error", (err) => {
    console.error("[TG] Error general:", err.message);
});

function send(chatId, text, extra = {}) {
    if (!chatId) return;
    return bot.sendMessage(chatId, text, { parse_mode: "Markdown", ...extra }).catch((e) => {
        console.error("[TG] Error enviando:", e.message);
    });
}

// ================================================================
//  TECLADOS (BOTONES INLINE)
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
                [{ text: "🔌 Desconectar", callback_data: "cmd_desconectar" }],
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
                [{ text: "🔟 10.000", callback_data: "cant_10000" }],
                [{ text: "✏️ Cantidad personalizada", callback_data: "cant_custom" }],
                [{ text: "🔙 Menú principal", callback_data: "menu_main" }],
            ],
        },
    };
}

function modeKeyboard(cantidad) {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: "👥 Leads", callback_data: `mode_leads_${cantidad}` }],
                [{ text: "⭐ Leads Dedicados", callback_data: `mode_dedicados_${cantidad}` }],
                [{ text: "🔙 Cambiar cantidad", callback_data: "menu_validar" }],
            ],
        },
    };
}

function filterKeyboard(cantidad, mode) {
    return {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🎯 Solo prefijos DIGI", callback_data: `filter_digi_${mode}_${cantidad}` }],
                [{ text: "🌐 Todos los prefijos", callback_data: `filter_todos_${mode}_${cantidad}` }],
                [{ text: "🔙 Cambiar modo", callback_data: `cant_${cantidad}` }],
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
                [
                    { text: "📥 Descargar CSV", callback_data: "cmd_descargar" },
                    { text: "🚀 Nueva validación", callback_data: "menu_validar" },
                ],
                [{ text: "🏠 Menú principal", callback_data: "menu_main" }],
            ],
        },
    };
}

// ================================================================
//  UTILIDADES
// ================================================================

function generateNumber(filter) {
    const prefixes = filter === "digi" ? PREFIJOS_DIGI : PREFIJOS_TODOS;
    const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
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
    try {
        const safeName = name.replace(/"/g, '""');
        const exists = fs.existsSync(ARCHIVO_RESULTADOS);
        const line = exists
            ? `\n"${safeName}","${number}"`
            : `"Nombre","Telefono"\n"${safeName}","${number}"`;
        fs.appendFileSync(ARCHIVO_RESULTADOS, line, "utf-8");
    } catch (e) {
        console.error("[CSV] Error guardando número:", e.message);
    }
}

function formatTime(ms) {
    if (!ms || ms < 0 || !isFinite(ms)) return "—";
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

function withTimeout(promise, ms, fallback = null) {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve) => {
            timer = setTimeout(() => resolve(fallback), ms);
        }),
    ]).finally(() => clearTimeout(timer));
}

// ================================================================
//  WHATSAPP — LIMPIEZA DE SOCKET
// ================================================================

// 🛡️ NUEVO: Función para cerrar y limpiar el socket anterior
function destroySocket() {
    clearTimeout(qrTimeout);
    qrTimeout = null;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;

    if (sock) {
        try {
            sock.ev.removeAllListeners();
            sock.end(undefined);
        } catch (_) {}
        sock = null;
    }
    isConnected = false;
    isConnecting = false;
}

// ================================================================
//  WHATSAPP — CONEXIÓN (SIN BUCLES)
// ================================================================

async function connectWhatsApp(chatId) {
    // 🛡️ GUARDIA: evitar conexiones simultáneas
    if (isConnecting) {
        console.log("[WA] Ya hay una conexión en progreso, ignorando...");
        if (chatId) send(chatId, "⏳ *Ya se está conectando...*\nEspera un momento.");
        return;
    }
    if (isConnected && sock) {
        console.log("[WA] Ya está conectado, ignorando...");
        return;
    }

    // Limpiar cualquier socket previo
    destroySocket();

    isConnecting = true;
    qrCount = 0;
    connectionChatId = chatId;

    let state, saveCreds;
    try {
        ({ state, saveCreds } = await useMultiFileAuthState(AUTH_DIR));
    } catch (e) {
        console.error("[WA] Error cargando estado de auth:", e.message);
        isConnecting = false;
        if (chatId) send(chatId, "❌ Error cargando sesión. Intenta de nuevo.", mainMenuKeyboard());
        return;
    }

    let version;
    try {
        ({ version } = await fetchLatestBaileysVersion());
    } catch (e) {
        console.error("[WA] Error obteniendo versión de Baileys:", e.message);
        isConnecting = false;
        if (chatId) send(chatId, "❌ Error conectando con WhatsApp. Intenta de nuevo.", mainMenuKeyboard());
        return;
    }

    try {
        sock = makeWASocket({
            version,
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(state.keys, logger),
            },
            logger,
            printQRInTerminal: false,
            browser: ["DIGI Validator", "Chrome", "1.0"],
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 30000,
            keepAliveIntervalMs: 15000,
            emitOwnEvents: false,
            generateHighQualityLinkPreview: false,
        });
    } catch (e) {
        console.error("[WA] Error creando socket:", e.message);
        isConnecting = false;
        if (chatId) send(chatId, "❌ Error creando conexión. Intenta de nuevo.", mainMenuKeyboard());
        return;
    }

    // Cache de contactos
    sock.ev.on("contacts.upsert", (contacts) => {
        for (const c of contacts) {
            const name = c.notify || c.verifiedName || c.name;
            if (name) contactNames.set(c.id, name);
        }
    });
    sock.ev.on("contacts.update", (updates) => {
        for (const u of updates) {
            const name = u.notify || u.verifiedName || u.name;
            if (name) contactNames.set(u.id, name);
        }
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect, qr } = update;

        // ── QR recibido ──
        if (qr) {
            qrCount++;
            console.log(`[WA] QR #${qrCount}/${MAX_QR_INTENTOS}`);

            // 🛡️ ANTI-BUCLE: Si superamos el máximo de QR, parar
            if (qrCount > MAX_QR_INTENTOS) {
                console.log("[WA] Máximo de QR alcanzado. Parando conexión.");
                destroySocket();
                if (chatId) {
                    send(chatId,
                        `⏰ *Se generaron ${MAX_QR_INTENTOS} QR sin escanear.*\n\n` +
                        `La conexión se ha detenido para evitar bucles.\n` +
                        `Pulsa 📱 *Conectar WhatsApp* cuando estés listo para escanear.`,
                        mainMenuKeyboard()
                    );
                }
                return;
            }

            // Limpiar timeout anterior
            clearTimeout(qrTimeout);

            // Enviar QR al chat
            QRCode.toBuffer(qr, { scale: 8 })
                .then((buffer) => {
                    if (!chatId) return;
                    bot.sendPhoto(chatId, buffer, {
                        caption:
                            `📱 *Escanea este QR* (${qrCount}/${MAX_QR_INTENTOS})\n\n` +
                            `1. Abre WhatsApp → ⋮ → Dispositivos vinculados\n` +
                            `2. Vincular dispositivo\n` +
                            `3. Escanea este QR\n\n` +
                            `_Tienes 60s antes de que expire_`,
                        parse_mode: "Markdown",
                    }).catch(() => {});
                })
                .catch(() => {});

            // Timeout del QR actual
            qrTimeout = setTimeout(() => {
                if (!isConnected && qrCount >= MAX_QR_INTENTOS) {
                    destroySocket();
                    if (chatId) {
                        send(chatId,
                            "⏰ *Tiempo agotado.*\nPulsa 📱 *Conectar* para generar un QR nuevo.",
                            mainMenuKeyboard()
                        );
                    }
                }
            }, QR_EXPIRY_MS);
        }

        // ── Conexión abierta ──
        if (connection === "open") {
            isConnected = true;
            isConnecting = false;
            qrCount = 0;
            reconnectCount = 0;     // Reset reconexiones al conectar ok
            clearTimeout(qrTimeout);
            qrTimeout = null;

            const phone = sock?.user?.id?.split(":")[0] || sock?.user?.id?.split("@")[0] || "?";
            console.log(`[WA] ✅ Conectado como +${phone}`);
            if (chatId) {
                send(chatId,
                    `✅ *¡WhatsApp conectado!*\n\n📱 Número: +${phone}\n🟢 Estado: Activo\n\n_Listo para validar_`,
                    mainMenuKeyboard()
                );
            }
        }

        // ── Conexión cerrada ──
        if (connection === "close") {
            const wasConnected = isConnected;
            isConnected = false;
            isConnecting = false;
            clearTimeout(qrTimeout);
            qrTimeout = null;

            const code = lastDisconnect?.error?.output?.statusCode;
            const msg = lastDisconnect?.error?.message || "desconocido";
            console.log(`[WA] Desconectado. Código: ${code} | Motivo: ${msg}`);

            // ── Sesión cerrada (loggedOut) → borrar credenciales, NO reconectar ──
            if (code === DisconnectReason.loggedOut) {
                console.log("[WA] Sesión cerrada por el usuario. Borrando credenciales...");
                try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
                sock = null;
                if (chatId) {
                    send(chatId,
                        "🔴 *Sesión cerrada*\n\nSe han eliminado las credenciales.\nUsa 📱 *Conectar* para vincular de nuevo.",
                        mainMenuKeyboard()
                    );
                }
                return;
            }

            // ── Otros códigos: intentar reconectar con LÍMITE ──
            // Solo reconectar si teníamos sesión previa (no si estábamos esperando QR)
            const hasSession = fs.existsSync(AUTH_DIR) &&
                               fs.readdirSync(AUTH_DIR).length > 0;

            if (!hasSession) {
                console.log("[WA] No hay sesión guardada. No reconectar.");
                sock = null;
                if (chatId) {
                    send(chatId,
                        "🔴 *Conexión perdida*\nNo hay sesión guardada. Usa 📱 *Conectar* para vincular.",
                        mainMenuKeyboard()
                    );
                }
                return;
            }

            reconnectCount++;
            console.log(`[WA] Intento de reconexión ${reconnectCount}/${MAX_RECONNECT_INTENTOS}`);

            // 🛡️ ANTI-BUCLE: Si superamos las reconexiones, parar
            if (reconnectCount > MAX_RECONNECT_INTENTOS) {
                console.log("[WA] Máximo de reconexiones alcanzado. Parando.");
                destroySocket();
                if (chatId) {
                    send(chatId,
                        `⚠️ *No se pudo reconectar tras ${MAX_RECONNECT_INTENTOS} intentos.*\n\n` +
                        `Último error: \`${msg.slice(0, 80)}\`\n\n` +
                        `Pulsa 📱 *Conectar* para intentar de nuevo manualmente.`,
                        mainMenuKeyboard()
                    );
                }
                return;
            }

            // Reconectar con backoff exponencial
            const delay = Math.min(
                RECONNECT_DELAY_MS * Math.pow(RECONNECT_BACKOFF_MULT, reconnectCount - 1),
                60000 // máximo 60s
            );

            if (wasConnected && chatId) {
                send(chatId,
                    `⚠️ *WhatsApp desconectado*\n\n` +
                    `Reconectando en ${Math.round(delay / 1000)}s... ` +
                    `(${reconnectCount}/${MAX_RECONNECT_INTENTOS})`
                );
            }

            // Limpiar socket anterior antes de reconectar
            try {
                sock.ev.removeAllListeners();
            } catch (_) {}
            sock = null;

            clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(() => {
                console.log(`[WA] Reconectando... (intento ${reconnectCount})`);
                isConnecting = false; // Permitir la reconexión
                connectWhatsApp(chatId).catch((e) => {
                    console.error("[WA] Error en reconexión:", e.message);
                });
            }, delay);
        }
    });
}

// ================================================================
//  VERIFICACIÓN DE NÚMEROS
// ================================================================

async function checkNumbers(numbers) {
    if (!sock || !isConnected) {
        return numbers.map(() => null);
    }

    try {
        const jids = numbers.map((n) => `${n}@s.whatsapp.net`);
        const results = await withTimeout(sock.onWhatsApp(...jids), 20000, null);
        if (!results) throw new Error("Timeout en onWhatsApp");

        return numbers.map((num) => {
            const found = results.find((r) => r.jid.startsWith(num));
            return found ? found.exists === true : false;
        });
    } catch (e) {
        console.error("[CHECK] Error:", e.message);
        validation.lastError = e.message;
        return numbers.map(() => null);
    }
}

// ================================================================
//  OBTENER NOMBRE DE WHATSAPP
// ================================================================

async function getWhatsAppName(number) {
    if (!sock || !isConnected) return null;

    const jid = `${number}@s.whatsapp.net`;

    // 1. Cache de contactos (push name)
    const cached = contactNames.get(jid);
    if (cached) return cached;

    // 2. Business profile
    try {
        const biz = await withTimeout(sock.getBusinessProfile(jid), 5000, null);
        if (biz?.profile?.tag) return biz.profile.tag;
        if (biz?.description) return biz.description.split("\n")[0].slice(0, 40);
    } catch (_) {}

    // 3. Store de contactos de Baileys
    try {
        if (sock.store?.contacts?.[jid]) {
            const c = sock.store.contacts[jid];
            return c.notify || c.verifiedName || c.name || null;
        }
    } catch (_) {}

    return null;
}

// ================================================================
//  LOOP DE VALIDACIÓN (MEJORADO)
// ================================================================

async function validationLoop() {
    const { target, chatId, mode, filter } = validation;
    validation.startTime = Date.now();
    validation.scanned = 0;
    validation.valid = 0;
    validation.skippedNoName = 0;
    validation.errors = 0;
    validation.errorsInRow = 0;
    validation.lastNotify = 0;
    validation.lastError = "";
    validation.stopRequested = false;

    console.log(`[VAL] === INICIO: objetivo=${target} | modo=${mode} | filtro=${filter} ===`);

    loadAlreadyValidated();

    let disconnectWaits = 0;         // 🛡️ NUEVO: contador de esperas por desconexión
    const MAX_DISCONNECT_WAITS = 3;  // Máximo veces que esperamos reconexión

    try {
        while (validation.valid < target) {
            if (validation.stopRequested) {
                console.log("[VAL] Stop solicitado");
                break;
            }

            // 🛡️ MEJORADO: Manejar desconexión con límite de esperas
            if (!isConnected) {
                disconnectWaits++;

                if (disconnectWaits > MAX_DISCONNECT_WAITS) {
                    send(chatId,
                        "🚫 *WhatsApp no se reconectó tras varios intentos.*\n\n" +
                        "La validación se ha pausado.\n" +
                        "Usa 📱 *Conectar* y luego inicia de nuevo.",
                        mainMenuKeyboard()
                    );
                    break;
                }

                send(chatId,
                    `⚠️ *WhatsApp desconectado*\n\n` +
                    `Esperando reconexión... (${disconnectWaits}/${MAX_DISCONNECT_WAITS})\n` +
                    `_Timeout: 30s_`
                );

                // Esperar hasta 30s comprobando cada 3s
                let waited = 0;
                while (!isConnected && waited < 30000 && !validation.stopRequested) {
                    await sleep(3000);
                    waited += 3000;
                }

                if (!isConnected) {
                    continue; // Volver al while para incrementar disconnectWaits
                }

                // Se reconectó
                console.log("[VAL] Reconectado, continuando validación...");
                disconnectWaits = 0;
                validation.errorsInRow = 0;
                continue;
            }

            // Reset contador si estamos conectados
            disconnectWaits = 0;

            // 🛡️ MEJORADO: Pausa por muchos errores seguidos con límite
            if (validation.errorsInRow >= MAX_ERRORES_SEGUIDOS) {
                console.log(`[VAL] ${validation.errorsInRow} errores seguidos. Pausa 30s...`);
                send(chatId,
                    `⚠️ *${validation.errorsInRow} errores seguidos*\n` +
                    `Último: \`${validation.lastError.slice(0, 80)}\`\n` +
                    `Pausando 30s...`
                );
                await sleep(30000);
                validation.errorsInRow = 0;

                // Si se desconectó durante la pausa, volver al loop
                if (!isConnected) continue;
            }

            // Generar lote
            const batch = [];
            let attempts = 0;
            while (batch.length < BATCH_SIZE && attempts < BATCH_SIZE * 20) {
                attempts++;
                const num = generateNumber(filter);
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
                    try {
                        name = await withTimeout(getWhatsAppName(number), 8000, null);
                    } catch (_) {}

                    if (mode === "dedicados") {
                        if (name && name !== "Sin nombre") {
                            validation.valid++;
                            saveNumber(number, name);
                            console.log(`[VAL] ⭐ #${validation.valid}: +${number} → ${name}`);
                        } else {
                            validation.skippedNoName++;
                            console.log(`[VAL] ⏭️ +${number} válido pero sin nombre → descartado`);
                        }
                    } else {
                        validation.valid++;
                        saveNumber(number, name || "Sin nombre");
                        console.log(`[VAL] ✅ #${validation.valid}: +${number} (${name || "Sin nombre"})`);
                    }
                }
            }

            // Notificación periódica
            if (validation.valid > 0 && validation.valid - validation.lastNotify >= NOTIFICAR_CADA) {
                const elapsed = Date.now() - validation.startTime;
                const speed = elapsed > 0 ? (validation.scanned / (elapsed / 1000)).toFixed(1) : "0.0";
                const rate = validation.scanned > 0
                    ? ((validation.valid / validation.scanned) * 100).toFixed(1)
                    : "0.0";
                const eta = validation.valid > 0
                    ? ((target - validation.valid) / validation.valid) * elapsed
                    : 0;

                let extraInfo = "";
                if (mode === "dedicados" && validation.skippedNoName > 0) {
                    extraInfo = `⏭️ Descartados sin nombre: ${validation.skippedNoName.toLocaleString()}\n`;
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
        send(chatId, `💥 *Error crítico*\n\n\`${String(e).slice(0, 300)}\``, postValidationKeyboard());
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
    const filterStr = filter === "digi" ? "🎯 Solo DIGI" : "🌐 Todos";
    let extraFinal = "";
    if (mode === "dedicados") {
        extraFinal = `⏭️ Descartados sin nombre: ${validation.skippedNoName.toLocaleString()}\n`;
    }

    send(chatId,
        `${emoji} *${title}*\n\n` +
        `🏷️ Modo: ${modeStr}\n` +
        `📡 Filtro: ${filterStr}\n` +
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

function startValidation(chatId, target, mode, filter) {
    if (!isConnected) {
        send(chatId, "❌ *WhatsApp no conectado*\n\nUsa 📱 Conectar primero.", mainMenuKeyboard());
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
    validation.filter = filter;

    const modeLabel = mode === "dedicados"
        ? "⭐ *LEADS DEDICADOS*\n_Solo números con nombre real_"
        : "👥 *LEADS*\n_Todos los números válidos_";

    const filterLabel = filter === "digi"
        ? "🎯 Solo prefijos DIGI (641-645)"
        : "🌐 Todos los prefijos móviles";

    send(chatId,
        `🚀 *Validación iniciada*\n\n` +
        `${modeLabel}\n` +
        `📡 ${filterLabel}\n\n` +
        `🎯 Objetivo: *${target.toLocaleString()}* válidos\n` +
        `📦 Lote: ${BATCH_SIZE} números/consulta\n` +
        `🔔 Aviso cada ${NOTIFICAR_CADA} válidos\n\n` +
        `_100% gratis con Baileys 🆓_`,
        validatingKeyboard()
    );

    validationLoop().catch((e) => {
        console.error("[VAL] Error no capturado:", e);
        validation.active = false;
        send(chatId, `💥 *Error inesperado*: \`${e.message}\``, postValidationKeyboard());
    });
}

// ================================================================
//  ESTADO PARA CALLBACKS
// ================================================================

const waitingCustomAmount = new Map(); // 🛡️ Cambiado de Set a Map para timeout

// ================================================================
//  CALLBACK QUERIES (BOTONES)
// ================================================================

bot.on("callback_query", async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    // Responder callback (evitar el relojito en Telegram)
    bot.answerCallbackQuery(query.id).catch(() => {});

    // ── MENÚ PRINCIPAL ──
    if (data === "menu_main") {
        const status = isConnected ? "🟢 Conectado" : "🔴 Desconectado";
        send(chatId,
            `🤖 *Bot Validador DIGI v9.0*\n` +
            `_Powered by Baileys — 100% Gratis 🆓_\n\n` +
            `📱 WhatsApp: ${status}`,
            mainMenuKeyboard()
        );
        return;
    }

    // ── CONECTAR ──
    if (data === "cmd_conectar") {
        if (isConnected && sock) {
            const phone = sock?.user?.id?.split(":")[0] || sock?.user?.id?.split("@")[0] || "?";
            send(chatId,
                `✅ *Ya estás conectado*\n\n📱 Número: +${phone}\n🟢 Estado: Activo\n\n` +
                `Usa 🔌 Desconectar si quieres cambiar de cuenta.`,
                mainMenuKeyboard()
            );
            return;
        }
        if (isConnecting) {
            send(chatId, "⏳ *Ya se está conectando...*\nEspera a que aparezca el QR.");
            return;
        }
        send(chatId, "📱 *Conectando WhatsApp...*\n\nGenerando QR, espera unos segundos...");
        connectWhatsApp(chatId).catch((e) => {
            console.error("[WA] Error en connectWhatsApp:", e.message);
            isConnecting = false;
            send(chatId, `❌ Error conectando: \`${e.message}\`\n\nIntenta de nuevo.`, mainMenuKeyboard());
        });
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
        if (isNaN(cantidad) || cantidad < 1) {
            send(chatId, "❌ Cantidad no válida.", cantidadKeyboard());
            return;
        }
        send(chatId,
            `📋 *${cantidad.toLocaleString()} números* — Elige el modo:\n\n` +
            `👥 *Leads*: Guarda todos los válidos\n\n` +
            `⭐ *Leads Dedicados*: Solo guarda los que tienen nombre real en WhatsApp`,
            modeKeyboard(cantidad)
        );
        return;
    }

    // ── CANTIDAD PERSONALIZADA ──
    if (data === "cant_custom") {
        // Limpiar timeout anterior si existía
        const prevTimeout = waitingCustomAmount.get(chatId);
        if (prevTimeout) clearTimeout(prevTimeout);

        // Auto-cancelar después de 60s
        const timeout = setTimeout(() => {
            if (waitingCustomAmount.has(chatId)) {
                waitingCustomAmount.delete(chatId);
                send(chatId, "⏰ Tiempo agotado para introducir cantidad.", mainMenuKeyboard());
            }
        }, 60000);

        waitingCustomAmount.set(chatId, timeout);
        send(chatId,
            "✏️ *Escribe la cantidad de números* que quieres encontrar:\n\n" +
            "_Ejemplo: 500, 3000, 15000..._\n" +
            "_Mínimo: 1 | Máximo: 100.000_"
        );
        return;
    }

    // ── MODO SELECCIONADO → FILTRO ──
    if (data.startsWith("mode_leads_") || data.startsWith("mode_dedicados_")) {
        const parts = data.split("_");
        const mode = parts[1]; // "leads" o "dedicados"
        const cantidad = parseInt(parts[2]);
        if (isNaN(cantidad) || cantidad < 1) {
            send(chatId, "❌ Error en la cantidad. Vuelve a empezar.", mainMenuKeyboard());
            return;
        }
        send(chatId,
            `📡 *Filtro de operador*\n\n` +
            `🎯 *Solo prefijos DIGI*: Busca en rangos 641-645\n\n` +
            `🌐 *Todos los prefijos*: Busca en todos los móviles españoles`,
            filterKeyboard(cantidad, mode)
        );
        return;
    }

    // ── FILTRO SELECCIONADO → INICIAR ──
    if (data.startsWith("filter_")) {
        const parts = data.split("_");
        // filter_digi_leads_2000 o filter_todos_dedicados_4000
        const filter = parts[1]; // "digi" o "todos"
        const mode = parts[2];   // "leads" o "dedicados"
        const cantidad = parseInt(parts[3]);

        if (!["digi", "todos"].includes(filter) || !["leads", "dedicados"].includes(mode)) {
            send(chatId, "❌ Parámetros no válidos. Vuelve a empezar.", mainMenuKeyboard());
            return;
        }
        if (isNaN(cantidad) || cantidad < 1) {
            send(chatId, "❌ Cantidad no válida. Vuelve a empezar.", mainMenuKeyboard());
            return;
        }

        startValidation(chatId, cantidad, mode, filter);
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
        if (!sock && !isConnecting) {
            send(chatId, "ℹ️ No hay sesión activa.", mainMenuKeyboard());
            return;
        }
        if (validation.active) {
            send(chatId, "⚠️ Hay una validación en curso. Párala primero.", validatingKeyboard());
            return;
        }
        try {
            if (sock) await sock.logout();
        } catch (e) {
            console.error("[WA] Error al cerrar sesión:", e.message);
        }
        destroySocket();
        try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
        send(chatId, "🔴 *Sesión de WhatsApp cerrada*\n\nCredenciales eliminadas.", mainMenuKeyboard());
        return;
    }
});

// ================================================================
//  FUNCIONES COMPARTIDAS (botones + comandos texto)
// ================================================================

function sendEstado(chatId) {
    if (!validation.active && validation.scanned === 0) {
        const waStatus = isConnected ? "🟢 Conectado" : "🔴 Desconectado";
        send(chatId, `💤 Sin validación activa.\n\n📱 WhatsApp: ${waStatus}`, mainMenuKeyboard());
        return;
    }

    const elapsed = validation.startTime ? Date.now() - validation.startTime : 0;
    const speed = elapsed > 0 ? (validation.scanned / (elapsed / 1000)).toFixed(1) : "0.0";
    const pct = validation.target > 0 ? (validation.valid / validation.target) * 100 : 0;
    const rate = validation.scanned > 0
        ? ((validation.valid / validation.scanned) * 100).toFixed(1)
        : "0.0";

    let etaStr = "calculando...";
    if (validation.valid > 0 && elapsed > 0) {
        const eta = ((validation.target - validation.valid) / validation.valid) * elapsed;
        etaStr = formatTime(eta);
    }

    const bars = Math.floor(Math.min(pct, 100) / 5);
    const bar = "█".repeat(bars) + "░".repeat(20 - bars);
    const statusStr = validation.active ? "🟢 En curso" : "🔴 Detenido";
    const waStatus = isConnected ? "🟢 Conectado" : "🔴 Desconectado";
    const modeStr = validation.mode === "dedicados" ? "⭐ Dedicados" : "👥 Leads";
    const filterStr = validation.filter === "digi" ? "🎯 DIGI" : "🌐 Todos";

    let errLine = "";
    if (validation.errors > 0) {
        errLine = `❌ Errores: ${validation.errors.toLocaleString()}\n`;
        if (validation.lastError) errLine += `📌 Último: \`${validation.lastError.slice(0, 60)}\`\n`;
    }

    let skipLine = "";
    if (validation.mode === "dedicados" && validation.skippedNoName > 0) {
        skipLine = `⏭️ Descartados sin nombre: ${validation.skippedNoName.toLocaleString()}\n`;
    }

    const kb = validation.active ? validatingKeyboard() : postValidationKeyboard();

    send(chatId,
        `📊 *Estado de validación*\n\n` +
        `${statusStr} | WhatsApp: ${waStatus}\n` +
        `🏷️ Modo: ${modeStr} | Filtro: ${filterStr}\n` +
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
        `🤖 *Bot Validador DIGI v9.0*\n` +
        `_Powered by Baileys — 100% Gratis 🆓_\n\n` +
        `📱 WhatsApp: ${status}\n\n` +
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
    if (isConnecting) {
        send(chatId, "⏳ *Ya se está conectando...*\nEspera a que aparezca el QR.");
        return;
    }
    send(chatId, "📱 *Conectando WhatsApp...*\nGenerando QR...");
    connectWhatsApp(chatId).catch((e) => {
        isConnecting = false;
        send(chatId, `❌ Error: \`${e.message}\``, mainMenuKeyboard());
    });
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
        send(chatId,
            `📋 *${target.toLocaleString()} números* — Elige el modo:`,
            modeKeyboard(target)
        );
    } else {
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
    if (!sock && !isConnecting) {
        send(chatId, "ℹ️ No hay sesión activa.", mainMenuKeyboard());
        return;
    }
    if (validation.active) {
        send(chatId, "⚠️ Para primero la validación.", validatingKeyboard());
        return;
    }
    try {
        if (sock) await sock.logout();
    } catch (e) {
        console.error("[WA] Error logout:", e.message);
    }
    destroySocket();
    try { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); } catch (_) {}
    send(chatId, "🔴 *Sesión cerrada*\nCredenciales eliminadas.", mainMenuKeyboard());
});

// ── CAPTURAR MENSAJES DE TEXTO para cantidad personalizada ──
bot.on("message", (msg) => {
    const chatId = msg.chat.id;
    if (!waitingCustomAmount.has(chatId)) return;
    if (msg.text?.startsWith("/")) return;

    const num = parseInt(msg.text);
    if (isNaN(num) || num < 1) {
        send(chatId, "❌ Escribe un número válido. Ejemplo: `5000`");
        return;
    }

    const cantidad = Math.min(100000, num);

    // Limpiar timeout
    const timeout = waitingCustomAmount.get(chatId);
    if (timeout) clearTimeout(timeout);
    waitingCustomAmount.delete(chatId);

    send(chatId,
        `📋 *${cantidad.toLocaleString()} números* — Elige el modo:`,
        modeKeyboard(cantidad)
    );
});

// ================================================================
//  APAGADO LIMPIO (SIGINT / SIGTERM)
// ================================================================

function gracefulShutdown(signal) {
    console.log(`\n[BOT] Señal ${signal} recibida. Cerrando limpiamente...`);

    if (validation.active) {
        validation.stopRequested = true;
    }

    destroySocket();

    try {
        bot.stopPolling();
    } catch (_) {}

    console.log("[BOT] ✅ Bot cerrado limpiamente.");
    process.exit(0);
}

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

// 🛡️ NUEVO: Capturar errores no manejados para que no crashee
process.on("uncaughtException", (err) => {
    console.error("[FATAL] Excepción no capturada:", err.message);
    console.error(err.stack);
    // No salir — intentar seguir funcionando
});

process.on("unhandledRejection", (reason) => {
    console.error("[FATAL] Promesa rechazada no capturada:", reason);
    // No salir — intentar seguir funcionando
});

// ================================================================
//  MAIN
// ================================================================

async function main() {
    console.log("╔══════════════════════════════════════════════════════════╗");
    console.log("║   BOT VALIDADOR DIGI v9.0 — Anti-Bucle Edition         ║");
    console.log("║   100% Gratis • Sin límites • Sin GreenAPI              ║");
    console.log("╚══════════════════════════════════════════════════════════╝");
    console.log();
    console.log(`  Prefijos DIGI: ${PREFIJOS_DIGI.join(", ")}`);
    console.log(`  Prefijos totales: ${PREFIJOS_TODOS.length}`);
    console.log(`  Batch: ${BATCH_SIZE} | Delay: ${DELAY_ENTRE_LOTES_MS}ms`);
    console.log(`  Modos: Leads | Dedicados`);
    console.log(`  Filtros: Solo DIGI | Todos`);
    console.log(`  Límite QR: ${MAX_QR_INTENTOS} intentos`);
    console.log(`  Límite reconexiones: ${MAX_RECONNECT_INTENTOS} intentos`);
    console.log();

    if (fs.existsSync(AUTH_DIR)) {
        let files = [];
        try { files = fs.readdirSync(AUTH_DIR); } catch (_) {}

        if (files.length > 0) {
            console.log("[WA] Sesión previa encontrada. Reconectando...");
            try {
                await connectWhatsApp(null);
            } catch (e) {
                console.error("[WA] Error reconectando:", e.message);
                isConnecting = false;
            }
        } else {
            console.log("[WA] Carpeta de sesión vacía. Esperando /conectar...");
        }
    } else {
        console.log("[WA] No hay sesión. Esperando /conectar...");
    }

    console.log("[BOT] ✅ Bot de Telegram activo. Esperando comandos...");
}

main().catch((e) => {
    console.error("[MAIN] Error fatal al arrancar:", e);
});
