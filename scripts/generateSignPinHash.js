// ═══════════════════════════════════════════════════════════════════════════════
//  Uso:  node scripts/generateSignPinHash.js
//  Pide la clave por consola (se ven asteriscos y no queda en el historial)
//  y devuelve las dos variables para pegar en el .env y en Render.
//  Si ya tenés ADMIN_SIGN_PEPPER en el .env lo reutiliza; si no, genera uno.
// ═══════════════════════════════════════════════════════════════════════════════
require("dotenv").config();
const crypto = require("crypto");

if (!process.env.ADMIN_SIGN_PEPPER || process.env.ADMIN_SIGN_PEPPER.length < 32) {
    process.env.ADMIN_SIGN_PEPPER = crypto.randomBytes(32).toString("hex");
}
const { hashPin, PIN_REGEX } = require("../utils/signPin");

function askHidden(question) {
    return new Promise((resolve) => {
        const stdin = process.stdin;
        process.stdout.write(question);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding("utf8");
        let value = "";
        const onData = (char) => {
            if (char === "\r" || char === "\n" || char === "\u0004") {
                stdin.setRawMode(false);
                stdin.pause();
                stdin.removeListener("data", onData);
                process.stdout.write("\n");
                resolve(value);
            } else if (char === "\u0003") {
                process.exit(1);
            } else if (char === "\u007f" || char === "\b") {
                if (value.length) {
                    value = value.slice(0, -1);
                    process.stdout.write("\b \b");
                }
            } else {
                value += char;
                process.stdout.write("*");
            }
        };
        stdin.on("data", onData);
    });
}

(async () => {
    const pin = await askHidden("Clave de firma (4 dígitos): ");
    if (!PIN_REGEX.test(pin)) {
        console.error("La clave tiene que ser de exactamente 4 dígitos.");
        process.exit(1);
    }
    const again = await askHidden("Repetila: ");
    if (again !== pin) {
        console.error("Las claves no coinciden.");
        process.exit(1);
    }
    const hash = await hashPin(pin);
    console.log("\nCopiá estas dos líneas al .env y a las variables de entorno de Render:\n");
    console.log(`ADMIN_SIGN_PEPPER=${process.env.ADMIN_SIGN_PEPPER}`);
    console.log(`ADMIN_SIGN_PIN_HASH=${hash}\n`);
    console.log("El hash solo funciona con este pepper: viajan siempre juntos.");
})();