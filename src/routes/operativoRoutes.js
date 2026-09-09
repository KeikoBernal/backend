const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { createClient } = require('@supabase/supabase-js');
const { verificarToken, autorizarRoles } = require('../middleware/authMiddleware');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// 1. Middleware de protección para roles operativos (Árbitros y Anotadores)
router.use(verificarToken, autorizarRoles('arbitro', 'árbitro', 'anotador', 'arbitro/anotador', 'árbitro / anotador'));

// 2. Ruta de Cambio Obligatorio de Contraseña (Idéntica a Admin de Liga)
router.post('/cambiar-password-obligatorio', async (req, res) => {
  const { nueva_password } = req.body;
  if (!nueva_password || nueva_password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  }
  try {
    const userId = req.usuario?.id || req.user?.id;
    if (!userId) return res.status(401).json({ error: 'Usuario no autenticado.' });

    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      password: nueva_password,
      user_metadata: { debe_cambiar_password: false }
    });
    
    if (error) return res.status(400).json({ error: error.message });
    
    await db.query('UPDATE public.usuarios SET debe_cambiar_password = false WHERE id = $1', [userId]);
    res.json({ mensaje: 'Contraseña actualizada con éxito.' });
  } catch (error) {
    console.error('Error al cambiar contraseña:', error);
    res.status(500).json({ error: 'Error al cambiar la contraseña.' });
  }
});

// 3. Obtener Partidos Asignados
router.get('/mis-partidos', async (req, res) => {
  try {
    const usuarioId = req.usuario?.id || req.user?.id;
    const query = `
      SELECT p.id, p.fecha_hora, p.estado, p.equipo_local_id, p.equipo_visita_id,
             t.nombre as torneo_nombre, s.nombre as sede_nombre, 
             el.nombre as local_nombre, ev.nombre as visita_nombre
      FROM public.partidos p
      JOIN public.torneos t ON p.torneo_id = t.id
      JOIN public.sedes s ON p.sede_id = s.id
      JOIN public.equipos el ON p.equipo_local_id = el.id
      JOIN public.equipos ev ON p.equipo_visita_id = ev.id
      WHERE (p.arbitro_id = $1 OR p.anotador_id = $1) AND p.estado != 'Finalizado'
      ORDER BY p.fecha_hora ASC
    `;
    const resultado = await db.query(query, [usuarioId]);
    res.json(resultado.rows);
  } catch (error) {
    console.error('Error en /mis-partidos:', error);
    res.status(500).json({ error: 'Error interno al cargar la agenda de partidos.' });
  }
});

// 4. Obtener Nómina de Jugadores
router.get('/partidos/:id/nomina', async (req, res) => {
  const partidoId = req.params.id;
  try {
    const partidoData = await db.query('SELECT equipo_local_id, equipo_visita_id FROM public.partidos WHERE id = $1', [partidoId]);
    if (partidoData.rows.length === 0) return res.status(404).json({ error: 'Partido no encontrado.' });
    
    const { equipo_local_id, equipo_visita_id } = partidoData.rows[0];
    const queryJugadores = `
      SELECT j.id, j.nombre, j.apellido, j.numero_dorsal, j.equipo_id, j.foto_url, e.nombre as equipo
      FROM public.jugadores j
      JOIN public.equipos e ON j.equipo_id = e.id
      WHERE (j.equipo_id = $1 OR j.equipo_id = $2) AND j.estado = 'Activo'
      ORDER BY j.equipo_id, j.numero_dorsal ASC
    `;
    const resultadoJugadores = await db.query(queryJugadores, [equipo_local_id, equipo_visita_id]);
    res.json(resultadoJugadores.rows);
  } catch (error) {
    console.error('Error en /nomina:', error);
    res.status(500).json({ error: 'Error interno al cargar los jugadores.' });
  }
});

// 5. Validaciones pendientes de cambios de resultado
router.get('/mis-validaciones', async (req, res) => {
  try {
    const usuarioId = req.usuario?.id || req.user?.id;
    const query = `
      SELECT p.id as partido_id, t.nombre as torneo_nombre, el.nombre as local, ev.nombre as visita, 
             COALESCE(r.motivo_cambio, 'Sin motivo especificado') as motivo_cambio, 
             r.ganador_propuesto_id, 
             COALESCE(r.estado_validacion, 'Pendiente') as estado_validacion, 
             eg.nombre as nuevo_ganador_nombre
      FROM public.partidos p
      JOIN public.torneos t ON p.torneo_id = t.id
      JOIN public.equipos el ON p.equipo_local_id = el.id
      JOIN public.equipos ev ON p.equipo_visita_id = ev.id
      LEFT JOIN public.resultados r ON r.partido_id = p.id
      LEFT JOIN public.equipos eg ON r.ganador_propuesto_id = eg.id
      WHERE p.arbitro_id = $1 AND (r.estado_validacion = 'Pendiente' OR r.estado_validacion IS NULL)
    `;
    const resultado = await db.query(query, [usuarioId]);
    res.json(resultado.rows);
  } catch (error) { 
    console.error('Error en /mis-validaciones:', error);
    res.json([]); 
  }
});

router.post('/validar-cambio/:partido_id', async (req, res) => {
  const { aprobado } = req.body;
  try {
    if (aprobado) {
      await db.query(`UPDATE public.resultados SET equipo_ganador_id = ganador_propuesto_id, estado_validacion = 'Validado' WHERE partido_id = $1`, [req.params.partido_id]);
      res.json({ mensaje: 'Cambio de resultado APROBADO e impactado.' });
    } else {
      await db.query(`UPDATE public.resultados SET estado_validacion = 'Rechazado' WHERE partido_id = $1`, [req.params.partido_id]);
      res.json({ mensaje: 'Cambio RECHAZADO.' });
    }
  } catch (error) { 
    console.error('Error en /validar-cambio:', error);
    res.status(500).json({ error: 'Error procesando validación.' }); 
  }
});

module.exports = router;