const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();
const http = require('http'); // 1. Importamos el módulo HTTP nativo de Node
const { Server } = require('socket.io'); // 2. Importamos Socket.io

const db = require('./config/db');

const app = express();
const PORT = process.env.PORT || 4000;

// Middlewares de seguridad
app.use(helmet());
app.use(cors({
  origin: '*', // En producción, cambia '*' por la URL de tu frontend (ej. 'https://misistema.unexpo.edu.ve')
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// 3. Crear el servidor HTTP vinculándolo con Express
const server = http.createServer(app);

// 4. Inicializar Socket.io con el servidor HTTP
const io = new Server(server, {
  cors: {
    origin: '*', 
    methods: ['GET', 'POST']
  }
});

// Ruta de prueba para verificar que el servidor y la BD responden
app.get('/api/health', async (req, res) => {
  try {
    const result = await db.query('SELECT NOW()');
    res.json({
      status: 'success',
      mensaje: 'Servidor activo y conectado a Supabase con éxito',
      timestamp_db: result.rows[0].now
    });
  } catch (error) {
    console.error('Error al conectar con la base de datos:', error);
    res.status(500).json({ status: 'error', mensaje: 'No hay conexión con la base de datos' });
  }
});

// Rutas RESTful
const authRoutes = require('./routes/authRoutes');
app.use('/api', authRoutes);

const superadminRoutes = require('./routes/superadminRoutes');
app.use('/api/superadmin', superadminRoutes);

const adminLigaRoutes = require('./routes/adminLigaRoutes');
app.use('/api/admin-liga', adminLigaRoutes);

const operativoRoutes = require('./routes/operativoRoutes');
app.use('/api/operativo', operativoRoutes);

// ==========================================
// 5. LÓGICA DE WEBSOCKETS (TIEMPO REAL)
// ==========================================
io.on('connection', (socket) => {
  console.log(`🟢 Nuevo cliente conectado: ${socket.id}`);

  // 5.1. Aislar las comunicaciones creando una "sala" (room) por partido
  socket.on('unirse_partido', (partidoId) => {
    const sala = `partido_${partidoId}`;
    socket.join(sala);
    console.log(`👤 Cliente ${socket.id} se unió a la sala: ${sala}`);
  });

  // 5.2. El Árbitro dicta una jugada (Arrime/Boche)
  socket.on('decision_arbitro', async (data) => {
    try {
      // Guardar la acción en la base de datos
      await db.query(
        `INSERT INTO public.detalle_jugadas (mano_id, jugador_id, tipo_destreza, efectividad, minuto_registro)
         VALUES ($1, $2, $3, $4, $5)`,
        [data.mano_id, data.jugador_id, data.tipo_destreza, data.efectividad, data.minuto_registro]
      );
      
      // Emitir el evento a todos en la sala del partido (incluyendo al Anotador)
      io.to(`partido_${data.partido_id}`).emit('bola_jugada_notificacion', data);
    } catch (error) {
      console.error('Error al registrar decisión del árbitro:', error);
    }
  });

  // 5.3. El Árbitro saca una tarjeta
  socket.on('tarjeta_emitida', async (data) => {
    try {
      await db.query(
        `INSERT INTO public.tarjetas (partido_id, jugador_id, color, minuto_registro)
         VALUES ($1, $2, $3, $4)`,
        [data.partido_id, data.jugador_id, data.color, data.minuto_registro]
      );
      
      io.to(`partido_${data.partido_id}`).emit('tarjeta_notificacion', data);
    } catch (error) {
      console.error('Error al emitir tarjeta:', error);
    }
  });

  // 5.4. El Anotador registra el resultado de la mano (tiro)
  socket.on('tantos_asignados', async (data) => {
    try {
      // Nota: Aquí asumimos que la mano ya existe o se inserta dinámicamente
      await db.query(
        `INSERT INTO public.manos (partido_id, numero_mano, equipo_ganador_id, tantos_anotados)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET equipo_ganador_id = $3, tantos_anotados = $4`,
        [data.partido_id, data.mano_id, data.equipo_ganador_id, data.tantos_anotados]
      );

      // Actualizar la tabla de resultados consolidada
      await db.query(
        `UPDATE public.resultados 
         SET marcador_local = $1, marcador_visita = $2 
         WHERE partido_id = $3`,
        [data.nuevo_marcador_local, data.nuevo_marcador_visita, data.partido_id]
      );

      // Notificar a todos los espectadores y roles en la sala
      io.to(`partido_${data.partido_id}`).emit('marcador_actualizado', data);
    } catch (error) {
      console.error('Error al registrar tantos:', error);
    }
  });

  // 5.5. El Anotador da por cerrado el partido
  socket.on('partido_finalizado', async (data) => {
    try {
      await db.query(
        `UPDATE public.partidos SET estado = 'Finalizado' WHERE id = $1`,
        [data.partido_id]
      );
      io.to(`partido_${data.partido_id}`).emit('fin_partido', data);
    } catch (error) {
      console.error('Error al finalizar el partido:', error);
    }
  });

  // 5.6. El Árbitro suspende el partido (por lluvia, luz, etc.)
  socket.on('suspender_partido', async (data) => {
    try {
      await db.query(
        `UPDATE public.partidos SET estado = 'Suspendido' WHERE id = $1`,
        [data.partido_id]
      );
      // Notificamos a toda la sala (Anotador y público)
      io.to(`partido_${data.partido_id}`).emit('partido_suspendido', data);
    } catch (error) {
      console.error('Error al suspender el partido:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log(`🔴 Cliente desconectado: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor HTTP y WebSockets corriendo en el puerto ${PORT}`);
});