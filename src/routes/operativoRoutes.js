const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verificarToken } = require('../middleware/authMiddleware');

router.use(verificarToken);

// 1. OBTENER MIS PARTIDOS
router.get('/mis-partidos', async (req, res) => {
  try {
    const usuarioId = req.usuario.id;
    const esAdmin = ['Administrador de Liga', 'Superadmin'].includes(req.usuario.rol || '');

    let query = `
      SELECT p.*, 
             el.nombre AS local_nombre, ev.nombre AS visita_nombre,
             t.nombre AS torneo_nombre, s.nombre AS sede_nombre,
             COALESCE(ua.nombre || ' ' || ua.apellido, 'Por definir') AS arbitro_nombre,
             COALESCE(un.nombre || ' ' || un.apellido, 'Por definir') AS anotador_nombre,
             COALESCE(jl_p.nombre || ' ' || jl_p.apellido, jl_e.nombre || ' ' || jl_e.apellido, 'Por definir') AS capitan_local_nombre,
             COALESCE(jv_p.nombre || ' ' || jv_p.apellido, jv_e.nombre || ' ' || jv_e.apellido, 'Por definir') AS capitan_visita_nombre
      FROM public.partidos p
      LEFT JOIN public.equipos el ON p.equipo_local_id = el.id
      LEFT JOIN public.equipos ev ON p.equipo_visita_id = ev.id
      LEFT JOIN public.torneos t ON p.torneo_id = t.id
      LEFT JOIN public.sedes s ON p.sede_id = s.id
      LEFT JOIN public.usuarios ua ON p.arbitro_id = ua.id
      LEFT JOIN public.usuarios un ON p.anotador_id = un.id
      LEFT JOIN public.jugadores jl_p ON p.capitan_local_id = jl_p.id
      LEFT JOIN public.jugadores jl_e ON el.capitan_id = jl_e.id
      LEFT JOIN public.jugadores jv_p ON p.capitan_visita_id = jv_p.id
      LEFT JOIN public.jugadores jv_e ON ev.capitan_id = jv_e.id
    `;
    const params = [];
    if (!esAdmin) { query += ` WHERE p.arbitro_id = $1 OR p.anotador_id = $1 `; params.push(usuarioId); }
    query += ` ORDER BY p.fecha_hora DESC `;

    const resDb = await db.query(query, params);
    res.json(resDb.rows);
  } catch (error) { res.status(500).json({ error: 'Error consultando partidos asignados.' }); }
});

// ==========================================
// 2. INICIAR PARTIDO
// ==========================================
router.put('/partidos/:id/iniciar', async (req, res) => {
  try {
    const { id } = req.params;
    const { hora_inicio } = req.body; // Recibida del dispositivo o generada como respaldo

    const horaParaGuardar = new Date();

    const resDb = await db.query(
      `UPDATE public.partidos 
       SET estado = 'En Curso', 
           hora_inicio = COALESCE(hora_inicio, $1)
       WHERE id = $2 
       RETURNING *, TO_CHAR(hora_inicio, 'HH12:MI AM') AS hora_inicio_fmt`,
      [horaParaGuardar, id]
    );

    if (resDb.rows.length === 0) {
      return res.status(404).json({ error: 'Partido no encontrado.' });
    }

    const partido = resDb.rows[0];
    const horaFinalStr = hora_inicio || partido.hora_inicio_fmt || new Date().toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit', hour12: true });

    res.json({
      mensaje: 'Partido iniciado con éxito.',
      partido: partido,
      hora_inicio: horaFinalStr
    });
  } catch (error) {
    console.error('Error iniciando partido:', error);
    res.status(500).json({ error: 'Error al cambiar estado del partido.' });
  }
});

// ==========================================
// 3. FINALIZAR PARTIDO
// ==========================================

router.put('/partidos/:id/finalizar', async (req, res) => {
  try {
    const { id } = req.params;
    const { hora_final } = req.body;

    const resDb = await db.query(
      `UPDATE public.partidos 
       SET estado = 'Finalizado', 
           hora_final = $1 
       WHERE id = $2 
       RETURNING *`,
      [hora_final, id]
    );

    if (resDb.rows.length === 0) {
      return res.status(404).json({ error: 'Partido no encontrado.' });
    }

    res.json({
      mensaje: 'Partido finalizado con éxito.',
      partido: resDb.rows[0],
      hora_final: hora_final
    });
  } catch (error) {
    console.error('Error finalizando partido:', error);
    res.status(500).json({ error: 'Error al finalizar el partido.' });
  }
});

// 4. SUSPENDER PARTIDO (Solo Árbitro)
router.put('/partidos/:id/suspender', async (req, res) => {
  try {
    const resDb = await db.query(`UPDATE public.partidos SET estado = 'Suspendido' WHERE id = $1 RETURNING *`, [req.params.id]);
    res.json({ mensaje: 'Partido suspendido.', partido: resDb.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Error al suspender el partido.' }); }
});

// 5. NÓMINA DEL PARTIDO
router.get('/partidos/:id/nomina', async (req, res) => {
  try {
    const resDb = await db.query(`
      SELECT j.*, e.nombre AS equipo_nombre
      FROM public.jugadores j
      JOIN public.equipos e ON j.equipo_id = e.id
      JOIN public.partidos p ON (p.equipo_local_id = e.id OR p.equipo_visita_id = e.id)
      WHERE p.id = $1 AND j.estado = 'Activo' ORDER BY e.nombre, j.numero_dorsal ASC
    `, [req.params.id]);
    res.json(resDb.rows);
  } catch (error) { res.status(500).json({ error: 'Error al obtener nómina.' }); }
});

module.exports = router;