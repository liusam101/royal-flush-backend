// src/config.js
// Central place for required secrets. Fails fast if any are missing in production.
const isProd = process.env.NODE_ENV === 'production' || !!process.env.RAILWAY_ENVIRONMENT;

function required(name) {
  const val = process.env[name];
  if (!val) {
    if (isProd) {
      console.error(`[FATAL] ${name} is not set. Refusing to start in production.`);
      process.exit(1);
    }
    console.warn(`[config] ${name} not set — using an ephemeral dev-only value.`);
    // Dev-only random value: changes every restart, never a known constant.
    return require('crypto').randomBytes(32).toString('hex');
  }
  return val;
}

module.exports = {
  ADMIN_SECRET: required('ADMIN_SECRET'),
  JWT_SECRET:   required('JWT_SECRET'),
};
