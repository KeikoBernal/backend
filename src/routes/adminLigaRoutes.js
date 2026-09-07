const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { createClient } = require('@supabase/supabase-js');
const { verificarToken, autorizarRoles } = require('../middleware/authMiddleware');

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

const registrarAuditoria = async (usuarioId, accion, tabla, valoresPrevios = null, nuevosValores = null, ip = null) => {
  try {
    await db.query(
      `INSERT INTO public.audit_logs (usuario_id, accion, tabla, valores_previos, nuevos_valores, ip) VALUES ($1, $2, $3, $4, $5, $6)`,
      [usuarioId, accion, tabla, valoresPrevios ? JSON.stringify(valoresPrevios) : null, nuevosValores ? JSON.stringify(nuevosValores) : null, ip]
    );
  } catch (error) {}
};

const formatearTexto = (texto) => {
  if (!texto) return '';
  return texto.trim().toLowerCase().split(' ').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
};

const obtenerOrgId = async (usuario) => {
  if (usuario.organizacion_id) return usuario.organizacion_id;
  const res = await db.query('SELECT organizacion_id FROM public.usuarios WHERE id = $1', [usuario.id]);
  return res.rows[0]?.organizacion_id || null;
};

router.use(verificarToken, autorizarRoles('Administrador de Liga', 'Superadmin'));

// Cambio obligatorio de contraseña
router.post('/cambiar-password-obligatorio', async (req, res) => {
  const { nueva_password } = req.body;
  if (!nueva_password || nueva_password.length < 6) {
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres.' });
  }
  try {
    const { error } = await supabaseAdmin.auth.admin.updateUserById(req.usuario.id, {
      password: nueva_password,
      user_metadata: { debe_cambiar_password: false }
    });
    if (error) return res.status(400).json({ error: error.message });
    await db.query('UPDATE public.usuarios SET debe_cambiar_password = false WHERE id = $1', [req.usuario.id]);
    res.json({ mensaje: 'Contraseña actualizada con éxito.' });
  } catch (error) {
    res.status(500).json({ error: 'Error al cambiar la contraseña.' });
  }
});

// ==========================================
// GESTIÓN DE SEDES
// ==========================================
router.get('/sedes', async (req, res) => {
  try {
    const orgId = await obtenerOrgId(req.usuario);
    const resultado = await db.query('SELECT * FROM public.sedes WHERE organizacion_id = $1 ORDER BY nombre ASC', [orgId]);
    res.json(resultado.rows);
  } catch (error) { res.status(500).json({ error: 'Error al obtener sedes.' }); }
});

router.post('/sedes', async (req, res) => {
  const { nombre, direccion } = req.body;
  try {
    const orgId = await obtenerOrgId(req.usuario);
    const resDb = await db.query(
      `INSERT INTO public.sedes (organizacion_id, nombre, direccion) VALUES ($1, $2, $3) RETURNING *`,
      [orgId, formatearTexto(nombre), direccion ? direccion.trim() : null]
    );
    await registrarAuditoria(req.usuario.id, 'CREAR_SEDE', 'sedes', null, resDb.rows[0], req.ip);
    res.status(201).json({ mensaje: 'Sede registrada con éxito.', sede: resDb.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Error registrando sede.' }); }
});

router.delete('/sedes/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM public.sedes WHERE id = $1', [req.params.id]);
    await registrarAuditoria(req.usuario.id, 'ELIMINAR_SEDE', 'sedes', { id: req.params.id }, null, req.ip);
    res.json({ mensaje: 'Sede eliminada con éxito.' });
  } catch (error) { res.status(500).json({ error: 'Error al eliminar sede.' }); }
});

// ==========================================
// EQUIPOS Y JUGADORES
// ==========================================
router.get('/equipos', async (req, res) => {
  try {
    const orgId = await obtenerOrgId(req.usuario);
    const resultado = await db.query(
      `SELECT e.*, u.email as delegado_email, u.id as delegado_id_usuario, j.nombre as capitan_nombre, j.apellido as capitan_apellido, j.cedula as capitan_cedula, j.correo as capitan_correo,
              COUNT(j_todos.id) as total_jugadores
       FROM public.equipos e
       LEFT JOIN public.usuarios u ON e.delegado_id = u.id
       LEFT JOIN public.jugadores j ON e.capitan_id = j.id
       LEFT JOIN public.jugadores j_todos ON j_todos.equipo_id = e.id AND j_todos.estado = 'Activo'
       WHERE e.organizacion_id = $1 OR $1 IS NULL
       GROUP BY e.id, u.email, u.id, j.nombre, j.apellido, j.cedula, j.correo ORDER BY e.nombre ASC`,
      [orgId]
    );
    res.json(resultado.rows);
  } catch (error) { res.status(500).json({ error: 'Error al obtener equipos.' }); }
});

router.post('/equipos', async (req, res) => {
  const { nombre, categoria, tipo_genero, logo_url } = req.body;
  try {
    const orgId = await obtenerOrgId(req.usuario);
    const resDb = await db.query(
      `INSERT INTO public.equipos (nombre, categoria, tipo_genero, logo_url, organizacion_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [formatearTexto(nombre), categoria, tipo_genero || 'Mixto', logo_url || null, orgId]
    );
    res.status(201).json({ mensaje: 'Equipo registrado.', equipo: resDb.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Error registrando equipo.' }); }
});

router.get('/equipos/:equipo_id/jugadores', async (req, res) => {
  try {
    const resDb = await db.query(
      `SELECT * FROM public.jugadores WHERE equipo_id = $1 AND estado = 'Activo' ORDER BY numero_dorsal ASC`, 
      [req.params.equipo_id]
    );
    res.json(resDb.rows);
  } catch (error) { res.status(500).json({ error: 'Error consultando jugadores.' }); }
});

router.post('/jugadores', async (req, res) => {
  const { equipo_id, cedula, nombre, apellido, fecha_nacimiento, correo, telefono, numero_dorsal, foto_url, es_capitan } = req.body;

  if (!/^\d{5,8}$/.test(cedula?.trim())) {
    return res.status(400).json({ error: 'La cédula debe ser numérica de 5 a 8 dígitos.' });
  }
  const dorsalNum = parseInt(numero_dorsal);
  if (isNaN(dorsalNum) || dorsalNum <= 0) {
    return res.status(400).json({ error: 'El número dorsal debe ser un número entero positivo.' });
  }

  try {
    const dorsalCheck = await db.query(`SELECT id FROM public.jugadores WHERE equipo_id = $1 AND numero_dorsal = $2 AND estado = 'Activo'`, [equipo_id, dorsalNum]);
    if (dorsalCheck.rows.length > 0) {
      return res.status(400).json({ error: `El número dorsal #${dorsalNum} ya está asignado a otro jugador activo.` });
    }

    const resDb = await db.query(
      `INSERT INTO public.jugadores (equipo_id, cedula, nombre, apellido, fecha_nacimiento, correo, telefono, numero_dorsal, foto_url, estado) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'Activo') RETURNING *`,
      [equipo_id, cedula.trim(), formatearTexto(nombre), formatearTexto(apellido), fecha_nacimiento, correo.trim(), telefono.trim(), dorsalNum, foto_url || null]
    );

    if (es_capitan) {
      await db.query(`UPDATE public.equipos SET capitan_id = $1 WHERE id = $2`, [resDb.rows[0].id, equipo_id]);
    }
    res.status(201).json({ mensaje: 'Jugador registrado.', jugador: resDb.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Error al registrar el jugador. Cédula duplicada.' }); }
});

router.put('/jugadores/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, apellido, cedula, fecha_nacimiento, correo, telefono, numero_dorsal, foto_url } = req.body;

  if (cedula && !/^\d{5,8}$/.test(cedula.trim())) {
    return res.status(400).json({ error: 'La cédula debe ser numérica de 5 a 8 dígitos.' });
  }

  try {
    const jugadorPrevio = await db.query('SELECT equipo_id FROM public.jugadores WHERE id = $1', [id]);
    if (jugadorPrevio.rows.length === 0) return res.status(404).json({ error: 'Jugador no encontrado.' });
    const equipoId = jugadorPrevio.rows[0].equipo_id;

    if (numero_dorsal) {
      const dorsalNum = parseInt(numero_dorsal);
      const dorsalCheck = await db.query(`SELECT id FROM public.jugadores WHERE equipo_id = $1 AND numero_dorsal = $2 AND id != $3 AND estado = 'Activo'`, [equipoId, dorsalNum, id]);
      if (dorsalCheck.rows.length > 0) {
        return res.status(400).json({ error: `El dorsal #${dorsalNum} ya está en uso por otro jugador activo.` });
      }
    }

    const resDb = await db.query(
      `UPDATE public.jugadores 
       SET nombre = COALESCE($1, nombre), apellido = COALESCE($2, apellido), cedula = COALESCE($3, cedula), 
           fecha_nacimiento = COALESCE($4, fecha_nacimiento), correo = COALESCE($5, correo), 
           telefono = COALESCE($6, telefono), numero_dorsal = COALESCE($7, numero_dorsal), foto_url = COALESCE($8, foto_url)
       WHERE id = $9 RETURNING *`,
      [
        nombre ? formatearTexto(nombre) : null, 
        apellido ? formatearTexto(apellido) : null, 
        cedula?.trim(), 
        fecha_nacimiento, 
        correo?.trim(), 
        telefono?.trim(), 
        numero_dorsal ? parseInt(numero_dorsal) : null, 
        foto_url, 
        id
      ]
    );

    res.json({ mensaje: 'Jugador actualizado con éxito.', jugador: resDb.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Error actualizando jugador.' }); }
});

router.delete('/jugadores/:id', async (req, res) => {
  try {
    await db.query(`UPDATE public.jugadores SET estado = 'Inactivo' WHERE id = $1`, [req.params.id]);
    res.json({ mensaje: 'Jugador desactivado con éxito.' });
  } catch (error) { res.status(500).json({ error: 'Error al desactivar jugador.' }); }
});

// ==========================================
// CREDENCIALES Y USUARIOS OPERATIVOS (Permite correos repetidos vía ID interno Auth)
// ==========================================
router.get('/usuarios-operativos', async (req, res) => {
  try {
    const orgId = await obtenerOrgId(req.usuario);
    const resDb = await db.query(
      `SELECT id, nombre, apellido, email, rol, cedula FROM public.usuarios 
       WHERE organizacion_id = $1 
         AND LOWER(rol) IN ('delegado de equipo', 'arbitro/anotador', 'árbitro / anotador')`, 
      [orgId]
    );
    res.json(resDb.rows);
  } catch (e) { res.status(500).json({ error: 'Error consultando usuarios operativos.' }); }
});

router.post('/crear-credencial', async (req, res) => {
  const { nombre, apellido, cedula, email, rol, equipo_id } = req.body;
  const orgId = await obtenerOrgId(req.usuario);

  if (!/^\d{5,8}$/.test(cedula?.trim())) {
    return res.status(400).json({ error: 'La cédula debe ser numérica de 5 a 8 dígitos.' });
  }

  const nombreFmt = formatearTexto(nombre);
  const apellidoFmt = formatearTexto(apellido);
  const primerNombre = nombreFmt.split(' ')[0];
  const passwordInicial = `${primerNombre}${cedula.trim().substring(0, 5)}!`;

  // Correo interno único para evitar restricciones globales de Supabase Auth ante correos repetidos
  const emailAuth = `user_${cedula.trim()}_${orgId.substring(0, 8)}@sistema.internal`;

  try {
    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: emailAuth, password: passwordInicial, email_confirm: true,
      user_metadata: { rol, nombre: nombreFmt, apellido: apellidoFmt, cedula: cedula.trim(), email_real: email.trim(), debe_cambiar_password: true }
    });
    if (authError) return res.status(400).json({ error: authError.message });

    const resDb = await db.query(
      `INSERT INTO public.usuarios (id, email, rol, nombre, apellido, cedula, organizacion_id, debe_cambiar_password) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, true)
       ON CONFLICT (id) DO UPDATE SET email=$2, rol=$3, nombre=$4, apellido=$5, cedula=$6, organizacion_id=$7, debe_cambiar_password=true RETURNING *`,
      [authUser.user.id, email.trim().toLowerCase(), rol, nombreFmt, apellidoFmt, cedula.trim(), orgId]
    );

    if (rol.toLowerCase() === 'delegado de equipo' && equipo_id) {
      await db.query(`UPDATE public.equipos SET delegado_id = $1 WHERE id = $2`, [authUser.user.id, equipo_id]);
    }
    res.status(201).json({ mensaje: `Credencial creada. Clave temporal: ${passwordInicial}` });
  } catch (error) { res.status(500).json({ error: 'Error registrando credencial.' }); }
});

router.post('/usuarios/:id/reset-password', async (req, res) => {
  try {
    const userDb = await db.query('SELECT email, cedula, nombre FROM public.usuarios WHERE id = $1', [req.params.id]);
    if (userDb.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const { cedula, nombre } = userDb.rows[0];
    const primerNombre = nombre ? nombre.trim().split(' ')[0] : 'User';
    const nuevaPassword = `${primerNombre}${cedula.trim().substring(0, 5)}!`;

    const { error } = await supabaseAdmin.auth.admin.updateUserById(req.params.id, {
      password: nuevaPassword, user_metadata: { debe_cambiar_password: true }
    });
    if (error) return res.status(400).json({ error: error.message });

    await db.query('UPDATE public.usuarios SET debe_cambiar_password = true WHERE id = $1', [req.params.id]);
    res.json({ mensaje: `Contraseña restablecida. Nueva clave temporal: ${nuevaPassword}` });
  } catch (error) { res.status(500).json({ error: 'Error al restablecer contraseña.' }); }
});

router.put('/equipos/:id/delegado', async (req, res) => {
  const { delegado_id } = req.body;
  try {
    await db.query(`UPDATE public.equipos SET delegado_id = $1 WHERE id = $2`, [delegado_id, req.params.id]);
    res.json({ mensaje: 'Delegado reasignado con éxito.' });
  } catch (error) { res.status(500).json({ error: 'Error al reasignar delegado.' }); }
});

// ==========================================
// PLANTILLAS DE REGLAS
// ==========================================
router.get('/plantillas-reglas', async (req, res) => {
  try {
    const orgId = await obtenerOrgId(req.usuario);
    const resDb = await db.query(`SELECT * FROM public.plantillas_reglas WHERE organizacion_id = $1 OR organizacion_id IS NULL ORDER BY id DESC`, [orgId]);
    res.json(resDb.rows);
  } catch (error) { res.status(500).json({ error: 'Error obteniendo reglas.' }); }
});

router.post('/plantillas-reglas', async (req, res) => {
  const { nombre, descripcion, reglas } = req.body;
  try {
    const orgId = await obtenerOrgId(req.usuario);
    const resDb = await db.query(
      `INSERT INTO public.plantillas_reglas (organizacion_id, nombre, descripcion, reglas) VALUES ($1, $2, $3, $4) RETURNING *`,
      [orgId, formatearTexto(nombre), descripcion ? descripcion.trim() : null, JSON.stringify(reglas)]
    );
    res.status(201).json({ mensaje: 'Plantilla guardada con éxito.', plantilla: resDb.rows[0] });
  } catch (error) { res.status(500).json({ error: 'Error guardando reglas.' }); }
});

// ==========================================
// TORNEOS Y RECURSOS
// ==========================================
router.get('/torneos/recursos', async (req, res) => {
  try {
    const orgId = await obtenerOrgId(req.usuario);
    const sedes = await db.query('SELECT * FROM public.sedes WHERE organizacion_id = $1', [orgId]);
    const arbitros = await db.query(`SELECT id, nombre, apellido FROM public.usuarios WHERE (LOWER(rol) LIKE '%arbitro%' OR LOWER(rol) LIKE '%anotador%') AND organizacion_id = $1`, [orgId]);
    const equipos = await db.query('SELECT id, nombre, categoria FROM public.equipos WHERE organizacion_id = $1', [orgId]);
    res.json({ sedes: sedes.rows, arbitros: arbitros.rows, equipos: equipos.rows });
  } catch (e) { res.status(500).json({ error: 'Error obteniendo recursos.' }); }
});

router.post('/torneos', async (req, res) => {
  const { nombre, fecha_inicio, fecha_fin, plantilla_id, partidos_iniciales } = req.body;
  const orgId = await obtenerOrgId(req.usuario);
  try {
    const reglaDb = await db.query('SELECT reglas FROM public.plantillas_reglas WHERE id = $1', [plantilla_id]);
    const reglasJson = reglaDb.rows.length > 0 ? reglaDb.rows[0].reglas : {};

    for (const p of partidos_iniciales) {
      const eqLocal = await db.query('SELECT categoria FROM public.equipos WHERE id = $1', [p.local_id]);
      const eqVisita = await db.query('SELECT categoria FROM public.equipos WHERE id = $1', [p.visita_id]);
      if (eqLocal.rows[0]?.categoria !== eqVisita.rows[0]?.categoria) {
        return res.status(400).json({ error: `Los equipos deben ser de la misma categoría.` });
      }
    }

    const resTorneo = await db.query(
      `INSERT INTO public.torneos (organizacion_id, nombre, fecha_inicio, fecha_fin, reglas) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [orgId, formatearTexto(nombre), fecha_inicio, fecha_fin, JSON.stringify(reglasJson)]
    );
    const torneoId = resTorneo.rows[0].id;

    for (const p of partidos_iniciales) {
      await db.query(
        `INSERT INTO public.partidos (torneo_id, equipo_local_id, equipo_visita_id, sede_id, arbitro_id, anotador_id, fecha_hora, fase) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [torneoId, p.local_id, p.visita_id, p.sede_id, p.arbitro_id, p.anotador_id, p.fecha_hora, p.fase || 'Eliminatoria']
      );
    }
    res.status(201).json({ mensaje: 'Torneo creado con éxito.' });
  } catch (error) { res.status(500).json({ error: 'Error creando torneo.' }); }
});

router.get('/estadisticas', async (req, res) => {
  try {
    const orgId = await obtenerOrgId(req.usuario);
    const partidosJugados = await db.query(`SELECT COUNT(*) FROM public.partidos p JOIN public.torneos t ON p.torneo_id = t.id WHERE t.organizacion_id = $1 AND p.estado = 'Finalizado'`, [orgId]);
    const totalTorneos = await db.query(`SELECT COUNT(*) FROM public.torneos WHERE organizacion_id = $1`, [orgId]);
    const totalEquipos = await db.query(`SELECT COUNT(*) FROM public.equipos WHERE organizacion_id = $1`, [orgId]);
    const totalJugadores = await db.query(`SELECT COUNT(j.id) FROM public.jugadores j JOIN public.equipos e ON j.equipo_id = e.id WHERE e.organizacion_id = $1 AND j.estado = 'Activo'`, [orgId]);
    const totalTarjetas = await db.query(`SELECT COUNT(tr.id) FROM public.tarjetas tr JOIN public.partidos p ON tr.partido_id = p.id JOIN public.torneos t ON p.torneo_id = t.id WHERE t.organizacion_id = $1`, [orgId]);

    const mejoresJugadores = await db.query(`
      SELECT j.nombre, j.apellido, e.nombre as equipo, COUNT(dj.id) as efectivas
      FROM public.detalle_jugadas dj
      JOIN public.jugadores j ON dj.jugador_id = j.id
      JOIN public.equipos e ON j.equipo_id = e.id
      WHERE dj.efectividad = true AND e.organizacion_id = $1
      GROUP BY j.id, j.nombre, j.apellido, e.nombre ORDER BY efectivas DESC LIMIT 5
    `, [orgId]);

    res.json({
      partidos_jugados: parseInt(partidosJugados.rows[0].count),
      total_torneos: parseInt(totalTorneos.rows[0].count),
      total_equipos: parseInt(totalEquipos.rows[0].count),
      total_jugadores: parseInt(totalJugadores.rows[0].count),
      total_tarjetas: parseInt(totalTarjetas.rows[0].count),
      mejores_jugadores: mejoresJugadores.rows
    });
  } catch (error) { res.status(500).json({ error: 'Error estadísticas.' }); }
});

router.get('/partidos-finalizados', async (req, res) => {
  try {
    const orgId = await obtenerOrgId(req.usuario);
    const resultado = await db.query(`
      SELECT p.id, p.fecha_hora, p.estado, t.nombre as torneo_nombre, el.nombre as local_nombre, ev.nombre as visita_nombre, r.marcador_local, r.marcador_visita
      FROM public.partidos p
      JOIN public.torneos t ON p.torneo_id = t.id
      JOIN public.equipos el ON p.equipo_local_id = el.id
      JOIN public.equipos ev ON p.equipo_visita_id = ev.id
      LEFT JOIN public.resultados r ON r.partido_id = p.id
      WHERE t.organizacion_id = $1 ORDER BY p.fecha_hora DESC
    `, [orgId]);
    res.json(resultado.rows);
  } catch (error) { res.status(500).json({ error: 'Error historial.' }); }
});

module.exports = router;