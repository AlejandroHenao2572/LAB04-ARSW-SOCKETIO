# Servidor Socket.IO para Blueprints (Node.js)

Esta aplicación es un gateway en Node.js que expone una pequeña API REST y un servidor Socket.IO que coordina colaboración en tiempo real para la edición de "blueprints". El servidor actúa como intermediario entre los clientes Web (frontend) y un backend REST en Spring Boot responsable de la persistencia.

**Descripción breve**

El gateway permite a varios clientes conectarse a una "sala" asociada a un blueprint (autor + nombre). Cuando un cliente emite un evento de dibujo (`draw-event`) con un punto, el gateway:

1. Persiste el punto en el backend Spring Boot (llamada REST `PUT`).
2. Recupera el blueprint actualizado desde el backend.
3. Difunde (`emit`) el blueprint actualizado a todos los clientes dentro de la sala (incluyendo el emisor) usando Socket.IO.

Esto garantiza que todos los clientes vean la versión más reciente del blueprint después de cada modificación.

---

**Requisitos**

- Node.js (v14+ recomendado)
- Dependencias (están en `package.json`): `express`, `socket.io`, `axios`, `cors`.

Instalación de dependencias:

```bash
npm install
```

---

**Variables de entorno**

- `PORT`: puerto donde escucha el gateway. Por defecto `3000`.
- `SPRING_BASE`: URL base del backend Spring Boot (por defecto `http://localhost:8080`).
- `FRONTEND_ORIGIN`: origen permitido por CORS para el frontend (por defecto `http://localhost:5173`).

Ejemplo al arrancar:

```powershell
npm start
```

---

**Cómo ejecutar**

1. Asegúrate de que el backend Spring Boot esté disponible en `SPRING_BASE`.
2. Ejecuta `npm install`.
3. Ejecuta `npm start` 

---

**Socket.IO — Eventos y flujo**

El servidor define los siguientes eventos Socket.IO:

- `join-room` (cliente -> servidor): solicita unirse a la sala de un blueprint.
	- Payload: `{ author, name }` (ambos strings).
	- Efecto: el socket se une a la sala `room:${author}-${name}`. El servidor intenta obtener el blueprint actual desde el backend y lo envía al cliente con `blueprint-update`.

- `draw-event` (cliente -> servidor): notifica que el cliente dibujó un punto.
	- Payload: `{ author, name, point: { x, y } }`.
	- Ack: el cliente puede enviar un callback `ack` para recibir la confirmación `{ ok: true }` o `{ ok: false, message }`.
	- Flujo del servidor:
		1. Valida payload.
		2. Persiste el punto en Spring Boot (`PUT /api/v1/blueprints/{author}/{name}/points`).
		3. Recupera el blueprint actualizado desde Spring.
		4. Emite `blueprint-update` a todos los clientes en la sala (incluyendo emisor) con el blueprint completo como payload.

- `blueprint-update` (servidor -> cliente): notifica a los clientes del estado actualizado del blueprint.
	- Payload: el objeto `blueprint` retornado por el backend (formato: el backend devuelve un wrapper `{ status, message, data, timestamp }` y `data` contiene el blueprint).

- `warning` y `error` (servidor -> cliente): mensajes informativos o de error en caso de fallos (por ejemplo cuando Spring no responde o payload inválido).

- `leave-room` (cliente -> servidor): opcional, para salir de la sala. Payload: `{ author, name }`.

---

**Nombres de sala**

Las salas se construyen con la función `roomName(author, name)` y tienen el formato `room:AUTHOR-NAME`.

Fragmento relevante de [server.js](server.js):

```js
// Utility: construir nombre de sala estable
function roomName(author, name) {
	return `room:${author}-${name}`
}
```

---

**Persistencia y consulta al backend (Spring Boot)**

El gateway se comunica con el backend usando `axios`. Se crean dos helpers relevantes:

1) `persistPoint(author, name, point)` — realiza la llamada `PUT` para agregar el punto:

```js
async function persistPoint(author, name, point) {
	const url = `/api/v1/blueprints/${encodeURIComponent(author)}/${encodeURIComponent(name)}/points`
	// El backend espera el body: { x, y }
	return spring.put(url, point)
}
```

2) `fetchBlueprint(author, name)` — obtiene el blueprint completo y desempaqueta el wrapper de la API:

```js
async function fetchBlueprint(author, name) {
	const url = `/api/v1/blueprints/${encodeURIComponent(author)}/${encodeURIComponent(name)}`
	const res = await spring.get(url)
	// La API Spring devuelve { status, message, data, timestamp }
	return res.data && res.data.data ? res.data.data : null
}
```

Estos helpers usan la instancia `spring` configurada con `baseURL` igual a `SPRING_BASE` y un timeout.

---

**Manejo de `draw-event` (lógica crítica)**

El handler para `draw-event` implementa validaciones, persistencia y broadcast del blueprint actualizado.

Fragmento clave (simplificado) de [server.js](server.js):

```js
socket.on('draw-event', async (payload, ack) => {
	try {
		if (!payload || !payload.author || !payload.name || !payload.point) {
			const msg = 'draw-event: missing author, name or point'
			if (typeof ack === 'function') ack({ ok: false, message: msg })
			socket.emit('error', { message: msg })
			return
		}

		const { author, name, point } = payload
		const room = roomName(author, name)

		// 1) Persiste el punto
		await persistPoint(author, name, point)

		// 2) Recupera blueprint actualizado
		const updatedBlueprint = await fetchBlueprint(author, name)

		// 3) Broadcast a todos en la sala (incluye emisor)
		io.to(room).emit('blueprint-update', updatedBlueprint)

		if (typeof ack === 'function') ack({ ok: true })
	} catch (err) {
		if (typeof ack === 'function') ack({ ok: false, message: 'Internal server error' })
		socket.emit('error', { message: 'Internal server error handling draw-event' })
	}
})
```
---

**Conexión y join-room**

Cuando un socket se conecta, el servidor escucha `join-room` y trata de enviar el estado inicial del blueprint al cliente que se unió.

Fragmento:

```js
socket.on('join-room', async (payload) => {
	if (!payload || !payload.author || !payload.name) {
		socket.emit('error', { message: 'join-room: missing author or name' })
		return
	}
	const room = roomName(payload.author, payload.name)
	socket.join(room)

	try {
		const bp = await fetchBlueprint(payload.author, payload.name)
		if (bp) socket.emit('blueprint-update', bp)
	} catch (err) {
		socket.emit('warning', { message: 'Could not fetch blueprint state from API' })
	}
})
```
--

**Ejemplo de flujo completo**

1. Cliente A conecta y emite `join-room` con `{ author: 'alice', name: 'plano1' }`.
2. Servidor responde con `blueprint-update` si existe un blueprint previo.
3. Cliente A dibuja un punto y emite `draw-event` con `{ author:'alice', name:'plano1', point:{ x: 10, y: 20 } }` y espera ack.
4. Servidor persiste el punto en Spring, recupera el blueprint actualizado y emite `blueprint-update` a la sala `room:alice-plano1`.
5. Todos los clientes en la sala redibujan el canvas con el blueprint recibido.
