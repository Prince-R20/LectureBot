const { createClient } = require("@supabase/supabase-js");
const {supabaseUrl, supabaseKey} = require("./api.json");

const supabase = createClient(supabaseUrl, supabaseKey);

module.exports = supabase;
