const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn('⚠️ Advertencia: Faltan SUPABASE_URL o SUPABASE_ANON_KEY en las variables de entorno del Backend.');
}

const supabaseBackend = createClient(supabaseUrl, supabaseAnonKey);

module.exports = supabaseBackend;