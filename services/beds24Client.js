// Cliente HTTP de la API v2 de Beds24: token, reintentos y paginación.
const BASE_URL = process.env.BEDS24_BASE_URL || "https://beds24.com/api/v2";
const esProduccion = (process.env.NODE_ENV === "production");

class Beds24Error extends Error {
    constructor(message, status, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function safeJson(res) {
    try { return await res.json(); } catch { return null; }
}

// ---------- Token ----------
// El access token dura 24 h. Se renueva con el refresh token, que no vence
// mientras se use al menos una vez cada 30 días (acá se usa a diario).
let cachedToken = null;   // { token, expiresAt }
let refreshing = null;    // evita pedir dos tokens a la vez

async function fetchNewToken() {
    const refreshToken = process.env.BEDS24_REFRESH_TOKEN;
    if (!refreshToken) throw new Error("Falta BEDS24_REFRESH_TOKEN en las variables de entorno");

    const res = await fetch(`${BASE_URL}/authentication/token`, {
        headers: { accept: "application/json", refreshToken },
    });
    const data = await safeJson(res);
    if (!res.ok || !data?.token) {
        throw new Beds24Error(`No se pudo renovar el token de Beds24 (${res.status})`, res.status, data);
    }
    cachedToken = { token: data.token, expiresAt: Date.now() + data.expiresIn * 1000 };
    return data.token;
}

async function getToken() {
    // Se renueva 5 minutos antes de que venza
    if (cachedToken && Date.now() < cachedToken.expiresAt - 5 * 60 * 1000) return cachedToken.token;
    if (!refreshing) refreshing = fetchNewToken().finally(() => { refreshing = null; });
    return refreshing;
}

// ---------- Petición genérica ----------
async function beds24Request(path, { method = "GET", query, body } = {}, attempt = 0) {
    const url = new URL(BASE_URL + path);
    Object.entries(query || {}).forEach(([key, value]) => {
        if (value === undefined || value === null || value === "") return;
        if (Array.isArray(value)) value.forEach((item) => url.searchParams.append(key, String(item)));
        else url.searchParams.set(key, String(value));
    });

    const res = await fetch(url, {
        method,
        headers: {
            accept: "application/json",
            "content-type": "application/json",
            token: await getToken(),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });

    // Límite: ~100 créditos cada 5 minutos
    const remaining = res.headers.get("x-five-min-limit-remaining");
    if (remaining !== null && Number(remaining) < 20) {
        console.warn(`Beds24: quedan pocos créditos (${remaining}) en esta ventana de 5 minutos 🟠`);
    }

    // Token vencido o revocado: se pide uno nuevo y se reintenta una vez
    if (res.status === 401 && attempt === 0) {
        cachedToken = null;
        return beds24Request(path, { method, query, body }, attempt + 1);
    }
    // Límite de peticiones: espera y reintenta
    if (res.status === 429 && attempt < 3) {
        await sleep(2000 * (attempt + 1));
        return beds24Request(path, { method, query, body }, attempt + 1);
    }

    const data = await safeJson(res);
    if (!res.ok || data?.success === false) {
        const detail = esProduccion ? "" : ` ${JSON.stringify(data)}`;
        throw new Beds24Error(`Beds24 ${method} ${path} → ${res.status}${detail}`, res.status, data);
    }
    return data;
}

// Recorre todas las páginas de un listado y devuelve un solo array
async function beds24GetAll(path, query = {}) {
    const items = [];
    let page = 1;
    // Tope de seguridad para no gastar créditos en un bucle infinito
    while (page <= 20) {
        const data = await beds24Request(path, { query: { ...query, page: page > 1 ? page : undefined } });
        items.push(...(data?.data || []));
        if (!data?.pages?.nextPageExists) break;
        page += 1;
    }
    return items;
}

module.exports = { beds24Request, beds24GetAll, Beds24Error };