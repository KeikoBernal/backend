const express = require('express');
const router = express.Router();
const db = require('../config/db');
const { createClient } = require('@supabase/supabase-js');
const { verificarToken, autorizarRoles } = require('../middleware/authMiddleware');

// Cliente para operaciones administrativas
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// Cliente para verificación de credenciales
const supabaseAuth = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Registrar eventos en la bitácora
const registrarAuditoria = async (usuarioId, accion, tabla, valoresPrevios = null, nuevosValores = null, ip = null) => {
  try {
    await db.query(
      `INSERT INTO public.audit_logs (usuario_id, accion, tabla, valores_previos, nuevos_valores, ip)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        usuarioId,
        accion,
        tabla,
        valoresPrevios ? JSON.stringify(valoresPrevios) : null,
        nuevosValores ? JSON.stringify(nuevosValores) : null,
        ip
      ]
    );
  } catch (error) {
    console.error('Error escribiendo en audit_logs:', error);
  }
};

router.use(verificarToken, autorizarRoles('Superadmin'));

router.post('/log-evento', async (req, res) => {
  const { accion, tabla, detalles } = req.body;
  try {
    await registrarAuditoria(req.usuario.id, accion || 'ACCION_SISTEMA', tabla || 'auth', null, detalles || null, req.ip);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'Error registrando evento.' });
  }
});

// ==========================================
// MÉTRICAS
// ==========================================
router.get('/metricas', async (req, res) => {
  try {
    const totalLigas = await db.query('SELECT COUNT(*) FROM public.organizaciones');
    const ligasActivas = await db.query('SELECT COUNT(*) FROM public.organizaciones WHERE estado_activa = true');
    const totalUsuarios = await db.query('SELECT COUNT(*) FROM public.usuarios');
    const usuariosPorRol = await db.query('SELECT rol, COUNT(*) as cantidad FROM public.usuarios GROUP BY rol');

    const partidosActivos = await db.query(`
      SELECT p.id, p.fecha_partido, p.estado, o.nombre as liga_nombre
      FROM public.partidos p
      LEFT JOIN public.organizaciones o ON p.organizacion_id = o.id
      WHERE p.estado IN ('en_curso', 'activo', 'en vivo')
      ORDER BY p.fecha_partido DESC
    `).catch(() => ({ rows: [] }));

    const partidosAgendados = await db.query(`
      SELECT p.id, p.fecha_partido, p.estado, o.nombre as liga_nombre
      FROM public.partidos p
      LEFT JOIN public.organizaciones o ON p.organizacion_id = o.id
      WHERE p.estado = 'agendado'
      ORDER BY p.fecha_partido ASC
    `).catch(() => ({ rows: [] }));

    res.json({
      total_ligas: parseInt(totalLigas.rows[0].count),
      ligas_activas: parseInt(ligasActivas.rows[0].count),
      total_usuarios: parseInt(totalUsuarios.rows[0].count),
      usuarios_por_rol: usuariosPorRol.rows,
      partidos_activos: partidosActivos.rows,
      partidos_agendados: partidosAgendados.rows
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar métricas.' });
  }
});

// ==========================================
// GESTIÓN DE LIGAS (CRUD CON ELIMINACIÓN SEGURA)
// ==========================================
router.get('/ligas', async (req, res) => {
  try {
    const resultado = await db.query(
      `SELECT id, nombre, estado_activa, logo_url, responsable_nombre, responsable_telefono, responsable_email, creado_en 
       FROM public.organizaciones ORDER BY creado_en DESC`
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar ligas.' });
  }
});

// 1. NUEVA SOLICITUD: Endpoint para ver información detallada de la liga
router.get('/ligas/:id/detalle', async (req, res) => {
  const { id } = req.params;
  try {
    const liga = await db.query('SELECT * FROM public.organizaciones WHERE id = $1', [id]);
    if (liga.rows.length === 0) return res.status(404).json({ error: 'Liga no encontrada.' });

    const usuarios = await db.query('SELECT id, nombre, apellido, email, rol, cedula FROM public.usuarios WHERE organizacion_id = $1', [id]);
    const equipos = await db.query('SELECT * FROM public.equipos WHERE organizacion_id = $1', [id]);
    const sedes = await db.query('SELECT * FROM public.sedes WHERE organizacion_id = $1', [id]);
    const torneos = await db.query('SELECT * FROM public.torneos WHERE organizacion_id = $1', [id]);
    
    // Obtenemos los jugadores a través de los equipos de esa liga
    const jugadores = await db.query(`
      SELECT j.*, e.nombre as equipo_nombre 
      FROM public.jugadores j 
      JOIN public.equipos e ON j.equipo_id = e.id 
      WHERE e.organizacion_id = $1
    `, [id]);

    // Obtenemos partidos vinculados a los torneos de esa liga
    const partidos = await db.query(`
      SELECT p.*, t.nombre as torneo_nombre, el.nombre as local_nombre, ev.nombre as visita_nombre 
      FROM public.partidos p
      JOIN public.torneos t ON p.torneo_id = t.id
      JOIN public.equipos el ON p.equipo_local_id = el.id
      JOIN public.equipos ev ON p.equipo_visita_id = ev.id
      WHERE t.organizacion_id = $1
    `, [id]);

    res.json({
      liga: liga.rows[0],
      usuarios: usuarios.rows,
      equipos: equipos.rows,
      sedes: sedes.rows,
      torneos: torneos.rows,
      jugadores: jugadores.rows,
      partidos: partidos.rows
    });
  } catch (error) {
    console.error('Error al obtener detalle de la liga:', error);
    res.status(500).json({ error: 'Error al consultar la información detallada.' });
  }
});

// 2. NUEVA SOLICITUD: Creación de Liga y usuario Administrador al mismo tiempo
router.post('/ligas', async (req, res) => {
  const { nombre, responsable_nombre, responsable_apellido, responsable_cedula, responsable_telefono, responsable_email, logo_url } = req.body;
  
  if (!nombre || !responsable_nombre || !responsable_apellido || !responsable_cedula || !responsable_email) {
    return res.status(400).json({ error: 'Faltan datos obligatorios de la liga o del responsable (nombre, apellido, cédula, correo).' });
  }

  const cedulaLimpia = responsable_cedula.trim();
  if (!/^\d{5,8}$/.test(cedulaLimpia)) {
    return res.status(400).json({ error: 'La cédula del responsable debe ser exclusivamente numérica de 5 a 8 dígitos.' });
  }

  try {
    // A. Insertamos la Organización en la tabla original
    const resDb = await db.query(
      `INSERT INTO public.organizaciones (nombre, responsable_nombre, responsable_telefono, responsable_email, logo_url) 
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [nombre.trim(), responsable_nombre.trim(), responsable_telefono?.trim(), responsable_email.trim().toLowerCase(), logo_url || null]
    );
    const organizacionId = resDb.rows[0].id;

    // B. Creamos el Usuario Auth en Supabase
    const primerNombre = responsable_nombre.trim().split(' ')[0];
    const passwordInicial = `${primerNombre}${cedulaLimpia.substring(0, 5)}!`;

    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: responsable_email.trim().toLowerCase(),
      password: passwordInicial,
      email_confirm: true,
      user_metadata: { 
        rol: 'Administrador de Liga',
        nombre: responsable_nombre.trim(),
        apellido: responsable_apellido.trim(),
        cedula: cedulaLimpia,
        debe_cambiar_password: true
      }
    });

    if (authError) {
      // Si falla la creación del usuario, deshacemos la creación de la liga para evitar registros huérfanos
      await db.query('DELETE FROM public.organizaciones WHERE id = $1', [organizacionId]);
      return res.status(400).json({ error: `Error creando credencial: ${authError.message}` });
    }

    // C. Insertamos el Administrador en la tabla usuarios local
    await db.query(
      `INSERT INTO public.usuarios (id, email, rol, nombre, apellido, cedula, organizacion_id, debe_cambiar_password) 
       VALUES ($1, $2, 'Administrador de Liga', $3, $4, $5, $6, true)`,
      [authUser.user.id, responsable_email.trim().toLowerCase(), responsable_nombre.trim(), responsable_apellido.trim(), cedulaLimpia, organizacionId]
    );

    await registrarAuditoria(req.usuario.id, 'CREAR_LIGA_Y_ADMIN', 'organizaciones', null, { ...resDb.rows[0], adminId: authUser.user.id }, req.ip);
    
    res.status(201).json({ 
      mensaje: `Liga creada con éxito. Contraseña del Administrador: ${passwordInicial}`, 
      liga: resDb.rows[0] 
    });
  } catch (error) {
    console.error('Error al registrar liga y administrador:', error);
    res.status(500).json({ error: 'Error general al crear la liga y su cuenta administradora.' });
  }
});

router.put('/ligas/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, responsable_nombre, responsable_telefono, responsable_email, estado_activa } = req.body;

  try {
    const previa = await db.query('SELECT * FROM public.organizaciones WHERE id = $1', [id]);
    if (previa.rows.length === 0) return res.status(404).json({ error: 'Liga no encontrada.' });

    const resDb = await db.query(
      `UPDATE public.organizaciones 
       SET nombre = $1, responsable_nombre = $2, responsable_telefono = $3, responsable_email = $4, estado_activa = $5 
       WHERE id = $6 RETURNING *`,
      [nombre, responsable_nombre, responsable_telefono, responsable_email, estado_activa, id]
    );

    // NUEVO: Bloquear/Desbloquear usuarios si el estado de la liga cambió
    if (estado_activa !== previa.rows[0].estado_activa) {
      const banStatus = estado_activa ? 'none' : '876000h'; // none = activo, 876000h = baneado por 100 años
      const usuariosLiga = await db.query('SELECT id FROM public.usuarios WHERE organizacion_id = $1', [id]);
      
      for (const u of usuariosLiga.rows) {
        await supabaseAdmin.auth.admin.updateUserById(u.id, { ban_duration: banStatus });
      }
    }

    await registrarAuditoria(req.usuario.id, 'EDITAR_LIGA', 'organizaciones', previa.rows[0], resDb.rows[0], req.ip);
    res.json({ mensaje: `Liga actualizada. Usuarios ${estado_activa ? 'habilitados' : 'deshabilitados'}.`, liga: resDb.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar la liga.' });
  }
});

// Eliminar Liga solicitando clave de confirmación (Se adapta el mensaje de error para cascada)
router.delete('/ligas/:id', async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Se requiere la contraseña de Superadmin para confirmar la eliminación.' });
  }

  // Validar credenciales del Superadmin
  const { error: authError } = await supabaseAuth.auth.signInWithPassword({
    email: req.usuario.email,
    password
  });

  if (authError) {
    return res.status(401).json({ error: 'Contraseña de confirmación incorrecta.' });
  }

  try {
    const previa = await db.query('SELECT * FROM public.organizaciones WHERE id = $1', [id]);
    if (previa.rows.length === 0) return res.status(404).json({ error: 'Liga no encontrada.' });

    await db.query('DELETE FROM public.organizaciones WHERE id = $1', [id]);
    await registrarAuditoria(req.usuario.id, 'ELIMINAR_LIGA', 'organizaciones', previa.rows[0], null, req.ip);
    
    res.json({ mensaje: 'Liga y todos sus registros vinculados han sido eliminados en cascada con éxito.' });
  } catch (error) {
    console.error('Error al eliminar liga:', error);
    res.status(500).json({ error: 'Error en la base de datos al intentar eliminar la liga y sus registros.' });
  }
});

// ==========================================
// GESTIÓN DE USUARIOS (CRUD CON ELIMINACIÓN SEGURA)
// ==========================================
router.get('/usuarios', async (req, res) => {
  try {
    const resultado = await db.query(
      `SELECT u.id, u.email, u.rol, u.nombre, u.apellido, u.cedula, u.debe_cambiar_password, u.organizacion_id, o.nombre as organizacion_nombre
       FROM public.usuarios u
       LEFT JOIN public.organizaciones o ON u.organizacion_id = o.id
       ORDER BY u.email ASC`
    );
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener usuarios.' });
  }
});

router.post('/usuarios', async (req, res) => {
  const { email, nombre, apellido, cedula, rol, organizacion_id } = req.body;

  if (!email || !nombre || !apellido || !cedula || !rol) {
    return res.status(400).json({ error: 'Nombre, apellido, cédula, correo y rol son obligatorios.' });
  }

  const cedulaLimpia = cedula.trim();
  const regexCedula = /^\d{5,8}$/;
  if (!regexCedula.test(cedulaLimpia)) {
    return res.status(400).json({ error: 'La cédula debe ser exclusivamente numérica y tener entre 5 y 8 dígitos.' });
  }

  // Formato: Primer Nombre + 5 dígitos de la cédula + ! (Ej: Juan30001!)
  const primerNombre = nombre.trim().split(' ')[0];
  const passwordInicial = `${primerNombre}${cedulaLimpia.substring(0, 5)}!`;

  try {
    const { data: authUser, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: email.trim().toLowerCase(),
      password: passwordInicial,
      email_confirm: true,
      user_metadata: { 
        rol,
        nombre: nombre.trim(),
        apellido: apellido.trim(),
        cedula: cedulaLimpia,
        debe_cambiar_password: true
      },
    });

    if (authError) return res.status(400).json({ error: authError.message });

    const resDb = await db.query(
      `UPDATE public.usuarios 
       SET rol = $1, nombre = $2, apellido = $3, cedula = $4, organizacion_id = $5, debe_cambiar_password = true 
       WHERE id = $6 RETURNING *`,
      [rol, nombre.trim(), apellido.trim(), cedulaLimpia, organizacion_id || null, authUser.user.id]
    );

    const usuarioCreado = resDb.rows[0] || { id: authUser.user.id, email, rol, nombre, apellido, cedula: cedulaLimpia };
    await registrarAuditoria(req.usuario.id, 'CREAR_USUARIO', 'usuarios', null, usuarioCreado, req.ip);
    
    res.status(201).json({ 
      mensaje: `Usuario creado con éxito. Contraseña inicial: ${passwordInicial}`, 
      usuario: usuarioCreado 
    });
  } catch (error) {
    console.error('Error al crear usuario:', error);
    res.status(500).json({ error: 'Error al registrar el usuario en la base de datos.' });
  }
});

router.put('/usuarios/:id', async (req, res) => {
  const { id } = req.params;
  const { nombre, apellido, cedula, rol, organizacion_id, debe_cambiar_password } = req.body;

  try {
    const previa = await db.query('SELECT * FROM public.usuarios WHERE id = $1', [id]);
    if (previa.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const resDb = await db.query(
      `UPDATE public.usuarios 
       SET nombre = $1, apellido = $2, cedula = $3, rol = $4, organizacion_id = $5, debe_cambiar_password = $6 
       WHERE id = $7 RETURNING *`,
      [nombre, apellido, cedula, rol, organizacion_id || null, debe_cambiar_password ?? previa.rows[0].debe_cambiar_password, id]
    );

    await supabaseAdmin.auth.admin.updateUserById(id, {
      user_metadata: { rol, nombre, apellido, cedula, debe_cambiar_password }
    });

    await registrarAuditoria(req.usuario.id, 'EDITAR_USUARIO', 'usuarios', previa.rows[0], resDb.rows[0], req.ip);
    res.json({ mensaje: 'Usuario actualizado con éxito.', usuario: resDb.rows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Error al actualizar el usuario.' });
  }
});

router.post('/usuarios/:id/reset-password', async (req, res) => {
  const { id } = req.params;

  try {
    const userDb = await db.query('SELECT id, email, cedula, nombre FROM public.usuarios WHERE id = $1', [id]);
    if (userDb.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado.' });

    const { cedula, nombre } = userDb.rows[0];
    if (!cedula || !/^\d{5,8}$/.test(cedula.trim())) {
      return res.status(400).json({ error: 'El usuario no posee una cédula válida para restablecer la clave.' });
    }

    const primerNombre = nombre ? nombre.trim().split(' ')[0] : 'User';
    const nuevaPassword = `${primerNombre}${cedula.trim().substring(0, 5)}!`;

    const { error } = await supabaseAdmin.auth.admin.updateUserById(id, {
      password: nuevaPassword,
      user_metadata: { debe_cambiar_password: true }
    });

    if (error) return res.status(400).json({ error: error.message });

    await db.query('UPDATE public.usuarios SET debe_cambiar_password = true WHERE id = $1', [id]);
    await registrarAuditoria(req.usuario.id, 'RESET_PASSWORD', 'usuarios', { id }, { password_reset: true }, req.ip);

    res.json({ mensaje: `Contraseña restablecida correctamente. Nueva clave temporal: ${nuevaPassword}` });
  } catch (error) {
    console.error('Error al restablecer la contraseña:', error);
    res.status(500).json({ error: 'Error al restablecer la contraseña.' });
  }
});

router.delete('/usuarios/:id', async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: 'Se requiere la contraseña de Superadmin para confirmar la eliminación.' });
  }

  if (id === req.usuario.id) {
    return res.status(400).json({ error: 'No puedes eliminar tu propia cuenta de Superadmin.' });
  }

  const { error: authError } = await supabaseAuth.auth.signInWithPassword({
    email: req.usuario.email,
    password
  });

  if (authError) {
    return res.status(401).json({ error: 'Contraseña de confirmación incorrecta.' });
  }

  try {
    const previa = await db.query('SELECT * FROM public.usuarios WHERE id = $1', [id]);
    if (previa.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado.' });

    await supabaseAdmin.auth.admin.deleteUser(id);
    await db.query('DELETE FROM public.usuarios WHERE id = $1', [id]);
    await registrarAuditoria(req.usuario.id, 'ELIMINAR_USUARIO', 'usuarios', previa.rows[0], null, req.ip);
    
    res.json({ mensaje: 'Usuario eliminado con éxito.' });
  } catch (error) {
    console.error('Error al eliminar usuario:', error);
    res.status(500).json({ error: 'Error al eliminar el usuario.' });
  }
});

// ==========================================
// COMUNICACIÓN OFICIAL
// ==========================================
router.post('/notificaciones', async (req, res) => {
  const { tipo_destino, organizacion_id, rol_destino, titulo, mensaje } = req.body;

  if (!titulo || !mensaje) {
    return res.status(400).json({ error: 'Título y mensaje son obligatorios.' });
  }

  try {
    let queryDestinatarios = 'SELECT id, organizacion_id FROM public.usuarios WHERE 1=1';
    const params = [];

    if (tipo_destino === 'liga_especifica' && organizacion_id) {
      params.push(organizacion_id);
      queryDestinatarios += ` AND organizacion_id = $${params.length}`;
    } else if (tipo_destino === 'por_rol' && rol_destino) {
      params.push(rol_destino);
      queryDestinatarios += ` AND rol = $${params.length}`;
    } else if (tipo_destino === 'admin_liga_especifica' && organizacion_id) {
      params.push(organizacion_id);
      queryDestinatarios += ` AND organizacion_id = $${params.length} AND LOWER(rol) = 'administrador de liga'`;
    }

    const destinatarios = await db.query(queryDestinatarios, params);

    if (destinatarios.rows.length === 0) {
      return res.status(404).json({ error: 'No se encontraron usuarios para el criterio seleccionado.' });
    }

    for (const user of destinatarios.rows) {
      const orgIdFinal = user.organizacion_id || organizacion_id;
      if (orgIdFinal) {
        await db.query(
          `INSERT INTO public.notificaciones (organizacion_id, remitente_id, destinatario_id, titulo, mensaje)
           VALUES ($1, $2, $3, $4, $5)`,
          [orgIdFinal, req.usuario.id, user.id, titulo.trim(), mensaje.trim()]
        );
      }
    }

    await registrarAuditoria(req.usuario.id, 'ENVIAR_NOTIFICACION', 'notificaciones', null, { tipo_destino, enviados: destinatarios.rows.length, titulo }, req.ip);
    res.status(201).json({ mensaje: `Notificación enviada a ${destinatarios.rows.length} usuario(s).` });
  } catch (error) {
    res.status(500).json({ error: 'Error al procesar el envío de notificaciones.' });
  }
});

router.get('/notificaciones', async (req, res) => {
  try {
    const resDb = await db.query(
      `SELECT n.id, n.titulo, n.mensaje, n.hora_envio, n.hora_lectura,
              o.nombre as organizacion_nombre, u.email as remitente_email, d.email as destinatario_email
       FROM public.notificaciones n
       LEFT JOIN public.organizaciones o ON n.organizacion_id = o.id
       JOIN public.usuarios u ON n.remitente_id = u.id
       LEFT JOIN public.usuarios d ON n.destinatario_id = d.id
       ORDER BY n.hora_envio DESC LIMIT 50`
    );
    res.json(resDb.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar notificaciones.' });
  }
});

// ==========================================
// BITÁCORA DE SEGURIDAD
// ==========================================
router.get('/bitacora', async (req, res) => {
  const { rol, usuario_id, busqueda } = req.query;

  try {
    let sql = `
      SELECT a.id, a.accion, a.tabla, a.valores_previos, a.nuevos_valores, a.ip, a.fecha,
             u.email as usuario_email, u.rol as usuario_rol, u.cedula as usuario_cedula
      FROM public.audit_logs a
      LEFT JOIN public.usuarios u ON a.usuario_id = u.id
      WHERE 1=1
    `;
    const params = [];

    if (rol) {
      params.push(rol);
      sql += ` AND LOWER(u.rol) = LOWER($${params.length})`;
    }

    if (usuario_id) {
      params.push(usuario_id);
      sql += ` AND a.usuario_id = $${params.length}`;
    }

    if (busqueda) {
      params.push(`%${busqueda.trim()}%`);
      sql += ` AND (u.email ILIKE $${params.length} OR u.cedula ILIKE $${params.length})`;
    }

    sql += ' ORDER BY a.fecha DESC LIMIT 150';

    const resultado = await db.query(sql, params);
    res.json(resultado.rows);
  } catch (error) {
    res.status(500).json({ error: 'Error al consultar auditoría.' });
  }
});

module.exports = router;