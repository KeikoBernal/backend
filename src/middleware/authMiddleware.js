const db = require('../config/db');

const verificarToken = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token no proporcionado o inválido.' });
  }

  const token = authHeader.split(' ')[1];
  try {
    // Validar token con Supabase o decodificar según implementes
    const { createClient } = require('@supabase/supabase-js');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(401).json({ error: 'Token inválido o expirado.' });
    }

    // Buscar información extendida del usuario en la base de datos local (incluyendo organizacion_id y rol)
    const userQuery = await db.query(
      `SELECT id, email, rol, organizacion_id, nombre FROM public.usuarios WHERE id = $1`, 
      [user.id]
    );

    if (userQuery.rows.length === 0) {
      // Si el usuario existe en Auth pero no en la tabla usuarios, intentamos extraer de metadata o crearlo si es necesario
      req.usuario = {
        id: user.id,
        email: user.email,
        rol: user.user_metadata?.rol || 'Administrador de Liga',
        organizacion_id: user.user_metadata?.organizacion_id || null,
        nombre: user.user_metadata?.nombre || ''
      };
    } else {
      req.usuario = userQuery.rows[0];
    }

    next();
  } catch (err) {
    console.error('Error en autenticación:', err);
    return res.status(401).json({ error: 'Error al procesar la autenticación.' });
  }
};

const autorizarRoles = (...rolesPermitidos) => {
  return (req, res, next) => {
    if (!req.usuario || !rolesPermitidos.map(r => r.toLowerCase()).includes(req.usuario.rol?.toLowerCase())) {
      return res.status(403).json({ error: 'No tienes permisos para realizar esta acción.' });
    }
    next();
  };
};

module.exports = { verificarToken, autorizarRoles };