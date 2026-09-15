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
             COALESCE(jl.nombre || ' ' || jl.apellido, 'Por definir') AS capitan_local_nombre,
             COALESCE(jv.nombre || ' ' || jv.apellido, 'Por definir') AS capitan_visita_nombre
      FROM public.partidos p
      LEFT JOIN public.equipos el ON p.equipo_local_id = el.id
      LEFT JOIN public.equipos ev ON p.equipo_visita_id = ev.id
      LEFT JOIN public.torneos t ON p.torneo_id = t.id
      LEFT JOIN public.sedes s ON p.sede_id = s.id
      LEFT JOIN public.usuarios ua ON p.arbitro_id = ua.id
      LEFT JOIN public.usuarios un ON p.anotador_id = un.id
      LEFT JOIN public.jugadores jl ON el.capitan_id = jl.id
      LEFT JOIN public.jugadores jv ON ev.capitan_id = jv.id
    `;
    const params = [];
    if (!esAdmin) { query += ` WHERE p.arbitro_id = $1 OR p.anotador_id = $1 `; params.push(usuarioId); }
    query += ` ORDER BY p.fecha_hora ASC `;

    const resDb = await db.query(query, params);
    res.json(resDb.rows);
  } catch (error) { res.status(500).json({ error: 'Error consultando partidos asignados.' }); }
});

// Endpoint para obtener un partido específico con metadatos completos (Árbitro, Anotador, Capitanes)
router.get('/partidos-publicos/:id', async (req, res) => {
  try {
    const resDb = await db.query(`
      SELECT p.*, 
             el.nombre AS local_nombre, ev.nombre AS visita_nombre,
             t.nombre AS torneo_nombre, s.nombre AS sede_nombre,
             COALESCE(ua.nombre || ' ' || ua.apellido, 'Por definir') AS arbitro_nombre,
             COALESCE(un.nombre || ' ' || un.apellido, 'Por definir') AS anotador_nombre,
             COALESCE(jl.nombre || ' ' || jl.apellido, 'Por definir') AS capitan_local_nombre,
             COALESCE(jv.nombre || ' ' || jv.apellido, 'Por definir') AS capitan_visita_nombre
      FROM public.partidos p
      LEFT JOIN public.equipos el ON p.equipo_local_id = el.id
      LEFT JOIN public.equipos ev ON p.equipo_visita_id = ev.id
      LEFT JOIN public.torneos t ON p.torneo_id = t.id
      LEFT JOIN public.sedes s ON p.sede_id = s.id
      LEFT JOIN public.usuarios ua ON p.arbitro_id = ua.id
      LEFT JOIN public.usuarios un ON p.anotador_id = un.id
      LEFT JOIN public.jugadores jl ON el.capitan_id = jl.id
      LEFT JOIN public.jugadores jv ON ev.capitan_id = jv.id
      WHERE p.id = $1
    `, [req.params.id]);

    if (resDb.rows.length === 0) return res.status(404).json({ error: 'Partido no encontrado' });
    res.json(resDb.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar partido' });
  }
});

// Endpoint para listar partidos activos o en curso
router.get('/partidos-activos', async (req, res) => {
  try {
    const resDb = await db.query(`
      SELECT p.*, 
             el.nombre AS local_nombre, ev.nombre AS visita_nombre,
             t.nombre AS torneo_nombre, s.nombre AS sede_nombre
      FROM public.partidos p
      LEFT JOIN public.equipos el ON p.equipo_local_id = el.id
      LEFT JOIN public.equipos ev ON p.equipo_visita_id = ev.id
      LEFT JOIN public.torneos t ON p.torneo_id = t.id
      LEFT JOIN public.sedes s ON p.sede_id = s.id
      WHERE p.estado IN ('En Curso', 'Agendado')
      ORDER BY p.fecha_hora ASC
    `);
    res.json(resDb.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar partidos activos' });
  }
});

// 2. INICIAR PARTIDO
router.put('/partidos/:id/iniciar', async (req, res) => {
  try {
    const { hora_inicio } = req.body;
    const resDb = await db.query(
      `UPDATE public.partidos SET estado = 'En Curso', hora_inicio = COALESCE(hora_inicio, $1) WHERE id = $2 RETURNING *`,
      [hora_inicio, req.params.id]
    );
    res.json({ mensaje: 'Partido iniciado con éxito.', partido: resDb.rows[0], hora_inicio: hora_inicio });
  } catch (error) { res.status(500).json({ error: 'Error al cambiar estado del partido.' }); }
});

// 3. FINALIZAR PARTIDO
router.put('/partidos/:id/finalizar', async (req, res) => {
  try {
    const { hora_final } = req.body;
    const resDb = await db.query(
      `UPDATE public.partidos SET estado = 'Finalizado', hora_final = $1 WHERE id = $2 RETURNING *`,
      [hora_final, req.params.id]
    );
    res.json({ mensaje: 'Partido finalizado con éxito.', partido: resDb.rows[0], hora_final: hora_final });
  } catch (error) { res.status(500).json({ error: 'Error al finalizar el partido.' }); }
});

// 4. SUSPENDER PARTIDO
router.put('/partidos/:id/suspender', async (req, res) => {
  try {
    const resDb = await db.query(`UPDATE public.partidos SET estado = 'Suspendido' WHERE id = $1 RETURNING *`, [req.params.id]);
    res.json({ mensaje: 'Partido suspendido.', partido: resDb.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Error al suspender el partido.' }); }
});

// 5. REGISTRAR SORTEO
router.put('/partidos/:id/sorteo', async (req, res) => {
  try {
    const { sorteo } = req.body;
    const resDb = await db.query(`UPDATE public.partidos SET sorteo_data = $1 WHERE id = $2 RETURNING *`, [JSON.stringify({ resultado: sorteo }), req.params.id]);
    res.json({ mensaje: 'Sorteo registrado.', partido: resDb.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Error al registrar sorteo.' }); }
});

// 6. NÓMINA DEL PARTIDO
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