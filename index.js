require("dotenv").config()
const express = require("express")
const cors = require("cors")
const { urlencoded } = require("body-parser")
const cookieParser = require("cookie-parser")
const dbConnection = require("./config/mongoose")
const authRouter = require("./routes/authRouter")
const contactRouter = require("./routes/contactRouter")
const firebaseRouter = require("./routes/firebaseRouter")
const adminConfigRouter = require("./routes/adminConfigRouter")
const adminReservasRouter = require("./routes/adminReservasRouter")
const adminChannelsRouter = require("./routes/adminChannelsRouter")
const paymentsRouter = require("./routes/paymentsRouter")
const reservasRouter = require("./routes/reservasRouter")
const adminReservasWebRouter = require("./routes/adminReservasWebRouter")
const adminGestionReservasRouter = require("./routes/adminGestionReservasRouter")

const app = express()
const PORT = process.env.PORT

app.set('trust proxy', 1); // Para el Rate Limiter

dbConnection()

app.use(cors({
    origin: [`${process.env.API_BACKEND_URL}`, `${process.env.BACKEND_RENDER_URL}`, `${process.env.FRONT_END}`, `${process.env.FRONT_END_WWW}`, `${process.env.LOCAL_HOST}`].filter(Boolean),
    methods: [ "GET", "POST", "PUT", "PATCH", "DELETE" ],
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}))

app.use(paymentsRouter)

app.use(urlencoded({ extended: true }))
app.use(express.json())
app.use(cookieParser())

app.use(authRouter)
app.use(contactRouter)
app.use(firebaseRouter)
app.use(adminReservasRouter)
app.use(adminConfigRouter)
app.use(adminChannelsRouter)
app.use(reservasRouter)
app.use(adminReservasWebRouter)
app.use(adminGestionReservasRouter)

app.use((req,res) => {
    res.send(`<h1>404 - Not Found</h1>`)
})

app.listen(PORT, "0.0.0.0", (req, res) => {
    console.log(`Server listening🟢`)
})