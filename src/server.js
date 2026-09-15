const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
require('dotenv').config();
const http = require('http'); 
const { Server } = require('socket.io'); 

const db = require('./config/db');

const app = express();
const PORT = process.env.PORT || 4000;

// Middlewares de seguridad
app.use(helmet());
app.use(cors({
  origin: '*', 
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Crear el servidor HTTP vinculándolo con Express
const server = http.createServer(app);

// Inicializar Socket.io con el servidor HTTP
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

const publicRoutes = require('./routes/publicRoutes');
app.use('/api/publico', publicRoutes); 

const mensajeriaRoutes = require('./routes/mensajeriaRoutes'); // Asegúrate de que el nombre coincida con tu archivo en la carpeta routes
app.use('/api/mensajeria', mensajeriaRoutes);

// ==========================================
// ESTADO EN MEMORIA PARA LA PLANILLA EN VIVO
// ==========================================
const partidosEnMemoria = {};

// ==========================================
// LÓGICA DE WEBSOCKETS (TIEMPO REAL)
// ==========================================
io.on('connection', (socket) => {
  console.log(`🟢 Nuevo cliente conectado: ${socket.id}`);

  // --- SISTEMA DE MENSAJERÍA JERÁRQUICA ---
  socket.on('registrar_usuario_mensajeria', (data) => {
    const { id, rol } = data;
    if (id) socket.join(`usuario_${id}`);
    
    // NORMALIZAR ROL PARA EVITAR ERRORES DE ACENTOS Y MAYÚSCULAS[cite: 27]
    if (rol) {
      const normalizedRol = rol.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      socket.join(`rol_${normalizedRol}`);
      console.log(`💬 Cliente ${socket.id} registrado en mensajería como: usuario_${id} y rol_${normalizedRol}`);
    }
  });

  socket.on('enviar_mensaje', (data) => {
    const { destinatario_sala, remitente, mensaje, timestamp, cc_admin } = data;
    
    if (Array.isArray(destinatario_sala)) {
      destinatario_sala.forEach(sala => {
        const nombreSala = (sala.startsWith('rol_') || sala.startsWith('usuario_')) ? sala : `usuario_${sala}`;
        io.to(nombreSala).emit('nuevo_mensaje', { remitente, mensaje, timestamp, destinatario_sala: nombreSala, propio: false });
      });
    } else {
      io.to(destinatario_sala).emit('nuevo_mensaje', { remitente, mensaje, timestamp, destinatario_sala, propio: false });
    }

    if (cc_admin) {
      io.to('rol_administrador de liga').emit('nuevo_mensaje', { 
        remitente: remitente + ' (CC)', 
        mensaje: mensaje, 
        timestamp: timestamp, 
        destinatario_sala: 'rol_administrador de liga',
        propio: false 
      });
    }
  });

  socket.on('notificacion_oficiales_partido', (data) => {
    if (data.arbitro_id) {
      io.to(`usuario_${data.arbitro_id}`).emit('nuevo_mensaje', {
        remitente: 'Sistema',
        mensaje: data.mensaje,
        timestamp: new Date().toLocaleTimeString()
      });
    }
    if (data.anotador_id) {
      io.to(`usuario_${data.anotador_id}`).emit('nuevo_mensaje', {
        remitente: 'Sistema',
        mensaje: data.mensaje,
        timestamp: new Date().toLocaleTimeString()
      });
    }
  });

  socket.on('sync_cronometro', (data) => {
      io.to(`partido_${data.partido_id}`).emit('sincronizacion_cronometro', data);
    });
    
  socket.on('enviar_notificacion_admin', (data) => {
    io.to('rol_administrador de liga').emit('nuevo_mensaje', {
      remitente: 'Sistema de Alertas Oficiales',
      mensaje: data.mensaje,
      timestamp: new Date().toLocaleTimeString()
    });
  });

  // 1. Salas por partido
  socket.on('unirse_partido', (partidoId) => {
    const sala = `partido_${partidoId}`;
    socket.join(sala);
    console.log(`👤 Cliente ${socket.id} se unió a la sala: ${sala}`);
    
    if (partidosEnMemoria[partidoId]) {
      socket.emit('actualizar_planilla', partidosEnMemoria[partidoId]);
    }
  });

  socket.on('presencia_oficial', (data) => {
    const { partidoId, rol, estado } = data;
    io.to(`partido_${partidoId}`).emit('presencia_actualizada', { rol, estado });
  });

  socket.on('proponer_jugada', (data) => {
    const { partido_id, jugador_id, mano_index, valor } = data;
    
    if (!partidosEnMemoria[partido_id]) partidosEnMemoria[partido_id] = { efectividad: {} };
    if (!partidosEnMemoria[partido_id].efectividad[jugador_id]) partidosEnMemoria[partido_id].efectividad[jugador_id] = {};
    
    partidosEnMemoria[partido_id].efectividad[jugador_id][mano_index] = { valor: valor, estado: 'validado' };
    
    io.to(`partido_${partido_id}`).emit('actualizar_planilla', partidosEnMemoria[partido_id]);
  });

  socket.on('sincronizar_planilla_completa', (data) => {
    const { partido_id, efectividad, manualStats, tantosLocal, tantosVisita } = data;
    if (!partidosEnMemoria[partido_id]) partidosEnMemoria[partido_id] = { efectividad: {} };
    
    partidosEnMemoria[partido_id].efectividad = efectividad || {};
    partidosEnMemoria[partido_id].manualStats = manualStats || {};
    partidosEnMemoria[partido_id].tantosLocal = tantosLocal || Array(20).fill('');
    partidosEnMemoria[partido_id].tantosVisita = tantosVisita || Array(20).fill('');
    
    io.to(`partido_${partido_id}`).emit('actualizar_planilla', partidosEnMemoria[partido_id]);
  });

  socket.on('solicitar_revision_jugada', (data) => {
    const { partido_id, jugador_id, mano_index, mensaje } = data;
    
    if (partidosEnMemoria[partido_id]?.efectividad[jugador_id]?.[mano_index]) {
      partidosEnMemoria[partido_id].efectividad[jugador_id][mano_index].estado = 'rechazado';
      
      io.to(`partido_${partido_id}`).emit('actualizar_planilla', partidosEnMemoria[partido_id]);
      io.to(`partido_${partido_id}`).emit('alerta_revision', mensaje);
    }
  });

  socket.on('decision_arbitro', async (data) => {
    try {
      await db.query(
        `INSERT INTO public.detalle_jugadas (mano_id, jugador_id, tipo_destreza, efectividad, minuto_registro)
         VALUES ($1, $2, $3, $4, $5)`,
        [data.mano_id, data.jugador_id, data.tipo_destreza, data.efectividad, data.minuto_registro]
      );
      io.to(`partido_${data.partido_id}`).emit('bola_jugada_notificacion', data);
    } catch (error) {
      console.error('Error al registrar decisión del árbitro:', error);
    }
  });

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

  socket.on('actualizar_stats_manuales', (data) => {
    const { partido_id, manualStats } = data;
    if (!partidosEnMemoria[partido_id]) partidosEnMemoria[partido_id] = { efectividad: {} };
    partidosEnMemoria[partido_id].manualStats = manualStats;
    io.to(`partido_${partido_id}`).emit('actualizar_planilla', partidosEnMemoria[partido_id]);
  });

  socket.on('tantos_asignados', async (data) => {
    const { partido_id, tantosLocal, tantosVisita } = data;
    
    if (!partidosEnMemoria[partido_id]) partidosEnMemoria[partido_id] = { efectividad: {} };
    partidosEnMemoria[partido_id].tantosLocal = tantosLocal;
    partidosEnMemoria[partido_id].tantosVisita = tantosVisita;
    io.to(`partido_${partido_id}`).emit('actualizar_planilla', partidosEnMemoria[partido_id]);

    try {
      await db.query(
        `INSERT INTO public.manos (partido_id, numero_mano, equipo_ganador_id, tantos_anotados)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET equipo_ganador_id = $3, tantos_anotados = $4`,
        [data.partido_id, data.mano_id, data.equipo_ganador_id, data.tantos_anotados]
      );
    } catch (error) {
      console.error('Error al registrar tantos en BD:', error);
    }
  });

  socket.on('partido_iniciado', (data) => {
    if (!partidosEnMemoria[data.partidoId]) partidosEnMemoria[data.partidoId] = { efectividad: {} };
    partidosEnMemoria[data.partidoId].estadoPartido = 'En Curso';
    partidosEnMemoria[data.partidoId].hora_inicio = data.hora_inicio;
    io.to(`partido_${data.partidoId}`).emit('actualizar_planilla', { estadoPartido: 'En Curso', hora_inicio: data.hora_inicio });
  });

  socket.on('partido_finalizado', async (data) => {
    if (!partidosEnMemoria[data.partidoId]) partidosEnMemoria[data.partidoId] = { efectividad: {} };
    partidosEnMemoria[data.partidoId].estadoPartido = 'Finalizado';
    partidosEnMemoria[data.partidoId].hora_final = data.hora_final;
    io.to(`partido_${data.partidoId}`).emit('actualizar_planilla', { estadoPartido: 'Finalizado', hora_final: data.hora_final });
  });

  socket.on('partido_suspendido', async (data) => {
    if (!partidosEnMemoria[data.partidoId]) partidosEnMemoria[data.partidoId] = { efectividad: {} };
    partidosEnMemoria[data.partidoId].estadoPartido = 'Suspendido';
    io.to(`partido_${data.partidoId}`).emit('actualizar_planilla', { estadoPartido: 'Suspendido' });
  });

  socket.on('disconnect', () => {
    console.log(`🔴 Cliente desconectado: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`🚀 Servidor HTTP y WebSockets corriendo en el puerto ${PORT}`);
});