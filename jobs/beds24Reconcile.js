// Sincronización periódica con Beds24, por si algún webhook se pierde.
// Llamar a startBeds24Reconcile() DESPUÉS de conectar Mongo.
const { syncUpcoming } = require("../services/bookingSync");

const esProduccion = (process.env.NODE_ENV === "production");
const INTERVAL_MS = 10 * 60 * 1000;   // cada 10 minutos (1 crédito por ejecución)

let started = false;

function startBeds24Reconcile() {
    if (started) return;
    started = true;

    const run = async () => {
        try {
            const result = await syncUpcoming();
            if (!esProduccion) console.log(`Sync Beds24 OK 🟢 (${result.fetched} reservas, ${result.markedDeleted} borradas)`);
        } catch (error) {
            console.error(esProduccion ? "Sync Beds24 falló 🔴" : `Sync Beds24 falló 🔴 ${error}`);
        }
    };

    setTimeout(run, 5000);             // primera sincronización al arrancar
    setInterval(run, INTERVAL_MS);
}

module.exports = { startBeds24Reconcile };