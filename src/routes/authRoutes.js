// src/routes/authRoutes.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs'); // Usamos bcryptjs para evitar errores en Windows
const jwt = require('jsonwebtoken');
const db = require('../config/db');

router.post('/login', async (req, res) => {
  console.log("👉 PETICIÓN RECIBIDA:", req.body);

  const { email, password } = req.body;
  
  try {
    const result = await db.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Usuario no encontrado' });
    }

    const usuario = result.rows[0];
    const passwordValido = await bcrypt.compare(password, usuario.password_hash);

    if (!passwordValido) {
      return res.status(401).json({ error: 'Contraseña incorrecta' });
    }

    // Token válido por 8 horas
    const token = jwt.sign(
      { id: usuario.id, rol: usuario.rol },
      process.env.JWT_SECRET || 'secreto_desarrollo',
      { expiresIn: '8h' }
    );

    res.json({ token, rol: usuario.rol, nombre: usuario.email });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Error en el servidor' });
  }
});

// Ruta para obtener partidos activos o agendados con nombres de equipos y sedes
router.get('/partidos-activos', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT p.*, el.nombre as local_nombre, ev.nombre as visita_nombre, t.nombre as torneo_nombre, s.nombre as sede_nombre
      FROM public.partidos p
      LEFT JOIN public.equipos el ON p.equipo_local_id = el.id
      LEFT JOIN public.equipos ev ON p.equipo_visita_id = ev.id
      LEFT JOIN public.torneos t ON p.torneo_id = t.id
      LEFT JOIN public.sedes s ON p.sede_id = s.id
      WHERE p.estado != 'Finalizado'
      ORDER BY p.fecha_hora ASC
    `);
    res.json(result.rows);
  } catch (error) {
    console.error('Error al buscar partidos:', error);
    res.status(500).json({ error: 'Error al buscar partidos' });
  }
});

// Ruta para obtener un partido específico por su ID con toda su información relacionada
router.get('/partidos/:id', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT p.*, el.nombre as local_nombre, ev.nombre as visita_nombre, t.nombre as torneo_nombre, s.nombre as sede_nombre
      FROM public.partidos p
      LEFT JOIN public.equipos el ON p.equipo_local_id = el.id
      LEFT JOIN public.equipos ev ON p.equipo_visita_id = ev.id
      LEFT JOIN public.torneos t ON p.torneo_id = t.id
      LEFT JOIN public.sedes s ON p.sede_id = s.id
      WHERE p.id = $1
    `, [req.params.id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Partido no encontrado' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error al buscar el partido:', error);
    res.status(500).json({ error: 'Error al buscar el partido' });
  }
});

module.exports = router;