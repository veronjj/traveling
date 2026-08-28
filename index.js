/**
 * =============================================================================
 *  TRAVELING — Plataforma de transporte interurbano / carpooling
 * =============================================================================
 *  Archivo único, listo para producción. Contiene:
 *    1) Conexión a MySQL (mysql2/promise) vía variables de entorno.
 *    2) Servidor Express con API REST (autenticación, viajes, reservas).
 *    3) Frontend completo (HTML5 + Tailwind CSS vía CDN + JS vanilla) servido
 *       desde GET /.
 *
 *  INSTALACIÓN Y EJECUCIÓN
 *    npm install express mysql2 dotenv web-push
 *    node index.js
 *
 *  VARIABLES DE ENTORNO (crea un archivo .env junto a este archivo)
 *    DB_HOST      Host de tu MySQL en la nube (PlanetScale, Aiven, Railway, RDS…)
 *    DB_USER      Usuario de la base de datos
 *    DB_PASSWORD  Contraseña de la base de datos
 *    DB_NAME      Nombre de la base de datos (debe existir; las tablas se crean solas)
 *    DB_PORT      Puerto (por defecto 3306)
 *    DB_SSL       "true" si tu proveedor exige SSL (PlanetScale, Aiven, etc.)
 *    PORT         Puerto HTTP del servidor (por defecto 3000)
 *    SESSION_SECRET     Cadena secreta para firmar las sesiones (obligatoria en producción)
 *    VAPID_PUBLIC_KEY   Clave pública para notificaciones push del navegador
 *    VAPID_PRIVATE_KEY  Clave privada para notificaciones push del navegador
 *    VAPID_SUBJECT      Contacto del remitente, ej. mailto:tucorreo@ejemplo.com
 *
 *  Genera el par de claves VAPID una sola vez con:
 *    node -e "console.log(require('web-push').generateVAPIDKeys())"
 *
 *  Sin esas 3 variables, la app funciona igual mas las notificaciones push
 *  quedan desactivadas silenciosamente (no rompe nada, solo no notifica).
 *
 *  La base de datos inicia completamente vacía: no hay usuarios, viajes ni
 *  reservas de ejemplo. Todo se crea desde la interfaz.
 * =============================================================================
 */

'use strict';

require('dotenv').config();

const express = require('express');
const mysql = require('mysql2/promise');
const crypto = require('crypto');
const webpush = require('web-push');

// -----------------------------------------------------------------------------
// 1. CONFIGURACIÓN GENERAL
// -----------------------------------------------------------------------------

const PUERTO = process.env.PORT || 3000;

if (!process.env.SESSION_SECRET) {
  console.warn(
    '[Traveling] Advertencia: no definiste SESSION_SECRET en tu .env. ' +
    'Se usará una clave temporal generada en memoria, lo que invalidará ' +
    'todas las sesiones activas cada vez que reinicies el servidor. ' +
    'Define SESSION_SECRET en producción.'
  );
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
const DURACION_SESION_MS = 7 * 24 * 60 * 60 * 1000; // 7 días

// Notificaciones push (Web Push). Si faltan las claves, la app sigue
// funcionando normal y las notificaciones simplemente no se envían.
const PUSH_HABILITADO = Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
if (PUSH_HABILITADO) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:soporte@traveling.app',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
} else {
  console.warn(
    '[Traveling] Advertencia: faltan VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY en tu .env. ' +
    'Las notificaciones push quedan desactivadas hasta que las configures.'
  );
}

// -----------------------------------------------------------------------------
// 2. CONEXIÓN A BASE DE DATOS (MySQL en la nube vía variables de entorno)
// -----------------------------------------------------------------------------

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'traveling',
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true,       // evita desfaces de zona horaria en DATE/TIME
  decimalNumbers: true,    // los DECIMAL llegan como number, no string
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
});

/**
 * Crea las tablas necesarias si no existen. No inserta ningún dato de
 * ejemplo: la base de datos queda vacía hasta que alguien se registre.
 */
async function inicializarBaseDeDatos() {
  const conexion = await pool.getConnection();
  try {
    await conexion.query(
      'CREATE TABLE IF NOT EXISTS usuarios (' +
      '  id INT AUTO_INCREMENT PRIMARY KEY,' +
      '  nombre VARCHAR(150) NOT NULL,' +
      '  telefono VARCHAR(30) NOT NULL,' +
      '  email VARCHAR(150) NOT NULL UNIQUE,' +
      '  password VARCHAR(255) NOT NULL,' +
      "  rol ENUM('conductor','pasajero') NOT NULL," +
      '  vehiculo_modelo VARCHAR(100) DEFAULT NULL,' +
      '  vehiculo_placa VARCHAR(20) DEFAULT NULL,' +
      '  capacidad_puestos INT DEFAULT NULL,' +
      '  creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );

    await conexion.query(
      'CREATE TABLE IF NOT EXISTS viajes (' +
      '  id INT AUTO_INCREMENT PRIMARY KEY,' +
      '  conductor_id INT NOT NULL,' +
      '  origen VARCHAR(150) NOT NULL,' +
      '  destino VARCHAR(150) NOT NULL,' +
      '  fecha_salida DATE NOT NULL,' +
      '  hora_salida TIME NOT NULL,' +
      '  puestos_disponibles INT NOT NULL,' +
      '  puestos_totales INT NOT NULL,' +
      '  precio DECIMAL(10,2) NOT NULL,' +
      "  estado ENUM('activo','completado','cancelado') NOT NULL DEFAULT 'activo'," +
      '  creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      '  CONSTRAINT fk_viajes_conductor FOREIGN KEY (conductor_id) REFERENCES usuarios(id) ON DELETE CASCADE,' +
      '  INDEX idx_busqueda (estado, fecha_salida, origen, destino)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );

    await conexion.query(
      'CREATE TABLE IF NOT EXISTS reservas (' +
      '  id INT AUTO_INCREMENT PRIMARY KEY,' +
      '  viaje_id INT NOT NULL,' +
      '  pasajero_id INT NOT NULL,' +
      '  puestos_reservados INT NOT NULL,' +
      '  punto_recogida VARCHAR(255) NOT NULL,' +
      "  estado ENUM('confirmada','cancelada') NOT NULL DEFAULT 'confirmada'," +
      '  creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      '  CONSTRAINT fk_reservas_viaje FOREIGN KEY (viaje_id) REFERENCES viajes(id) ON DELETE CASCADE,' +
      '  CONSTRAINT fk_reservas_pasajero FOREIGN KEY (pasajero_id) REFERENCES usuarios(id) ON DELETE CASCADE,' +
      '  INDEX idx_viaje (viaje_id),' +
      '  INDEX idx_pasajero (pasajero_id)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );

    await conexion.query(
      'CREATE TABLE IF NOT EXISTS push_suscripciones (' +
      '  id INT AUTO_INCREMENT PRIMARY KEY,' +
      '  usuario_id INT NOT NULL,' +
      '  endpoint VARCHAR(500) NOT NULL,' +
      '  p256dh VARCHAR(255) NOT NULL,' +
      '  auth VARCHAR(255) NOT NULL,' +
      '  creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      '  UNIQUE KEY uq_endpoint (endpoint(255)),' +
      '  CONSTRAINT fk_push_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios(id) ON DELETE CASCADE,' +
      '  INDEX idx_push_usuario (usuario_id)' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );

    await conexion.query(
      'CREATE TABLE IF NOT EXISTS avisos_cupo (' +
      '  id INT AUTO_INCREMENT PRIMARY KEY,' +
      '  viaje_id INT NOT NULL,' +
      '  pasajero_id INT NOT NULL,' +
      '  creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,' +
      '  UNIQUE KEY uq_aviso (viaje_id, pasajero_id),' +
      '  CONSTRAINT fk_aviso_viaje FOREIGN KEY (viaje_id) REFERENCES viajes(id) ON DELETE CASCADE,' +
      '  CONSTRAINT fk_aviso_pasajero FOREIGN KEY (pasajero_id) REFERENCES usuarios(id) ON DELETE CASCADE' +
      ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );

    // Migración suave: si "viajes" ya existía de una versión anterior (sin
    // pico y placa), le añade la columna sin tocar los datos existentes.
    const [columnas] = await conexion.query(
      'SELECT COLUMN_NAME FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?',
      ['viajes', 'pico_y_placa']
    );
    if (columnas.length === 0) {
      await conexion.query(
        'ALTER TABLE viajes ADD COLUMN pico_y_placa BOOLEAN NOT NULL DEFAULT FALSE AFTER hora_salida'
      );
      console.log('[Traveling] Migración aplicada: columna viajes.pico_y_placa añadida.');
    }

    console.log('[Traveling] Tablas verificadas/creadas correctamente (base de datos vacía, sin datos de ejemplo).');
  } finally {
    conexion.release();
  }
}

// -----------------------------------------------------------------------------
// 3. UTILIDADES: CONTRASEÑAS Y TOKENS DE SESIÓN
// -----------------------------------------------------------------------------

function hashearPassword(password) {
  const sal = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, sal, 64).toString('hex');
  return sal + ':' + hash;
}

function verificarPassword(password, almacenado) {
  const partes = String(almacenado || '').split(':');
  if (partes.length !== 2) return false;
  const [sal, hashGuardado] = partes;
  const hashGuardadoBuffer = Buffer.from(hashGuardado, 'hex');
  const hashIntentado = crypto.scryptSync(password, sal, 64);
  if (hashIntentado.length !== hashGuardadoBuffer.length) return false;
  return crypto.timingSafeEqual(hashIntentado, hashGuardadoBuffer);
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(cadena) {
  let normalizada = cadena.replace(/-/g, '+').replace(/_/g, '/');
  while (normalizada.length % 4) normalizada += '=';
  return Buffer.from(normalizada, 'base64');
}

function crearToken(datos) {
  const carga = {
    id: datos.id,
    nombre: datos.nombre,
    rol: datos.rol,
    iat: Date.now(),
    exp: Date.now() + DURACION_SESION_MS,
  };
  const cargaB64 = base64url(JSON.stringify(carga));
  const firma = crypto.createHmac('sha256', SESSION_SECRET).update(cargaB64).digest('hex');
  return cargaB64 + '.' + firma;
}

function verificarToken(token) {
  if (!token || typeof token !== 'string' || token.indexOf('.') === -1) return null;
  const [cargaB64, firma] = token.split('.');
  if (!cargaB64 || !firma) return null;

  const firmaEsperada = crypto.createHmac('sha256', SESSION_SECRET).update(cargaB64).digest('hex');
  const bufFirma = Buffer.from(firma, 'hex');
  const bufEsperada = Buffer.from(firmaEsperada, 'hex');
  if (bufFirma.length !== bufEsperada.length) return null;
  if (!crypto.timingSafeEqual(bufFirma, bufEsperada)) return null;

  try {
    const datos = JSON.parse(base64urlDecode(cargaB64).toString('utf8'));
    if (!datos.exp || datos.exp < Date.now()) return null;
    return datos;
  } catch (err) {
    return null;
  }
}

// -----------------------------------------------------------------------------
// 4. VALIDACIONES
// -----------------------------------------------------------------------------

const REGEX_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REGEX_FECHA = /^\d{4}-\d{2}-\d{2}$/;
const REGEX_HORA = /^\d{2}:\d{2}(:\d{2})?$/;

// Días de la semana: el índice coincide con Date.getDay() (0 = domingo).
const DIAS_SEMANA = ['DOM', 'LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB'];

function diaValido(codigo) {
  return DIAS_SEMANA.indexOf(codigo) !== -1;
}

/**
 * Dada una lista de códigos de día (['LUN','MIE']) devuelve las fechas
 * (YYYY-MM-DD) de la semana actual (domingo a sábado) que coinciden y que
 * todavía no han pasado (desde mañana en adelante). Cada semana el
 * conductor vuelve a publicar para la semana siguiente.
 */
function generarFechasParaDias(codigosDias) {
  const fechas = [];
  const manana = new Date();
  manana.setHours(0, 0, 0, 0);
  manana.setDate(manana.getDate() + 1);

  // Domingo de la semana de "mañana" (0 = domingo, así que restamos su
  // propio índice para llegar al domingo de esa misma semana).
  const inicioSemana = new Date(manana.getTime() - manana.getDay() * 24 * 60 * 60 * 1000);
  const finSemana = new Date(inicioSemana.getTime() + 6 * 24 * 60 * 60 * 1000); // sábado

  for (let fecha = new Date(manana); fecha <= finSemana; fecha.setDate(fecha.getDate() + 1)) {
    const codigoDia = DIAS_SEMANA[fecha.getDay()];
    if (codigosDias.indexOf(codigoDia) !== -1) {
      const anio = fecha.getFullYear();
      const mes = String(fecha.getMonth() + 1).padStart(2, '0');
      const dia = String(fecha.getDate()).padStart(2, '0');
      fechas.push(anio + '-' + mes + '-' + dia);
    }
  }
  return fechas;
}

function textoValido(valor, min, max) {
  return typeof valor === 'string' && valor.trim().length >= min && valor.trim().length <= max;
}

function enteroPositivo(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n > 0;
}

function numeroNoNegativo(valor) {
  const n = Number(valor);
  return Number.isFinite(n) && n >= 0;
}

/**
 * Decide cuántos puestos de una reserva se van a cancelar. Si no viene
 * "puestos_a_cancelar" en el cuerpo, se cancela la reserva completa (para
 * no romper llamadas viejas). Si viene, se valida contra lo que de verdad
 * tiene reservado.
 */
function resolverPuestosACancelar(cuerpoPeticion, reserva) {
  const crudo = cuerpoPeticion.puestos_a_cancelar;
  if (crudo === undefined || crudo === null || crudo === '') {
    return { cantidad: reserva.puestos_reservados };
  }
  const cantidad = Number(crudo);
  if (!enteroPositivo(cantidad)) {
    return { error: 'Indica una cantidad válida de puestos a cancelar.' };
  }
  if (cantidad > reserva.puestos_reservados) {
    return { error: `Esa reserva solo tiene ${reserva.puestos_reservados} puesto(s) para cancelar.` };
  }
  return { cantidad };
}

// -----------------------------------------------------------------------------
// 5. APLICACIÓN EXPRESS
// -----------------------------------------------------------------------------

const app = express();
app.use(express.json({ limit: '1mb' }));

// Registro simple de peticiones (sin dependencias externas)
app.use((req, res, next) => {
  const inicio = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - inicio;
    console.log(`[Traveling] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

function manejadorAsincrono(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function autenticar(req, res, next) {
  const encabezado = req.headers.authorization || '';
  const token = encabezado.startsWith('Bearer ') ? encabezado.slice(7) : null;
  const datos = verificarToken(token);
  if (!datos) {
    return res.status(401).json({ ok: false, mensaje: 'Tu sesión no es válida o expiró. Inicia sesión de nuevo.' });
  }
  req.usuario = datos;
  next();
}

function requiereRol(rol) {
  return (req, res, next) => {
    if (req.usuario.rol !== rol) {
      const otro = rol === 'conductor' ? 'conductores' : 'pasajeros';
      return res.status(403).json({ ok: false, mensaje: `Esta acción es solo para ${otro}.` });
    }
    next();
  };
}

// Igual que "autenticar" pero no falla si no hay token: solo adjunta
// req.usuario cuando el token es válido. Útil para endpoints públicos que
// personalizan la respuesta cuando el visitante sí inició sesión.
function autenticarOpcional(req, res, next) {
  const encabezado = req.headers.authorization || '';
  const token = encabezado.startsWith('Bearer ') ? encabezado.slice(7) : null;
  const datos = verificarToken(token);
  req.usuario = datos || null;
  next();
}

/**
 * Envía una notificación push a todas las suscripciones activas de un
 * usuario. Si las claves VAPID no están configuradas, no hace nada. Si una
 * suscripción ya no es válida (el navegador la revocó), la borra sola.
 */
async function enviarNotificacionAUsuario(usuarioId, payload) {
  if (!PUSH_HABILITADO) return;
  try {
    const [suscripciones] = await pool.query('SELECT * FROM push_suscripciones WHERE usuario_id = ?', [usuarioId]);
    for (const s of suscripciones) {
      const suscripcion = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
      try {
        await webpush.sendNotification(suscripcion, JSON.stringify(payload));
        console.log(`[Traveling] Push enviado a usuario ${usuarioId} (suscripción ${s.id}).`);
      } catch (err) {
        const codigo = err && err.statusCode;
        if (codigo === 404 || codigo === 410 || codigo === 401 || codigo === 403) {
          // Suscripción vencida o firmada con otras claves VAPID: se borra
          // para que el usuario tenga que volver a activarla desde la app.
          await pool.query('DELETE FROM push_suscripciones WHERE id = ?', [s.id]);
          console.warn(`[Traveling] Suscripción push ${s.id} inválida (HTTP ${codigo}), eliminada.`);
        } else {
          console.error('[Traveling] Error enviando notificación push:', err && err.message);
        }
      }
    }
  } catch (err) {
    console.error('[Traveling] Error consultando suscripciones push:', err.message);
  }
}

// -----------------------------------------------------------------------------
// 6. RUTAS API — AUTENTICACIÓN
// -----------------------------------------------------------------------------

app.get('/api/salud', (req, res) => {
  res.json({ ok: true, servicio: 'Traveling', hora: new Date().toISOString() });
});

app.post('/api/auth/registro', manejadorAsincrono(async (req, res) => {
  const cuerpo = req.body || {};
  const nombre = String(cuerpo.nombre || '').trim();
  const telefono = String(cuerpo.telefono || '').trim();
  const email = String(cuerpo.email || '').trim().toLowerCase();
  const password = String(cuerpo.password || '');
  const rol = cuerpo.rol === 'conductor' ? 'conductor' : (cuerpo.rol === 'pasajero' ? 'pasajero' : null);

  if (!textoValido(nombre, 2, 150)) {
    return res.status(400).json({ ok: false, mensaje: 'Ingresa un nombre válido.' });
  }
  if (!textoValido(telefono, 6, 30)) {
    return res.status(400).json({ ok: false, mensaje: 'Ingresa un teléfono válido.' });
  }
  if (!REGEX_EMAIL.test(email)) {
    return res.status(400).json({ ok: false, mensaje: 'Ingresa un correo electrónico válido.' });
  }
  if (password.length < 6) {
    return res.status(400).json({ ok: false, mensaje: 'La contraseña debe tener al menos 6 caracteres.' });
  }
  if (!rol) {
    return res.status(400).json({ ok: false, mensaje: 'Selecciona si eres conductor o pasajero.' });
  }

  let vehiculoModelo = null;
  let vehiculoPlaca = null;
  let capacidadPuestos = null;

  if (rol === 'conductor') {
    vehiculoModelo = String(cuerpo.vehiculo_modelo || '').trim();
    vehiculoPlaca = String(cuerpo.vehiculo_placa || '').trim().toUpperCase();
    capacidadPuestos = cuerpo.capacidad_puestos;

    if (!textoValido(vehiculoModelo, 2, 100)) {
      return res.status(400).json({ ok: false, mensaje: 'Ingresa el modelo de tu vehículo.' });
    }
    if (!textoValido(vehiculoPlaca, 3, 20)) {
      return res.status(400).json({ ok: false, mensaje: 'Ingresa la placa de tu vehículo.' });
    }
    if (!enteroPositivo(capacidadPuestos) || Number(capacidadPuestos) > 20) {
      return res.status(400).json({ ok: false, mensaje: 'Ingresa una capacidad de puestos válida.' });
    }
    capacidadPuestos = Number(capacidadPuestos);
  }

  const passwordHasheada = hashearPassword(password);

  try {
    const [resultado] = await pool.query(
      'INSERT INTO usuarios (nombre, telefono, email, password, rol, vehiculo_modelo, vehiculo_placa, capacidad_puestos) VALUES (?,?,?,?,?,?,?,?)',
      [nombre, telefono, email, passwordHasheada, rol, vehiculoModelo, vehiculoPlaca, capacidadPuestos]
    );

    const usuario = {
      id: resultado.insertId,
      nombre,
      telefono,
      email,
      rol,
      vehiculo_modelo: vehiculoModelo,
      vehiculo_placa: vehiculoPlaca,
      capacidad_puestos: capacidadPuestos,
    };
    const token = crearToken(usuario);
    res.status(201).json({ ok: true, mensaje: 'Cuenta creada correctamente.', token, usuario });
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ ok: false, mensaje: 'Ese correo ya está registrado. Intenta iniciar sesión.' });
    }
    throw err;
  }
}));

app.post('/api/auth/login', manejadorAsincrono(async (req, res) => {
  const cuerpo = req.body || {};
  const email = String(cuerpo.email || '').trim().toLowerCase();
  const password = String(cuerpo.password || '');

  if (!email || !password) {
    return res.status(400).json({ ok: false, mensaje: 'Ingresa tu correo y tu contraseña.' });
  }

  const [filas] = await pool.query('SELECT * FROM usuarios WHERE email = ? LIMIT 1', [email]);
  const usuarioDb = filas[0];

  if (!usuarioDb || !verificarPassword(password, usuarioDb.password)) {
    return res.status(401).json({ ok: false, mensaje: 'Correo o contraseña incorrectos.' });
  }

  const usuario = {
    id: usuarioDb.id,
    nombre: usuarioDb.nombre,
    telefono: usuarioDb.telefono,
    email: usuarioDb.email,
    rol: usuarioDb.rol,
    vehiculo_modelo: usuarioDb.vehiculo_modelo,
    vehiculo_placa: usuarioDb.vehiculo_placa,
    capacidad_puestos: usuarioDb.capacidad_puestos,
  };
  const token = crearToken(usuario);
  res.json({ ok: true, mensaje: 'Sesión iniciada.', token, usuario });
}));

app.get('/api/auth/perfil', autenticar, manejadorAsincrono(async (req, res) => {
  const [filas] = await pool.query(
    'SELECT id, nombre, telefono, email, rol, vehiculo_modelo, vehiculo_placa, capacidad_puestos FROM usuarios WHERE id = ? LIMIT 1',
    [req.usuario.id]
  );
  const usuario = filas[0];
  if (!usuario) {
    return res.status(401).json({ ok: false, mensaje: 'Tu cuenta ya no existe.' });
  }
  res.json({ ok: true, usuario });
}));

app.put('/api/auth/perfil', autenticar, manejadorAsincrono(async (req, res) => {
  const cuerpo = req.body || {};
  const nombre = String(cuerpo.nombre || '').trim();
  const telefono = String(cuerpo.telefono || '').trim();

  if (!textoValido(nombre, 2, 150)) {
    return res.status(400).json({ ok: false, mensaje: 'Ingresa un nombre válido.' });
  }
  if (!textoValido(telefono, 6, 30)) {
    return res.status(400).json({ ok: false, mensaje: 'Ingresa un teléfono válido.' });
  }

  let vehiculoModelo = null;
  let vehiculoPlaca = null;
  let capacidadPuestos = null;

  if (req.usuario.rol === 'conductor') {
    vehiculoModelo = String(cuerpo.vehiculo_modelo || '').trim();
    vehiculoPlaca = String(cuerpo.vehiculo_placa || '').trim().toUpperCase();
    capacidadPuestos = cuerpo.capacidad_puestos;

    if (!textoValido(vehiculoModelo, 2, 100)) {
      return res.status(400).json({ ok: false, mensaje: 'Ingresa el modelo de tu vehículo.' });
    }
    if (!textoValido(vehiculoPlaca, 3, 20)) {
      return res.status(400).json({ ok: false, mensaje: 'Ingresa la placa de tu vehículo.' });
    }
    if (!enteroPositivo(capacidadPuestos) || Number(capacidadPuestos) > 20) {
      return res.status(400).json({ ok: false, mensaje: 'Ingresa una capacidad de puestos válida.' });
    }
    capacidadPuestos = Number(capacidadPuestos);

    await pool.query(
      'UPDATE usuarios SET nombre = ?, telefono = ?, vehiculo_modelo = ?, vehiculo_placa = ?, capacidad_puestos = ? WHERE id = ?',
      [nombre, telefono, vehiculoModelo, vehiculoPlaca, capacidadPuestos, req.usuario.id]
    );
  } else {
    await pool.query('UPDATE usuarios SET nombre = ?, telefono = ? WHERE id = ?', [nombre, telefono, req.usuario.id]);
  }

  const [filas] = await pool.query(
    'SELECT id, nombre, telefono, email, rol, vehiculo_modelo, vehiculo_placa, capacidad_puestos FROM usuarios WHERE id = ? LIMIT 1',
    [req.usuario.id]
  );

  res.json({ ok: true, mensaje: 'Perfil actualizado correctamente.', usuario: filas[0] });
}));

app.put('/api/auth/password', autenticar, manejadorAsincrono(async (req, res) => {
  const cuerpo = req.body || {};
  const passwordActual = String(cuerpo.password_actual || '');
  const passwordNueva = String(cuerpo.password_nueva || '');

  if (passwordNueva.length < 6) {
    return res.status(400).json({ ok: false, mensaje: 'La contraseña nueva debe tener al menos 6 caracteres.' });
  }

  const [filas] = await pool.query('SELECT password FROM usuarios WHERE id = ? LIMIT 1', [req.usuario.id]);
  const usuarioDb = filas[0];
  if (!usuarioDb || !verificarPassword(passwordActual, usuarioDb.password)) {
    return res.status(401).json({ ok: false, mensaje: 'Tu contraseña actual no es correcta.' });
  }

  const nuevoHash = hashearPassword(passwordNueva);
  await pool.query('UPDATE usuarios SET password = ? WHERE id = ?', [nuevoHash, req.usuario.id]);

  res.json({ ok: true, mensaje: 'Contraseña actualizada correctamente.' });
}));

app.delete('/api/auth/cuenta', autenticar, manejadorAsincrono(async (req, res) => {
  const cuerpo = req.body || {};
  const password = String(cuerpo.password || '');

  const [filas] = await pool.query('SELECT password FROM usuarios WHERE id = ? LIMIT 1', [req.usuario.id]);
  const usuarioDb = filas[0];
  if (!usuarioDb || !verificarPassword(password, usuarioDb.password)) {
    return res.status(401).json({ ok: false, mensaje: 'Tu contraseña no es correcta.' });
  }

  // ON DELETE CASCADE en viajes/reservas/push_suscripciones/avisos_cupo se
  // encarga de limpiar todo lo asociado a este usuario.
  await pool.query('DELETE FROM usuarios WHERE id = ?', [req.usuario.id]);

  res.json({ ok: true, mensaje: 'Tu cuenta fue eliminada permanentemente.' });
}));

// -----------------------------------------------------------------------------
// 7. RUTAS API — VIAJES
// -----------------------------------------------------------------------------

app.post('/api/viajes', autenticar, requiereRol('conductor'), manejadorAsincrono(async (req, res) => {
  const cuerpo = req.body || {};
  const origen = String(cuerpo.origen || '').trim();
  const destino = String(cuerpo.destino || '').trim();
  const horaSalida = String(cuerpo.hora_salida || '').trim();
  const puestosDisponibles = cuerpo.puestos_disponibles;
  const precio = cuerpo.precio;

  // dias_semana / pico_placa_dias llegan como array (checkboxes) o como un
  // único string si solo se marcó una casilla — normalizamos a array.
  let diasSemana = cuerpo.dias_semana || [];
  if (!Array.isArray(diasSemana)) diasSemana = [diasSemana];
  diasSemana = diasSemana.filter(diaValido);

  let diasPicoPlaca = cuerpo.pico_placa_dias || [];
  if (!Array.isArray(diasPicoPlaca)) diasPicoPlaca = [diasPicoPlaca];
  diasPicoPlaca = diasPicoPlaca.filter(diaValido);

  if (!textoValido(origen, 2, 150) || !textoValido(destino, 2, 150)) {
    return res.status(400).json({ ok: false, mensaje: 'Ingresa el origen y el destino del viaje.' });
  }
  if (origen.trim().toLowerCase() === destino.trim().toLowerCase()) {
    return res.status(400).json({ ok: false, mensaje: 'El origen y el destino no pueden ser el mismo lugar.' });
  }
  if (!REGEX_HORA.test(horaSalida)) {
    return res.status(400).json({ ok: false, mensaje: 'Ingresa una hora de salida válida.' });
  }
  if (diasSemana.length === 0) {
    return res.status(400).json({ ok: false, mensaje: 'Selecciona al menos un día de la semana en que circulas.' });
  }
  const diasEnComun = diasSemana.filter((d) => diasPicoPlaca.indexOf(d) !== -1);
  if (diasEnComun.length > 0) {
    return res.status(400).json({ ok: false, mensaje: 'Un día no puede ser a la vez día de circulación y día de pico y placa.' });
  }
  if (!enteroPositivo(puestosDisponibles)) {
    return res.status(400).json({ ok: false, mensaje: 'Ingresa una cantidad válida de puestos disponibles.' });
  }
  if (!numeroNoNegativo(precio)) {
    return res.status(400).json({ ok: false, mensaje: 'Ingresa un precio válido.' });
  }

  const [filasConductor] = await pool.query('SELECT capacidad_puestos FROM usuarios WHERE id = ? LIMIT 1', [req.usuario.id]);
  const capacidadVehiculo = filasConductor[0] ? filasConductor[0].capacidad_puestos : null;
  if (capacidadVehiculo && Number(puestosDisponibles) > Number(capacidadVehiculo)) {
    return res.status(400).json({
      ok: false,
      mensaje: `No puedes ofrecer más puestos (${puestosDisponibles}) que la capacidad de tu vehículo (${capacidadVehiculo}).`,
    });
  }

  const fechasCirculacion = generarFechasParaDias(diasSemana);
  const fechasPicoPlaca = diasPicoPlaca.length ? generarFechasParaDias(diasPicoPlaca) : [];

  if (fechasCirculacion.length === 0) {
    return res.status(400).json({
      ok: false,
      mensaje: 'Esos días ya pasaron en la semana actual (domingo a sábado). Vuelve a publicar el próximo domingo.',
    });
  }

  const filasAInsertar = [];
  for (const fecha of fechasCirculacion) {
    filasAInsertar.push([req.usuario.id, origen, destino, fecha, horaSalida, Number(puestosDisponibles), Number(puestosDisponibles), Number(precio), false]);
  }
  for (const fecha of fechasPicoPlaca) {
    filasAInsertar.push([req.usuario.id, origen, destino, fecha, horaSalida, 0, Number(puestosDisponibles), Number(precio), true]);
  }

  await pool.query(
    'INSERT INTO viajes (conductor_id, origen, destino, fecha_salida, hora_salida, puestos_disponibles, puestos_totales, precio, pico_y_placa) VALUES ?',
    [filasAInsertar]
  );

  res.status(201).json({
    ok: true,
    mensaje: `Viaje publicado: se generaron ${fechasCirculacion.length} salida(s) para esta semana (domingo a sábado).`,
    totalGenerado: fechasCirculacion.length,
  });
}));

app.get('/api/viajes', autenticarOpcional, manejadorAsincrono(async (req, res) => {
  const origen = String(req.query.origen || '').trim();
  const destino = String(req.query.destino || '').trim();
  const fecha = String(req.query.fecha || '').trim();

  // Se muestran todos los viajes activos, incluso los llenos: así el
  // pasajero puede pedir que le avisen si se libera un puesto. El frontend
  // distingue "lleno", "en pico y placa" y "con cupo" con el mismo listado.
  const condiciones = ["v.estado = 'activo'"];
  const parametros = [];

  if (origen) {
    condiciones.push('v.origen LIKE ?');
    parametros.push('%' + origen + '%');
  }
  if (destino) {
    condiciones.push('v.destino LIKE ?');
    parametros.push('%' + destino + '%');
  }
  if (fecha && REGEX_FECHA.test(fecha)) {
    condiciones.push('v.fecha_salida = ?');
    parametros.push(fecha);
  } else {
    const hoy = new Date().toISOString().slice(0, 10);
    condiciones.push('v.fecha_salida >= ?');
    parametros.push(hoy);
  }

  const pasajeroId = req.usuario ? req.usuario.id : 0;
  const sql =
    'SELECT v.id, v.origen, v.destino, v.fecha_salida, v.hora_salida, v.puestos_disponibles, v.puestos_totales, v.precio, v.estado, v.pico_y_placa, ' +
    '       u.id AS conductor_id, u.nombre AS conductor_nombre, u.telefono AS conductor_telefono, ' +
    '       u.vehiculo_modelo, u.vehiculo_placa, ' +
    '       EXISTS(SELECT 1 FROM avisos_cupo a WHERE a.viaje_id = v.id AND a.pasajero_id = ?) AS tiene_aviso ' +
    'FROM viajes v JOIN usuarios u ON v.conductor_id = u.id ' +
    'WHERE ' + condiciones.join(' AND ') + ' ' +
    'ORDER BY v.fecha_salida ASC, v.hora_salida ASC ' +
    'LIMIT 100';

  const [filas] = await pool.query(sql, [pasajeroId, ...parametros]);
  res.json({ ok: true, viajes: filas });
}));

app.get('/api/viajes/mios', autenticar, requiereRol('conductor'), manejadorAsincrono(async (req, res) => {
  const sql =
    'SELECT v.*, ' +
    '  (SELECT COALESCE(SUM(r.puestos_reservados),0) FROM reservas r WHERE r.viaje_id = v.id AND r.estado = "confirmada") AS reservas_confirmadas ' +
    "FROM viajes v WHERE v.conductor_id = ? AND v.estado = 'activo' " +
    'ORDER BY v.fecha_salida ASC, v.hora_salida ASC';
  const [filas] = await pool.query(sql, [req.usuario.id]);
  res.json({ ok: true, viajes: filas });
}));

app.get('/api/viajes/historial', autenticar, requiereRol('conductor'), manejadorAsincrono(async (req, res) => {
  const sql =
    'SELECT v.*, ' +
    '  (SELECT COALESCE(SUM(r.puestos_reservados),0) FROM reservas r WHERE r.viaje_id = v.id AND r.estado = "confirmada") AS reservas_confirmadas ' +
    "FROM viajes v WHERE v.conductor_id = ? AND v.estado IN ('completado','cancelado') " +
    'ORDER BY v.fecha_salida DESC, v.hora_salida DESC ' +
    'LIMIT 200';
  const [filas] = await pool.query(sql, [req.usuario.id]);
  res.json({ ok: true, viajes: filas });
}));

app.delete('/api/viajes/:id', autenticar, requiereRol('conductor'), manejadorAsincrono(async (req, res) => {
  const id = Number(req.params.id);
  if (!enteroPositivo(id)) return res.status(400).json({ ok: false, mensaje: 'Viaje inválido.' });

  const [filasViaje] = await pool.query('SELECT * FROM viajes WHERE id = ? LIMIT 1', [id]);
  const viaje = filasViaje[0];
  if (!viaje) return res.status(404).json({ ok: false, mensaje: 'Ese viaje no existe.' });
  if (viaje.conductor_id !== req.usuario.id) {
    return res.status(403).json({ ok: false, mensaje: 'No puedes eliminar un viaje que no publicaste.' });
  }
  if (viaje.estado === 'activo') {
    return res.status(400).json({ ok: false, mensaje: 'Solo puedes eliminar viajes de tu historial (completados o cancelados). Cancélalo primero.' });
  }

  await pool.query('DELETE FROM viajes WHERE id = ?', [id]);
  res.json({ ok: true, mensaje: 'Viaje eliminado de tu historial.' });
}));

app.put('/api/viajes/:id', autenticar, requiereRol('conductor'), manejadorAsincrono(async (req, res) => {
  const id = Number(req.params.id);
  if (!enteroPositivo(id)) return res.status(400).json({ ok: false, mensaje: 'Viaje inválido.' });

  const cuerpo = req.body || {};
  const horaSalida = String(cuerpo.hora_salida || '').trim();
  const precio = cuerpo.precio;
  const puestosTotales = cuerpo.puestos_totales;

  if (!REGEX_HORA.test(horaSalida)) {
    return res.status(400).json({ ok: false, mensaje: 'Ingresa una hora de salida válida.' });
  }
  if (!numeroNoNegativo(precio)) {
    return res.status(400).json({ ok: false, mensaje: 'Ingresa un precio válido.' });
  }
  if (!enteroPositivo(puestosTotales)) {
    return res.status(400).json({ ok: false, mensaje: 'Ingresa una cantidad válida de puestos.' });
  }

  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();

    const [filasViaje] = await conexion.query('SELECT * FROM viajes WHERE id = ? FOR UPDATE', [id]);
    const viaje = filasViaje[0];
    if (!viaje) {
      await conexion.rollback();
      return res.status(404).json({ ok: false, mensaje: 'Ese viaje no existe.' });
    }
    if (viaje.conductor_id !== req.usuario.id) {
      await conexion.rollback();
      return res.status(403).json({ ok: false, mensaje: 'No puedes editar un viaje que no publicaste.' });
    }
    if (viaje.estado !== 'activo') {
      await conexion.rollback();
      return res.status(400).json({ ok: false, mensaje: 'Solo puedes editar viajes que todavía están activos.' });
    }

    const puestosYaReservados = viaje.puestos_totales - viaje.puestos_disponibles;
    if (Number(puestosTotales) < puestosYaReservados) {
      await conexion.rollback();
      return res.status(400).json({
        ok: false,
        mensaje: `Ya hay ${puestosYaReservados} puesto(s) reservado(s): no puedes bajar de esa cantidad.`,
      });
    }

    const [filasConductor] = await conexion.query('SELECT capacidad_puestos FROM usuarios WHERE id = ? LIMIT 1', [req.usuario.id]);
    const capacidadVehiculo = filasConductor[0] ? filasConductor[0].capacidad_puestos : null;
    if (capacidadVehiculo && Number(puestosTotales) > Number(capacidadVehiculo)) {
      await conexion.rollback();
      return res.status(400).json({
        ok: false,
        mensaje: `No puedes ofrecer más puestos (${puestosTotales}) que la capacidad de tu vehículo (${capacidadVehiculo}).`,
      });
    }

    const nuevosDisponibles = Number(puestosTotales) - puestosYaReservados;

    await conexion.query(
      'UPDATE viajes SET hora_salida = ?, precio = ?, puestos_totales = ?, puestos_disponibles = ? WHERE id = ?',
      [horaSalida, Number(precio), Number(puestosTotales), nuevosDisponibles, id]
    );

    await conexion.commit();
    res.json({ ok: true, mensaje: 'Viaje actualizado correctamente.' });
  } catch (err) {
    await conexion.rollback();
    throw err;
  } finally {
    conexion.release();
  }
}));

app.patch('/api/viajes/:id/finalizar', autenticar, requiereRol('conductor'), manejadorAsincrono(async (req, res) => {
  const id = Number(req.params.id);
  if (!enteroPositivo(id)) return res.status(400).json({ ok: false, mensaje: 'Viaje inválido.' });

  const [filasViaje] = await pool.query('SELECT * FROM viajes WHERE id = ? LIMIT 1', [id]);
  const viaje = filasViaje[0];
  if (!viaje) return res.status(404).json({ ok: false, mensaje: 'Ese viaje no existe.' });
  if (viaje.conductor_id !== req.usuario.id) {
    return res.status(403).json({ ok: false, mensaje: 'No puedes finalizar un viaje que no publicaste.' });
  }
  if (viaje.estado !== 'activo') {
    return res.status(400).json({ ok: false, mensaje: 'Ese viaje ya no está activo.' });
  }
  const hoy = new Date().toISOString().slice(0, 10);
  if (viaje.fecha_salida > hoy) {
    return res.status(400).json({ ok: false, mensaje: 'Todavía no puedes finalizar un viaje que no ha empezado.' });
  }

  await pool.query("UPDATE viajes SET estado = 'completado' WHERE id = ?", [id]);

  res.json({ ok: true, mensaje: 'Viaje finalizado. Ya quedó libre en tu historial y puedes publicar uno nuevo cuando quieras.' });
}));

app.get('/api/viajes/:id/reservas', autenticar, requiereRol('conductor'), manejadorAsincrono(async (req, res) => {
  const id = Number(req.params.id);
  if (!enteroPositivo(id)) return res.status(400).json({ ok: false, mensaje: 'Viaje inválido.' });

  const [filasViaje] = await pool.query('SELECT * FROM viajes WHERE id = ? LIMIT 1', [id]);
  const viaje = filasViaje[0];
  if (!viaje) return res.status(404).json({ ok: false, mensaje: 'Ese viaje no existe.' });
  if (viaje.conductor_id !== req.usuario.id) {
    return res.status(403).json({ ok: false, mensaje: 'No puedes ver las reservas de un viaje que no publicaste.' });
  }

  const sql =
    'SELECT r.pasajero_id, u.nombre AS pasajero_nombre, u.telefono AS pasajero_telefono, ' +
    '       SUM(r.puestos_reservados) AS puestos_totales, ' +
    "       GROUP_CONCAT(r.punto_recogida SEPARATOR ' · ') AS puntos_recogida, " +
    '       COUNT(*) AS num_reservas, MIN(r.creado_en) AS creado_en ' +
    'FROM reservas r JOIN usuarios u ON r.pasajero_id = u.id ' +
    "WHERE r.viaje_id = ? AND r.estado = 'confirmada' " +
    'GROUP BY r.pasajero_id, u.nombre, u.telefono ' +
    'ORDER BY MIN(r.creado_en) ASC';
  const [filas] = await pool.query(sql, [id]);
  res.json({ ok: true, reservas: filas });
}));

app.patch('/api/viajes/:id/pasajeros/:pasajeroId/cancelar', autenticar, requiereRol('conductor'), manejadorAsincrono(async (req, res) => {
  const viajeId = Number(req.params.id);
  const pasajeroId = Number(req.params.pasajeroId);
  if (!enteroPositivo(viajeId) || !enteroPositivo(pasajeroId)) {
    return res.status(400).json({ ok: false, mensaje: 'Datos inválidos.' });
  }

  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();

    const [filasViaje] = await conexion.query('SELECT * FROM viajes WHERE id = ? FOR UPDATE', [viajeId]);
    const viaje = filasViaje[0];
    if (!viaje) {
      await conexion.rollback();
      return res.status(404).json({ ok: false, mensaje: 'Ese viaje no existe.' });
    }
    if (viaje.conductor_id !== req.usuario.id) {
      await conexion.rollback();
      return res.status(403).json({ ok: false, mensaje: 'Ese viaje no es tuyo.' });
    }

    const [reservasPasajero] = await conexion.query(
      "SELECT * FROM reservas WHERE viaje_id = ? AND pasajero_id = ? AND estado = 'confirmada' FOR UPDATE",
      [viajeId, pasajeroId]
    );
    if (reservasPasajero.length === 0) {
      await conexion.rollback();
      return res.status(404).json({ ok: false, mensaje: 'Ese pasajero no tiene una reserva activa en este viaje.' });
    }
    const totalPuestos = reservasPasajero.reduce((acumulado, r) => acumulado + r.puestos_reservados, 0);

    await conexion.query(
      "UPDATE reservas SET estado = 'cancelada' WHERE viaje_id = ? AND pasajero_id = ? AND estado = 'confirmada'",
      [viajeId, pasajeroId]
    );

    let seLiberoCupo = false;
    if (viaje.estado === 'activo') {
      const restaurados = Math.min(viaje.puestos_totales, viaje.puestos_disponibles + totalPuestos);
      await conexion.query('UPDATE viajes SET puestos_disponibles = ? WHERE id = ?', [restaurados, viaje.id]);
      seLiberoCupo = restaurados > 0;
    }

    await conexion.commit();
    res.json({ ok: true, mensaje: `Se canceló la reserva de ese pasajero (${totalPuestos} puesto(s) en total).` });

    enviarNotificacionAUsuario(pasajeroId, {
      titulo: 'Tu reserva fue cancelada',
      cuerpo: `El conductor canceló tu reserva en el viaje ${viaje.origen} → ${viaje.destino} del ${viaje.fecha_salida}.`,
      url: '/',
    });

    if (seLiberoCupo) {
      const [interesados] = await pool.query('SELECT pasajero_id FROM avisos_cupo WHERE viaje_id = ?', [viaje.id]);
      for (const interesado of interesados) {
        enviarNotificacionAUsuario(interesado.pasajero_id, {
          titulo: '¡Hay cupo disponible!',
          cuerpo: `Se liberó un puesto en el viaje ${viaje.origen} → ${viaje.destino} del ${viaje.fecha_salida}.`,
          url: '/',
        });
      }
    }
  } catch (err) {
    await conexion.rollback();
    throw err;
  } finally {
    conexion.release();
  }
}));

app.patch('/api/viajes/:id/cancelar', autenticar, requiereRol('conductor'), manejadorAsincrono(async (req, res) => {
  const id = Number(req.params.id);
  if (!enteroPositivo(id)) return res.status(400).json({ ok: false, mensaje: 'Viaje inválido.' });

  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();

    const [filasViaje] = await conexion.query('SELECT * FROM viajes WHERE id = ? FOR UPDATE', [id]);
    const viaje = filasViaje[0];
    if (!viaje) {
      await conexion.rollback();
      return res.status(404).json({ ok: false, mensaje: 'Ese viaje no existe.' });
    }
    if (viaje.conductor_id !== req.usuario.id) {
      await conexion.rollback();
      return res.status(403).json({ ok: false, mensaje: 'No puedes cancelar un viaje que no publicaste.' });
    }
    if (viaje.estado === 'cancelado') {
      await conexion.rollback();
      return res.status(400).json({ ok: false, mensaje: 'Ese viaje ya estaba cancelado.' });
    }

    await conexion.query("UPDATE viajes SET estado = 'cancelado' WHERE id = ?", [id]);
    await conexion.query("UPDATE reservas SET estado = 'cancelada' WHERE viaje_id = ? AND estado = 'confirmada'", [id]);

    await conexion.commit();
    res.json({ ok: true, mensaje: 'Viaje cancelado. Los pasajeros verán el cambio en sus reservas.' });
  } catch (err) {
    await conexion.rollback();
    throw err;
  } finally {
    conexion.release();
  }
}));

// -----------------------------------------------------------------------------
// 8. RUTAS API — RESERVAS
// -----------------------------------------------------------------------------

app.post('/api/viajes/:id/reservar', autenticar, requiereRol('pasajero'), manejadorAsincrono(async (req, res) => {
  const id = Number(req.params.id);
  if (!enteroPositivo(id)) return res.status(400).json({ ok: false, mensaje: 'Viaje inválido.' });

  const cuerpo = req.body || {};
  const puestos = Number(cuerpo.puestos_reservados);
  const puntoRecogida = String(cuerpo.punto_recogida || '').trim();

  if (!enteroPositivo(puestos)) {
    return res.status(400).json({ ok: false, mensaje: 'Indica cuántos puestos deseas reservar.' });
  }
  if (!textoValido(puntoRecogida, 3, 255)) {
    return res.status(400).json({ ok: false, mensaje: 'Indica tu punto exacto de recogida.' });
  }

  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();

    const [filasViaje] = await conexion.query('SELECT * FROM viajes WHERE id = ? FOR UPDATE', [id]);
    const viaje = filasViaje[0];
    if (!viaje) {
      await conexion.rollback();
      return res.status(404).json({ ok: false, mensaje: 'Ese viaje no existe.' });
    }
    if (viaje.estado !== 'activo') {
      await conexion.rollback();
      return res.status(400).json({ ok: false, mensaje: 'Ese viaje ya no está disponible.' });
    }
    if (viaje.conductor_id === req.usuario.id) {
      await conexion.rollback();
      return res.status(400).json({ ok: false, mensaje: 'No puedes reservar puestos en tu propio viaje.' });
    }
    if (puestos > viaje.puestos_disponibles) {
      await conexion.rollback();
      return res.status(400).json({
        ok: false,
        mensaje: `Solo quedan ${viaje.puestos_disponibles} puesto(s) disponible(s) en este viaje.`,
      });
    }

    await conexion.query(
      'INSERT INTO reservas (viaje_id, pasajero_id, puestos_reservados, punto_recogida) VALUES (?,?,?,?)',
      [id, req.usuario.id, puestos, puntoRecogida]
    );
    const nuevosDisponibles = viaje.puestos_disponibles - puestos;
    await conexion.query('UPDATE viajes SET puestos_disponibles = ? WHERE id = ?', [nuevosDisponibles, id]);

    await conexion.commit();
    res.status(201).json({ ok: true, mensaje: '¡Reserva confirmada! El conductor verá tu punto de recogida.' });

    // Aviso al conductor (no bloquea la respuesta si falla).
    enviarNotificacionAUsuario(viaje.conductor_id, {
      titulo: 'Nueva reserva en Traveling',
      cuerpo: `${req.usuario.nombre} reservó ${puestos} puesto(s) en tu viaje ${viaje.origen} → ${viaje.destino}.`,
      url: '/',
    });
  } catch (err) {
    await conexion.rollback();
    throw err;
  } finally {
    conexion.release();
  }
}));

app.get('/api/reservas/mias', autenticar, requiereRol('pasajero'), manejadorAsincrono(async (req, res) => {
  const sql =
    'SELECT r.id, r.puestos_reservados, r.punto_recogida, r.estado, r.creado_en, ' +
    '       v.id AS viaje_id, v.origen, v.destino, v.fecha_salida, v.hora_salida, v.precio, v.estado AS viaje_estado, ' +
    '       u.nombre AS conductor_nombre, u.telefono AS conductor_telefono, u.vehiculo_modelo, u.vehiculo_placa ' +
    'FROM reservas r ' +
    'JOIN viajes v ON r.viaje_id = v.id ' +
    'JOIN usuarios u ON v.conductor_id = u.id ' +
    "WHERE r.pasajero_id = ? AND r.estado = 'confirmada' AND v.estado = 'activo' " +
    'ORDER BY v.fecha_salida ASC, v.hora_salida ASC';
  const [filas] = await pool.query(sql, [req.usuario.id]);
  res.json({ ok: true, reservas: filas });
}));

app.get('/api/reservas/historial', autenticar, requiereRol('pasajero'), manejadorAsincrono(async (req, res) => {
  const sql =
    'SELECT r.id, r.puestos_reservados, r.punto_recogida, r.estado, r.creado_en, ' +
    '       v.id AS viaje_id, v.origen, v.destino, v.fecha_salida, v.hora_salida, v.precio, v.estado AS viaje_estado, ' +
    '       u.nombre AS conductor_nombre, u.telefono AS conductor_telefono, u.vehiculo_modelo, u.vehiculo_placa ' +
    'FROM reservas r ' +
    'JOIN viajes v ON r.viaje_id = v.id ' +
    'JOIN usuarios u ON v.conductor_id = u.id ' +
    "WHERE r.pasajero_id = ? AND (r.estado = 'cancelada' OR v.estado IN ('completado','cancelado')) " +
    'ORDER BY v.fecha_salida DESC, v.hora_salida DESC ' +
    'LIMIT 200';
  const [filas] = await pool.query(sql, [req.usuario.id]);
  res.json({ ok: true, reservas: filas });
}));

app.delete('/api/reservas/:id', autenticar, requiereRol('pasajero'), manejadorAsincrono(async (req, res) => {
  const id = Number(req.params.id);
  if (!enteroPositivo(id)) return res.status(400).json({ ok: false, mensaje: 'Reserva inválida.' });

  const [filasReserva] = await pool.query(
    'SELECT r.*, v.estado AS viaje_estado FROM reservas r JOIN viajes v ON r.viaje_id = v.id WHERE r.id = ? LIMIT 1',
    [id]
  );
  const reserva = filasReserva[0];
  if (!reserva) return res.status(404).json({ ok: false, mensaje: 'Esa reserva no existe.' });
  if (reserva.pasajero_id !== req.usuario.id) {
    return res.status(403).json({ ok: false, mensaje: 'Esa reserva no te pertenece.' });
  }
  const estaEnHistorial = reserva.estado === 'cancelada' || reserva.viaje_estado === 'completado' || reserva.viaje_estado === 'cancelado';
  if (!estaEnHistorial) {
    return res.status(400).json({ ok: false, mensaje: 'Solo puedes eliminar reservas de tu historial.' });
  }

  await pool.query('DELETE FROM reservas WHERE id = ?', [id]);
  res.json({ ok: true, mensaje: 'Reserva eliminada de tu historial.' });
}));

app.patch('/api/reservas/:id/cancelar', autenticar, requiereRol('pasajero'), manejadorAsincrono(async (req, res) => {
  const id = Number(req.params.id);
  if (!enteroPositivo(id)) return res.status(400).json({ ok: false, mensaje: 'Reserva inválida.' });

  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();

    const [filasReserva] = await conexion.query('SELECT * FROM reservas WHERE id = ? FOR UPDATE', [id]);
    const reserva = filasReserva[0];
    if (!reserva) {
      await conexion.rollback();
      return res.status(404).json({ ok: false, mensaje: 'Esa reserva no existe.' });
    }
    if (reserva.pasajero_id !== req.usuario.id) {
      await conexion.rollback();
      return res.status(403).json({ ok: false, mensaje: 'Esa reserva no te pertenece.' });
    }
    if (reserva.estado !== 'confirmada') {
      await conexion.rollback();
      return res.status(400).json({ ok: false, mensaje: 'Esa reserva ya estaba cancelada.' });
    }

    const resuelto = resolverPuestosACancelar(req.body || {}, reserva);
    if (resuelto.error) {
      await conexion.rollback();
      return res.status(400).json({ ok: false, mensaje: resuelto.error });
    }
    const puestosACancelar = resuelto.cantidad;
    const puestosRestantes = reserva.puestos_reservados - puestosACancelar;

    if (puestosRestantes > 0) {
      await conexion.query('UPDATE reservas SET puestos_reservados = ? WHERE id = ?', [puestosRestantes, id]);
    } else {
      await conexion.query("UPDATE reservas SET estado = 'cancelada' WHERE id = ?", [id]);
    }

    const [filasViaje] = await conexion.query('SELECT * FROM viajes WHERE id = ? FOR UPDATE', [reserva.viaje_id]);
    const viaje = filasViaje[0];
    let seLiberoCupo = false;
    if (viaje && viaje.estado === 'activo') {
      const restaurados = Math.min(viaje.puestos_totales, viaje.puestos_disponibles + puestosACancelar);
      await conexion.query('UPDATE viajes SET puestos_disponibles = ? WHERE id = ?', [restaurados, viaje.id]);
      seLiberoCupo = restaurados > 0;
    }

    await conexion.commit();
    const mensajeExito = puestosRestantes > 0
      ? `Cancelaste ${puestosACancelar} puesto(s). Te quedan ${puestosRestantes} puesto(s) confirmado(s) en ese viaje.`
      : 'Reserva cancelada correctamente.';
    res.json({ ok: true, mensaje: mensajeExito });

    // Avisa a quienes pidieron que les avisaran de cupo en este viaje.
    if (seLiberoCupo) {
      const [interesados] = await pool.query('SELECT pasajero_id FROM avisos_cupo WHERE viaje_id = ?', [viaje.id]);
      for (const interesado of interesados) {
        enviarNotificacionAUsuario(interesado.pasajero_id, {
          titulo: '¡Hay cupo disponible!',
          cuerpo: `Se liberó un puesto en el viaje ${viaje.origen} → ${viaje.destino} del ${viaje.fecha_salida}.`,
          url: '/',
        });
      }
    }
  } catch (err) {
    await conexion.rollback();
    throw err;
  } finally {
    conexion.release();
  }
}));

app.patch('/api/reservas/:id/cancelar-conductor', autenticar, requiereRol('conductor'), manejadorAsincrono(async (req, res) => {
  const id = Number(req.params.id);
  if (!enteroPositivo(id)) return res.status(400).json({ ok: false, mensaje: 'Reserva inválida.' });

  const conexion = await pool.getConnection();
  try {
    await conexion.beginTransaction();

    const [filasReserva] = await conexion.query('SELECT * FROM reservas WHERE id = ? FOR UPDATE', [id]);
    const reserva = filasReserva[0];
    if (!reserva) {
      await conexion.rollback();
      return res.status(404).json({ ok: false, mensaje: 'Esa reserva no existe.' });
    }

    const [filasViaje] = await conexion.query('SELECT * FROM viajes WHERE id = ? FOR UPDATE', [reserva.viaje_id]);
    const viaje = filasViaje[0];
    if (!viaje || viaje.conductor_id !== req.usuario.id) {
      await conexion.rollback();
      return res.status(403).json({ ok: false, mensaje: 'Esa reserva no pertenece a uno de tus viajes.' });
    }
    if (reserva.estado !== 'confirmada') {
      await conexion.rollback();
      return res.status(400).json({ ok: false, mensaje: 'Esa reserva ya estaba cancelada.' });
    }

    const resuelto = resolverPuestosACancelar(req.body || {}, reserva);
    if (resuelto.error) {
      await conexion.rollback();
      return res.status(400).json({ ok: false, mensaje: resuelto.error });
    }
    const puestosACancelar = resuelto.cantidad;
    const puestosRestantes = reserva.puestos_reservados - puestosACancelar;

    if (puestosRestantes > 0) {
      await conexion.query('UPDATE reservas SET puestos_reservados = ? WHERE id = ?', [puestosRestantes, id]);
    } else {
      await conexion.query("UPDATE reservas SET estado = 'cancelada' WHERE id = ?", [id]);
    }

    let seLiberoCupo = false;
    if (viaje.estado === 'activo') {
      const restaurados = Math.min(viaje.puestos_totales, viaje.puestos_disponibles + puestosACancelar);
      await conexion.query('UPDATE viajes SET puestos_disponibles = ? WHERE id = ?', [restaurados, viaje.id]);
      seLiberoCupo = restaurados > 0;
    }

    await conexion.commit();
    const mensajeExito = puestosRestantes > 0
      ? `Cancelaste ${puestosACancelar} de los ${reserva.puestos_reservados} puesto(s) de ese pasajero.`
      : 'Reserva del pasajero cancelada correctamente.';
    res.json({ ok: true, mensaje: mensajeExito });

    // Avisa al pasajero de que el conductor canceló (parte de) su reserva.
    enviarNotificacionAUsuario(reserva.pasajero_id, {
      titulo: puestosRestantes > 0 ? 'Se canceló parte de tu reserva' : 'Tu reserva fue cancelada',
      cuerpo: puestosRestantes > 0
        ? `El conductor canceló ${puestosACancelar} puesto(s) de tu reserva en ${viaje.origen} → ${viaje.destino}. Te quedan ${puestosRestantes}.`
        : `El conductor canceló tu reserva en el viaje ${viaje.origen} → ${viaje.destino} del ${viaje.fecha_salida}.`,
      url: '/',
    });

    // Avisa a quienes pidieron que les avisaran de cupo en este viaje.
    if (seLiberoCupo) {
      const [interesados] = await pool.query('SELECT pasajero_id FROM avisos_cupo WHERE viaje_id = ?', [viaje.id]);
      for (const interesado of interesados) {
        enviarNotificacionAUsuario(interesado.pasajero_id, {
          titulo: '¡Hay cupo disponible!',
          cuerpo: `Se liberó un puesto en el viaje ${viaje.origen} → ${viaje.destino} del ${viaje.fecha_salida}.`,
          url: '/',
        });
      }
    }
  } catch (err) {
    await conexion.rollback();
    throw err;
  } finally {
    conexion.release();
  }
}));

// -----------------------------------------------------------------------------
// 8.5 RUTAS API — NOTIFICACIONES PUSH
// -----------------------------------------------------------------------------

app.get('/api/notificaciones/clave-publica', (req, res) => {
  res.json({ ok: true, clavePublica: PUSH_HABILITADO ? process.env.VAPID_PUBLIC_KEY : null });
});

app.post('/api/notificaciones/suscribir', autenticar, manejadorAsincrono(async (req, res) => {
  const cuerpo = req.body || {};
  const endpoint = String(cuerpo.endpoint || '').trim();
  const claves = cuerpo.keys || {};
  const p256dh = String(claves.p256dh || '').trim();
  const auth = String(claves.auth || '').trim();

  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ ok: false, mensaje: 'Suscripción de notificaciones inválida.' });
  }

  await pool.query(
    'INSERT INTO push_suscripciones (usuario_id, endpoint, p256dh, auth) VALUES (?,?,?,?) ' +
    'ON DUPLICATE KEY UPDATE usuario_id = VALUES(usuario_id), p256dh = VALUES(p256dh), auth = VALUES(auth)',
    [req.usuario.id, endpoint, p256dh, auth]
  );

  res.status(201).json({ ok: true, mensaje: 'Notificaciones activadas.' });
}));

app.post('/api/viajes/:id/avisar-cupo', autenticar, requiereRol('pasajero'), manejadorAsincrono(async (req, res) => {
  const id = Number(req.params.id);
  if (!enteroPositivo(id)) return res.status(400).json({ ok: false, mensaje: 'Viaje inválido.' });

  await pool.query(
    'INSERT IGNORE INTO avisos_cupo (viaje_id, pasajero_id) VALUES (?, ?)',
    [id, req.usuario.id]
  );

  res.status(201).json({ ok: true, mensaje: 'Listo, te avisaremos si se libera un puesto en este viaje.' });
}));

app.delete('/api/viajes/:id/avisar-cupo', autenticar, requiereRol('pasajero'), manejadorAsincrono(async (req, res) => {
  const id = Number(req.params.id);
  if (!enteroPositivo(id)) return res.status(400).json({ ok: false, mensaje: 'Viaje inválido.' });

  await pool.query('DELETE FROM avisos_cupo WHERE viaje_id = ? AND pasajero_id = ?', [id, req.usuario.id]);

  res.json({ ok: true, mensaje: 'Aviso cancelado.' });
}));

// -----------------------------------------------------------------------------
// 8.6 SERVICE WORKER (necesario para notificaciones push del navegador)
// -----------------------------------------------------------------------------

const SERVICE_WORKER_JS = `self.addEventListener('install', function (event) {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', function (event) {
  var datos = {};
  try {
    datos = event.data ? event.data.json() : {};
  } catch (err) {
    datos = { titulo: 'Traveling', cuerpo: 'Tienes una novedad.' };
  }

  var opciones = {
    body: datos.cuerpo || '',
    icon: undefined,
    badge: undefined,
    data: { url: datos.url || '/' }
  };

  event.waitUntil(
    self.registration.showNotification(datos.titulo || 'Traveling', opciones).then(function () {
      return self.clients.matchAll({ type: 'window' }).then(function (listaClientes) {
        listaClientes.forEach(function (cliente) {
          cliente.postMessage({ tipo: 'notificacion-push', payload: datos });
        });
      });
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(self.clients.openWindow(url));
});
`;

// -----------------------------------------------------------------------------
// 9. FRONTEND (HTML + Tailwind CDN + JS vanilla) — servido desde GET /
// -----------------------------------------------------------------------------

const PAGINA_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1">
<title>Traveling — Viaja acompañado</title>
<meta name="description" content="Traveling conecta conductores y pasajeros para viajes interurbanos compartidos.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = {
    theme: {
      extend: {
        colors: {
          travel: {
            bg: '#0A0D14',
            surface: '#141926',
            surface2: '#1B2233',
            ink: '#F3F4F6',
            primary: '#2A3548',
            primarydark: '#1B2233',
            accent: '#D4AF5E',
            accentdark: '#B8902F',
            success: '#3FCF8E',
            danger: '#F0685A',
            muted: '#9AA1B1',
            line: 'rgba(255,255,255,0.10)'
          }
        },
        fontFamily: {
          display: ['Space Grotesk', 'sans-serif'],
          body: ['Inter', 'sans-serif']
        },
        boxShadow: {
          card: '0 1px 0 rgba(255,255,255,0.04) inset, 0 20px 48px -20px rgba(0,0,0,0.65)',
          lift: '0 16px 36px -14px rgba(0,0,0,0.7)'
        }
      }
    }
  };
</script>
<style>
  html { color-scheme: dark; }
  body { background-color: #0A0D14; font-family: 'Inter', sans-serif; color: #F3F4F6; }
  .fuente-display { font-family: 'Space Grotesk', sans-serif; letter-spacing: -0.01em; }
  ::selection { background-color: #D4AF5E; color: #0A0D14; }

  .ruta-linea { display: flex; align-items: center; gap: 8px; }
  .ruta-linea .punto { width: 8px; height: 8px; border-radius: 999px; flex-shrink: 0; }
  .ruta-linea .punto-origen { background-color: #3FCF8E; }
  .ruta-linea .punto-destino { width: 9px; height: 9px; background-color: transparent; border: 2px solid #D4AF5E; }
  .ruta-linea .segmento { flex: 1; border-top: 1.5px dashed rgba(255,255,255,0.18); min-width: 16px; }

  @keyframes traveling-entrada {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .anim-entrada { animation: traveling-entrada 0.35s cubic-bezier(0.16,1,0.3,1); }

  @keyframes traveling-toast {
    from { opacity: 0; transform: translateY(-8px) scale(0.98); }
    to { opacity: 1; transform: translateY(0) scale(1); }
  }
  .anim-toast { animation: traveling-toast 0.2s ease-out; }

  .pestana-activa { color: #F3F4F6; border-bottom: 2px solid #D4AF5E; font-weight: 700; }
  .pestana-inactiva { color: #767D8C; border-bottom: 2px solid transparent; font-weight: 600; }
  .pestana-inactiva:hover { color: #C7CBD4; }

  input, select, textarea, button { font-family: 'Inter', sans-serif; }

  input:focus, select:focus, textarea:focus {
    outline: none;
    border-color: #D4AF5E !important;
    box-shadow: 0 0 0 4px rgba(212,175,94,0.18);
  }
  button:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px rgba(212,175,94,0.4);
  }

  .tarjeta-rol { cursor: pointer; }
  .tarjeta-rol input { position: absolute; opacity: 0; pointer-events: none; }

  /* ---------- Sistema de componentes premium (tema oscuro) ---------- */

  .tarjeta {
    background-color: #141926;
    border-radius: 1.25rem;
    box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset, 0 20px 48px -20px rgba(0,0,0,0.65);
    border: 1px solid rgba(255,255,255,0.06);
    color: #F3F4F6;
  }

  .campo {
    width: 100%;
    border-radius: 0.85rem;
    border: 1.5px solid rgba(255,255,255,0.12);
    padding: 0.7rem 1rem;
    font-size: 0.875rem;
    background-color: #1B2233;
    color: #F3F4F6;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
  }
  .campo::placeholder { color: #6B7280; }
  .campo:disabled { opacity: 0.6; }

  .etiqueta {
    display: block;
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: #9AA1B1;
    margin-bottom: 0.4rem;
  }

  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    border-radius: 0.85rem;
    font-weight: 700;
    font-size: 0.875rem;
    padding: 0.8rem 1.4rem;
    transition: transform 0.15s cubic-bezier(0.16,1,0.3,1), box-shadow 0.2s ease, background-color 0.15s ease, opacity 0.15s ease;
    cursor: pointer;
    border: none;
  }
  .btn:active { transform: translateY(1px) scale(0.99); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

  .btn-sm { padding: 0.55rem 1.1rem; font-size: 0.8125rem; border-radius: 0.7rem; }

  .btn-primario { background-color: #232C40; color: #F3F4F6; border: 1px solid rgba(255,255,255,0.09); }
  .btn-primario:hover { background-color: #2D384F; box-shadow: 0 10px 24px -10px rgba(0,0,0,0.6); transform: translateY(-1px); }

  .btn-accent { background: linear-gradient(135deg, #E3C177, #B8902F); color: #1B1206; }
  .btn-accent:hover { box-shadow: 0 10px 26px -10px rgba(212,175,94,0.55); transform: translateY(-1px); }

  .btn-oscuro { background-color: #0A0D14; color: #F3F4F6; border: 1px solid rgba(255,255,255,0.1); }
  .btn-oscuro:hover { background-color: #05070B; transform: translateY(-1px); }

  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    font-size: 0.75rem;
    font-weight: 700;
    border-radius: 0.65rem;
    padding: 0.5rem 0.85rem;
    transition: background-color 0.15s ease, transform 0.15s ease;
    white-space: nowrap;
    cursor: pointer;
    border: none;
  }
  .chip:active { transform: scale(0.97); }
  .chip-danger { color: #FF8A7C; background-color: rgba(240,104,90,0.14); }
  .chip-danger:hover { background-color: rgba(240,104,90,0.22); }
  .chip-primary { color: #E3E6EC; background-color: rgba(255,255,255,0.08); }
  .chip-primary:hover { background-color: rgba(255,255,255,0.14); }
  .chip-success { color: #6FE3AC; background-color: rgba(63,207,142,0.14); }
  .chip-success:hover { background-color: rgba(63,207,142,0.22); }

  @keyframes chip-parpadeo {
    0%, 100% { background-color: rgba(212,175,94,0.25); box-shadow: 0 0 0 0 rgba(212,175,94,0.45); }
    50% { background-color: rgba(212,175,94,0.6); box-shadow: 0 0 0 5px rgba(212,175,94,0); }
  }
  .chip-alerta { color: #FFF3D6; background-color: rgba(212,175,94,0.3); animation: chip-parpadeo 1.6s ease-in-out infinite; }
  .chip-alerta:hover { animation-play-state: paused; background-color: rgba(212,175,94,0.5); }

  .insignia {
    display: inline-flex;
    align-items: center;
    font-size: 0.6875rem;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
    padding: 0.3rem 0.6rem;
    border-radius: 999px;
    white-space: nowrap;
  }

  #app { background-color: #0A0D14; }
</style>
</head>
<body class="min-h-screen">

<div id="toasts" class="fixed top-4 right-4 left-4 sm:left-auto z-50 flex flex-col items-end gap-2 pointer-events-none"></div>

<div id="app" class="min-h-screen"></div>

<script>
(function () {
  'use strict';

  var API_BASE = '/api';

  var estado = {
    token: localStorage.getItem('traveling_token') || null,
    usuario: null,
    vista: 'cargando',
    authTab: 'login',
    registroRol: 'pasajero',
    conductorTab: 'publicar',
    pasajeroTab: 'buscar',
    viajesBusqueda: [],
    busquedaCargando: false,
    busquedaHecha: false,
    misViajes: [],
    misViajesCargando: false,
    historialViajes: [],
    historialViajesCargando: false,
    detallePasajeros: {},
    viajeExpandido: {},
    misReservas: [],
    misReservasCargando: false,
    historialReservas: [],
    historialReservasCargando: false,
    diasVisiblesMisViajes: 2,
    diasVisiblesBusqueda: 2,
    modalViajeId: null,
    modalPerfilAbierto: false,
    modalEditarViajeId: null,
    enviando: false,
    notificacionesEstado: 'default',
    clavePublicaVapid: null
  };

  try {
    var usuarioGuardado = localStorage.getItem('traveling_usuario');
    if (usuarioGuardado) estado.usuario = JSON.parse(usuarioGuardado);
  } catch (err) {
    estado.usuario = null;
  }

  // ---------------------------------------------------------------------
  // Utilidades
  // ---------------------------------------------------------------------

  function escaparHTML(valor) {
    if (valor === null || valor === undefined) return '';
    var mapa = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(valor).replace(/[&<>"']/g, function (c) { return mapa[c]; });
  }

  function formatearPrecio(numero) {
    var n = Number(numero) || 0;
    try {
      return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
    } catch (err) {
      return '$' + n;
    }
  }

  function formatearFecha(fechaStr) {
    if (!fechaStr) return '';
    var partes = String(fechaStr).slice(0, 10);
    try {
      var d = new Date(partes + 'T00:00:00');
      var texto = new Intl.DateTimeFormat('es-CO', { weekday: 'short', day: 'numeric', month: 'short' }).format(d);
      return texto.charAt(0).toUpperCase() + texto.slice(1);
    } catch (err) {
      return partes;
    }
  }

  function formatearHora(horaStr) {
    if (!horaStr) return '';
    return String(horaStr).slice(0, 5);
  }

  function fechaMinima() {
    var hoy = new Date();
    var mes = String(hoy.getMonth() + 1).padStart(2, '0');
    var dia = String(hoy.getDate()).padStart(2, '0');
    return hoy.getFullYear() + '-' + mes + '-' + dia;
  }

  function casillasDias(nombreCampo, colorTailwind) {
    var codigos = ['LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB', 'DOM'];
    var etiquetas = { LUN: 'L', MAR: 'M', MIE: 'X', JUE: 'J', VIE: 'V', SAB: 'S', DOM: 'D' };
    var p = [];
    p.push('<div class="flex gap-1.5 flex-wrap">');
    for (var i = 0; i < codigos.length; i++) {
      var codigo = codigos[i];
      p.push('<label class="cursor-pointer" title="' + codigo + '">');
      p.push('  <input type="checkbox" name="' + nombreCampo + '" value="' + codigo + '" class="peer sr-only">');
      p.push('  <span class="flex items-center justify-center w-9 h-9 rounded-full border border-travel-line text-sm font-semibold text-travel-muted transition peer-checked:bg-' + colorTailwind + ' peer-checked:text-white peer-checked:border-' + colorTailwind + '">' + etiquetas[codigo] + '</span>');
      p.push('</label>');
    }
    p.push('</div>');
    return p.join('');
  }

  function mostrarToast(mensaje, tipo) {
    var contenedor = document.getElementById('toasts');
    if (!contenedor) return;
    var estilos = {
      exito: 'background-color:#15803D;color:#F3F4F6;border:1px solid rgba(255,255,255,0.12);',
      error: 'background-color:#B91C1C;color:#F3F4F6;border:1px solid rgba(255,255,255,0.12);',
      info: 'background-color:#232C40;color:#F3F4F6;border:1px solid rgba(255,255,255,0.12);'
    };
    var estilo = estilos[tipo] || estilos.info;
    var toast = document.createElement('div');
    toast.className = 'anim-toast pointer-events-auto max-w-xs sm:max-w-sm w-full rounded-xl px-4 py-3 shadow-lift text-sm font-medium';
    toast.setAttribute('style', estilo);
    toast.textContent = mensaje;
    contenedor.appendChild(toast);
    setTimeout(function () {
      toast.style.transition = 'opacity 0.25s ease, transform 0.25s ease';
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-6px)';
      setTimeout(function () { toast.remove(); }, 260);
    }, 3200);
  }

  function api(ruta, opciones) {
    opciones = opciones || {};
    var headers = { 'Content-Type': 'application/json' };
    if (estado.token) headers['Authorization'] = 'Bearer ' + estado.token;
    var config = {
      method: opciones.method || 'GET',
      headers: headers
    };
    if (opciones.cuerpo) config.body = JSON.stringify(opciones.cuerpo);

    return fetch(API_BASE + ruta, config).then(function (respuesta) {
      return respuesta.json().catch(function () { return {}; }).then(function (datos) {
        if (!respuesta.ok) {
          if (respuesta.status === 401) {
            cerrarSesion(false);
          }
          var error = new Error((datos && datos.mensaje) || 'Ocurrió un error inesperado.');
          throw error;
        }
        return datos;
      });
    });
  }

  // ---------------------------------------------------------------------
  // Sonido y notificaciones push
  // ---------------------------------------------------------------------

  function reproducirSonidoAviso() {
    try {
      var ContextoAudio = window.AudioContext || window.webkitAudioContext;
      if (!ContextoAudio) return;
      var contexto = new ContextoAudio();
      var oscilador = contexto.createOscillator();
      var ganancia = contexto.createGain();
      oscilador.type = 'sine';
      oscilador.frequency.setValueAtTime(880, contexto.currentTime);
      oscilador.frequency.setValueAtTime(1174, contexto.currentTime + 0.12);
      ganancia.gain.setValueAtTime(0.15, contexto.currentTime);
      ganancia.gain.exponentialRampToValueAtTime(0.001, contexto.currentTime + 0.45);
      oscilador.connect(ganancia);
      ganancia.connect(contexto.destination);
      oscilador.start();
      oscilador.stop(contexto.currentTime + 0.45);
    } catch (err) {
      // Sin soporte de audio: no pasa nada, seguimos sin sonido.
    }
  }

  function convertirClaveVapid(claveBase64) {
    var resto = claveBase64.length % 4;
    var relleno = resto ? new Array(5 - resto).join('=') : '';
    var base64 = (claveBase64 + relleno).replace(/-/g, '+').replace(/_/g, '/');
    var cadenaCruda = window.atob(base64);
    var arreglo = new Uint8Array(cadenaCruda.length);
    for (var i = 0; i < cadenaCruda.length; i++) {
      arreglo[i] = cadenaCruda.charCodeAt(i);
    }
    return arreglo;
  }

  function registrarServiceWorker() {
    if (!('serviceWorker' in navigator)) return Promise.resolve(null);
    return navigator.serviceWorker.register('/sw.js').then(function (registro) {
      // Espera a que quede realmente activo antes de usarlo, si no,
      // pushManager.subscribe puede fallar en el primer intento.
      return navigator.serviceWorker.ready.then(function () { return registro; });
    }).catch(function (err) {
      console.error('[Traveling] No se pudo registrar el Service Worker:', err);
      return null;
    });
  }

  function obtenerClavePublicaVapid() {
    if (estado.clavePublicaVapid) return Promise.resolve(estado.clavePublicaVapid);
    return api('/notificaciones/clave-publica', { method: 'GET' }).then(function (datos) {
      estado.clavePublicaVapid = datos.clavePublica;
      return datos.clavePublica;
    });
  }

  function activarNotificaciones() {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
      mostrarToast('Este navegador no soporta notificaciones push.', 'error');
      return Promise.resolve(false);
    }

    if (Notification.permission === 'denied') {
      mostrarToast('Tienes las notificaciones bloqueadas para este sitio. Actívalas desde el candado/ajustes del navegador junto a la dirección web.', 'error');
      return Promise.resolve(false);
    }

    return Notification.requestPermission().then(function (permiso) {
      estado.notificacionesEstado = permiso;
      render();
      if (permiso !== 'granted') {
        mostrarToast('No se activaron las notificaciones: el permiso quedó en "' + permiso + '".', 'info');
        return false;
      }

      return obtenerClavePublicaVapid().then(function (clavePublica) {
        if (!clavePublica) {
          mostrarToast('Las notificaciones aún no están configuradas en el servidor (faltan las claves VAPID).', 'error');
          return false;
        }

        return registrarServiceWorker().then(function (registro) {
          if (!registro) {
            mostrarToast('No se pudo preparar el Service Worker en este navegador.', 'error');
            return false;
          }

          return registro.pushManager.getSubscription().then(function (existente) {
            if (existente) return existente;
            return registro.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: convertirClaveVapid(clavePublica)
            });
          }).then(function (suscripcion) {
            return api('/notificaciones/suscribir', { method: 'POST', cuerpo: suscripcion.toJSON() }).then(function () {
              mostrarToast('Notificaciones activadas. Así vas a sonar.', 'exito');
              reproducirSonidoAviso();
              render();
              return true;
            });
          }).catch(function (err) {
            console.error('[Traveling] Error creando la suscripción push:', err);
            mostrarToast('No se pudo activar el push: ' + (err && err.message ? err.message : 'error desconocido') + '.', 'error');
            return false;
          });
        });
      });
    }).catch(function (err) {
      console.error('[Traveling] Error activando notificaciones:', err);
      mostrarToast('No pudimos activar las notificaciones.', 'error');
      return false;
    });
  }

  // ---------------------------------------------------------------------
  // Sesión
  // ---------------------------------------------------------------------

  function guardarSesion(token, usuario) {
    estado.token = token;
    estado.usuario = usuario;
    localStorage.setItem('traveling_token', token);
    localStorage.setItem('traveling_usuario', JSON.stringify(usuario));
  }

  function cerrarSesion(rerenderizar) {
    estado.token = null;
    estado.usuario = null;
    estado.vista = 'auth';
    estado.misViajes = [];
    estado.misReservas = [];
    estado.viajesBusqueda = [];
    estado.busquedaHecha = false;
    localStorage.removeItem('traveling_token');
    localStorage.removeItem('traveling_usuario');
    if (rerenderizar !== false) render();
  }

  function iniciarApp() {
    if ('Notification' in window) {
      estado.notificacionesEstado = Notification.permission;
    }
    registrarServiceWorker();

    if (estado.token) {
      api('/auth/perfil', { method: 'GET' }).then(function (datos) {
        estado.usuario = datos.usuario;
        localStorage.setItem('traveling_usuario', JSON.stringify(datos.usuario));
        estado.vista = datos.usuario.rol;
        render();
        if (estado.vista === 'pasajero') cargarBusqueda();
      }).catch(function () {
        cerrarSesion();
      });
    } else {
      estado.vista = 'auth';
      render();
    }
  }

  // ---------------------------------------------------------------------
  // Render principal
  // ---------------------------------------------------------------------

  function render() {
    var raiz = document.getElementById('app');
    var html = '';
    html += renderEncabezado();
    if (estado.vista === 'cargando') {
      html += '<div class="flex items-center justify-center py-24 text-travel-muted">Cargando…</div>';
    } else if (estado.vista === 'auth') {
      html += vistaAuth();
    } else if (estado.vista === 'conductor') {
      html += vistaConductor();
    } else if (estado.vista === 'pasajero') {
      html += vistaPasajero();
    }
    if (estado.modalPerfilAbierto) html += modalPerfil();
    raiz.innerHTML = html;
  }

  function renderEncabezado() {
    var partes = [];
    partes.push('<header class="sticky top-0 z-30" style="background: linear-gradient(135deg, #152238, #0A1220); box-shadow: 0 1px 0 rgba(255,255,255,0.06), 0 12px 32px -16px rgba(10,18,32,0.6);">');
    partes.push('  <div class="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">');
    partes.push('    <div class="flex items-center gap-2.5">');
    partes.push('      <span class="w-8 h-8 rounded-lg flex items-center justify-center" style="background: linear-gradient(135deg, #D8B563, #B8902F);"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 12L21 4L13 22L11 13L3 12Z" fill="#10192B"/></svg></span>');
    partes.push('      <span class="fuente-display text-xl font-bold tracking-tight text-white">Traveling</span>');
    partes.push('    </div>');
    if (estado.usuario) {
      var inicial = escaparHTML((estado.usuario.nombre || '?').trim().charAt(0).toUpperCase());
      var notiActivas = estado.notificacionesEstado === 'granted';
      partes.push('    <div class="flex items-center gap-2 sm:gap-3">');
      if (!notiActivas) {
        partes.push('      <button data-action="activar-notificaciones" title="Activar notificaciones" class="w-9 h-9 flex items-center justify-center rounded-full bg-white/10 hover:bg-white/20 transition text-base">🔔</button>');
      } else {
        partes.push('      <span title="Notificaciones activadas" class="w-9 h-9 flex items-center justify-center rounded-full text-base" style="background-color: rgba(201,162,75,0.22);">🔔</span>');
      }
      partes.push('      <div class="hidden sm:flex flex-col items-end leading-tight">');
      partes.push('        <span class="text-sm font-semibold text-white">' + escaparHTML(estado.usuario.nombre) + '</span>');
      partes.push('        <span class="text-xs" style="color: rgba(255,255,255,0.5);">' + (estado.usuario.rol === 'conductor' ? 'Conductor' : 'Pasajero') + '</span>');
      partes.push('      </div>');
      partes.push('      <button data-action="abrir-perfil" title="Mi perfil" class="w-9 h-9 rounded-full text-travel-primarydark flex items-center justify-center font-display font-bold text-sm transition hover:opacity-90" style="background: linear-gradient(135deg, #D8B563, #B8902F); box-shadow: 0 0 0 2px rgba(255,255,255,0.15);">' + inicial + '</button>');
      partes.push('      <button data-action="cerrar-sesion" class="text-xs sm:text-sm font-semibold text-white/85 hover:text-white transition rounded-lg px-3 py-2 hover:bg-white/8" style="border: 1px solid rgba(255,255,255,0.15);">Salir</button>');
      partes.push('    </div>');
    }
    partes.push('  </div>');
    partes.push('</header>');
    return partes.join('');
  }

  // ---------------------------------------------------------------------
  // Vista: autenticación
  // ---------------------------------------------------------------------

  function vistaAuth() {
    var p = [];
    p.push('<div class="max-w-md mx-auto px-4 sm:px-6 py-12 sm:py-20 anim-entrada">');

    p.push('  <div class="text-center mb-10">');
    p.push('    <span class="insignia mb-4" style="background-color: rgba(201,162,75,0.14); color: #A9822E;">✦ Transporte compartido</span>');
    p.push('    <h1 class="fuente-display text-4xl font-bold text-travel-ink leading-tight mt-4">Viaja <span style="color: #B8902F;">acompañado</span></h1>');
    p.push('    <p class="text-travel-muted mt-3 text-[15px]">Conductores y pasajeros conectados sin llamadas ni anotaciones.</p>');
    p.push('  </div>');

    p.push('  <div class="flex border-b border-travel-line mb-6">');
    p.push('    <button data-action="mostrar-login" class="flex-1 py-3 text-sm ' + (estado.authTab === 'login' ? 'pestana-activa' : 'pestana-inactiva') + '">Iniciar sesión</button>');
    p.push('    <button data-action="mostrar-registro" class="flex-1 py-3 text-sm ' + (estado.authTab === 'registro' ? 'pestana-activa' : 'pestana-inactiva') + '">Crear cuenta</button>');
    p.push('  </div>');

    if (estado.authTab === 'login') {
      p.push(formularioLogin());
    } else {
      p.push(formularioRegistro());
    }

    p.push('</div>');
    return p.join('');
  }

  function formularioLogin() {
    var p = [];
    p.push('<form id="form-login" class="tarjeta p-6 flex flex-col gap-4">');
    p.push('  <div>');
    p.push('    <label class="etiqueta">Correo electrónico</label>');
    p.push('    <input type="email" name="email" required autocomplete="email" placeholder="tucorreo@ejemplo.com" class="campo">');
    p.push('  </div>');
    p.push('  <div>');
    p.push('    <label class="etiqueta">Contraseña</label>');
    p.push('    <input type="password" name="password" required autocomplete="current-password" placeholder="••••••••" class="campo">');
    p.push('  </div>');
    p.push('  <button type="submit" class="mt-2 btn btn-primario">Iniciar sesión</button>');
    p.push('</form>');
    return p.join('');
  }

  function formularioRegistro() {
    var esConductor = estado.registroRol === 'conductor';
    var p = [];
    p.push('<form id="form-registro" class="tarjeta p-6 flex flex-col gap-4">');

    p.push('  <div>');
    p.push('    <label class="block text-sm font-medium text-travel-ink mb-2">¿Cómo quieres usar Traveling?</label>');
    p.push('    <div class="grid grid-cols-2 gap-3">');
    p.push('      <label class="tarjeta-rol relative rounded-xl border-2 ' + (!esConductor ? 'border-travel-accent bg-travel-accent/10' : 'border-travel-line') + ' px-3 py-3 text-center">');
    p.push('        <input type="radio" name="rol" value="pasajero" ' + (!esConductor ? 'checked' : '') + '>');
    p.push('        <span class="block text-sm font-semibold text-travel-ink">Soy pasajero</span>');
    p.push('        <span class="block text-xs text-travel-muted mt-0.5">Busco viajes</span>');
    p.push('      </label>');
    p.push('      <label class="tarjeta-rol relative rounded-xl border-2 ' + (esConductor ? 'border-travel-accent bg-travel-accent/10' : 'border-travel-line') + ' px-3 py-3 text-center">');
    p.push('        <input type="radio" name="rol" value="conductor" ' + (esConductor ? 'checked' : '') + '>');
    p.push('        <span class="block text-sm font-semibold text-travel-ink">Soy conductor</span>');
    p.push('        <span class="block text-xs text-travel-muted mt-0.5">Publico viajes</span>');
    p.push('      </label>');
    p.push('    </div>');
    p.push('  </div>');

    p.push('  <div>');
    p.push('    <label class="etiqueta">Nombre completo</label>');
    p.push('    <input type="text" name="nombre" required minlength="2" maxlength="150" placeholder="Ej. Camila Ramírez" class="campo">');
    p.push('  </div>');
    p.push('  <div>');
    p.push('    <label class="etiqueta">Teléfono</label>');
    p.push('    <input type="tel" name="telefono" required minlength="6" maxlength="30" placeholder="Ej. 3001234567" class="campo">');
    p.push('  </div>');
    p.push('  <div>');
    p.push('    <label class="etiqueta">Correo electrónico</label>');
    p.push('    <input type="email" name="email" required placeholder="tucorreo@ejemplo.com" class="campo">');
    p.push('  </div>');
    p.push('  <div>');
    p.push('    <label class="etiqueta">Contraseña</label>');
    p.push('    <input type="password" name="password" required minlength="6" placeholder="Mínimo 6 caracteres" class="campo">');
    p.push('  </div>');

    p.push('  <div id="campos-vehiculo" class="flex flex-col gap-4 ' + (esConductor ? '' : 'hidden') + '">');
    p.push('    <div class="h-px bg-travel-line my-1"></div>');
    p.push('    <p class="text-xs font-semibold text-travel-muted uppercase tracking-wide">Datos de tu vehículo</p>');
    p.push('    <div>');
    p.push('      <label class="etiqueta">Modelo del vehículo</label>');
    p.push('      <input type="text" name="vehiculo_modelo" ' + (esConductor ? 'required' : '') + ' maxlength="100" placeholder="Ej. Chevrolet Spark 2020" class="campo">');
    p.push('    </div>');
    p.push('    <div class="grid grid-cols-2 gap-3">');
    p.push('      <div>');
    p.push('        <label class="etiqueta">Placa</label>');
    p.push('        <input type="text" name="vehiculo_placa" ' + (esConductor ? 'required' : '') + ' maxlength="20" placeholder="ABC123" class="campo uppercase">');
    p.push('      </div>');
    p.push('      <div>');
    p.push('        <label class="etiqueta">Capacidad</label>');
    p.push('        <input type="number" name="capacidad_puestos" ' + (esConductor ? 'required' : '') + ' min="1" max="20" placeholder="Ej. 4" class="campo">');
    p.push('      </div>');
    p.push('    </div>');
    p.push('  </div>');

    p.push('  <button type="submit" class="mt-2 btn btn-primario">Crear cuenta</button>');
    p.push('</form>');
    return p.join('');
  }

  // ---------------------------------------------------------------------
  // Vista: conductor
  // ---------------------------------------------------------------------

  function vistaConductor() {
    var p = [];
    p.push('<div class="max-w-3xl mx-auto px-4 sm:px-6 py-6 anim-entrada">');
    p.push('  <div class="flex border-b border-travel-line mb-6">');
    p.push('    <button data-action="tab-conductor-publicar" class="px-4 py-3 text-sm font-semibold ' + (estado.conductorTab === 'publicar' ? 'pestana-activa' : 'pestana-inactiva') + '">Publicar viaje</button>');
    p.push('    <button data-action="tab-conductor-mis-viajes" class="px-4 py-3 text-sm font-semibold ' + (estado.conductorTab === 'mis-viajes' ? 'pestana-activa' : 'pestana-inactiva') + '">Mis viajes</button>');
    p.push('    <button data-action="tab-conductor-historial" class="px-4 py-3 text-sm font-semibold ' + (estado.conductorTab === 'historial' ? 'pestana-activa' : 'pestana-inactiva') + '">Historial</button>');
    p.push('  </div>');

    if (estado.conductorTab === 'publicar') {
      p.push(formularioPublicarViaje());
    } else if (estado.conductorTab === 'mis-viajes') {
      p.push(listaMisViajes());
    } else {
      p.push(listaHistorialViajes());
    }

    if (estado.modalEditarViajeId) {
      p.push(modalEditarViaje());
    }

    p.push('</div>');
    return p.join('');
  }

  function formularioPublicarViaje() {
    var p = [];
    p.push('<form id="form-publicar-viaje" class="tarjeta p-6 flex flex-col gap-4 max-w-lg">');
    p.push('  <div class="grid grid-cols-2 gap-3">');
    p.push('    <div>');
    p.push('      <label class="etiqueta">Origen</label>');
    p.push('      <input type="text" name="origen" required minlength="2" maxlength="150" placeholder="Ej. Medellín" class="campo">');
    p.push('    </div>');
    p.push('    <div>');
    p.push('      <label class="etiqueta">Destino</label>');
    p.push('      <input type="text" name="destino" required minlength="2" maxlength="150" placeholder="Ej. Bogotá" class="campo">');
    p.push('    </div>');
    p.push('  </div>');
    p.push('  <div>');
    p.push('    <label class="etiqueta">Hora de salida</label>');
    p.push('    <input type="time" name="hora_salida" required class="w-full sm:w-48 rounded-xl border border-travel-line px-4 py-2.5 text-sm">');
    p.push('  </div>');
    p.push('  <div>');
    p.push('    <label class="etiqueta">¿Qué días de la semana circulas?</label>');
    p.push('    <p class="text-xs text-travel-muted mb-2">Se publican las salidas de esta semana (domingo a sábado) en esos días. La próxima semana debes volver a publicar.</p>');
    p.push(casillasDias('dias_semana', 'travel-primary'));
    p.push('  </div>');
    p.push('  <div>');
    p.push('    <label class="etiqueta">¿Tienes pico y placa? <span class="font-normal text-travel-muted">(opcional)</span></label>');
    p.push('    <p class="text-xs text-travel-muted mb-2">Marca el día que tu vehículo no puede circular. Los pasajeros lo verán marcado como "EN PICO Y PLACA".</p>');
    p.push(casillasDias('pico_placa_dias', 'travel-danger'));
    p.push('  </div>');
    p.push('  <div class="grid grid-cols-2 gap-3">');
    p.push('    <div>');
    p.push('      <label class="etiqueta">Puestos disponibles</label>');
    p.push('      <input type="number" name="puestos_disponibles" required min="1" max="' + (estado.usuario.capacidad_puestos || 20) + '" placeholder="Ej. 3" class="campo">');
    p.push('    </div>');
    p.push('    <div>');
    p.push('      <label class="etiqueta">Precio por puesto (COP)</label>');
    p.push('      <input type="number" name="precio" required min="0" step="1000" placeholder="Ej. 35000" class="campo">');
    p.push('    </div>');
    p.push('  </div>');
    p.push('  <button type="submit" class="mt-2 btn btn-accent">Publicar viaje</button>');
    p.push('</form>');
    return p.join('');
  }

  function agruparPorFecha(lista) {
    var grupos = [];
    var mapa = {};
    for (var i = 0; i < lista.length; i++) {
      var f = lista[i].fecha_salida;
      if (!(f in mapa)) {
        mapa[f] = grupos.length;
        grupos.push({ fecha: f, items: [] });
      }
      grupos[mapa[f]].items.push(lista[i]);
    }
    return grupos;
  }

  function listaMisViajes() {
    var p = [];
    if (estado.misViajesCargando) {
      p.push('<div class="text-center text-travel-muted py-16">Cargando tus viajes…</div>');
      return p.join('');
    }
    if (!estado.misViajes.length) {
      p.push('<div class="text-center py-16">');
      p.push('  <p class="text-travel-muted">Todavía no has publicado ningún viaje.</p>');
      p.push('</div>');
      return p.join('');
    }

    var grupos = agruparPorFecha(estado.misViajes);
    var totalDias = grupos.length;
    var diasAMostrar = Math.min(estado.diasVisiblesMisViajes, totalDias);

    p.push('<div class="flex flex-col gap-7">');
    for (var g = 0; g < diasAMostrar; g++) {
      var grupo = grupos[g];
      p.push('<div>');
      p.push('  <p class="etiqueta mb-3">' + formatearFecha(grupo.fecha) + '</p>');
      p.push('  <div class="flex flex-col gap-4">');

      for (var i = 0; i < grupo.items.length; i++) {
        var v = grupo.items[i];
        var expandido = !!estado.viajeExpandido[v.id];
        var estadoBadge = v.estado === 'activo'
          ? '<span class="insignia bg-travel-success/10 text-travel-success">Activo</span>'
          : v.estado === 'cancelado'
            ? '<span class="insignia bg-travel-danger/10 text-travel-danger">Cancelado</span>'
            : '<span class="insignia bg-travel-muted/10 text-travel-muted">Completado</span>';

        p.push('<div class="tarjeta p-5">');
        p.push('  <div class="flex items-start justify-between gap-3">');
        p.push('    <div class="flex-1">');
        p.push('      <div class="ruta-linea mb-2">');
        p.push('        <span class="punto punto-origen"></span><span class="segmento"></span><span class="punto punto-destino"></span>');
        p.push('      </div>');
        p.push('      <div class="flex items-center gap-2 flex-wrap">');
        p.push('        <span class="font-display font-bold text-travel-ink">' + escaparHTML(v.origen) + ' → ' + escaparHTML(v.destino) + '</span>');
        p.push('        ' + estadoBadge);
        p.push('      </div>');
        p.push('      <p class="text-sm text-travel-muted mt-1">' + formatearFecha(v.fecha_salida) + ' · ' + formatearHora(v.hora_salida) + ' · ' + formatearPrecio(v.precio) + ' por puesto</p>');
        p.push('    </div>');
        p.push('    <div class="text-right shrink-0">');
        p.push('      <p class="font-display font-bold text-travel-accent">' + v.puestos_disponibles + '/' + v.puestos_totales + '</p>');
        p.push('      <p class="text-xs text-travel-muted">puestos libres</p>');
        p.push('    </div>');
        p.push('  </div>');

        p.push('  <div class="flex items-center gap-2 mt-4 flex-wrap">');
        p.push('    <button data-action="ver-pasajeros" data-id="' + v.id + '" class="chip ' + (!expandido && v.reservas_confirmadas > 0 ? 'chip-alerta' : 'chip-primary') + '">' + (expandido ? 'Ocultar pasajeros' : 'Ver pasajeros (' + (v.reservas_confirmadas || 0) + ')') + '</button>');
        if (v.estado === 'activo') {
          p.push('    <button data-action="finalizar-viaje" data-id="' + v.id + '" class="chip chip-success">✓ Finalizar viaje</button>');
          p.push('    <button data-action="editar-viaje" data-id="' + v.id + '" class="chip chip-primary">Editar</button>');
          p.push('    <button data-action="cancelar-viaje" data-id="' + v.id + '" class="chip chip-danger">Cancelar viaje</button>');
        }
        p.push('  </div>');

        if (expandido) {
          p.push('  <div class="mt-4 border-t border-travel-line pt-4">');
          p.push(detallePasajerosHTML(v.id));
          p.push('  </div>');
        }

        p.push('</div>');
      }

      p.push('  </div>');
      p.push('</div>');
    }
    p.push('</div>');

    if (totalDias > diasAMostrar) {
      p.push('<div class="text-center mt-7">');
      p.push('  <button data-action="mostrar-mas-dias-mis-viajes" class="btn btn-sm btn-primario">Ver ' + (totalDias - diasAMostrar) + ' día(s) más</button>');
      p.push('</div>');
    }

    return p.join('');
  }

  function listaHistorialViajes() {
    var p = [];
    if (estado.historialViajesCargando) {
      p.push('<div class="text-center text-travel-muted py-16">Cargando tu historial…</div>');
      return p.join('');
    }
    if (!estado.historialViajes.length) {
      p.push('<div class="text-center py-16"><p class="text-travel-muted">Todavía no tienes viajes completados o cancelados.</p></div>');
      return p.join('');
    }

    p.push('<div class="flex flex-col gap-4">');
    for (var i = 0; i < estado.historialViajes.length; i++) {
      var v = estado.historialViajes[i];
      var expandido = !!estado.viajeExpandido[v.id];
      var estadoBadge = v.estado === 'cancelado'
        ? '<span class="insignia bg-travel-danger/10 text-travel-danger">Cancelado</span>'
        : '<span class="insignia bg-travel-muted/10 text-travel-muted">Completado</span>';

      p.push('<div class="tarjeta p-5 opacity-90">');
      p.push('  <div class="flex items-start justify-between gap-3">');
      p.push('    <div class="flex-1">');
      p.push('      <div class="flex items-center gap-2 flex-wrap">');
      p.push('        <span class="font-display font-bold text-travel-ink">' + escaparHTML(v.origen) + ' → ' + escaparHTML(v.destino) + '</span>');
      p.push('        ' + estadoBadge);
      p.push('      </div>');
      p.push('      <p class="text-sm text-travel-muted mt-1">' + formatearFecha(v.fecha_salida) + ' · ' + formatearHora(v.hora_salida) + ' · ' + formatearPrecio(v.precio) + ' por puesto</p>');
      p.push('    </div>');
      p.push('  </div>');
      p.push('  <div class="flex items-center gap-2 mt-4">');
      p.push('    <button data-action="ver-pasajeros" data-id="' + v.id + '" class="chip chip-primary">' + (expandido ? 'Ocultar pasajeros' : 'Ver pasajeros (' + (v.reservas_confirmadas || 0) + ')') + '</button>');
      p.push('    <button data-action="eliminar-viaje-historial" data-id="' + v.id + '" class="chip chip-danger">Eliminar</button>');
      p.push('  </div>');
      if (expandido) {
        p.push('  <div class="mt-4 border-t border-travel-line pt-4">');
        p.push(detallePasajerosHTML(v.id));
        p.push('  </div>');
      }
      p.push('</div>');
    }
    p.push('</div>');
    return p.join('');
  }

  function modalEditarViaje() {
    var viaje = null;
    for (var i = 0; i < estado.misViajes.length; i++) {
      if (estado.misViajes[i].id === estado.modalEditarViajeId) { viaje = estado.misViajes[i]; break; }
    }
    if (!viaje) return '';

    var p = [];
    p.push('<div class="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/70 px-0 sm:px-4">');
    p.push('  <div class="tarjeta w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl p-6 anim-entrada">');
    p.push('    <div class="flex items-center justify-between mb-4">');
    p.push('      <h3 class="fuente-display text-lg font-bold text-travel-ink">Editar viaje</h3>');
    p.push('      <button data-action="cerrar-modal-editar-viaje" class="text-travel-muted hover:text-travel-ink text-xl leading-none">&times;</button>');
    p.push('    </div>');
    p.push('    <p class="text-sm text-travel-muted mb-4">' + escaparHTML(viaje.origen) + ' → ' + escaparHTML(viaje.destino) + ' · ' + formatearFecha(viaje.fecha_salida) + '</p>');
    p.push('    <form id="form-editar-viaje" class="flex flex-col gap-4">');
    p.push('      <input type="hidden" name="viaje_id" value="' + viaje.id + '">');
    p.push('      <div>');
    p.push('        <label class="etiqueta">Hora de salida</label>');
    p.push('        <input type="time" name="hora_salida" required value="' + formatearHora(viaje.hora_salida) + '" class="campo">');
    p.push('      </div>');
    p.push('      <div class="grid grid-cols-2 gap-3">');
    p.push('        <div>');
    p.push('          <label class="etiqueta">Puestos totales</label>');
    p.push('          <input type="number" name="puestos_totales" required min="1" max="20" value="' + viaje.puestos_totales + '" class="campo">');
    p.push('        </div>');
    p.push('        <div>');
    p.push('          <label class="etiqueta">Precio por puesto</label>');
    p.push('          <input type="number" name="precio" required min="0" step="1000" value="' + viaje.precio + '" class="campo">');
    p.push('        </div>');
    p.push('      </div>');
    if (viaje.puestos_totales - viaje.puestos_disponibles > 0) {
      p.push('      <p class="text-xs text-travel-muted">Ya hay ' + (viaje.puestos_totales - viaje.puestos_disponibles) + ' puesto(s) reservado(s): no puedes bajar de esa cantidad.</p>');
    }
    p.push('      <button type="submit" class="btn btn-primario">Guardar cambios</button>');
    p.push('    </form>');
    p.push('  </div>');
    p.push('</div>');
    return p.join('');
  }

  function detallePasajerosHTML(viajeId) {
    var lista = estado.detallePasajeros[viajeId];
    if (!lista) {
      return '<p class="text-sm text-travel-muted">Cargando pasajeros…</p>';
    }
    if (!lista.length) {
      return '<p class="text-sm text-travel-muted">Todavía nadie ha reservado en este viaje.</p>';
    }
    var p = [];
    p.push('<div class="flex flex-col gap-3">');
    for (var i = 0; i < lista.length; i++) {
      var r = lista[i];
      var notaReservas = r.num_reservas > 1 ? ' (' + r.num_reservas + ' reservas)' : '';
      p.push('<div class="flex items-start justify-between gap-3 bg-travel-bg rounded-xl p-3">');
      p.push('  <div>');
      p.push('    <p class="text-sm font-semibold text-travel-ink">' + escaparHTML(r.pasajero_nombre) + ' · ' + r.puestos_totales + ' puesto(s)' + notaReservas + '</p>');
      p.push('    <p class="text-xs text-travel-muted mt-0.5">Recogida: ' + escaparHTML(r.puntos_recogida) + '</p>');
      p.push('  </div>');
      p.push('  <div class="text-right shrink-0 flex flex-col items-end gap-1.5">');
      p.push('    <a href="tel:' + escaparHTML(r.pasajero_telefono) + '" class="text-xs font-semibold text-travel-accent whitespace-nowrap">' + escaparHTML(r.pasajero_telefono) + '</a>');
      p.push('    <button data-action="cancelar-reserva-conductor" data-viaje="' + viajeId + '" data-pasajero="' + r.pasajero_id + '" class="chip chip-danger">Cancelar</button>');
      p.push('  </div>');
      p.push('</div>');
    }
    p.push('</div>');
    return p.join('');
  }

  // ---------------------------------------------------------------------
  // Vista: pasajero
  // ---------------------------------------------------------------------

  function vistaPasajero() {
    var p = [];
    p.push('<div class="max-w-3xl mx-auto px-4 sm:px-6 py-6 anim-entrada">');
    p.push('  <div class="flex border-b border-travel-line mb-6">');
    p.push('    <button data-action="tab-pasajero-buscar" class="px-4 py-3 text-sm font-semibold ' + (estado.pasajeroTab === 'buscar' ? 'pestana-activa' : 'pestana-inactiva') + '">Buscar viaje</button>');
    p.push('    <button data-action="tab-pasajero-mis-reservas" class="px-4 py-3 text-sm font-semibold ' + (estado.pasajeroTab === 'mis-reservas' ? 'pestana-activa' : 'pestana-inactiva') + '">Mis reservas</button>');
    p.push('    <button data-action="tab-pasajero-historial" class="px-4 py-3 text-sm font-semibold ' + (estado.pasajeroTab === 'historial' ? 'pestana-activa' : 'pestana-inactiva') + '">Historial</button>');
    p.push('  </div>');

    if (estado.pasajeroTab === 'buscar') {
      p.push(formularioBusqueda());
      p.push('<div class="mt-6">');
      p.push(listaResultadosBusqueda());
      p.push('</div>');
    } else if (estado.pasajeroTab === 'mis-reservas') {
      p.push(listaMisReservas());
    } else {
      p.push(listaHistorialReservas());
    }

    if (estado.modalViajeId) {
      p.push(modalReserva());
    }

    p.push('</div>');
    return p.join('');
  }

  function formularioBusqueda() {
    var p = [];
    p.push('<form id="form-busqueda" class="tarjeta p-4 sm:p-5 flex flex-col sm:flex-row gap-3">');
    p.push('  <input type="text" name="origen" placeholder="Origen" class="flex-1 rounded-xl border border-travel-line px-4 py-2.5 text-sm">');
    p.push('  <input type="text" name="destino" placeholder="Destino" class="flex-1 rounded-xl border border-travel-line px-4 py-2.5 text-sm">');
    p.push('  <input type="date" name="fecha" min="' + fechaMinima() + '" class="rounded-xl border border-travel-line px-4 py-2.5 text-sm">');
    p.push('  <button type="submit" class="btn btn-sm btn-primario whitespace-nowrap">Buscar</button>');
    p.push('</form>');
    return p.join('');
  }

  function listaResultadosBusqueda() {
    var p = [];
    if (estado.busquedaCargando) {
      p.push('<div class="text-center text-travel-muted py-16">Buscando viajes…</div>');
      return p.join('');
    }
    if (estado.busquedaHecha && !estado.viajesBusqueda.length) {
      p.push('<div class="text-center py-16">');
      p.push('  <p class="text-travel-muted">No encontramos viajes con esos filtros. Prueba con otra fecha o ruta.</p>');
      p.push('</div>');
      return p.join('');
    }

    var grupos = agruparPorFecha(estado.viajesBusqueda);
    var totalDias = grupos.length;
    var diasAMostrar = Math.min(estado.diasVisiblesBusqueda, totalDias);

    p.push('<div class="flex flex-col gap-7">');
    for (var g = 0; g < diasAMostrar; g++) {
      var grupo = grupos[g];
      p.push('<div>');
      p.push('  <p class="etiqueta mb-3">' + formatearFecha(grupo.fecha) + '</p>');
      p.push('  <div class="flex flex-col gap-4">');

      for (var i = 0; i < grupo.items.length; i++) {
        var v = grupo.items[i];
        var inicial = escaparHTML((v.conductor_nombre || '?').trim().charAt(0).toUpperCase());
        p.push('<div class="tarjeta p-5 flex flex-col gap-4">');
        p.push('  <div class="flex items-start justify-between gap-3">');
        p.push('    <div class="flex-1">');
        p.push('      <div class="ruta-linea mb-2">');
        p.push('        <span class="punto punto-origen"></span><span class="segmento"></span><span class="punto punto-destino"></span>');
        p.push('      </div>');
        p.push('      <p class="font-display font-bold text-travel-ink">' + escaparHTML(v.origen) + ' → ' + escaparHTML(v.destino) + '</p>');
        p.push('      <p class="text-sm text-travel-muted mt-1">' + formatearFecha(v.fecha_salida) + ' · ' + formatearHora(v.hora_salida) + '</p>');
        p.push('    </div>');
        p.push('    <div class="text-right shrink-0">');
        p.push('      <p class="font-display font-bold text-travel-accent text-lg">' + formatearPrecio(v.precio) + '</p>');
        if (!v.pico_y_placa) {
          p.push('      <p class="text-xs text-travel-muted mt-0.5">' + v.puestos_disponibles + ' puesto(s) libre(s)</p>');
        }
        p.push('    </div>');
        p.push('  </div>');

        p.push('  <div class="flex items-center justify-between gap-3 border-t border-travel-line pt-4">');
        p.push('    <div class="flex items-center gap-2">');
        p.push('      <div class="w-9 h-9 rounded-full bg-white/10 text-travel-ink flex items-center justify-center font-display font-bold text-sm">' + inicial + '</div>');
        p.push('      <div class="leading-tight">');
        p.push('        <p class="text-sm font-semibold text-travel-ink">' + escaparHTML(v.conductor_nombre) + '</p>');
        p.push('        <p class="text-xs text-travel-muted">' + escaparHTML(v.vehiculo_modelo) + ' · ' + escaparHTML(v.vehiculo_placa) + '</p>');
        p.push('      </div>');
        p.push('    </div>');
        if (v.pico_y_placa) {
          p.push('    <span class="text-xs font-bold px-3 py-2 rounded-full bg-travel-danger/10 text-travel-danger whitespace-nowrap">EN PICO Y PLACA</span>');
        } else if (v.puestos_disponibles > 0) {
          p.push('    <div class="text-right">');
          p.push('      <button data-action="abrir-modal-reserva" data-id="' + v.id + '" class="btn btn-sm btn-accent">Reservar</button>');
          p.push('    </div>');
        } else {
          p.push('    <div class="text-right">');
          p.push('      <p class="text-xs text-travel-muted mb-1">Sin cupo por ahora</p>');
          if (v.tiene_aviso) {
            p.push('      <button data-action="quitar-aviso-cupo" data-id="' + v.id + '" class="chip chip-success">🔔 Te avisaremos</button>');
          } else {
            p.push('      <button data-action="avisar-cupo" data-id="' + v.id + '" class="chip chip-primary">🔔 Avisarme si hay cupo</button>');
          }
          p.push('    </div>');
        }
        p.push('  </div>');
        p.push('</div>');
      }

      p.push('  </div>');
      p.push('</div>');
    }
    p.push('</div>');

    if (totalDias > diasAMostrar) {
      p.push('<div class="text-center mt-7">');
      p.push('  <button data-action="mostrar-mas-dias-busqueda" class="btn btn-sm btn-primario">Ver ' + (totalDias - diasAMostrar) + ' día(s) más</button>');
      p.push('</div>');
    }

    return p.join('');
  }

  function modalReserva() {
    var viaje = null;
    for (var i = 0; i < estado.viajesBusqueda.length; i++) {
      if (estado.viajesBusqueda[i].id === estado.modalViajeId) { viaje = estado.viajesBusqueda[i]; break; }
    }
    if (!viaje) return '';

    var p = [];
    p.push('<div class="fixed inset-0 z-40 flex items-end sm:items-center justify-center bg-black/70 px-0 sm:px-4">');
    p.push('  <div class="tarjeta w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl p-6 anim-entrada">');
    p.push('    <div class="flex items-center justify-between mb-4">');
    p.push('      <h3 class="fuente-display text-lg font-bold text-travel-ink">Reservar puesto</h3>');
    p.push('      <button data-action="cerrar-modal" class="text-travel-muted hover:text-travel-ink text-xl leading-none">&times;</button>');
    p.push('    </div>');
    p.push('    <p class="text-sm text-travel-muted mb-4">' + escaparHTML(viaje.origen) + ' → ' + escaparHTML(viaje.destino) + ' · ' + formatearFecha(viaje.fecha_salida) + ' · ' + formatearHora(viaje.hora_salida) + '</p>');
    p.push('    <form id="form-reservar" class="flex flex-col gap-4">');
    p.push('      <input type="hidden" name="viaje_id" value="' + viaje.id + '">');
    p.push('      <div>');
    p.push('        <label class="etiqueta">Puestos a reservar</label>');
    p.push('        <input type="number" name="puestos_reservados" required min="1" max="' + viaje.puestos_disponibles + '" value="1" class="campo">');
    p.push('      </div>');
    p.push('      <div>');
    p.push('        <label class="etiqueta">Tu punto exacto de recogida</label>');
    p.push('        <textarea name="punto_recogida" required minlength="3" maxlength="255" rows="2" placeholder="Ej. Carrera 43A #5-15, El Poblado" class="campo"></textarea>');
    p.push('      </div>');
    p.push('      <button type="submit" class="btn btn-primario">Confirmar reserva</button>');
    p.push('    </form>');
    p.push('  </div>');
    p.push('</div>');
    return p.join('');
  }

  function modalPerfil() {
    if (!estado.usuario) return '';
    var u = estado.usuario;
    var esConductor = u.rol === 'conductor';
    var p = [];
    p.push('<div class="fixed inset-0 z-40 flex items-start sm:items-center justify-center bg-black/70 px-0 sm:px-4 overflow-y-auto py-6">');
    p.push('  <div class="tarjeta w-full sm:max-w-md rounded-t-3xl sm:rounded-2xl p-6 anim-entrada">');
    p.push('    <div class="flex items-center justify-between mb-4">');
    p.push('      <h3 class="fuente-display text-lg font-bold text-travel-ink">Mi perfil</h3>');
    p.push('      <button data-action="cerrar-modal-perfil" class="text-travel-muted hover:text-travel-ink text-xl leading-none">&times;</button>');
    p.push('    </div>');

    p.push('    <form id="form-editar-perfil" class="flex flex-col gap-4">');
    p.push('      <div>');
    p.push('        <label class="etiqueta">Nombre completo</label>');
    p.push('        <input type="text" name="nombre" required minlength="2" maxlength="150" value="' + escaparHTML(u.nombre) + '" class="campo">');
    p.push('      </div>');
    p.push('      <div>');
    p.push('        <label class="etiqueta">Teléfono</label>');
    p.push('        <input type="tel" name="telefono" required minlength="6" maxlength="30" value="' + escaparHTML(u.telefono) + '" class="campo">');
    p.push('      </div>');
    p.push('      <div>');
    p.push('        <label class="etiqueta">Correo</label>');
    p.push('        <input type="email" disabled value="' + escaparHTML(u.email) + '" class="campo bg-travel-bg text-travel-muted">');
    p.push('      </div>');
    if (esConductor) {
      p.push('      <div class="h-px bg-travel-line my-1"></div>');
      p.push('      <p class="text-xs font-semibold text-travel-muted uppercase tracking-wide">Datos de tu vehículo</p>');
      p.push('      <div>');
      p.push('        <label class="etiqueta">Modelo del vehículo</label>');
      p.push('        <input type="text" name="vehiculo_modelo" required maxlength="100" value="' + escaparHTML(u.vehiculo_modelo) + '" class="campo">');
      p.push('      </div>');
      p.push('      <div class="grid grid-cols-2 gap-3">');
      p.push('        <div>');
      p.push('          <label class="etiqueta">Placa</label>');
      p.push('          <input type="text" name="vehiculo_placa" required maxlength="20" value="' + escaparHTML(u.vehiculo_placa) + '" class="campo uppercase">');
      p.push('        </div>');
      p.push('        <div>');
      p.push('          <label class="etiqueta">Capacidad</label>');
      p.push('          <input type="number" name="capacidad_puestos" required min="1" max="20" value="' + escaparHTML(u.capacidad_puestos) + '" class="campo">');
      p.push('        </div>');
      p.push('      </div>');
    }
    p.push('      <button type="submit" class="btn btn-primario">Guardar cambios</button>');
    p.push('    </form>');

    p.push('    <div class="h-px bg-travel-line my-5"></div>');
    p.push('    <p class="text-xs font-semibold text-travel-muted uppercase tracking-wide mb-3">Cambiar contraseña</p>');
    p.push('    <form id="form-cambiar-password" class="flex flex-col gap-3">');
    p.push('      <input type="password" name="password_actual" required placeholder="Contraseña actual" class="campo">');
    p.push('      <input type="password" name="password_nueva" required minlength="6" placeholder="Contraseña nueva (mínimo 6 caracteres)" class="campo">');
    p.push('      <button type="submit" class="btn btn-oscuro">Cambiar contraseña</button>');
    p.push('    </form>');

    p.push('    <div class="h-px bg-travel-line my-5"></div>');
    p.push('    <p class="text-xs font-semibold uppercase tracking-wide mb-3" style="color: #FF8A7C;">Zona de peligro</p>');
    p.push('    <form id="form-eliminar-cuenta" class="flex flex-col gap-3">');
    p.push('      <p class="text-xs text-travel-muted">Esto elimina tu cuenta, tus viajes o reservas y todo tu historial de forma permanente. No se puede deshacer.</p>');
    p.push('      <input type="password" name="password" required placeholder="Confirma tu contraseña" class="campo">');
    p.push('      <button type="submit" class="chip chip-danger justify-center py-3">Eliminar mi cuenta</button>');
    p.push('    </form>');

    p.push('  </div>');
    p.push('</div>');
    return p.join('');
  }

  function listaMisReservas() {
    var p = [];
    if (estado.misReservasCargando) {
      p.push('<div class="text-center text-travel-muted py-16">Cargando tus reservas…</div>');
      return p.join('');
    }
    if (!estado.misReservas.length) {
      p.push('<div class="text-center py-16"><p class="text-travel-muted">Todavía no has reservado ningún viaje.</p></div>');
      return p.join('');
    }

    p.push('<div class="flex flex-col gap-4">');
    for (var i = 0; i < estado.misReservas.length; i++) {
      var r = estado.misReservas[i];
      var estadoTexto, estadoClase;
      if (r.estado === 'cancelada') { estadoTexto = 'Cancelada'; estadoClase = 'bg-travel-danger/10 text-travel-danger'; }
      else if (r.viaje_estado === 'cancelado') { estadoTexto = 'Viaje cancelado'; estadoClase = 'bg-travel-danger/10 text-travel-danger'; }
      else { estadoTexto = 'Confirmada'; estadoClase = 'bg-travel-success/10 text-travel-success'; }

      p.push('<div class="tarjeta p-5">');
      p.push('  <div class="flex items-start justify-between gap-3">');
      p.push('    <div>');
      p.push('      <p class="font-display font-bold text-travel-ink">' + escaparHTML(r.origen) + ' → ' + escaparHTML(r.destino) + '</p>');
      p.push('      <p class="text-sm text-travel-muted mt-1">' + formatearFecha(r.fecha_salida) + ' · ' + formatearHora(r.hora_salida) + ' · ' + r.puestos_reservados + ' puesto(s)</p>');
      p.push('      <p class="text-sm text-travel-muted">Recogida: ' + escaparHTML(r.punto_recogida) + '</p>');
      p.push('      <p class="text-sm text-travel-muted">Conductor: ' + escaparHTML(r.conductor_nombre) + ' · ' + escaparHTML(r.conductor_telefono) + '</p>');
      p.push('    </div>');
      p.push('    <span class="insignia whitespace-nowrap ' + estadoClase + '">' + estadoTexto + '</span>');
      p.push('  </div>');
      if (r.estado === 'confirmada' && r.viaje_estado === 'activo') {
        p.push('  <div class="mt-3 pt-3 border-t border-travel-line">');
        p.push('    <button data-action="cancelar-reserva" data-id="' + r.id + '" data-total="' + r.puestos_reservados + '" class="chip chip-danger">Cancelar reserva</button>');
        p.push('  </div>');
      }
      p.push('</div>');
    }
    p.push('</div>');
    return p.join('');
  }

  function listaHistorialReservas() {
    var p = [];
    if (estado.historialReservasCargando) {
      p.push('<div class="text-center text-travel-muted py-16">Cargando tu historial…</div>');
      return p.join('');
    }
    if (!estado.historialReservas.length) {
      p.push('<div class="text-center py-16"><p class="text-travel-muted">Todavía no tienes viajes en tu historial.</p></div>');
      return p.join('');
    }

    p.push('<div class="flex flex-col gap-4">');
    for (var i = 0; i < estado.historialReservas.length; i++) {
      var r = estado.historialReservas[i];
      var estadoTexto, estadoClase;
      if (r.estado === 'cancelada') { estadoTexto = 'Cancelada'; estadoClase = 'bg-travel-danger/10 text-travel-danger'; }
      else if (r.viaje_estado === 'cancelado') { estadoTexto = 'Viaje cancelado'; estadoClase = 'bg-travel-danger/10 text-travel-danger'; }
      else { estadoTexto = 'Completado'; estadoClase = 'bg-travel-muted/10 text-travel-muted'; }

      p.push('<div class="tarjeta p-5 opacity-90">');
      p.push('  <div class="flex items-start justify-between gap-3">');
      p.push('    <div>');
      p.push('      <p class="font-display font-bold text-travel-ink">' + escaparHTML(r.origen) + ' → ' + escaparHTML(r.destino) + '</p>');
      p.push('      <p class="text-sm text-travel-muted mt-1">' + formatearFecha(r.fecha_salida) + ' · ' + formatearHora(r.hora_salida) + ' · ' + r.puestos_reservados + ' puesto(s)</p>');
      p.push('      <p class="text-sm text-travel-muted">Conductor: ' + escaparHTML(r.conductor_nombre) + '</p>');
      p.push('    </div>');
      p.push('    <span class="insignia whitespace-nowrap ' + estadoClase + '">' + estadoTexto + '</span>');
      p.push('  </div>');
      p.push('  <div class="flex items-center gap-2 mt-4">');
      p.push('    <button data-action="eliminar-reserva-historial" data-id="' + r.id + '" class="chip chip-danger">Eliminar</button>');
      p.push('  </div>');
      p.push('</div>');
    }
    p.push('</div>');
    return p.join('');
  }

  // ---------------------------------------------------------------------
  // Carga de datos
  // ---------------------------------------------------------------------

  function cargarBusqueda(filtros) {
    filtros = filtros || {};
    estado.busquedaCargando = true;
    estado.diasVisiblesBusqueda = 2;
    render();
    var params = new URLSearchParams();
    if (filtros.origen) params.set('origen', filtros.origen);
    if (filtros.destino) params.set('destino', filtros.destino);
    if (filtros.fecha) params.set('fecha', filtros.fecha);
    var query = params.toString();
    api('/viajes' + (query ? '?' + query : ''), { method: 'GET' }).then(function (datos) {
      estado.viajesBusqueda = datos.viajes;
      estado.busquedaCargando = false;
      estado.busquedaHecha = true;
      render();
    }).catch(function (err) {
      estado.busquedaCargando = false;
      estado.busquedaHecha = true;
      render();
      mostrarToast(err.message, 'error');
    });
  }

  function cargarMisViajes(mostrarCargando) {
    if (mostrarCargando !== false) {
      estado.misViajesCargando = true;
      estado.diasVisiblesMisViajes = 2;
      render();
    }
    api('/viajes/mios', { method: 'GET' }).then(function (datos) {
      estado.misViajes = datos.viajes;
      estado.misViajesCargando = false;
      render();
    }).catch(function (err) {
      estado.misViajesCargando = false;
      render();
      mostrarToast(err.message, 'error');
    });
  }

  function cargarHistorialViajes(mostrarCargando) {
    if (mostrarCargando !== false) {
      estado.historialViajesCargando = true;
      render();
    }
    api('/viajes/historial', { method: 'GET' }).then(function (datos) {
      estado.historialViajes = datos.viajes;
      estado.historialViajesCargando = false;
      render();
    }).catch(function (err) {
      estado.historialViajesCargando = false;
      render();
      mostrarToast(err.message, 'error');
    });
  }

  function cargarMisReservas(mostrarCargando) {
    if (mostrarCargando !== false) {
      estado.misReservasCargando = true;
      render();
    }
    api('/reservas/mias', { method: 'GET' }).then(function (datos) {
      estado.misReservas = datos.reservas;
      estado.misReservasCargando = false;
      render();
    }).catch(function (err) {
      estado.misReservasCargando = false;
      render();
      mostrarToast(err.message, 'error');
    });
  }

  function cargarHistorialReservas(mostrarCargando) {
    if (mostrarCargando !== false) {
      estado.historialReservasCargando = true;
      render();
    }
    api('/reservas/historial', { method: 'GET' }).then(function (datos) {
      estado.historialReservas = datos.reservas;
      estado.historialReservasCargando = false;
      render();
    }).catch(function (err) {
      estado.historialReservasCargando = false;
      render();
      mostrarToast(err.message, 'error');
    });
  }

  function alternarDetallePasajeros(viajeId) {
    var id = Number(viajeId);
    var yaExpandido = !!estado.viajeExpandido[id];
    estado.viajeExpandido[id] = !yaExpandido;
    render();
    if (!yaExpandido && !estado.detallePasajeros[id]) {
      api('/viajes/' + id + '/reservas', { method: 'GET' }).then(function (datos) {
        estado.detallePasajeros[id] = datos.reservas;
        render();
      }).catch(function (err) {
        mostrarToast(err.message, 'error');
      });
    }
  }

  function confirmarCancelarViaje(viajeId) {
    if (!window.confirm('¿Seguro que deseas cancelar este viaje? Se notificará el cambio a los pasajeros.')) return;
    api('/viajes/' + viajeId + '/cancelar', { method: 'PATCH' }).then(function (datos) {
      mostrarToast(datos.mensaje, 'exito');
      cargarMisViajes(false);
    }).catch(function (err) {
      mostrarToast(err.message, 'error');
    });
  }

  function confirmarFinalizarViaje(viajeId) {
    if (!window.confirm('¿Ya llegaste a tu destino? Esto cierra el viaje y lo pasa a tu historial.')) return;
    api('/viajes/' + viajeId + '/finalizar', { method: 'PATCH' }).then(function (datos) {
      mostrarToast(datos.mensaje, 'exito');
      cargarMisViajes(false);
    }).catch(function (err) {
      mostrarToast(err.message, 'error');
    });
  }

  function confirmarEliminarViajeHistorial(viajeId) {
    if (!window.confirm('¿Eliminar este viaje de tu historial para siempre? No se puede deshacer.')) return;
    api('/viajes/' + viajeId, { method: 'DELETE' }).then(function (datos) {
      mostrarToast(datos.mensaje, 'exito');
      cargarHistorialViajes(false);
    }).catch(function (err) {
      mostrarToast(err.message, 'error');
    });
  }

  function confirmarEliminarReservaHistorial(reservaId) {
    if (!window.confirm('¿Eliminar esta reserva de tu historial para siempre? No se puede deshacer.')) return;
    api('/reservas/' + reservaId, { method: 'DELETE' }).then(function (datos) {
      mostrarToast(datos.mensaje, 'exito');
      cargarHistorialReservas(false);
    }).catch(function (err) {
      mostrarToast(err.message, 'error');
    });
  }

  function abrirModalEditarViaje(viajeId) {
    estado.modalEditarViajeId = Number(viajeId);
    render();
  }

  function pedirCantidadACancelar(totalPuestos) {
    if (totalPuestos <= 1) return totalPuestos;
    var texto = window.prompt('¿Cuántos puestos deseas cancelar? (tienes ' + totalPuestos + ')', String(totalPuestos));
    if (texto === null) return null;
    var cantidad = parseInt(texto, 10);
    if (!cantidad || cantidad < 1 || cantidad > totalPuestos) {
      mostrarToast('Ingresa un número entre 1 y ' + totalPuestos + '.', 'error');
      return null;
    }
    return cantidad;
  }

  function confirmarCancelarReserva(reservaId, totalPuestos) {
    var cantidad = pedirCantidadACancelar(totalPuestos);
    if (cantidad === null) return;
    if (!window.confirm('¿Cancelar ' + cantidad + ' de ' + totalPuestos + ' puesto(s) de esta reserva?')) return;
    api('/reservas/' + reservaId + '/cancelar', { method: 'PATCH', cuerpo: { puestos_a_cancelar: cantidad } }).then(function (datos) {
      mostrarToast(datos.mensaje, 'exito');
      cargarMisReservas(false);
    }).catch(function (err) {
      mostrarToast(err.message, 'error');
    });
  }

  function confirmarCancelarReservaConductor(viajeId, pasajeroId) {
    if (!window.confirm('¿Cancelar toda la reserva de este pasajero en el viaje? Se le notificará.')) return;
    api('/viajes/' + viajeId + '/pasajeros/' + pasajeroId + '/cancelar', { method: 'PATCH' }).then(function (datos) {
      mostrarToast(datos.mensaje, 'exito');
      api('/viajes/' + viajeId + '/reservas', { method: 'GET' }).then(function (datosDetalle) {
        estado.detallePasajeros[viajeId] = datosDetalle.reservas;
        render();
      });
      cargarMisViajes(false);
    }).catch(function (err) {
      mostrarToast(err.message, 'error');
    });
  }

  function marcarAvisoLocal(viajeId, valor) {
    for (var i = 0; i < estado.viajesBusqueda.length; i++) {
      if (estado.viajesBusqueda[i].id === Number(viajeId)) {
        estado.viajesBusqueda[i].tiene_aviso = valor;
        break;
      }
    }
    render();
  }

  function pedirAvisoCupo(viajeId) {
    var registrarAviso = function () {
      api('/viajes/' + viajeId + '/avisar-cupo', { method: 'POST' }).then(function (datos) {
        mostrarToast(datos.mensaje, 'exito');
        marcarAvisoLocal(viajeId, true);
      }).catch(function (err) {
        mostrarToast(err.message, 'error');
      });
    };
    if (estado.notificacionesEstado === 'granted') {
      registrarAviso();
    } else {
      activarNotificaciones().then(function () { registrarAviso(); });
    }
  }

  function quitarAvisoCupo(viajeId) {
    api('/viajes/' + viajeId + '/avisar-cupo', { method: 'DELETE' }).then(function (datos) {
      mostrarToast(datos.mensaje, 'exito');
      marcarAvisoLocal(viajeId, false);
    }).catch(function (err) {
      mostrarToast(err.message, 'error');
    });
  }

  // ---------------------------------------------------------------------
  // Manejadores de formularios
  // ---------------------------------------------------------------------

  function datosFormulario(formulario) {
    var datos = {};
    var elementos = new FormData(formulario);
    elementos.forEach(function (valor, clave) {
      if (Object.prototype.hasOwnProperty.call(datos, clave)) {
        // Ya había un valor con esa clave (checkboxes repetidos): lo
        // convertimos en arreglo en vez de perder el anterior.
        if (Array.isArray(datos[clave])) {
          datos[clave].push(valor);
        } else {
          datos[clave] = [datos[clave], valor];
        }
      } else {
        datos[clave] = valor;
      }
    });
    return datos;
  }

  function manejarLogin(formulario) {
    if (estado.enviando) return;
    var datos = datosFormulario(formulario);
    estado.enviando = true;
    api('/auth/login', { method: 'POST', cuerpo: datos }).then(function (respuesta) {
      estado.enviando = false;
      guardarSesion(respuesta.token, respuesta.usuario);
      estado.vista = respuesta.usuario.rol;
      mostrarToast(respuesta.mensaje, 'exito');
      render();
      if (estado.vista === 'pasajero') cargarBusqueda();
    }).catch(function (err) {
      estado.enviando = false;
      mostrarToast(err.message, 'error');
    });
  }

  function manejarRegistro(formulario) {
    if (estado.enviando) return;
    var datos = datosFormulario(formulario);
    estado.enviando = true;
    api('/auth/registro', { method: 'POST', cuerpo: datos }).then(function (respuesta) {
      estado.enviando = false;
      guardarSesion(respuesta.token, respuesta.usuario);
      estado.vista = respuesta.usuario.rol;
      mostrarToast(respuesta.mensaje, 'exito');
      render();
      if (estado.vista === 'pasajero') cargarBusqueda();
    }).catch(function (err) {
      estado.enviando = false;
      mostrarToast(err.message, 'error');
    });
  }

  function manejarPublicarViaje(formulario) {
    if (estado.enviando) return;
    var datos = datosFormulario(formulario);
    estado.enviando = true;
    api('/viajes', { method: 'POST', cuerpo: datos }).then(function (respuesta) {
      estado.enviando = false;
      mostrarToast(respuesta.mensaje, 'exito');
      formulario.reset();
      estado.conductorTab = 'mis-viajes';
      cargarMisViajes();
    }).catch(function (err) {
      estado.enviando = false;
      mostrarToast(err.message, 'error');
    });
  }

  function manejarEditarPerfil(formulario) {
    if (estado.enviando) return;
    var datos = datosFormulario(formulario);
    estado.enviando = true;
    api('/auth/perfil', { method: 'PUT', cuerpo: datos }).then(function (respuesta) {
      estado.enviando = false;
      estado.usuario = respuesta.usuario;
      localStorage.setItem('traveling_usuario', JSON.stringify(respuesta.usuario));
      mostrarToast(respuesta.mensaje, 'exito');
      render();
    }).catch(function (err) {
      estado.enviando = false;
      mostrarToast(err.message, 'error');
    });
  }

  function manejarCambiarPassword(formulario) {
    if (estado.enviando) return;
    var datos = datosFormulario(formulario);
    estado.enviando = true;
    api('/auth/password', { method: 'PUT', cuerpo: datos }).then(function (respuesta) {
      estado.enviando = false;
      mostrarToast(respuesta.mensaje, 'exito');
      formulario.reset();
    }).catch(function (err) {
      estado.enviando = false;
      mostrarToast(err.message, 'error');
    });
  }

  function manejarEliminarCuenta(formulario) {
    if (estado.enviando) return;
    if (!window.confirm('¿Seguro que quieres eliminar tu cuenta para siempre? Esto no se puede deshacer.')) return;
    var datos = datosFormulario(formulario);
    estado.enviando = true;
    api('/auth/cuenta', { method: 'DELETE', cuerpo: datos }).then(function (respuesta) {
      estado.enviando = false;
      mostrarToast(respuesta.mensaje, 'exito');
      cerrarSesion();
    }).catch(function (err) {
      estado.enviando = false;
      mostrarToast(err.message, 'error');
    });
  }

  function manejarEditarViaje(formulario) {
    if (estado.enviando) return;
    var datos = datosFormulario(formulario);
    var viajeId = datos.viaje_id;
    estado.enviando = true;
    api('/viajes/' + viajeId, { method: 'PUT', cuerpo: datos }).then(function (respuesta) {
      estado.enviando = false;
      mostrarToast(respuesta.mensaje, 'exito');
      estado.modalEditarViajeId = null;
      cargarMisViajes(false);
    }).catch(function (err) {
      estado.enviando = false;
      mostrarToast(err.message, 'error');
    });
  }

  function manejarBusqueda(formulario) {
    var datos = datosFormulario(formulario);
    cargarBusqueda(datos);
  }

  function manejarReservar(formulario) {
    if (estado.enviando) return;
    var datos = datosFormulario(formulario);
    var viajeId = datos.viaje_id;
    estado.enviando = true;
    api('/viajes/' + viajeId + '/reservar', { method: 'POST', cuerpo: datos }).then(function (respuesta) {
      estado.enviando = false;
      mostrarToast(respuesta.mensaje, 'exito');
      estado.modalViajeId = null;
      cargarBusqueda();
    }).catch(function (err) {
      estado.enviando = false;
      mostrarToast(err.message, 'error');
    });
  }

  function abrirModalReserva(viajeId) {
    estado.modalViajeId = Number(viajeId);
    render();
  }

  // ---------------------------------------------------------------------
  // Delegación de eventos
  // ---------------------------------------------------------------------

  document.addEventListener('submit', function (e) {
    var formulario = e.target;
    if (formulario.id === 'form-login') { e.preventDefault(); manejarLogin(formulario); }
    else if (formulario.id === 'form-registro') { e.preventDefault(); manejarRegistro(formulario); }
    else if (formulario.id === 'form-publicar-viaje') { e.preventDefault(); manejarPublicarViaje(formulario); }
    else if (formulario.id === 'form-busqueda') { e.preventDefault(); manejarBusqueda(formulario); }
    else if (formulario.id === 'form-reservar') { e.preventDefault(); manejarReservar(formulario); }
    else if (formulario.id === 'form-editar-perfil') { e.preventDefault(); manejarEditarPerfil(formulario); }
    else if (formulario.id === 'form-cambiar-password') { e.preventDefault(); manejarCambiarPassword(formulario); }
    else if (formulario.id === 'form-eliminar-cuenta') { e.preventDefault(); manejarEliminarCuenta(formulario); }
    else if (formulario.id === 'form-editar-viaje') { e.preventDefault(); manejarEditarViaje(formulario); }
  });

  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el) return;
    var accion = el.getAttribute('data-action');
    var id = el.getAttribute('data-id');

    if (accion === 'mostrar-login') { estado.authTab = 'login'; render(); }
    else if (accion === 'mostrar-registro') { estado.authTab = 'registro'; render(); }
    else if (accion === 'cerrar-sesion') { cerrarSesion(); }
    else if (accion === 'tab-conductor-publicar') { estado.conductorTab = 'publicar'; render(); }
    else if (accion === 'tab-conductor-mis-viajes') { estado.conductorTab = 'mis-viajes'; cargarMisViajes(); }
    else if (accion === 'tab-conductor-historial') { estado.conductorTab = 'historial'; cargarHistorialViajes(); }
    else if (accion === 'tab-pasajero-buscar') { estado.pasajeroTab = 'buscar'; render(); }
    else if (accion === 'tab-pasajero-mis-reservas') { estado.pasajeroTab = 'mis-reservas'; cargarMisReservas(); }
    else if (accion === 'tab-pasajero-historial') { estado.pasajeroTab = 'historial'; cargarHistorialReservas(); }
    else if (accion === 'ver-pasajeros') { alternarDetallePasajeros(id); }
    else if (accion === 'cancelar-viaje') { confirmarCancelarViaje(id); }
    else if (accion === 'finalizar-viaje') { confirmarFinalizarViaje(id); }
    else if (accion === 'mostrar-mas-dias-mis-viajes') { estado.diasVisiblesMisViajes = 99; render(); }
    else if (accion === 'mostrar-mas-dias-busqueda') { estado.diasVisiblesBusqueda = 99; render(); }
    else if (accion === 'eliminar-viaje-historial') { confirmarEliminarViajeHistorial(id); }
    else if (accion === 'eliminar-reserva-historial') { confirmarEliminarReservaHistorial(id); }
    else if (accion === 'editar-viaje') { abrirModalEditarViaje(id); }
    else if (accion === 'cerrar-modal-editar-viaje') { estado.modalEditarViajeId = null; render(); }
    else if (accion === 'abrir-modal-reserva') { abrirModalReserva(id); }
    else if (accion === 'cerrar-modal') { estado.modalViajeId = null; render(); }
    else if (accion === 'cancelar-reserva') { confirmarCancelarReserva(id, Number(el.getAttribute('data-total')) || 1); }
    else if (accion === 'cancelar-reserva-conductor') { confirmarCancelarReservaConductor(el.getAttribute('data-viaje'), el.getAttribute('data-pasajero')); }
    else if (accion === 'activar-notificaciones') { activarNotificaciones(); }
    else if (accion === 'avisar-cupo') { pedirAvisoCupo(id); }
    else if (accion === 'quitar-aviso-cupo') { quitarAvisoCupo(id); }
    else if (accion === 'abrir-perfil') { estado.modalPerfilAbierto = true; render(); }
    else if (accion === 'cerrar-modal-perfil') { estado.modalPerfilAbierto = false; render(); }
  });

  document.addEventListener('change', function (e) {
    if (e.target && e.target.name === 'rol' && e.target.closest('#form-registro')) {
      estado.registroRol = e.target.value;
      var camposVehiculo = document.getElementById('campos-vehiculo');
      var tarjetas = document.querySelectorAll('.tarjeta-rol');
      for (var i = 0; i < tarjetas.length; i++) {
        var input = tarjetas[i].querySelector('input');
        if (input && input.value === estado.registroRol) {
          tarjetas[i].classList.add('border-travel-accent', 'bg-travel-accent/10');
          tarjetas[i].classList.remove('border-travel-line');
        } else {
          tarjetas[i].classList.remove('border-travel-accent', 'bg-travel-accent/10');
          tarjetas[i].classList.add('border-travel-line');
        }
      }
      if (camposVehiculo) {
        var camposInternos = camposVehiculo.querySelectorAll('input[name="vehiculo_modelo"], input[name="vehiculo_placa"], input[name="capacidad_puestos"]');
        if (estado.registroRol === 'conductor') {
          camposVehiculo.classList.remove('hidden');
          camposInternos.forEach(function (campo) { campo.setAttribute('required', 'required'); });
        } else {
          camposVehiculo.classList.add('hidden');
          camposInternos.forEach(function (campo) { campo.removeAttribute('required'); });
        }
      }
    }
  });

  // 20s: refresco silencioso de las vistas con datos que cambian con el uso de otros
  setInterval(function () {
    if (!estado.usuario || document.hidden) return;
    if (estado.vista === 'conductor' && estado.conductorTab === 'mis-viajes') cargarMisViajes(false);
    if (estado.vista === 'pasajero' && estado.pasajeroTab === 'mis-reservas') cargarMisReservas(false);
  }, 20000);

  // Cuando llega una notificación push mientras la pestaña está abierta, el
  // Service Worker nos la reenvía aquí para poder sonar y mostrar un toast
  // aunque el navegador no muestre la notificación del sistema en primer plano.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (event) {
      if (event.data && event.data.tipo === 'notificacion-push') {
        reproducirSonidoAviso();
        var carga = event.data.payload || {};
        mostrarToast(carga.cuerpo || carga.titulo || 'Tienes una novedad en Traveling.', 'info');
        if (estado.usuario && estado.usuario.rol === 'conductor' && estado.conductorTab === 'mis-viajes') {
          cargarMisViajes(false);
        }
        if (estado.usuario && estado.usuario.rol === 'pasajero' && estado.pasajeroTab === 'buscar') {
          cargarBusqueda();
        }
      }
    });
  }

  document.addEventListener('DOMContentLoaded', iniciarApp);
})();
</script>
</body>
</html>`;

app.get('/', (req, res) => {
  res.type('html').send(PAGINA_HTML);
});

app.get('/sw.js', (req, res) => {
  res.type('application/javascript').send(SERVICE_WORKER_JS);
});

// -----------------------------------------------------------------------------
// 10. MANEJO DE ERRORES Y ARRANQUE DEL SERVIDOR
// -----------------------------------------------------------------------------

app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, mensaje: 'Ese recurso no existe.' });
});

app.use((err, req, res, next) => {
  console.error('[Traveling] Error no controlado:', err);
  res.status(500).json({ ok: false, mensaje: 'Ocurrió un error interno. Intenta de nuevo en unos segundos.' });
});

/**
 * Pasa a "completado" cualquier viaje activo cuya fecha y hora ya pasaron.
 * Se corre al iniciar y luego cada 15 minutos: así "Mis viajes" /
 * "Historial" siempre reflejan la realidad sin depender de un cron externo.
 */
async function marcarViajesCompletados() {
  try {
    const [resultado] = await pool.query(
      "UPDATE viajes SET estado = 'completado' WHERE estado = 'activo' AND TIMESTAMP(fecha_salida, hora_salida) < NOW()"
    );
    if (resultado.affectedRows > 0) {
      console.log(`[Traveling] ${resultado.affectedRows} viaje(s) pasaron a "completado".`);
    }
  } catch (err) {
    console.error('[Traveling] Error marcando viajes completados:', err.message);
  }
}

async function iniciar() {
  try {
    await inicializarBaseDeDatos();
    await marcarViajesCompletados();
    setInterval(marcarViajesCompletados, 15 * 60 * 1000);
    app.listen(PUERTO, () => {
      console.log(`[Traveling] Servidor escuchando en http://localhost:${PUERTO}`);
    });
  } catch (err) {
    console.error('[Traveling] No se pudo iniciar la aplicación. Revisa tus variables de entorno DB_HOST, DB_USER, DB_PASSWORD, DB_NAME y DB_PORT.');
    console.error(err);
    process.exit(1);
  }
}

iniciar();
