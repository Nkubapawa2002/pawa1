// =====================================================
// Auth helper — Supabase email/password
// Used to gate admin.html. Only emails listed in APP_CONFIG.ADMIN_EMAILS
// AND present in the `admins` table can pass.
// =====================================================

window.Auth = (() => {
  const sb = window.SB || (window.DataStore && window.DataStore.sb);
  const cfg = window.APP_CONFIG || {};

  async function getSession() {
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data.session || null;
  }

  async function currentEmail() {
    const s = await getSession();
    return s?.user?.email || null;
  }

  function isAllowedEmail(email) {
    const list = (cfg.ADMIN_EMAILS || []).map(e => e.toLowerCase().trim());
    return !!email && list.includes(email.toLowerCase().trim());
  }

  // Verifies the email is also in the `admins` DB table (RLS-protected).
  async function isDbAdmin() {
    if (!sb) return false;
    const email = await currentEmail();
    if (!email || !isAllowedEmail(email)) return false;
    const { data, error } = await sb.from("admins").select("email").limit(1);
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  }

  async function signIn(email, password) {
    if (!sb) throw new Error("Supabase not configured");
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data.session;
  }

  async function signUp(email, password) {
    if (!sb) throw new Error("Supabase not configured");
    const { data, error } = await sb.auth.signUp({ email, password });
    if (error) throw error;
    return data;
  }

  async function signOut() {
    if (!sb) return;
    await sb.auth.signOut();
  }

  function onAuthChange(cb) {
    if (!sb) return { unsubscribe() {} };
    return sb.auth.onAuthStateChange((_event, session) => cb(session));
  }

  return { getSession, currentEmail, isAllowedEmail, isDbAdmin, signIn, signUp, signOut, onAuthChange };
})();
