const express = require('express');
const router = express.Router();
const db = require('../config/db');

// 1. OBTENER PARTIDO ESPECÍFICO CON METADATOS (Árbitro, Anotador, Capitanes)
router.get('/partidos/:id', async (req, res) => {
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
  } catch (error) { res.status(500).json({ error: 'Error al consultar partido' }); }
});

// 2. OBTENER NÓMINA PÚBLICA
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

// 3. LISTAR PARTIDOS ACTIVOS
router.get('/partidos-activos', async (req, res) => {
  try {
    const resDb = await db.query(`
      SELECT p.*, el.nombre AS local_nombre, ev.nombre AS visita_nombre, s.nombre AS sede_nombre
      FROM public.partidos p
      LEFT JOIN public.equipos el ON p.equipo_local_id = el.id
      LEFT JOIN public.equipos ev ON p.equipo_visita_id = ev.id
      LEFT JOIN public.sedes s ON p.sede_id = s.id
      WHERE p.estado IN ('En Curso', 'Agendado')
      ORDER BY p.fecha_hora ASC
    `);
    res.json(resDb.rows);
  } catch (error) { res.status(500).json({ error: 'Error al consultar partidos activos' }); }
});

module.exports = router;