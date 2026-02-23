const express = require('express')
const http = require('http')
const { Server } = require('socket.io')
const axios = require('axios')
const cors = require('cors')

// Configuración 
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000
const SPRING_BASE = process.env.SPRING_BASE || 'http://localhost:8080'
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || 'http://localhost:5173'

// Cliente HTTP hacia Spring Boot (usamos axios)
const spring = axios.create({
  baseURL: SPRING_BASE,
  timeout: 5000,
  headers: { 'Content-Type': 'application/json' },
})

// Express (solo para health-check / debugging mínimo)
const app = express()
app.use(cors({ origin: FRONTEND_ORIGIN }))
app.use(express.json())

// HTTP + Socket.IO
const server = http.createServer(app)
const io = new Server(server, {
  cors: {
    origin: FRONTEND_ORIGIN,
    methods: ['GET', 'POST'],
    credentials: true,
  },
})

// Utility: construir nombre de sala estable
function roomName(author, name) {
  return `room:${author}-${name}`
}

// Helper: persistir punto en Spring Boot
async function persistPoint(author, name, point) {
  const url = `/api/v1/blueprints/${encodeURIComponent(author)}/${encodeURIComponent(name)}/points`
  // El backend espera el body: { x, y }
  return spring.put(url, point)
}

// Helper: obtener blueprint completo (desempaquetando el wrapper ApiResponse)
async function fetchBlueprint(author, name) {
  const url = `/api/v1/blueprints/${encodeURIComponent(author)}/${encodeURIComponent(name)}`
  const res = await spring.get(url)
  // La API Spring devuelve { status, message, data, timestamp }
  return res.data && res.data.data ? res.data.data : null
}

// Manejo de conexiones Socket.IO
io.on('connection', (socket) => {
  console.log(`[io] Cliente conectado: ${socket.id}`)

  // join-room -> { author, name }
  socket.on('join-room', async (payload) => {
    try {
      if (!payload || !payload.author || !payload.name) {
        socket.emit('error', { message: 'join-room: missing author or name' })
        return
      }
      const room = roomName(payload.author, payload.name)
      socket.join(room)
      console.log(`[io] ${socket.id} joined ${room}`)

      // Enviar estado inicial al cliente que se unió (si existe)
      try {
        const bp = await fetchBlueprint(payload.author, payload.name)
        if (bp) {
          socket.emit('blueprint-update', bp)
        }
      } catch (err) {
        // No bloquea el join si Spring no responde; informar en log y al cliente
        console.warn(`[io] Could not fetch blueprint on join: ${err.message}`)
        socket.emit('warning', { message: 'Could not fetch blueprint state from API' })
      }
    } catch (err) {
      console.error('[io] join-room error', err)
      socket.emit('error', { message: 'Internal error on join-room' })
    }
  })

  // draw-event -> { author, name, point: { x, y } }
  socket.on('draw-event', async (payload, ack) => {
    // ack es un callback opcional proporcionado por el cliente (socket.io ack)
    try {
      if (!payload || !payload.author || !payload.name || !payload.point) {
        const msg = 'draw-event: missing author, name or point'
        if (typeof ack === 'function') ack({ ok: false, message: msg })
        socket.emit('error', { message: msg })
        return
      }

      const { author, name, point } = payload
      const room = roomName(author, name)

      // 1) Persiste el punto via REST en Spring Boot
      try {
        await persistPoint(author, name, point)
      } catch (err) {
        const msg = `Failed to persist point: ${err?.response?.data?.message || err.message}`
        console.error('[io] persistPoint error:', msg)
        if (typeof ack === 'function') ack({ ok: false, message: msg })
        socket.emit('error', { message: msg })
        return
      }

      // 2) Recupera el blueprint actualizado desde Spring
      let updatedBlueprint = null
      try {
        updatedBlueprint = await fetchBlueprint(author, name)
      } catch (err) {
        const msg = `Failed to fetch updated blueprint: ${err?.message}`
        console.error('[io] fetchBlueprint error:', msg)
        // Informar al emisor pero continuar con broadcast mínimo (sin payload)
        if (typeof ack === 'function') ack({ ok: false, message: msg })
        socket.emit('warning', { message: msg })
        return
      }

      if (!updatedBlueprint) {
        const msg = 'Blueprint not found after persisting point'
        console.warn('[io] ' + msg)
        if (typeof ack === 'function') ack({ ok: false, message: msg })
        socket.emit('warning', { message: msg })
        return
      }

      // 3) Broadcast del blueprint actualizado a TODOS los clientes de la sala,
      // incluido el emisor, para que su propio canvas se redibuje.
      // Usamos io.to(room) en lugar de socket.to(room) que excluye al emisor.
      io.to(room).emit('blueprint-update', updatedBlueprint)

      // Opcional: enviar ack exitoso al emisor
      if (typeof ack === 'function') ack({ ok: true })
    } catch (err) {
      console.error('[io] draw-event handler error', err)
      if (typeof ack === 'function') ack({ ok: false, message: 'Internal server error' })
      socket.emit('error', { message: 'Internal server error handling draw-event' })
    }
  })

  // leave-room -> { author, name }  (opcional)
  socket.on('leave-room', (payload) => {
    try {
      if (!payload || !payload.author || !payload.name) return
      const room = roomName(payload.author, payload.name)
      socket.leave(room)
      console.log(`[io] ${socket.id} left ${room}`)
    } catch (err) {
      console.warn('[io] leave-room error', err)
    }
  })

  socket.on('disconnect', (reason) => {
    console.log(`[io] Cliente desconectado: ${socket.id} (${reason})`)
  })
})

// Arranque del servidor
server.listen(PORT, () => {
  console.log(`Socket.IO gateway escuchando en :${PORT}`)
  console.log(`-> Frontend allowed origin: ${FRONTEND_ORIGIN}`)
  console.log(`-> Spring Boot base URL: ${SPRING_BASE}`)
})