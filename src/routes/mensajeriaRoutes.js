const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { verificarToken } = require('../middleware/authMiddleware');

router.use(verificarToken);

// 1. OBTENER CONTACTOS PERMITIDOS
router.get('/contactos', async (req, res) => {
  try {
    const { id, rol, organizacion_id } = req.usuario;
    let query = '';
    let params = [];

    // Normalizamos el rol a minúsculas y sin acentos para que los "if" no fallen
    const rolNormalizado = rol ? rol.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "") : '';

    if (rolNormalizado === 'superadmin') {
      // Superadmin ve a todos
      query = `SELECT id, nombre, apellido, rol, organizacion_id FROM public.usuarios WHERE id != $1 ORDER BY rol, nombre`;
      params = [id];
    } else if (rolNormalizado === 'administrador de liga') {
      // Admin ve a toda su organización
      query = `SELECT id, nombre, apellido, rol FROM public.usuarios WHERE organizacion_id = $2 AND id != $1 ORDER BY rol, nombre`;
      params = [id, organizacion_id];
    } else if (rolNormalizado === 'arbitro' || rolNormalizado === 'anotador') {
      // Oficiales ven a Admins, Árbitros y Anotadores de su org
      // Normalizamos también la búsqueda en SQL usando LOWER()
      query = `
        SELECT id, nombre, apellido, rol FROM public.usuarios 
        WHERE organizacion_id = $2 AND id != $1 
        AND LOWER(rol) IN ('administrador de liga', 'arbitro', 'árbitro', 'anotador') 
        ORDER BY rol, nombre
      `;
      params = [id, organizacion_id];
    } else if (rolNormalizado === 'delegado de equipo') {
      // Delegados solo ven al Admin
      query = `SELECT id, nombre, apellido, rol FROM public.usuarios WHERE organizacion_id = $2 AND LOWER(rol) = 'administrador de liga'`;
      params = [id, organizacion_id];
    } else {
      // Si el rol no entra en ninguna categoría, devolver vacío por seguridad
      return res.json([]);
    }

    const { rows } = await db.query(query, params);
    res.json(rows);
  } catch (error) {
    console.error('Error cargando contactos:', error);
    res.status(500).json({ error: 'Error al obtener contactos' });
  }
});

// 1.5 OBTENER BANDEJA DE ENTRADA (Último mensaje por conversación - Tipo Pila)
router.get('/bandeja', async (req, res) => {
  try {
    const miId = req.usuario.id;
    const { rows } = await db.query(`
      SELECT 
        u.id, u.nombre, u.apellido, u.rol,
        m.mensaje as ultimo_mensaje,
        m.hora_envio,
        m.hora_lectura,
        m.remitente_id
      FROM public.usuarios u
      JOIN (
        SELECT DISTINCT ON (
          CASE WHEN remitente_id = $1 THEN destinatario_id ELSE remitente_id END
        )
          CASE WHEN remitente_id = $1 THEN destinatario_id ELSE remitente_id END as otro_id,
          mensaje, 
          hora_envio, 
          hora_lectura, 
          remitente_id
        FROM public.notificaciones
        WHERE remitente_id = $1 OR destinatario_id = $1
        ORDER BY 
          CASE WHEN remitente_id = $1 THEN destinatario_id ELSE remitente_id END, 
          hora_envio DESC
      ) m ON u.id = m.otro_id
      ORDER BY 
        -- 1. Agrupa arriba las conversaciones que tienen mensajes sin leer
        CASE WHEN m.remitente_id != $1 AND m.hora_lectura IS NULL THEN 0 ELSE 1 END ASC,
        -- 2. Ordena el resto por la hora de envío más reciente
        m.hora_envio DESC
    `, [miId]);
    
    res.json(rows);
  } catch (error) {
    console.error('Error al obtener bandeja:', error);
    res.status(500).json({ error: 'Error al obtener la bandeja de entrada' });
  }
});

// 2. OBTENER HISTORIAL DE CONVERSACIÓN 1-a-1 (Requisito 3)
router.get('/conversacion/:contacto_id', async (req, res) => {
  try {
    const miId = req.usuario.id;
    const contactoId = req.params.contacto_id;

    // Marcar como leídos los mensajes que recibí de este contacto al abrir el chat
    await db.query(
      `UPDATE public.notificaciones SET hora_lectura = NOW() 
       WHERE destinatario_id = $1 AND remitente_id = $2 AND hora_lectura IS NULL`,
      [miId, contactoId]
    );

    const { rows } = await db.query(`
      SELECT * FROM public.notificaciones 
      WHERE (remitente_id = $1 AND destinatario_id = $2) 
         OR (remitente_id = $2 AND destinatario_id = $1)
      ORDER BY hora_envio ASC
    `, [miId, contactoId]);

    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al cargar conversación' });
  }
});

// 3. ENVIAR NUEVO MENSAJE (Individual o Masivo)
router.post('/enviar', async (req, res) => {
  const { destinatario_id, destinatario_rol, mensaje } = req.body;
  const { id: remitente_id, organizacion_id, rol: miRol } = req.usuario;

  // Límite estricto de caracteres en el backend (Evita saturar la BD)
  if (!mensaje || mensaje.trim().length === 0 || mensaje.length > 200) {
    return res.status(400).json({ error: 'El mensaje debe tener entre 1 y 200 caracteres.' });
  }

  try {
    if (destinatario_rol) {
      // LOGICA DE ENVÍO MASIVO
      // 1. Identificar a todos los usuarios de ese rol permitidos para el remitente
      let queryStr = `SELECT id FROM public.usuarios WHERE rol = $1 AND id != $2`;
      let params = [destinatario_rol, remitente_id];

      if (miRol !== 'Superadmin') {
        queryStr += ` AND organizacion_id = $3`;
        params.push(organizacion_id);
      }

      const usuarios = await db.query(queryStr, params);
      
      if (usuarios.rows.length === 0) {
        return res.status(404).json({ error: 'No hay usuarios registrados con ese rol para recibir el mensaje.' });
      }

      // 2. Insertar un registro INDIVIDUAL por cada destinatario
      const promises = usuarios.rows.map(u => 
        db.query(`
          INSERT INTO public.notificaciones 
          (organizacion_id, remitente_id, destinatario_id, titulo, mensaje) 
          VALUES ($1, $2, $3, 'Anuncio Oficial', $4) RETURNING *
        `, [organizacion_id, remitente_id, u.id, mensaje.trim()])
      );

      const resultados = await Promise.all(promises);
      
      // Retornar los IDs de los destinatarios para que el frontend dispare las notificaciones por Socket
      res.status(201).json({ 
        esMasivo: true, 
        total_enviados: resultados.length, 
        destinatarios: usuarios.rows.map(u => u.id) 
      });

    } else {
      // LÓGICA DE ENVÍO INDIVIDUAL (1 a 1)
      const { rows } = await db.query(`
        INSERT INTO public.notificaciones 
        (organizacion_id, remitente_id, destinatario_id, titulo, mensaje) 
        VALUES ($1, $2, $3, 'Mensaje Directo', $4) RETURNING *
      `, [organizacion_id, remitente_id, destinatario_id, mensaje.trim()]);

      res.status(201).json({ esMasivo: false, mensaje: rows[0] });
    }
  } catch (error) {
    res.status(500).json({ error: 'Error al enviar mensaje' });
  }
});

module.exports = router;