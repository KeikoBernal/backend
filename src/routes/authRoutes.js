// src/routes/authRoutes.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs'); // Usamos bcryptjs para evitar errores en Windows
const jwt = require('jsonwebtoken');
const db = require('../config/db');

router.post('/login', async (req, res) => {
  console.log("👉 PETICIÓN RECIBIDA:", req.body); // <-- AGREGA ESTA LÍNEA

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

// Ruta temporal para obtener partidos activos
router.get('/partidos-activos', async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM partidos WHERE estado = 'En Vivo'");
    res.json(result.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al buscar partidos' });
  }
});

module.exports = router;