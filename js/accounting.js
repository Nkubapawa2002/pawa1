// ============================================================================
//  Pawa Bus Cargo — Accounting & Finance Dashboard  (v2)
//  Roles: admin | accountant (read+write) | auditor (read-only)
//  Tanzania tax: VAT 18%, CIT 30%, WHT 5%/10%, SDL 4%
//
//  Changes from live test:
//   - null/zero fares handled gracefully
//   - Booking funnel & conversion rate KPI
//   - Payment status pulled from bookings when payments table is empty
//   - Pending revenue shown separately from confirmed
//   - Per-bus share % column in bus table
//   - CIT note shown only for yearly period
//   - Period pill shows actual date range
// ============================================================================

const TAX = { VAT_RATE:0.18, CIT_RATE:0.30, WHT_SERVICES:0.05, WHT_RENT:0.10, SDL_RATE:0.04 };

// ─── helpers ────────────────────────────────────────────────────────────────
const fmt   = (n) => 'TZS ' + Math.round(n||0).toLocaleString('en-US');
const fmtN  = (n) => Math.round(n||0).toLocaleString('en-US');
const pct   = (a,b) => b ? ((a/b)*100).toFixed(1)+'%' : '0%';
const $     = (id) => document.getElementById(id);
const clamp = (v,lo,hi) => Math.min(hi, Math.max(lo, v));

function dateRange(anchor, period) {
  const d = anchor ? new Date(anchor) : new Date();
  d.setHours(0,0,0,0);
  let from, to;
  if (period==='day')   { from=new Date(d); to=new Date(d); to.setDate(to.getDate()+1); }
  else if (period==='week') {
    from=new Date(d); from.setDate(d.getDate()-d.getDay());
    to=new Date(from); to.setDate(from.getDate()+7);
  } else if (period==='month') {
    from=new Date(d.getFullYear(),d.getMonth(),1);
    to  =new Date(d.getFullYear(),d.getMonth()+1,1);
  } else {
    from=new Date(d.getFullYear(),0,1);
    to  =new Date(d.getFullYear()+1,0,1);
  }
  return { from:from.toISOString().slice(0,10), to:to.toISOString().slice(0,10),
           label:periodLabel(period,d), period };
}

function periodLabel(period,d) {
  if (period==='day')   return d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric'});
  if (period==='week')  return 'Week of '+d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});
  if (period==='month') return d.toLocaleDateString('en-GB',{month:'long',year:'numeric'});
  return 'Year '+d.getFullYear();
}

function freightCalc(s) {
  const cfg = window.APP_CONFIG||{};
  const base  = cfg.FREIGHT_BASE_TZS||2000;
  const perKg = cfg.FREIGHT_PER_KG_TZS||500;
  const maint = cfg.FREIGHT_MAINTENANCE_PCT||10;
  const mults = cfg.FREIGHT_SIZE_MULTIPLIERS||{small:1,medium:1.5,large:2.5};
  return (base+(s.product_weight_kg||0)*perKg)*(mults[s.size_category]||1)*(1+maint/100);
}

function statusColor(st) {
  return ({confirmed:'#16a34a',boarded:'#16a34a',completed:'#16a34a',delivered:'#16a34a',
           pending:'#f59e0b',awaiting_payment:'#f59e0b','In Transit':'#f59e0b',
           cancelled:'#dc2626',expired:'#dc2626',refund_initiated:'#dc2626',
           rescheduled:'#7c3aed',paid:'#2563eb'})[st]||'#6b7280';
}

// ─── main ──────────────────────────────────────────────────────────────────
window.initAccountingPage = async () => {
  const sb = window.SB;

  const todayStr = new Date().toISOString().slice(0,10);
  const pdEl = $('periodDate'); if (pdEl) pdEl.value = todayStr;
  const expDateEl = $('expDate'); if (expDateEl) expDateEl.value = todayStr;
  const adjDateEl = $('adjDate'); if (adjDateEl) adjDateEl.value = todayStr;

  let userRole = 'auditor';
  let currentRange = null;
  let busMap = {};
  let allData = null;
  let activePeriod = 'month';

  // ── auth gate ──────────────────────────────────────────────────────────────
  async function gate() {
    // Check Supabase session first, then fall back to offline session
    let session = await window.Auth.getSession();
    let offlineEmail = null;

    if (!session) {
      const stored = JSON.parse(sessionStorage.getItem('fin_offline_session') || 'null');
      if (stored && stored.email && window.Auth.isAllowedEmail(stored.email)) {
        offlineEmail = stored.email;
      } else {
        show('loginGate'); hide('financePanel'); hide('forbidden'); return;
      }
    }

    const email = offlineEmail || session.user.email;
    let row = null;

    // Try the admins DB table first
    if (sb) {
      try {
        const { data } = await sb.from('admins')
          .select('role,full_name')
          .eq('email', email)
          .maybeSingle();
        row = data;
      } catch (_) { /* table may not exist — fall through to ADMIN_EMAILS check */ }
    }

    // Fallback: if email is in ADMIN_EMAILS config, grant admin access
    if (!row && window.Auth.isAllowedEmail(email)) {
      row = { role: 'admin', full_name: '' };
    }

    if (!row) {
      const whoEl = $('whoami');
      const reasonEl = $('forbiddenReason');
      if (whoEl) whoEl.textContent = email;
      if (reasonEl) reasonEl.textContent = `${email} is not listed in ADMIN_EMAILS (config.js) and has no record in the admins table.`;
      show('forbidden'); hide('loginGate'); hide('financePanel'); return;
    }

    userRole = row.role;
    const emailDisplay = offlineEmail
      ? `${email} · offline mode`
      : (row.full_name ? `${row.full_name} (${email})` : email);
    $('finEmail').textContent = emailDisplay;
    $('roleBadge').textContent = {admin:'Admin',accountant:'Accountant',auditor:'Auditor'}[userRole]||userRole;
    $('roleBadge').className = 'fin-role-badge role-'+userRole;
    if (userRole==='auditor') { const c=$('addExpenseCard'); if(c) c.hidden=true; }
    hide('loginGate'); hide('forbidden'); show('financePanel');
    await loadBuses();
    showSection('overview');
    await loadReport();
  }

  function show(id){const el=$(id);if(el)el.hidden=false;}
  function hide(id){const el=$(id);if(el)el.hidden=true;}

  // ── connection status indicator ───────────────────────────────────────────
  (async function checkSbStatus() {
    const box = $('sbStatus'); if (!box) return;
    if (!window.SB) {
      box.style.display = '';
      box.style.background = '#fef2f2'; box.style.color = '#991b1b';
      box.textContent = '⚠ Supabase library not loaded. Check your internet connection, then do a hard refresh (Ctrl + Shift + R).';
      return;
    }
    box.style.display = ''; box.textContent = '⏳ Checking connection…';
    try {
      await window.SB.auth.getSession();
      box.style.display = 'none'; // all good — hide the status bar
    } catch(e) {
      box.style.background = '#fef2f2'; box.style.color = '#991b1b';
      box.textContent = '⚠ Cannot reach Supabase: ' + (e.message || 'network error');
    }
  })();

  // ── login ──────────────────────────────────────────────────────────────────
  // Password show/hide toggle
  $('togglePass')?.addEventListener('click', () => {
    const inp = $('loginPassword');
    const isText = inp.type === 'text';
    inp.type = isText ? 'password' : 'text';
    $('eyeOpen').style.display  = isText ? '' : 'none';
    $('eyeClosed').style.display = isText ? 'none' : '';
  });

  function loginSetBusy(busy) {
    $('loginBtn').disabled = busy;
    $('loginBtn').textContent = busy ? 'Signing in…' : 'Sign in';
    const s = $('signUpBtn'); if (s) s.disabled = busy;
  }

  function showLoginErr(msg) {
    const el = $('loginError');
    el.innerHTML = msg;
    el.hidden = false;
    $('loginSuccess').hidden = true;
    $('offlineBypass').hidden = true;
  }
  function showLoginOk(msg) {
    const el = $('loginSuccess');
    el.textContent = msg;
    el.hidden = false;
    $('loginError').hidden = true;
    $('offlineBypass').hidden = true;
  }

  $('loginForm').addEventListener('submit', async(e)=>{
    e.preventDefault();
    $('loginError').hidden = true;
    $('loginSuccess').hidden = true;
    $('offlineBypass').hidden = true;
    const email = $('loginEmail').value.trim();
    const pass  = $('loginPassword').value;
    loginSetBusy(true);
    try {
      await window.Auth.signIn(email, pass);
      sessionStorage.removeItem('fin_offline_session');
      await gate();
    } catch(ex) {
      const msg = ex.message || '';
      if (msg.includes('Invalid login') || msg.includes('invalid_credentials')) {
        showLoginErr('Wrong email or password. If you haven\'t created an account yet, click <strong>Create account</strong> below.');
      } else if (msg.includes('Email not confirmed')) {
        if (window.Auth.isAllowedEmail(email)) {
          showLoginErr('Your email isn\'t confirmed yet. Either:<br>1. Go to <strong>Supabase Dashboard → Authentication → Providers → Email → turn OFF "Confirm email"</strong><br>2. Or use <strong>offline mode</strong> below while you fix it.');
          $('offlineBypass').hidden = false;
        } else {
          showLoginErr('Please confirm your email first — check your inbox for a verification link.');
        }
      } else if (msg.includes('not configured')) {
        showLoginErr('Supabase not configured. Check <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code> in config.js.');
      } else {
        showLoginErr(msg || 'Sign-in failed. Check your email and password and try again.');
      }
    }
    loginSetBusy(false);
  });

  $('signUpBtn')?.addEventListener('click', async()=>{
    const email = $('loginEmail').value.trim();
    const pass  = $('loginPassword').value;
    if (!email || !pass) { showLoginErr('Enter your email and a password (min 6 chars) first.'); return; }
    if (pass.length < 6) { showLoginErr('Password must be at least 6 characters.'); return; }
    if (!window.Auth.isAllowedEmail(email)) {
      showLoginErr(`<strong>${email}</strong> is not in the authorized list. Add it to <code>ADMIN_EMAILS</code> in config.js first.`); return;
    }
    loginSetBusy(true);
    try {
      await window.Auth.signUp(email, pass);
      showLoginOk('Account created! Now go to Supabase Dashboard → Authentication → Providers → Email → turn OFF "Confirm email", then sign in.');
    } catch(ex) {
      const msg = ex.message || '';
      if (msg.includes('already registered') || msg.includes('already been registered'))
        showLoginErr('An account with this email already exists — just sign in with your password.');
      else
        showLoginErr(msg || 'Sign-up failed.');
    }
    loginSetBusy(false);
  });

  $('offlineAccessBtn')?.addEventListener('click', async()=>{
    const email = $('loginEmail').value.trim();
    if (!window.Auth.isAllowedEmail(email)) return;
    sessionStorage.setItem('fin_offline_session', JSON.stringify({ email, ts: Date.now() }));
    $('offlineBypass').hidden = true;
    await gate();
  });

  ['logoutBtn','signOutBtn'].forEach(id=>{
    $(id)?.addEventListener('click', async()=>{
      sessionStorage.removeItem('fin_offline_session');
      await window.Auth.signOut();
      location.reload();
    });
  });

  // ── sidebar nav (with mobile drawer auto-close) ───────────────────────────
  function closeMobileSidebar() {
    document.body.classList.remove('fin-sidebar-open');
  }
  function toggleMobileSidebar() {
    document.body.classList.toggle('fin-sidebar-open');
  }
  $('mobileMenuBtn')?.addEventListener('click', toggleMobileSidebar);
  $('sidebarOverlay')?.addEventListener('click', closeMobileSidebar);

  document.querySelectorAll('.fin-nav-item').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.fin-nav-item').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      showSection(btn.dataset.section);
      closeMobileSidebar();
    });
  });
  function showSection(name){
    document.querySelectorAll('.fin-section').forEach(s=>s.classList.remove('active'));
    const sec=$('sec-'+name); if(sec) sec.classList.add('active');
  }

  // ── period buttons ─────────────────────────────────────────────────────────
  document.querySelectorAll('.fin-period-btn').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('.fin-period-btn').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      activePeriod=btn.dataset.period;
    });
  });

  // ── ledger tabs ────────────────────────────────────────────────────────────
  document.querySelectorAll('[data-ledger]').forEach(btn=>{
    btn.addEventListener('click',()=>{
      document.querySelectorAll('[data-ledger]').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      ['bookings','shipments','payments'].forEach(t=>{
        const el=$('ledger-'+t); if(el) el.hidden=(t!==btn.dataset.ledger);
      });
    });
  });

  // ── load buses ─────────────────────────────────────────────────────────────
  async function loadBuses(){
    if(!sb) return;
    const {data}=await sb.from('buses').select('id,name').order('name');
    (data||[]).forEach(b=>{
      busMap[b.id]=b.name;
      [$('busFilter'),$('expBus'),$('adjBus')].forEach(sel=>{
        if(!sel) return;
        const o=document.createElement('option'); o.value=b.id; o.textContent=b.name; sel.appendChild(o);
      });
    });
  }

  // ── load report ────────────────────────────────────────────────────────────
  $('loadDataBtn').addEventListener('click', loadReport);

  async function loadReport(){
    const anchor=$('periodDate').value||new Date().toISOString().slice(0,10);
    const busId=$('busFilter').value;
    currentRange=dateRange(anchor,activePeriod);
    $('finLoading').hidden=false;
    document.querySelectorAll('.fin-section').forEach(s=>s.classList.remove('active'));
    try {
      allData=await fetchAll(sb,currentRange,busId==='all'?null:busId);
      render(allData,currentRange,busId);
    } catch(e){ alert('Error loading data: '+e.message); }
    finally {
      $('finLoading').hidden=true;
      showSection(document.querySelector('.fin-nav-item.active')?.dataset.section||'overview');
    }
  }

  // ── fetch ──────────────────────────────────────────────────────────────────
  async function fetchAll(sb,range,busId){
    if(!sb) return emptyData();
    const [bookings,shipments,payments,expenses,adjustments]=await Promise.all([
      fetchBookings(sb,range,busId),
      fetchShipments(sb,range,busId),
      fetchPayments(sb,range),
      fetchExpenses(sb,range,busId),
      fetchAdjustments(sb,range,busId),
    ]);
    return {bookings,shipments,payments,expenses,adjustments};
  }

  async function fetchBookings(sb,range,busId){
    let q=sb.from('bookings')
      .select('ticket_code,bus_id,bus_name,origin,destination,travel_date,departure_time,seat_number,passenger_name,passenger_phone,fare_tzs,status,created_at,refund_tzs,cancelled_at,passenger_phone')
      .gte('created_at',range.from).lt('created_at',range.to)
      .order('created_at',{ascending:false});
    if(busId) q=q.eq('bus_id',busId);
    const {data,error}=await q;
    if(error){ console.warn('Bookings:',error.message); return []; }
    return data||[];
  }

  async function fetchShipments(sb,range,busId){
    let q=sb.from('shipments')
      .select('tracking_code,sender_name,sender_phone,sender_region,receiver_name,receiver_phone,receiver_region,product_description,product_weight_kg,product_value_tzs,insured,bus_name,bus_route,status,created_at,notes')
      .gte('created_at',range.from).lt('created_at',range.to)
      .order('created_at',{ascending:false});
    if(busId){ const bn=busMap[busId]; if(bn) q=q.eq('bus_name',bn); }
    const {data,error}=await q;
    if(error){ console.warn('Shipments:',error.message); return []; }
    return data||[];
  }

  async function fetchPayments(sb,range){
    const {data,error}=await sb.from('payments')
      .select('id,reference,reference_type,amount_tzs,method,provider,status,customer_name,customer_phone,provider_ref,external_ref,paid_at,created_at')
      .gte('created_at',range.from).lt('created_at',range.to)
      .order('created_at',{ascending:false});
    if(error){ console.warn('Payments:',error.message); return []; }
    return data||[];
  }

  async function fetchExpenses(sb,range,busId){
    let q=sb.from('org_expenses').select('*')
      .gte('period_date',range.from).lt('period_date',range.to)
      .order('period_date',{ascending:false});
    if(busId) q=q.eq('bus_company_id',busId);
    const {data,error}=await q;
    if(error){ console.warn('Expenses:',error.message); return []; }
    return data||[];
  }

  async function fetchAdjustments(sb,range,busId){
    let q=sb.from('org_adjustments').select('*')
      .gte('period_date',range.from).lt('period_date',range.to)
      .order('period_date',{ascending:false});
    if(busId) q=q.eq('bus_company_id',busId);
    const {data,error}=await q;
    if(error){ console.warn('Adjustments:',error.message); return []; }
    return data||[];
  }

  function emptyData(){ return {bookings:[],shipments:[],payments:[],expenses:[],adjustments:[]}; }

  // ── calculations ───────────────────────────────────────────────────────────
  function calcFinancials(data){
    // Booking funnel
    const total        = data.bookings.length;
    const confirmed    = data.bookings.filter(b=>['confirmed','boarded','completed'].includes(b.status));
    const pending      = data.bookings.filter(b=>['pending','awaiting_payment'].includes(b.status));
    const expired      = data.bookings.filter(b=>['expired','cancelled','refund_initiated','rescheduled'].includes(b.status));
    const convRate     = total ? (confirmed.length/total) : 0;

    const ticketRev    = confirmed.reduce((s,b)=>s+(b.fare_tzs||0),0);
    const pendingRev   = pending.reduce((s,b)=>s+(b.fare_tzs||0),0);
    const refundedRev  = data.bookings.filter(b=>b.status==='refund_initiated').reduce((s,b)=>s+(b.refund_tzs||0),0);

    const cargoRev     = data.shipments.filter(s=>s.status!=='Cancelled').reduce((s,sh)=>s+freightCalc(sh),0);
    const totalRev     = ticketRev+cargoRev;
    const vatAmt       = totalRev*(TAX.VAT_RATE/(1+TAX.VAT_RATE));
    const netRev       = totalRev-vatAmt;

    const salaryCost   = data.expenses.filter(e=>e.category==='salaries').reduce((s,e)=>s+(e.amount_tzs||0),0);
    const sdlAmt       = salaryCost*TAX.SDL_RATE;
    const totalExp     = data.expenses.reduce((s,e)=>s+(e.amount_tzs||0),0);

    // Adjustments (company-level: bonuses, deductions, corrections, etc.)
    const adjs         = data.adjustments || [];
    const adjDebits    = adjs.filter(a=>a.direction==='debit').reduce((s,a)=>s+(a.amount_tzs||0),0);
    const adjCredits   = adjs.filter(a=>a.direction==='credit').reduce((s,a)=>s+(a.amount_tzs||0),0);
    const adjNet       = adjCredits - adjDebits; // positive = net income boost, negative = net cost
    const adjByType    = {};
    adjs.forEach(a=>{ adjByType[a.type]=(adjByType[a.type]||0)+(a.direction==='debit'?-(a.amount_tzs||0):(a.amount_tzs||0)); });

    const opProfit     = netRev + adjNet - totalExp;
    const citProv      = Math.max(0,opProfit*TAX.CIT_RATE);
    const netProfit    = opProfit-citProv;

    // Payment status — prefer payments table; fall back to bookings status
    let payConf,payPend,payFail,payRef;
    if(data.payments.length){
      payConf = data.payments.filter(p=>p.status==='completed').reduce((s,p)=>s+(p.amount_tzs||0),0);
      payPend = data.payments.filter(p=>['pending','awaiting_payment','processing'].includes(p.status)).reduce((s,p)=>s+(p.amount_tzs||0),0);
      payFail = data.payments.filter(p=>['failed','cancelled','expired'].includes(p.status)).reduce((s,p)=>s+(p.amount_tzs||0),0);
      payRef  = data.payments.filter(p=>p.status==='refunded').reduce((s,p)=>s+(p.amount_tzs||0),0);
    } else {
      // Fall back: derive from bookings when payments table has no rows
      payConf = ticketRev;
      payPend = pendingRev;
      payFail = expired.reduce((s,b)=>s+(b.fare_tzs||0),0);
      payRef  = refundedRev;
    }

    // By bus company
    const byBus={};
    confirmed.forEach(b=>{
      const k=b.bus_id||'unk';
      if(!byBus[k]) byBus[k]={name:b.bus_name||busMap[k]||k,bookingCount:0,ticketRev:0,shipCount:0,cargoRev:0,expenses:0};
      byBus[k].bookingCount++; byBus[k].ticketRev+=(b.fare_tzs||0);
    });
    data.shipments.filter(s=>s.status!=='Cancelled').forEach(s=>{
      const mid=Object.keys(busMap).find(id=>busMap[id]===s.bus_name);
      const k=mid||('s-'+s.bus_name);
      if(!byBus[k]) byBus[k]={name:s.bus_name||k,bookingCount:0,ticketRev:0,shipCount:0,cargoRev:0,expenses:0};
      byBus[k].shipCount++; byBus[k].cargoRev+=freightCalc(s);
    });
    data.expenses.forEach(e=>{
      const k=e.bus_company_id||'org';
      if(!byBus[k]) byBus[k]={name:busMap[k]||'Organisation',bookingCount:0,ticketRev:0,shipCount:0,cargoRev:0,expenses:0};
      byBus[k].expenses+=(e.amount_tzs||0);
    });

    const expByCat={};
    data.expenses.forEach(e=>{ expByCat[e.category]=(expByCat[e.category]||0)+(e.amount_tzs||0); });

    return {
      total,confirmed:confirmed.length,pending:pending.length,
      expired:expired.length,convRate,
      ticketRev,pendingRev,refundedRev,cargoRev,totalRev,
      vatAmt,netRev,salaryCost,sdlAmt,totalExp,
      adjDebits,adjCredits,adjNet,adjByType,
      opProfit,citProv,netProfit,
      payConf,payPend,payFail,payRef,
      byBus,expByCat,
      shipCount:data.shipments.length,
      paymentsFallback:data.payments.length===0,
    };
  }

  // ── render (all sections) ──────────────────────────────────────────────────
  function render(data,range,busId){
    const fin=calcFinancials(data);
    const pill=`${range.from} → ${range.to} (${range.label})`;
    ['overview','income','tax','buses','ledger','expenses','cashflow','balance','budget','ratios','adj','forecast'].forEach(s=>{
      const el=$(s+'PeriodLabel'); if(el) el.textContent=pill;
    });
    renderOverview(fin,data);
    renderPL(fin,range);
    renderTax(fin,range);
    renderBusTable(fin);
    renderLedger(data);
    renderExpenses(data.expenses,fin.totalExp);
    renderAdjustments(data.adjustments||[],fin);
    renderCashFlow(fin,range);
    renderBalanceSheet(fin,range);
    renderBudget(fin);
    renderRatios(fin);
  }

  // ── overview ───────────────────────────────────────────────────────────────
  function renderOverview(fin,data){
    $('kpiGrossRevenue').textContent = fmt(fin.totalRev);
    $('kpiGrossRevSub').textContent  = `${fin.confirmed} confirmed · ${fin.shipCount} shipments`;
    $('kpiTickets').textContent      = fmt(fin.ticketRev);
    $('kpiTicketsSub').textContent   = `${fin.confirmed} of ${fin.total} bookings confirmed (${pct(fin.confirmed,fin.total)} conversion)`;
    $('kpiCargo').textContent        = fmt(fin.cargoRev);
    $('kpiCargoSub').textContent     = `${fin.shipCount} shipments`;
    $('kpiVat').textContent          = fmt(fin.vatAmt);
    $('kpiExpenses').textContent     = fmt(fin.totalExp);
    $('kpiExpensesSub').textContent  = `${data.expenses.length} expense entries`;

    const profEl=$('kpiProfit'), profCard=$('kpiProfitCard');
    profEl.textContent   = fmt(fin.netProfit);
    $('kpiProfitSub').textContent = fin.netProfit>=0
      ? `After VAT, expenses & CIT est.`
      : 'Operating at a loss — review expenses';
    profCard.className='kpi-card '+(fin.netProfit>=0?'kpi-profit':'kpi-loss');

    // Booking funnel card
    renderFunnel(fin);

    // Payment status (with fallback note)
    $('psSConfirmed').textContent = fmt(fin.payConf);
    $('psSPending').textContent   = fmt(fin.payPend);
    $('pssFailed').textContent    = fmt(fin.payFail);
    $('psSRefunded').textContent  = fmt(fin.payRef);
    const fallbackNote=$('payFallbackNote');
    if(fallbackNote) fallbackNote.hidden=!fin.paymentsFallback;

    // Revenue bar chart
    const chartEl=$('revenueChart'); chartEl.innerHTML='';
    const entries=Object.entries(fin.byBus)
      .map(([k,v])=>({...v,key:k,total:v.ticketRev+v.cargoRev}))
      .filter(v=>v.total>0).sort((a,b)=>b.total-a.total);
    const maxRev=entries[0]?.total||1;
    entries.slice(0,12).forEach(b=>{
      const w=clamp((b.total/maxRev)*100,2,100);
      const share=pct(b.total,fin.totalRev);
      const row=document.createElement('div'); row.className='chart-row';
      row.innerHTML=`
        <span class="chart-label" title="${b.name}">${b.name}</span>
        <div class="chart-bar-wrap">
          <div class="chart-bar" style="width:${w.toFixed(1)}%"></div>
          <span class="chart-val">${fmt(b.total)} <span class="chart-share">${share}</span></span>
        </div>`;
      chartEl.appendChild(row);
    });
    if(!entries.length) chartEl.innerHTML='<p class="empty-row">No revenue data for this period.</p>';
  }

  function renderFunnel(fin){
    const el=$('bookingFunnel'); if(!el) return;
    el.innerHTML=`
      <div class="funnel-row">
        <span class="funnel-label">Total Bookings</span>
        <span class="funnel-bar-wrap">
          <span class="funnel-bar" style="width:100%;background:#6b7280"></span>
        </span>
        <span class="funnel-val">${fin.total}</span>
      </div>
      <div class="funnel-row">
        <span class="funnel-label">Confirmed</span>
        <span class="funnel-bar-wrap">
          <span class="funnel-bar" style="width:${pct(fin.confirmed,fin.total||1)};background:#16a34a"></span>
        </span>
        <span class="funnel-val">${fin.confirmed} <small>(${pct(fin.confirmed,fin.total||1)})</small></span>
      </div>
      <div class="funnel-row">
        <span class="funnel-label">Pending</span>
        <span class="funnel-bar-wrap">
          <span class="funnel-bar" style="width:${pct(fin.pending,fin.total||1)};background:#f59e0b"></span>
        </span>
        <span class="funnel-val">${fin.pending} <small style="color:var(--warn)">${fmt(fin.pendingRev)}</small></span>
      </div>
      <div class="funnel-row">
        <span class="funnel-label">Cancelled / Expired</span>
        <span class="funnel-bar-wrap">
          <span class="funnel-bar" style="width:${pct(fin.expired,fin.total||1)};background:#dc2626"></span>
        </span>
        <span class="funnel-val">${fin.expired}</span>
      </div>`;
  }

  // ── P&L ────────────────────────────────────────────────────────────────────
  function renderPL(fin,range){
    $('plDateRange').textContent=`${range.from}  →  ${range.to}`;
    const rows=[
      ['section','REVENUE'],
      ['item','Ticket Sales (confirmed bookings)',   fin.ticketRev],
      ['item','Cargo & Parcel Revenue',              fin.cargoRev],
      ['item','Pending Revenue (not yet confirmed)',  fin.pendingRev,'pending'],
      ['subtotal','GROSS REVENUE (confirmed)',        fin.totalRev],
      ['space'],
      ['deduct','Less: VAT Collected (18%)',         -fin.vatAmt],
      ['subtotal','NET REVENUE (ex-VAT)',             fin.netRev],
      ['space'],
      ['section','OPERATING EXPENSES'],
      ...expCatRows(fin.expByCat),
      ['subtotal','TOTAL EXPENSES',                  -fin.totalExp],
      ['space'],
      ['section','COMPANY ADJUSTMENTS'],
      ...(fin.adjDebits>0  ? [['deduct','Adjustments — Debits (bonuses, deductions, etc.)', -fin.adjDebits]] : []),
      ...(fin.adjCredits>0 ? [['item','Adjustments — Credits (income corrections, etc.)',    fin.adjCredits]] : []),
      ...(fin.adjDebits===0&&fin.adjCredits===0 ? [['note','No adjustments recorded for this period','']] : []),
      ['subtotal','NET ADJUSTMENT EFFECT', fin.adjNet, fin.adjNet>=0?'pos':'neg'],
      ['space'],
      ['subtotal','OPERATING PROFIT (EBITDA)',        fin.opProfit, fin.opProfit>=0?'pos':'neg'],
      ['space'],
      ['section','TAX PROVISIONS (ESTIMATES)'],
      ['deduct',`Skills Development Levy SDL (${(TAX.SDL_RATE*100).toFixed(0)}%)`, -fin.sdlAmt],
      ...(range.period==='year'
        ? [['deduct',`Corporate Income Tax CIT (${(TAX.CIT_RATE*100).toFixed(0)}%)`, -fin.citProv]]
        : [['note','CIT is annual — shown in Yearly report only','']]),
      ['space'],
      ['total','NET PROFIT AFTER TAX (est.)', fin.netProfit, fin.netProfit>=0?'pos':'neg'],
    ];
    $('plTable').querySelector('tbody').innerHTML=rows.map(plRow).join('');
  }

  function expCatRows(expByCat){
    const L={fuel:'Fuel & Operations',salaries:'Salaries & PAYE',maintenance:'Maintenance',
      insurance:'Insurance',marketing:'Marketing',office:'Office & Admin',
      tax_payment:'Tax Payments (TRA)',licensing:'Licensing & Permits',repairs:'Repairs',other:'Other'};
    return Object.entries(expByCat).map(([c,a])=>['item',L[c]||c,-a]);
  }

  function plRow([type,label,amt,cls]){
    if(type==='space') return '<tr class="pl-space"><td colspan="2"></td></tr>';
    if(type==='section') return `<tr class="pl-section"><td colspan="2">${label}</td></tr>`;
    if(type==='note') return `<tr class="pl-note"><td colspan="2"><em>${label}</em></td></tr>`;
    const css=['pl-'+type, cls||( (amt!=null&&amt<0)?'neg':'')].filter(Boolean).join(' ');
    const av= amt==null?'' : (amt<0?`(${fmt(Math.abs(amt))})`:fmt(amt));
    const pending = cls==='pending'?` <span class="pill-warn">pending</span>`:'';
    return `<tr class="${css}"><td>${label}${pending}</td><td class="num">${av}</td></tr>`;
  }

  // ── Tax ────────────────────────────────────────────────────────────────────
  function renderTax(fin,range){
    const isYear=range.period==='year';
    $('vatTable').querySelector('tbody').innerHTML=[
      ['Gross Revenue (VAT-inclusive)',   fmt(fin.totalRev)],
      ['VAT Rate',                        '18%'],
      ['Output VAT',                      fmt(fin.vatAmt)],
      ['Net Revenue (ex-VAT)',            fmt(fin.netRev)],
      ['---'],
      ['Filing Period',                   range.label],
      ['Return Due Date',                 vatDue(range)],
    ].map(taxRow).join('');

    $('payeTable').querySelector('tbody').innerHTML=[
      ['Gross Salary Costs (period)',     fmt(fin.salaryCost)],
      ['SDL @ 4%',                        fmt(fin.sdlAmt)],
      ['PAYE',                            'Calculated per employee salary band'],
      ['---'],
      ['Due Date',                        'By 7th of following month'],
    ].map(taxRow).join('');

    $('citTable').querySelector('tbody').innerHTML=isYear?[
      ['Net Revenue (ex-VAT)',            fmt(fin.netRev)],
      ['Total Expenses',                  `(${fmt(fin.totalExp)})`],
      ['Taxable Profit (estimate)',        fmt(fin.opProfit)],
      ['CIT Rate',                        '30%'],
      ['CIT Provision',                   fmt(fin.citProv)],
      ['---'],
      ['Tax Year',                        range.from.slice(0,4)],
      ['Annual Return Due',               'Within 6 months of year-end'],
    ].map(taxRow).join('')
    : `<tr><td colspan="2" class="empty-row" style="font-style:italic;padding:16px">
        CIT is an annual tax. Switch to the <strong>Year</strong> period to see the CIT estimate.
       </td></tr>`;

    $('whtTable').querySelector('tbody').innerHTML=[
      ['Service Payments (from expenses)', fmt(fin.expByCat['office']||0)],
      ['WHT on Services (5%)',             fmt((fin.expByCat['office']||0)*TAX.WHT_SERVICES)],
      ['Rental Payments (from expenses)',  fmt(fin.expByCat['other']||0)],
      ['WHT on Rent (10%)',                fmt((fin.expByCat['other']||0)*TAX.WHT_RENT)],
      ['---'],
      ['WHT Due',                          '7 days after payment to resident'],
    ].map(taxRow).join('');

    renderTaxCalendar(range);
  }

  function taxRow(r){
    if(!r||r[0]==='---') return '<tr class="tax-divider"><td colspan="2"></td></tr>';
    return `<tr><td>${r[0]}</td><td class="num tax-val">${r[1]}</td></tr>`;
  }

  function vatDue(range){
    const d=new Date(range.to); d.setDate(20);
    return d.toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
  }

  function renderTaxCalendar(range){
    const year=parseInt(range.from.slice(0,4));
    const now=new Date();
    const items=[
      {month:1,day:7,tax:'PAYE & SDL',desc:'January payroll'},
      {month:2,day:7,tax:'PAYE & SDL',desc:'February payroll'},
      {month:2,day:20,tax:'VAT',desc:'January VAT return'},
      {month:3,day:7,tax:'PAYE & SDL',desc:'March payroll'},
      {month:3,day:20,tax:'VAT',desc:'February VAT return'},
      {month:4,day:7,tax:'PAYE & SDL',desc:'April payroll + Q1 CIT installment'},
      {month:4,day:20,tax:'VAT',desc:'March VAT return'},
      {month:5,day:7,tax:'PAYE & SDL',desc:'May payroll'},
      {month:5,day:20,tax:'VAT',desc:'April VAT return'},
      {month:6,day:7,tax:'PAYE & SDL',desc:'June payroll + Q2 CIT installment'},
      {month:6,day:20,tax:'VAT',desc:'May VAT return'},
      {month:7,day:7,tax:'PAYE & SDL',desc:'July payroll'},
      {month:7,day:20,tax:'VAT',desc:'June VAT return'},
      {month:8,day:7,tax:'PAYE & SDL',desc:'August payroll'},
      {month:8,day:20,tax:'VAT',desc:'July VAT return'},
      {month:9,day:7,tax:'PAYE & SDL',desc:'September payroll + Q3 CIT installment'},
      {month:9,day:20,tax:'VAT',desc:'August VAT return'},
      {month:10,day:7,tax:'PAYE & SDL',desc:'October payroll'},
      {month:10,day:20,tax:'VAT',desc:'September VAT return'},
      {month:11,day:7,tax:'PAYE & SDL',desc:'November payroll'},
      {month:11,day:20,tax:'VAT',desc:'October VAT return'},
      {month:12,day:7,tax:'PAYE & SDL',desc:'December payroll + Q4 CIT installment'},
      {month:12,day:20,tax:'VAT',desc:'November VAT return'},
    ];
    $('taxCalendar').innerHTML=items.map(it=>{
      const due=new Date(year,it.month-1,it.day);
      const past=due<now, soon=!past&&(due-now)<14*86400000;
      return `<div class="tcal-item ${past?'tcal-past':soon?'tcal-soon':''}">
        <span class="tcal-date">${due.toLocaleDateString('en-GB',{day:'numeric',month:'short'})}</span>
        <span class="tcal-tax">${it.tax}</span>
        <span class="tcal-desc">${it.desc}</span>
      </div>`;
    }).join('');
  }

  // ── Bus company table ──────────────────────────────────────────────────────
  function renderBusTable(fin){
    const rows=Object.values(fin.byBus)
      .filter(b=>b.ticketRev+b.cargoRev+b.expenses>0)
      .sort((a,b)=>(b.ticketRev+b.cargoRev)-(a.ticketRev+a.cargoRev));

    let tBk=0,tTk=0,tSh=0,tCg=0,tEx=0;
    rows.forEach(r=>{tBk+=r.bookingCount;tTk+=r.ticketRev;tSh+=r.shipCount;tCg+=r.cargoRev;tEx+=r.expenses;});
    const tRev=tTk+tCg, tVat=tRev*(TAX.VAT_RATE/(1+TAX.VAT_RATE)), tNet=tRev-tVat;

    $('busRevenueBody').innerHTML=rows.length?rows.map(r=>{
      const rev=r.ticketRev+r.cargoRev;
      const vat=rev*(TAX.VAT_RATE/(1+TAX.VAT_RATE));
      const net=rev-vat;
      const profit=net-r.expenses;
      const share=pct(rev,fin.totalRev||1);
      return `<tr>
        <td>${r.name}</td>
        <td class="num">${r.bookingCount}</td>
        <td class="num">${fmtN(r.ticketRev)}</td>
        <td class="num">${r.shipCount}</td>
        <td class="num">${fmtN(r.cargoRev)}</td>
        <td class="num"><strong>${fmtN(rev)}</strong></td>
        <td class="num"><span class="share-pill">${share}</span></td>
        <td class="num neg">(${fmtN(vat)})</td>
        <td class="num">${fmtN(net)}</td>
        <td class="num neg">(${fmtN(r.expenses)})</td>
        <td class="num ${profit>=0?'pos':'neg'}">${profit>=0?fmtN(profit):'('+fmtN(Math.abs(profit))+')' }</td>
      </tr>`;
    }).join(''):'<tr><td colspan="11" class="empty-row">No data for this period.</td></tr>';

    const tProfit=tNet-tEx;
    $('busRevenueFoot').innerHTML=`<tr class="pl-total">
      <td>TOTAL</td><td class="num">${tBk}</td><td class="num">${fmtN(tTk)}</td>
      <td class="num">${tSh}</td><td class="num">${fmtN(tCg)}</td>
      <td class="num"><strong>${fmtN(tRev)}</strong></td>
      <td class="num">100%</td>
      <td class="num neg">(${fmtN(tVat)})</td><td class="num">${fmtN(tNet)}</td>
      <td class="num neg">(${fmtN(tEx)})</td>
      <td class="num ${tProfit>=0?'pos':'neg'}">${tProfit>=0?fmtN(tProfit):'('+fmtN(Math.abs(tProfit))+')'}</td>
    </tr>`;
  }

  // ── Ledger ─────────────────────────────────────────────────────────────────
  function renderLedger(data){
    $('bookingsLedgerBody').innerHTML=data.bookings.length
      ?data.bookings.map(b=>{
          const ph=(b.passenger_phone||'').replace(/\s/g,'');
          const callLink=ph?`<a href="tel:${ph}" class="btn btn-outline btn-xs" title="Call passenger">📞</a>`:'—';
          return `<tr>
            <td><code>${b.ticket_code}</code></td>
            <td>${b.travel_date||b.created_at?.slice(0,10)||'—'}</td>
            <td>${b.bus_name||'—'}</td>
            <td>${b.origin||'—'} → ${b.destination||'—'}</td>
            <td>${b.passenger_name||'—'}</td>
            <td>${b.seat_number||'—'}</td>
            <td>${callLink}</td>
            <td class="num ${(b.fare_tzs||0)===0?'neg':''}">${fmtN(b.fare_tzs)}</td>
            <td><span class="status-pill" style="background:${statusColor(b.status)}20;color:${statusColor(b.status)};border:1px solid ${statusColor(b.status)}40">${b.status}</span></td>
          </tr>`;}).join('')
      :'<tr><td colspan="9" class="empty-row">No bookings in this period.</td></tr>';

    $('shipmentsLedgerBody').innerHTML=data.shipments.length
      ?data.shipments.map(s=>`<tr>
          <td><code>${s.tracking_code}</code></td>
          <td>${s.created_at?.slice(0,10)||'—'}</td>
          <td>${s.bus_name||'—'}</td>
          <td>${s.bus_route||'—'}</td>
          <td>${s.sender_name||'—'}</td>
          <td>${s.receiver_name||'—'}</td>
          <td class="num">${s.product_weight_kg}</td>
          <td class="num">${fmtN(freightCalc(s))}</td>
          <td><span class="status-pill" style="background:${statusColor(s.status)}20;color:${statusColor(s.status)};border:1px solid ${statusColor(s.status)}40">${s.status}</span></td>
        </tr>`).join('')
      :'<tr><td colspan="9" class="empty-row">No shipments in this period.</td></tr>';

    $('paymentsLedgerBody').innerHTML=data.payments.length
      ?data.payments.map(p=>`<tr>
          <td><code>${p.reference||'—'}</code></td>
          <td>${(p.paid_at||p.created_at)?.slice(0,10)||'—'}</td>
          <td>${p.customer_name||'—'}</td>
          <td>${p.customer_phone?`<a href="tel:${(p.customer_phone).replace(/\s/g,'')}" class="btn btn-outline btn-xs">📞 ${p.customer_phone}</a>`:'—'}</td>
          <td>${p.method||'—'}</td>
          <td>${p.provider||'—'}</td>
          <td class="num">${fmtN(p.amount_tzs)}</td>
          <td><span class="status-pill" style="background:${statusColor(p.status)}20;color:${statusColor(p.status)};border:1px solid ${statusColor(p.status)}40">${p.status}</span></td>
        </tr>`).join('')
      :'<tr><td colspan="8" class="empty-row">No payment records in this period.</td></tr>';
  }

  // ── Expenses ───────────────────────────────────────────────────────────────
  function catLabel(c){
    return ({fuel:'Fuel',salaries:'Salaries',maintenance:'Maintenance',insurance:'Insurance',
      marketing:'Marketing',office:'Office',tax_payment:'Tax (TRA)',
      licensing:'Licensing',repairs:'Repairs',other:'Other'})[c]||c;
  }

  function renderExpenses(expenses,total){
    $('expTotal').textContent=fmt(total);
    $('expensesBody').innerHTML=expenses.length
      ?expenses.map(e=>`<tr>
          <td>${e.period_date}</td>
          <td>${e.bus_company_id?(busMap[e.bus_company_id]||e.bus_company_id):'Organisation'}</td>
          <td>${catLabel(e.category)}</td>
          <td>${e.description}</td>
          <td class="num">${fmtN(e.amount_tzs)}</td>
          <td><small>${e.receipt_ref||'—'}</small></td>
          <td><small>${e.recorded_by}</small></td>
          <td>${userRole!=='auditor'?`<button class="btn-icon" onclick="window.deleteExpense(${e.id})" title="Delete">🗑</button>`:''}</td>
        </tr>`).join('')
      :'<tr><td colspan="8" class="empty-row">No expenses for this period.</td></tr>';

    const byCat={};
    expenses.forEach(e=>{byCat[e.category]=(byCat[e.category]||0)+(e.amount_tzs||0);});
    $('expSummary').innerHTML=Object.entries(byCat).sort((a,b)=>b[1]-a[1])
      .map(([c,a])=>`<span class="exp-chip"><strong>${catLabel(c)}</strong> ${fmt(a)}</span>`).join('');
  }

  // ── Expense form ───────────────────────────────────────────────────────────
  $('expenseForm')?.addEventListener('submit',async(e)=>{
    e.preventDefault();
    const msg=$('expMsg'); msg.textContent=''; msg.className='fin-inline-msg';
    const btn=$('expSubmitBtn'); btn.disabled=true; btn.textContent='Saving…';
    const email=await window.Auth.currentEmail();
    const payload={
      period_date:$('expDate').value,
      bus_company_id:$('expBus').value||null,
      category:$('expCategory').value,
      amount_tzs:parseFloat($('expAmount').value),
      description:$('expDesc').value.trim(),
      receipt_ref:$('expReceipt').value.trim()||null,
      notes:$('expNotes').value.trim()||null,
      recorded_by:email,
    };
    try {
      const {error}=await sb.from('org_expenses').insert(payload);
      if(error) throw error;
      msg.textContent='✓ Expense recorded.'; msg.className='fin-inline-msg success';
      $('expenseForm').reset(); $('expDate').value=new Date().toISOString().slice(0,10);
      if(allData){ allData.expenses.unshift({...payload,id:Date.now()});
        renderExpenses(allData.expenses,allData.expenses.reduce((s,e)=>s+e.amount_tzs,0)); }
    } catch(err){ msg.textContent='✗ '+err.message; msg.className='fin-inline-msg error'; }
    btn.disabled=false; btn.textContent='Record Expense';
  });

  window.deleteExpense=async(id)=>{
    if(!confirm('Delete this expense record?')) return;
    const {error}=await sb.from('org_expenses').delete().eq('id',id);
    if(error){ alert('Error: '+error.message); return; }
    if(allData){ allData.expenses=allData.expenses.filter(e=>e.id!==id);
      renderExpenses(allData.expenses,allData.expenses.reduce((s,e)=>s+e.amount_tzs,0)); }
  };

  // ── Adjustments ────────────────────────────────────────────────────────────
  const ADJ_LABELS = {
    bonus:'Bonus', allowance:'Allowance', commission:'Commission',
    overtime:'Overtime', deduction:'Deduction', penalty:'Penalty',
    correction:'Correction', other:'Other',
  };
  const ADJ_COLORS = {
    bonus:'#0a6f4d', allowance:'#2563eb', commission:'#7c3aed',
    overtime:'#0891b2', deduction:'#dc2626', penalty:'#b91c1c',
    correction:'#92400e', other:'#6b7280',
  };

  function renderAdjustments(adjs,fin){
    // Summary chips
    const summary=$('adjSummary');
    if(summary){
      if(!adjs.length){
        summary.innerHTML='<span style="color:#9ca3af;font-size:0.82rem;padding:8px">No adjustments for this period.</span>';
      } else {
        const debit=fin.adjDebits, credit=fin.adjCredits, net=fin.adjNet;
        summary.innerHTML=`
          <div style="background:#fee2e2;border:1px solid #fca5a5;border-radius:8px;padding:10px 16px;min-width:130px">
            <div style="font-size:0.72rem;font-weight:700;color:#991b1b;text-transform:uppercase;letter-spacing:0.5px">Total Debits</div>
            <div style="font-size:1.1rem;font-weight:800;color:#dc2626">${fmt(debit)}</div>
          </div>
          <div style="background:#dcfce7;border:1px solid #86efac;border-radius:8px;padding:10px 16px;min-width:130px">
            <div style="font-size:0.72rem;font-weight:700;color:#065f46;text-transform:uppercase;letter-spacing:0.5px">Total Credits</div>
            <div style="font-size:1.1rem;font-weight:800;color:#0a6f4d">${fmt(credit)}</div>
          </div>
          <div style="background:${net>=0?'#f0fdf4':'#fff1f2'};border:1px solid ${net>=0?'#86efac':'#fca5a5'};border-radius:8px;padding:10px 16px;min-width:130px">
            <div style="font-size:0.72rem;font-weight:700;color:${net>=0?'#065f46':'#991b1b'};text-transform:uppercase;letter-spacing:0.5px">Net Effect</div>
            <div style="font-size:1.1rem;font-weight:800;color:${net>=0?'#0a6f4d':'#dc2626'}">${net>=0?'+':''}${fmt(Math.abs(net))}</div>
          </div>
          ${Object.entries(fin.adjByType||{}).map(([t,v])=>`
            <span style="background:#f3f4f6;border:1px solid #e5e7eb;border-radius:8px;padding:6px 12px;font-size:0.8rem">
              <strong style="color:${ADJ_COLORS[t]||'#374151'}">${ADJ_LABELS[t]||t}</strong>
              <span style="color:${v>=0?'#0a6f4d':'#dc2626'};margin-left:4px">${v>=0?'+':''}${fmt(Math.abs(v))}</span>
            </span>`).join('')}`;
      }
    }

    // Filter
    const filter=$('adjFilter')?.value||'all';
    const visible=filter==='all'?adjs:adjs.filter(a=>a.type===filter);

    const body=$('adjBody');
    if(!body) return;
    body.innerHTML=visible.length
      ?visible.map(a=>`<tr>
          <td>${a.period_date}</td>
          <td><span style="background:${ADJ_COLORS[a.type]||'#e5e7eb'}22;color:${ADJ_COLORS[a.type]||'#374151'};border-radius:5px;padding:2px 8px;font-size:0.78rem;font-weight:700">${ADJ_LABELS[a.type]||a.type}</span></td>
          <td><span style="font-size:0.78rem;font-weight:700;padding:2px 8px;border-radius:5px;${a.direction==='debit'?'background:#fee2e2;color:#dc2626':'background:#dcfce7;color:#0a6f4d'}">${a.direction==='debit'?'Debit':'Credit'}</span></td>
          <td>${a.bus_company_id?(busMap[a.bus_company_id]||a.bus_company_id):'Org-wide'}</td>
          <td>${a.staff_name||'—'}</td>
          <td>${a.description}</td>
          <td class="num ${a.direction==='debit'?'neg':'pos'}">${a.direction==='debit'?'(':''}${fmtN(a.amount_tzs)}${a.direction==='debit'?')':''}</td>
          <td><small>${a.reference_no||'—'}</small></td>
          <td><small>${a.approved_by||'—'}</small></td>
          <td><small>${a.recorded_by}</small></td>
          <td style="white-space:nowrap">
            <button class="btn-icon" onclick="window.editAdj(${a.id})" title="Edit">✏️</button>
            <button class="btn-icon" onclick="window.deleteAdj(${a.id})" title="Delete" style="color:#dc2626">🗑</button>
          </td>
        </tr>`).join('')
      :'<tr><td colspan="11" class="empty-row">No adjustments for this period.</td></tr>';

    // Totals
    const td=visible.filter(a=>a.direction==='debit').reduce((s,a)=>s+(a.amount_tzs||0),0);
    const tc=visible.filter(a=>a.direction==='credit').reduce((s,a)=>s+(a.amount_tzs||0),0);
    const tn=tc-td;
    const adjTotalDebit=$('adjTotalDebit'), adjTotalCredit=$('adjTotalCredit'), adjNetEl=$('adjNet');
    if(adjTotalDebit) adjTotalDebit.textContent=fmt(td);
    if(adjTotalCredit) adjTotalCredit.textContent=fmt(tc);
    if(adjNetEl){ adjNetEl.textContent=(tn>=0?'+':'')+fmt(Math.abs(tn)); adjNetEl.style.color=tn>=0?'#0a6f4d':'#dc2626'; }
  }

  // Filter re-render on change
  $('adjFilter')?.addEventListener('change',()=>{ if(allData) renderAdjustments(allData.adjustments||[],calcFinancials(allData)); });

  // ── Adjustment form ─────────────────────────────────────────────────────────
  $('adjForm')?.addEventListener('submit',async(e)=>{
    e.preventDefault();
    const msg=$('adjMsg'); msg.textContent=''; msg.className='fin-inline-msg';
    const btn=$('adjSubmitBtn'); btn.disabled=true; btn.textContent='Saving…';
    const email=await window.Auth.currentEmail();
    const payload={
      period_date:$('adjDate').value,
      bus_company_id:$('adjBus').value||null,
      type:$('adjType').value,
      direction:$('adjDirection').value,
      amount_tzs:parseFloat($('adjAmount').value),
      staff_name:$('adjStaff').value.trim()||null,
      description:$('adjDesc').value.trim(),
      reference_no:$('adjRef').value.trim()||null,
      approved_by:$('adjApproved').value.trim()||null,
      notes:$('adjNotes').value.trim()||null,
      recorded_by:email,
    };
    try {
      const editId=btn.dataset.editId;
      let err;
      if(editId){
        ({error:err}=await sb.from('org_adjustments').update(payload).eq('id',Number(editId)));
      } else {
        ({error:err}=await sb.from('org_adjustments').insert(payload));
      }
      if(err) throw err;
      msg.textContent=editId?'✓ Adjustment updated.':'✓ Adjustment recorded.';
      msg.className='fin-inline-msg success';
      delete btn.dataset.editId; btn.textContent='Record Adjustment';
      $('adjForm').reset(); $('adjDate').value=new Date().toISOString().slice(0,10);
      if(allData){
        if(editId){
          allData.adjustments=allData.adjustments.map(a=>a.id===Number(editId)?{...payload,id:Number(editId)}:a);
        } else {
          allData.adjustments.unshift({...payload,id:Date.now()});
        }
        renderAdjustments(allData.adjustments,calcFinancials(allData));
      }
    } catch(err2){ msg.textContent='✗ '+err2.message; msg.className='fin-inline-msg error'; }
    btn.disabled=false;
    if(!btn.dataset.editId) btn.textContent='Record Adjustment';
  });

  window.deleteAdj=async(id)=>{
    if(!confirm('Delete this adjustment? This cannot be undone.')) return;
    const {error}=await sb.from('org_adjustments').delete().eq('id',id);
    if(error){ alert('Error: '+error.message); return; }
    if(allData){
      allData.adjustments=allData.adjustments.filter(a=>a.id!==id);
      renderAdjustments(allData.adjustments,calcFinancials(allData));
    }
  };

  window.editAdj=async(id)=>{
    const a=allData?.adjustments?.find(x=>x.id===id);
    if(!a) return;
    $('adjDate').value=a.period_date;
    $('adjBus').value=a.bus_company_id||'';
    $('adjType').value=a.type;
    $('adjDirection').value=a.direction;
    $('adjAmount').value=a.amount_tzs;
    $('adjStaff').value=a.staff_name||'';
    $('adjDesc').value=a.description;
    $('adjRef').value=a.reference_no||'';
    $('adjApproved').value=a.approved_by||'';
    $('adjNotes').value=a.notes||'';
    const btn=$('adjSubmitBtn');
    btn.dataset.editId=id;
    btn.textContent='Update Adjustment';
    // scroll to form
    $('addAdjCard')?.scrollIntoView({behavior:'smooth',block:'start'});
  };

  // Populate adjBus select (mirrors expBus)
  function populateAdjBus(){
    const sel=$('adjBus'); if(!sel) return;
    sel.innerHTML='<option value="">Organisation-wide</option>';
    Object.entries(busMap).forEach(([id,name])=>{
      const o=document.createElement('option'); o.value=id; o.textContent=name; sel.appendChild(o);
    });
  }

  // ── PAYE Calculator ────────────────────────────────────────────────────────
  function calcPAYE(gross) {
    gross = Math.round(gross)||0;
    let paye = 0;
    if      (gross <= 270000)  paye = 0;
    else if (gross <= 520000)  paye = (gross-270000)*0.08;
    else if (gross <= 760000)  paye = 20000+(gross-520000)*0.20;
    else if (gross <= 1000000) paye = 68000+(gross-760000)*0.25;
    else                       paye = 128000+(gross-1000000)*0.30;
    paye = Math.round(paye);
    const sdl = Math.round(gross*TAX.SDL_RATE);
    return { gross, paye, sdl, net:gross-paye, employerCost:gross+sdl };
  }

  // ── Budget categories ────────────────────────────────────────────────────────
  const BUDGET_CATS = [
    {key:'rev_tickets',  label:'Ticket Revenue',     type:'revenue'},
    {key:'rev_cargo',    label:'Cargo Revenue',       type:'revenue'},
    {key:'exp_fuel',     label:'Fuel & Operations',   type:'expense', cat:'fuel'},
    {key:'exp_salaries', label:'Salaries & PAYE',     type:'expense', cat:'salaries'},
    {key:'exp_maint',    label:'Maintenance',         type:'expense', cat:'maintenance'},
    {key:'exp_insure',   label:'Insurance',           type:'expense', cat:'insurance'},
    {key:'exp_market',   label:'Marketing',           type:'expense', cat:'marketing'},
    {key:'exp_office',   label:'Office & Admin',      type:'expense', cat:'office'},
    {key:'exp_tax',      label:'Tax Payments (TRA)',  type:'expense', cat:'tax_payment'},
    {key:'exp_other',    label:'Other Expenses',      type:'expense', cat:'other'},
  ];

  // ── Cash Flow Statement ────────────────────────────────────────────────────
  function renderCashFlow(fin, range) {
    const el=$('cfDateRange'); if(el) el.textContent=`${range.from}  →  ${range.to}`;
    const netOp = fin.ticketRev+fin.cargoRev-fin.vatAmt-fin.totalExp;
    const rows=[
      ['section','A. OPERATING ACTIVITIES'],
      ['item','Cash receipts — ticket sales (confirmed)', fin.ticketRev],
      ['item','Cash receipts — cargo & freight',         fin.cargoRev],
      ['deduct','VAT remitted to TRA (output tax)',      -fin.vatAmt],
      ['deduct','Operating expenses paid',               -fin.totalExp],
      ['subtotal','NET CASH FROM OPERATING ACTIVITIES',  netOp, netOp>=0?'pos':'neg'],
      ['space'],
      ['section','B. INVESTING ACTIVITIES'],
      ['note','No capital expenditure recorded. Log asset purchases in Expenses.',''],
      ['subtotal','NET CASH FROM INVESTING ACTIVITIES', 0],
      ['space'],
      ['section','C. FINANCING ACTIVITIES'],
      ['note','No financing transactions recorded for this period.',''],
      ['subtotal','NET CASH FROM FINANCING ACTIVITIES', 0],
      ['space'],
      ['total','NET INCREASE / (DECREASE) IN CASH', netOp, netOp>=0?'pos':'neg'],
    ];
    const tb=$('cfTable')?.querySelector('tbody'); if(tb) tb.innerHTML=rows.map(plRow).join('');
  }

  // ── Balance Sheet ──────────────────────────────────────────────────────────
  const BS_FIELDS = [
    {key:'cash',       label:'Cash & Bank Balances',           sec:'Current Assets'},
    {key:'receivables',label:'Trade Receivables (Debtors)',     sec:'Current Assets'},
    {key:'prepayments',label:'Prepayments & Deposits',         sec:'Current Assets'},
    {key:'inventory',  label:'Fuel & Spare Parts Inventory',   sec:'Current Assets'},
    {key:'ppe',        label:'Property, Plant & Equipment (net)',sec:'Non-Current Assets'},
    {key:'intangibles',label:'Intangibles & Software',         sec:'Non-Current Assets'},
    {key:'creditors',  label:'Trade Creditors & Payables',     sec:'Current Liabilities'},
    {key:'vat_pay',    label:'VAT Payable to TRA',             sec:'Current Liabilities'},
    {key:'paye_pay',   label:'PAYE & SDL Payable',             sec:'Current Liabilities'},
    {key:'loans_cur',  label:'Current Portion of Loans',       sec:'Current Liabilities'},
    {key:'loans_lt',   label:'Long-Term Bank Loans',           sec:'Non-Current Liabilities'},
    {key:'share_cap',  label:'Share Capital',                  sec:'Equity'},
    {key:'retained',   label:'Retained Earnings (prior)',       sec:'Equity'},
  ];

  function renderBalanceSheet(fin, range) {
    const lbl=$('balancePeriodLabel'); if(lbl) lbl.textContent=range?`${range.from} → ${range.to} (${range.label})`:'';
    const dl=$('bsDateLabel'); if(dl) dl.textContent=range?range.to:new Date().toISOString().slice(0,10);
    const saved=JSON.parse(localStorage.getItem('pawa_balance')||'{}');
    const defs={cash:Math.max(0,Math.round(fin.netProfit)),receivables:Math.round(fin.pendingRev),vat_pay:Math.round(fin.vatAmt),paye_pay:Math.round(fin.sdlAmt)};

    // Build input grid
    const grid=$('balanceInputGrid');
    if(grid){
      const secs=[...new Set(BS_FIELDS.map(f=>f.sec))];
      grid.innerHTML=secs.map((sec,si)=>`
        <div class="bs-sec-hdr" style="grid-column:1/-1${si?';margin-top:16px':''}">${sec}</div>
        ${BS_FIELDS.filter(f=>f.sec===sec).map(f=>`
          <div class="budget-input-item">
            <label class="budget-input-label">${f.label}</label>
            <input type="number" id="bs_${f.key}" value="${saved[f.key]??(defs[f.key]??0)}" min="0" placeholder="0" />
          </div>`).join('')}
      `).join('');
    }

    const v={};
    BS_FIELDS.forEach(f=>{v[f.key]=parseFloat(saved[f.key]??(defs[f.key]??0))||0;});
    const tCA=v.cash+v.receivables+v.prepayments+v.inventory;
    const tNCA=v.ppe+v.intangibles;
    const tA=tCA+tNCA;
    const tCL=v.creditors+v.vat_pay+v.paye_pay+v.loans_cur;
    const tNCL=v.loans_lt;
    const tL=tCL+tNCL;
    const curProfit=Math.round(fin.netProfit);
    const tEq=v.share_cap+v.retained+curProfit;
    const tLE=tL+tEq;

    const rows=[
      ['section','ASSETS'],
      ['section','Current Assets'],
      ['item','Cash & Bank Balances',v.cash],['item','Trade Receivables',v.receivables],
      ['item','Prepayments & Deposits',v.prepayments],['item','Fuel & Spare Parts Inventory',v.inventory],
      ['subtotal','Total Current Assets',tCA],['space'],
      ['section','Non-Current Assets'],
      ['item','Property, Plant & Equipment (net)',v.ppe],['item','Intangibles & Software',v.intangibles],
      ['subtotal','Total Non-Current Assets',tNCA],['space'],
      ['total','TOTAL ASSETS',tA],['space'],
      ['section','LIABILITIES'],
      ['section','Current Liabilities'],
      ['item','Trade Creditors & Payables',v.creditors],['item','VAT Payable to TRA',v.vat_pay],
      ['item','PAYE & SDL Payable',v.paye_pay],['item','Current Portion of Loans',v.loans_cur],
      ['subtotal','Total Current Liabilities',tCL],['space'],
      ['section','Non-Current Liabilities'],
      ['item','Long-Term Bank Loans',v.loans_lt],
      ['subtotal','Total Non-Current Liabilities',tNCL],['space'],
      ['subtotal','TOTAL LIABILITIES',tL],['space'],
      ['section','EQUITY'],
      ['item','Share Capital',v.share_cap],['item','Retained Earnings (prior)',v.retained],
      ['item','Current Period Net Profit (est.)',curProfit,curProfit>=0?'pos':'neg'],
      ['subtotal','TOTAL EQUITY',tEq],['space'],
      ['total','TOTAL LIABILITIES & EQUITY',tLE],
    ];
    const tb=$('bsTable')?.querySelector('tbody'); if(tb) tb.innerHTML=rows.map(plRow).join('');

    const par=$('bsTable')?.parentNode;
    par?.querySelector('.bs-note')?.remove();
    const diff=Math.abs(tA-tLE);
    if(par&&diff>1){
      const n=document.createElement('div'); n.className='tax-note bs-note'; n.style.marginTop='12px';
      n.style.borderColor=diff<100?'var(--green)':'var(--warn)';
      n.textContent=diff<100?'✓ Balanced (minor rounding)':'⚠️ Out of balance by '+fmt(diff)+'. Check your input values.';
      par.appendChild(n);
    }
  }

  // Save balance sheet
  $('saveBalanceBtn')?.addEventListener('click',()=>{
    const saved={};
    BS_FIELDS.forEach(f=>{const el=$('bs_'+f.key);if(el)saved[f.key]=parseFloat(el.value)||0;});
    localStorage.setItem('pawa_balance',JSON.stringify(saved));
    const msg=$('balanceSavedMsg'); if(msg){msg.hidden=false;setTimeout(()=>msg.hidden=true,2000);}
    if(allData) renderBalanceSheet(calcFinancials(allData),currentRange);
  });

  // ── Payroll ────────────────────────────────────────────────────────────────
  function renderPayroll(){
    const list=JSON.parse(localStorage.getItem('pawa_payroll')||'[]');
    const tb=$('payrollBody'),tf=$('payrollFoot'); if(!tb) return;
    if(!list.length){
      tb.innerHTML='<tr><td colspan="9" class="empty-row">No employees added yet. Fill in the form above.</td></tr>';
      if(tf) tf.innerHTML=''; return;
    }
    let tG=0,tP=0,tS=0,tN=0,tC=0;
    tb.innerHTML=list.map((e,i)=>{
      const t=calcPAYE(e.gross);
      tG+=t.gross;tP+=t.paye;tS+=t.sdl;tN+=t.net;tC+=t.employerCost;
      return `<tr>
        <td><strong>${e.name}</strong></td><td>${e.type}</td><td>${e.dept}</td>
        <td class="num">${fmtN(t.gross)}</td><td class="num neg">${fmtN(t.paye)}</td>
        <td class="num neg">${fmtN(t.sdl)}</td><td class="num pos">${fmtN(t.net)}</td>
        <td class="num">${fmtN(t.employerCost)}</td>
        <td><button class="btn-icon" onclick="window.removeEmployee(${i})" title="Remove">🗑</button></td>
      </tr>`;
    }).join('');
    if(tf) tf.innerHTML=`<tr class="pl-total">
      <td colspan="3">TOTALS — ${list.length} employee${list.length!==1?'s':''}</td>
      <td class="num">${fmtN(tG)}</td><td class="num neg">${fmtN(tP)}</td>
      <td class="num neg">${fmtN(tS)}</td><td class="num">${fmtN(tN)}</td>
      <td class="num">${fmtN(tC)}</td><td></td></tr>`;
  }

  window.removeEmployee=(idx)=>{
    const list=JSON.parse(localStorage.getItem('pawa_payroll')||'[]');
    list.splice(idx,1); localStorage.setItem('pawa_payroll',JSON.stringify(list)); renderPayroll();
  };

  $('calcPayeBtn')?.addEventListener('click',()=>{
    const gross=parseFloat($('payeGross')?.value)||0;
    if(!gross){alert('Enter a gross salary amount first.');return;}
    const t=calcPAYE(gross);
    const el=$('payeQuickResult'); if(!el) return;
    el.hidden=false;
    el.innerHTML=`
      <div class="paye-r"><div class="paye-r-lbl">Gross Salary</div><div class="paye-r-val">${fmt(t.gross)}</div></div>
      <div class="paye-r"><div class="paye-r-lbl">PAYE Deducted</div><div class="paye-r-val" style="color:#dc2626">(${fmt(t.paye)})</div></div>
      <div class="paye-r"><div class="paye-r-lbl">SDL (employer 4%)</div><div class="paye-r-val" style="color:#dc2626">(${fmt(t.sdl)})</div></div>
      <div class="paye-r"><div class="paye-r-lbl">Net Take-Home Pay</div><div class="paye-r-val" style="color:#16a34a">${fmt(t.net)}</div></div>
      <div class="paye-r"><div class="paye-r-lbl">Total Employer Cost</div><div class="paye-r-val">${fmt(t.employerCost)}</div></div>
      <div class="paye-r"><div class="paye-r-lbl">Effective Tax Rate</div><div class="paye-r-val">${gross>0?(t.paye/gross*100).toFixed(1)+'%':'0%'}</div></div>`;
  });

  $('addEmployeeBtn')?.addEventListener('click',()=>{
    const name=$('payeEmpName')?.value.trim();
    const gross=parseFloat($('payeGross')?.value)||0;
    if(!name){alert('Enter employee name.');return;}
    if(!gross){alert('Enter a gross salary amount.');return;}
    const list=JSON.parse(localStorage.getItem('pawa_payroll')||'[]');
    list.push({name,gross,type:$('payeEmpType')?.value||'Permanent',dept:$('payeDept')?.value||'Other'});
    localStorage.setItem('pawa_payroll',JSON.stringify(list));
    if($('payeEmpName')) $('payeEmpName').value='';
    if($('payeGross'))   $('payeGross').value='';
    if($('payeQuickResult')) $('payeQuickResult').hidden=true;
    renderPayroll();
  });

  $('clearPayrollBtn')?.addEventListener('click',()=>{
    if(confirm('Clear all employees from the payroll register?')){
      localStorage.removeItem('pawa_payroll'); renderPayroll();
    }
  });

  // ── Budget vs Actual ───────────────────────────────────────────────────────
  function initBudgetInputs(){
    const grid=$('budgetInputGrid'); if(!grid) return;
    const saved=JSON.parse(localStorage.getItem('pawa_budget')||'{}');
    grid.innerHTML=BUDGET_CATS.map(c=>`
      <div class="budget-input-item">
        <label class="budget-input-label">${c.label}
          <small style="font-weight:400;color:var(--gray)">${c.type}</small>
        </label>
        <input type="number" id="bgt_${c.key}" value="${saved[c.key]||''}" min="0" placeholder="0" />
      </div>`).join('');
  }

  function renderBudget(fin){
    initBudgetInputs();
    const saved=JSON.parse(localStorage.getItem('pawa_budget')||'{}');
    const actuals={
      rev_tickets:fin.ticketRev, rev_cargo:fin.cargoRev,
      exp_fuel:fin.expByCat.fuel||0, exp_salaries:fin.expByCat.salaries||0,
      exp_maint:fin.expByCat.maintenance||0, exp_insure:fin.expByCat.insurance||0,
      exp_market:fin.expByCat.marketing||0, exp_office:fin.expByCat.office||0,
      exp_tax:fin.expByCat.tax_payment||0, exp_other:fin.expByCat.other||0,
    };
    let tBR=0,tAR=0,tBE=0,tAE=0;
    $('budgetBody').innerHTML=BUDGET_CATS.map(c=>{
      const budget=parseFloat(saved[c.key])||0;
      const actual=actuals[c.key]||0;
      const isRev=c.type==='revenue';
      const variance=isRev?actual-budget:budget-actual;
      const fav=variance>=0;
      const varPct=budget>0?(Math.abs(variance)/budget*100).toFixed(1)+'%':'—';
      const fmtVar=budget>0?(variance>=0?'+':'')+fmt(variance):'—';
      const status=!budget?'No budget set':fav?'✓ On track':'✗ Off track';
      const ps=!budget?'background:#f3f4f6;color:#6b7280':fav?'background:#dcfce7;color:#166534':'background:#fee2e2;color:#991b1b';
      if(isRev){tBR+=budget;tAR+=actual;}else{tBE+=budget;tAE+=actual;}
      return `<tr>
        <td><strong>${c.label}</strong></td>
        <td><span class="status-pill" style="background:${isRev?'#dbeafe':'#fef3c7'};color:${isRev?'#1e40af':'#92400e'}">${c.type}</span></td>
        <td class="num">${budget?fmtN(budget):'—'}</td>
        <td class="num">${fmtN(actual)}</td>
        <td class="num ${fav?'pos':'neg'}">${fmtVar}</td>
        <td class="num ${fav?'pos':'neg'}">${varPct}</td>
        <td><span class="status-pill" style="${ps}">${status}</span></td>
      </tr>`;
    }).join('');
    const nb=tBR-tBE,na=tAR-tAE,nv=na-nb;
    $('budgetFoot').innerHTML=`<tr class="pl-total">
      <td colspan="2">NET (Revenue − Expenses)</td>
      <td class="num">${tBR||tBE?fmtN(nb):'—'}</td><td class="num">${fmtN(na)}</td>
      <td class="num ${nv>=0?'pos':'neg'}">${tBR||tBE?(nv>=0?'+':'')+fmt(nv):'—'}</td><td colspan="2"></td></tr>`;
  }

  $('saveBudgetBtn')?.addEventListener('click',()=>{
    const saved={};
    BUDGET_CATS.forEach(c=>{const el=$('bgt_'+c.key);if(el)saved[c.key]=parseFloat(el.value)||0;});
    localStorage.setItem('pawa_budget',JSON.stringify(saved));
    const msg=$('budgetSavedMsg'); if(msg){msg.hidden=false;setTimeout(()=>msg.hidden=true,2000);}
    if(allData) renderBudget(calcFinancials(allData));
  });

  $('resetBudgetBtn')?.addEventListener('click',()=>{
    if(confirm('Reset all budget targets to zero?')){
      localStorage.removeItem('pawa_budget'); initBudgetInputs();
      if(allData) renderBudget(calcFinancials(allData));
    }
  });

  // ── Financial Ratios ───────────────────────────────────────────────────────
  function renderRatios(fin){
    const el=$('ratiosContent'); if(!el) return;
    if(!fin||fin.totalRev===0){
      el.innerHTML='<p class="empty-row" style="text-align:center;padding:48px">Load a report first to calculate financial ratios.</p>'; return;
    }
    function rc(v,g,o){return v>=g?'ratio-good':v>=o?'ratio-warn':'ratio-bad';}
    const gm=fin.netRev>0?fin.opProfit/fin.netRev*100:0;
    const nm=fin.totalRev>0?fin.netProfit/fin.totalRev*100:0;
    const er=fin.totalRev>0?fin.totalExp/fin.totalRev*100:0;
    const cr=fin.convRate*100;
    const rpb=fin.confirmed>0?fin.ticketRev/fin.confirmed:0;
    const fps=fin.shipCount>0?fin.cargoRev/fin.shipCount:0;
    const vr=fin.totalRev>0?fin.vatAmt/fin.totalRev*100:0;
    const ol=fin.netRev>0?fin.opProfit/fin.netRev*100:0;
    const tmix=fin.totalRev>0?fin.ticketRev/fin.totalRev*100:0;
    const cmix=fin.totalRev>0?fin.cargoRev/fin.totalRev*100:0;
    const cards=[
      {label:'Gross Profit Margin',     val:gm.toFixed(1)+'%',   desc:'Operating profit ÷ net revenue (ex-VAT)',                  bench:gm>=20?'Healthy':gm>=10?'Average':'Low',    r:rc(gm,20,10)},
      {label:'Net Profit Margin',       val:nm.toFixed(1)+'%',   desc:'Net profit ÷ gross revenue (after VAT, expenses, tax)',    bench:nm>=10?'Healthy':nm>=5?'Average':'Low',     r:rc(nm,10,5)},
      {label:'Expense Ratio',           val:er.toFixed(1)+'%',   desc:'Total expenses ÷ gross revenue',                          bench:er<=50?'Lean':er<=70?'Average':'High',      r:er<=50?'ratio-good':er<=70?'ratio-warn':'ratio-bad'},
      {label:'Booking Conversion Rate', val:cr.toFixed(1)+'%',   desc:'Confirmed bookings ÷ all bookings created',               bench:cr>=70?'Strong':cr>=50?'Average':'Low',     r:rc(cr,70,50)},
      {label:'Avg Revenue / Booking',   val:'TZS '+fmtN(rpb),    desc:'Average confirmed ticket fare per booking',               bench:'',r:''},
      {label:'Avg Freight / Shipment',  val:'TZS '+fmtN(fps),    desc:'Average cargo revenue per shipment',                      bench:'',r:''},
      {label:'VAT Collection Rate',     val:vr.toFixed(1)+'%',   desc:'VAT collected ÷ gross revenue (expected ~15.3% of incl.)',bench:Math.abs(vr-15.25)<1.5?'Correct':'Review', r:Math.abs(vr-15.25)<1.5?'ratio-good':'ratio-warn'},
      {label:'Operating Leverage',      val:ol.toFixed(1)+'%',   desc:'Operating profit as % of net revenue',                   bench:ol>=15?'Strong':ol>=5?'Average':ol<0?'Loss':'Low', r:rc(ol,15,5)},
      {label:'Revenue Mix — Tickets',   val:tmix.toFixed(1)+'%', desc:'Ticket revenue share of total gross revenue',            bench:'',r:''},
      {label:'Revenue Mix — Cargo',     val:cmix.toFixed(1)+'%', desc:'Cargo revenue share of total gross revenue',             bench:'',r:''},
    ];
    el.innerHTML=`<div class="ratios-grid">${cards.map(c=>`
      <div class="ratio-card">
        <div class="ratio-label">${c.label}</div>
        <div class="ratio-value">${c.val}</div>
        <div class="ratio-desc">${c.desc}</div>
        ${c.bench?`<span class="ratio-bench ${c.r}">${c.bench}</span>`:''}
      </div>`).join('')}</div>
    <div class="tax-note" style="margin-top:16px">Benchmarks are indicative for East African transport operators. Ratios vary by route mix, fleet size, and season.</div>`;
  }

  // ── Invoice Generator ──────────────────────────────────────────────────────
  function initInvoiceSection(){
    let lc=0;
    $('invType')?.addEventListener('change',()=>{
      if($('invManualArea')) $('invManualArea').hidden=$('invType').value!=='manual';
    });
    $('addInvLineBtn')?.addEventListener('click',()=>{
      lc++;
      const d=document.createElement('div');
      d.className='inv-line-row';
      d.style.cssText='display:grid;grid-template-columns:3fr 70px 1fr auto;gap:8px;margin-bottom:8px;align-items:center';
      d.innerHTML=`
        <input type="text" placeholder="Description" id="id_${lc}" style="padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:.9rem"/>
        <input type="number" placeholder="Qty" value="1" id="iq_${lc}" style="padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:.9rem" min="1"/>
        <input type="number" placeholder="Unit Price (TZS)" id="ip_${lc}" style="padding:7px 10px;border:1px solid var(--border);border-radius:8px;font-size:.9rem" min="0"/>
        <button onclick="this.parentNode.remove()" class="btn-icon" title="Remove">✕</button>`;
      $('invLineItems').appendChild(d);
    });
    $('generateInvBtn')?.addEventListener('click',()=>{
      const type=$('invType')?.value||'manual';
      const ref=$('invRef')?.value.trim()||'';
      const bName=$('invBillName')?.value.trim()||'Customer';
      const bContact=$('invBillContact')?.value.trim()||'';
      let items=[];
      if(type==='booking'&&allData){
        const b=allData.bookings.find(x=>x.ticket_code===ref||x.ticket_code?.includes(ref));
        if(!b){alert('Booking not found. Load a report that covers that booking date first.');return;}
        items=[{desc:`Bus Ticket: ${b.origin} → ${b.destination}\n${b.bus_name} | Seat ${b.seat_number||'—'} | Date: ${b.travel_date||''}`,qty:1,unit:b.fare_tzs||0}];
      } else if(type==='shipment'&&allData){
        const s=allData.shipments.find(x=>x.tracking_code===ref||x.tracking_code?.includes(ref));
        if(!s){alert('Shipment not found. Load a report that covers that shipment date first.');return;}
        const fr=Math.round(freightCalc(s));
        items=[{desc:`Cargo Freight: ${s.sender_region} → ${s.receiver_region}\n${s.product_description}, ${s.product_weight_kg}kg (${s.size_category})`,qty:1,unit:fr}];
        if(s.insured) items.push({desc:'Cargo Insurance (2% of freight)',qty:1,unit:Math.round(fr*0.02)});
      } else {
        document.querySelectorAll('.inv-line-row').forEach(r=>{
          const d=r.querySelector('[id^=id_]')?.value.trim();
          const q=parseFloat(r.querySelector('[id^=iq_]')?.value)||1;
          const p=parseFloat(r.querySelector('[id^=ip_]')?.value)||0;
          if(d) items.push({desc:d,qty:q,unit:p});
        });
        if(!items.length){alert('Add at least one line item.');return;}
      }
      const sub=items.reduce((s,i)=>s+i.qty*i.unit,0);
      const vat=sub*(TAX.VAT_RATE/(1+TAX.VAT_RATE));
      const net=sub-vat;
      const num='INV-'+new Date().getFullYear()+'-'+String(Date.now()).slice(-6);
      const today=new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric'});
      $('invoiceDoc').innerHTML=`
        <div class="inv-header">
          <div>
            <div class="inv-logo">📊 PAWA BUS CARGO</div>
            <div style="font-size:.82rem;color:#6b7280;margin-top:6px;line-height:1.6">Tanzania's Trusted Logistics Partner<br>Dar es Salaam, Tanzania<br>TIN: — &nbsp;|&nbsp; VAT Reg: —</div>
          </div>
          <div class="inv-meta">
            <strong>INVOICE</strong>
            <div>No: <strong>${num}</strong></div>
            <div>Date: ${today}</div>
            ${ref?`<div>Ref: <code>${ref}</code></div>`:''}
          </div>
        </div>
        <div class="inv-parties">
          <div><div class="inv-party-lbl">FROM</div><div class="inv-party-name">Pawa Bus Cargo Ltd</div><div class="inv-party-sub">Dar es Salaam, Tanzania</div></div>
          <div><div class="inv-party-lbl">BILL TO</div><div class="inv-party-name">${bName}</div><div class="inv-party-sub">${bContact}</div></div>
        </div>
        <table class="inv-table">
          <thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit (TZS)</th><th class="num">Total (TZS)</th></tr></thead>
          <tbody>${items.map(i=>`<tr><td style="white-space:pre-line">${i.desc}</td><td class="num">${i.qty}</td><td class="num">${fmtN(i.unit)}</td><td class="num">${fmtN(i.qty*i.unit)}</td></tr>`).join('')}</tbody>
        </table>
        <div class="inv-totals">
          <div class="inv-tot-row"><span>Net Amount (ex-VAT)</span><span>TZS ${fmtN(net)}</span></div>
          <div class="inv-tot-row"><span>VAT @ 18%</span><span>TZS ${fmtN(vat)}</span></div>
          <div class="inv-tot-row inv-grand"><span>TOTAL DUE</span><span>TZS ${fmtN(sub)}</span></div>
        </div>
        <div class="inv-footer">Payment terms: 7 days from invoice date &nbsp;|&nbsp; M-Pesa / Tigo / Airtel available<br>For queries: accounts@pawabus.co.tz &nbsp;|&nbsp; Thank you for your business!</div>`;
      $('invoicePreview').hidden=false;
      $('invoicePreview').scrollIntoView({behavior:'smooth',block:'start'});
    });
    window.printInvoice=()=>{
      const w=window.open('','_blank','width=750,height=950');
      w.document.write(`<!doctype html><html><head><title>Invoice</title><style>
        body{font-family:Arial,sans-serif;margin:32px;font-size:13px;color:#111}
        .inv-header{display:flex;justify-content:space-between;margin-bottom:28px}
        .inv-logo{font-size:1.3rem;font-weight:900;color:#1a472a}
        .inv-meta{text-align:right}.inv-meta strong{font-size:1.3rem;color:#1a472a;display:block}
        .inv-parties{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:24px}
        .inv-party-lbl{font-size:.7rem;font-weight:700;text-transform:uppercase;color:#6b7280;margin-bottom:4px}
        .inv-party-name{font-weight:700;font-size:1rem}.inv-party-sub{font-size:.85rem;color:#6b7280}
        .inv-table{width:100%;border-collapse:collapse;margin-bottom:20px}
        .inv-table th{background:#1a472a;color:#fff;padding:9px 12px;text-align:left;font-size:.82rem}
        .inv-table td{padding:9px 12px;border-bottom:1px solid #e5e7eb;white-space:pre-line}
        .num{text-align:right}
        .inv-totals{margin-left:auto;max-width:300px}
        .inv-tot-row{display:flex;justify-content:space-between;padding:5px 0;font-size:.9rem}
        .inv-grand{font-weight:800;font-size:1.1rem;border-top:2px solid #1a472a;padding-top:10px;color:#1a472a}
        .inv-footer{margin-top:28px;border-top:1px solid #e5e7eb;padding-top:12px;font-size:.76rem;color:#6b7280;text-align:center}
        code{background:#f3f4f6;padding:2px 6px;border-radius:4px}
      </style></head><body>${$('invoiceDoc').innerHTML}</body></html>`);
      w.document.close();w.focus();setTimeout(()=>{w.print();w.close();},500);
    };
  }

  // ── Revenue Forecast ───────────────────────────────────────────────────────
  let fcData = null; // cached projection rows

  // Fetch last 24 months of monthly revenue + expense totals from DB
  async function fetchMonthlyTrend() {
    if (!sb) return { rev: [], exp: [] };
    const cutoff = new Date(); cutoff.setMonth(cutoff.getMonth() - 24);
    const from = cutoff.toISOString().slice(0, 10);

    const [bkRes, shRes, exRes] = await Promise.all([
      sb.from('bookings')
        .select('created_at,fare_tzs,status')
        .gte('created_at', from)
        .in('status', ['confirmed','boarded','completed']),
      sb.from('shipments')
        .select('created_at,product_weight_kg,product_value_tzs,insured,status')
        .gte('created_at', from)
        .neq('status', 'Cancelled'),
      sb.from('org_expenses')
        .select('period_date,amount_tzs')
        .gte('period_date', from),
    ]);

    // Aggregate by month
    const revByMo = {}, expByMo = {};
    (bkRes.data||[]).forEach(b => {
      const mo = b.created_at.slice(0,7);
      revByMo[mo] = (revByMo[mo]||0) + (b.fare_tzs||0);
    });
    (shRes.data||[]).forEach(s => {
      const mo = s.created_at.slice(0,7);
      revByMo[mo] = (revByMo[mo]||0) + freightCalc(s);
    });
    (exRes.data||[]).forEach(e => {
      const mo = e.period_date.slice(0,7);
      expByMo[mo] = (expByMo[mo]||0) + (e.amount_tzs||0);
    });

    const rev = Object.entries(revByMo).sort().map(([mo,v]) => ({ mo, v }));
    const exp = Object.entries(expByMo).sort().map(([mo,v]) => ({ mo, v }));
    return { rev, exp };
  }

  // Calculate annualised growth rate from a series of monthly values
  function detectAnnualGrowth(monthlies) {
    if (monthlies.length < 2) return null;
    // Use first and last non-zero months for CAGR
    const vals = monthlies.map(m => m.v).filter(v => v > 0);
    if (vals.length < 2) return null;
    const first = vals[0], last = vals[vals.length - 1];
    const months = monthlies.length;
    // Monthly CAGR → annualise
    const monthlyRate = Math.pow(last / first, 1 / months) - 1;
    const annualRate  = Math.pow(1 + monthlyRate, 12) - 1;
    return Math.round(annualRate * 1000) / 10; // percentage with 1dp
  }

  async function autoDetectRates() {
    const statusEl = $('fcStatus'); if(statusEl) statusEl.textContent = 'Detecting trends…';
    const { rev, exp } = await fetchMonthlyTrend();
    const detectedRev = detectAnnualGrowth(rev);
    const detectedExp = detectAnnualGrowth(exp);

    const revInput = $('fcRevGrowth'), expInput = $('fcExpGrowth');
    const revNote  = $('fcRevGrowthNote'), expNote = $('fcExpGrowthNote');

    if (detectedRev !== null) {
      if(revInput) revInput.value = detectedRev;
      if(revNote)  revNote.textContent = `Auto-detected from ${rev.length} months of data`;
    } else {
      if(revNote) revNote.textContent = `Insufficient history — using default. Edit as needed.`;
    }
    if (detectedExp !== null) {
      if(expInput) expInput.value = detectedExp;
      if(expNote)  expNote.textContent = `Auto-detected from ${exp.length} months of data`;
    } else {
      if(expNote) expNote.textContent = `Insufficient history — using default. Edit as needed.`;
    }
    if(statusEl) statusEl.textContent = detectedRev !== null
      ? `Trends loaded from ${rev.length} months of history.`
      : 'Not enough historical data — growth rates are editable estimates.';
  }

  function runForecast() {
    if (!allData) { alert('Load a report first — the forecast uses the loaded period as the baseline.'); return; }
    const fin = calcFinancials(allData);
    const years = $('fcYears').value === 'custom'
      ? (parseInt($('fcCustomYears').value) || 5)
      : parseInt($('fcYears').value);
    const rg   = (parseFloat($('fcRevGrowth').value)  || 0) / 100;
    const eg   = (parseFloat($('fcExpGrowth').value)  || 0) / 100;
    const ag   = (parseFloat($('fcAdjGrowth').value)  || 0) / 100;
    const band = (parseInt($('fcSensitivity').value)  || 20) / 100;

    // Base values from current loaded period (annualised if not yearly)
    const isYearly = currentRange?.period === 'year';
    const months   = isYearly ? 12 : (currentRange
      ? Math.max(1, Math.round((new Date(currentRange.to) - new Date(currentRange.from)) / (1000*60*60*24*30.44)))
      : 1);
    const annualRev  = fin.totalRev  * (12 / months);
    const annualExp  = fin.totalExp  * (12 / months);
    const annualAdj  = fin.adjNet    * (12 / months);
    const ticketShare = fin.totalRev > 0 ? fin.ticketRev / fin.totalRev : 0.7;
    const cargoShare  = 1 - ticketShare;

    const baseYear = new Date().getFullYear();

    // Generate projection rows for a given revenue multiplier (for scenarios)
    function project(revMult, expMult) {
      const rows = [];
      let prevRev = 0;
      for (let y = 1; y <= years; y++) {
        const rev  = annualRev  * revMult * Math.pow(1 + rg, y);
        const exp  = annualExp  * expMult * Math.pow(1 + eg, y);
        const adj  = annualAdj  * Math.pow(1 + ag, y);
        const op   = rev + adj - exp;
        const tax  = Math.max(0, op * TAX.CIT_RATE);
        const net  = op - tax;
        const yoy  = prevRev > 0 ? ((rev - prevRev) / prevRev) * 100 : null;
        rows.push({ year: baseYear + y, rev, ticketRev: rev * ticketShare, cargoRev: rev * cargoShare, exp, adj, op, tax, net, yoy });
        prevRev = rev;
      }
      return rows;
    }

    const base = project(1, 1);
    const pess = project(1 - band, 1 + band * 0.5);
    const opt  = project(1 + band, 1 - band * 0.5);
    fcData = base;

    // Scenario summary cards
    const finalBase = base[base.length - 1];
    const finalPess = pess[pess.length - 1];
    const finalOpt  = opt[opt.length - 1];
    ['fcScenarioCards','fcCagrBar','fcTableWrap','fcSensWrap'].forEach(id => {
      const el = $(id); if (el) { el.style.display = id === 'fcScenarioCards' ? 'grid' : 'block'; }
    });

    $('fcPessRev').textContent    = fmt(finalPess.rev);
    $('fcPessProfit').textContent = (finalPess.net>=0?'+':'')+fmt(finalPess.net);
    $('fcBaseRev').textContent    = fmt(finalBase.rev);
    $('fcBaseProfit').textContent = (finalBase.net>=0?'+':'')+fmt(finalBase.net);
    $('fcOptRev').textContent     = fmt(finalOpt.rev);
    $('fcOptProfit').textContent  = (finalOpt.net>=0?'+':'')+fmt(finalOpt.net);

    // CAGR row
    function cagr(start, end, yrs) {
      if (!start || start <= 0) return '—';
      const r = (Math.pow(end / start, 1 / yrs) - 1) * 100;
      return (r >= 0 ? '+' : '') + r.toFixed(1) + '%';
    }
    $('fcCagrRev').textContent    = cagr(annualRev, finalBase.rev, years);
    $('fcCagrExp').textContent    = cagr(annualExp, finalBase.exp, years);
    $('fcCagrProfit').textContent = annualRev - annualExp > 0
      ? cagr(Math.abs(annualRev - annualExp), Math.abs(finalBase.net), years) : '—';
    const breakEvenYr = base.find(r => r.net >= 0);
    $('fcBreakeven').textContent  = breakEvenYr ? String(breakEvenYr.year) : 'Beyond horizon';

    // Year-by-year table
    const baselineRow = `<tr style="background:#fefce8;font-weight:700">
      <td>${baseYear} (baseline)</td>
      <td class="num">${fmtN(annualRev*ticketShare)}</td>
      <td class="num">${fmtN(annualRev*cargoShare)}</td>
      <td class="num">${fmtN(annualRev)}</td>
      <td class="num neg">(${fmtN(annualExp)})</td>
      <td class="num ${annualAdj>=0?'pos':'neg'}">${annualAdj>=0?'+':''}${fmtN(Math.abs(annualAdj))}</td>
      <td class="num ${annualRev-annualExp>=0?'pos':'neg'}">${fmtN(annualRev-annualExp)}</td>
      <td class="num neg">(${fmtN(Math.max(0,(annualRev-annualExp)*TAX.CIT_RATE))})</td>
      <td class="num">${fmtN(annualRev-annualExp-Math.max(0,(annualRev-annualExp)*TAX.CIT_RATE))}</td>
      <td class="num" style="color:#9ca3af">—</td>
    </tr>`;
    $('fcBody').innerHTML = baselineRow + base.map(r => `<tr>
      <td><strong>${r.year}</strong></td>
      <td class="num">${fmtN(r.ticketRev)}</td>
      <td class="num">${fmtN(r.cargoRev)}</td>
      <td class="num pos">${fmtN(r.rev)}</td>
      <td class="num neg">(${fmtN(r.exp)})</td>
      <td class="num ${r.adj>=0?'pos':'neg'}">${r.adj>=0?'+':''}${fmtN(Math.abs(r.adj))}</td>
      <td class="num ${r.op>=0?'pos':'neg'}">${fmtN(r.op)}</td>
      <td class="num neg">(${fmtN(r.tax)})</td>
      <td class="num ${r.net>=0?'pos':'neg'}" style="font-weight:700">${fmtN(r.net)}</td>
      <td class="num" style="color:${r.yoy!=null&&r.yoy>=0?'#0a6f4d':'#dc2626'}">${r.yoy!=null?(r.yoy>=0?'+':'')+r.yoy.toFixed(1)+'%':'—'}</td>
    </tr>`).join('');

    // Sensitivity table
    const sensHead = $('fcSensHead'), sensBody = $('fcSensBody');
    sensHead.innerHTML = '<th>Year</th>'
      + ['Pessimistic','Base Case','Optimistic'].map((s,i) =>
          `<th class="num" style="color:${['#dc2626','#0a6f4d','#2563eb'][i]}">${s} Net Profit</th>`).join('')
      + '<th class="num">Range</th>';
    sensBody.innerHTML = [
      { year: baseYear, pn: annualRev-annualExp-Math.max(0,(annualRev-annualExp)*TAX.CIT_RATE),
        bn: annualRev-annualExp-Math.max(0,(annualRev-annualExp)*TAX.CIT_RATE),
        on: annualRev-annualExp-Math.max(0,(annualRev-annualExp)*TAX.CIT_RATE), baseline:true }
    ].concat(base.map((r,i) => ({ year:r.year, pn:pess[i].net, bn:r.net, on:opt[i].net })))
    .map(r => `<tr${r.baseline?' style="background:#fefce8;font-weight:700"':''}>
      <td>${r.year}${r.baseline?' (baseline)':''}</td>
      <td class="num" style="color:#dc2626">${fmtN(r.pn)}</td>
      <td class="num" style="color:#0a6f4d;font-weight:${r.baseline?700:600}">${fmtN(r.bn)}</td>
      <td class="num" style="color:#2563eb">${fmtN(r.on)}</td>
      <td class="num" style="color:#6b7280;font-size:0.78rem">${fmtN(r.on-r.pn)} spread</td>
    </tr>`).join('');
  }

  // Wire forecast controls
  $('fcYears')?.addEventListener('change', () => {
    const wrap = $('fcCustomWrap');
    if (wrap) wrap.style.display = $('fcYears').value === 'custom' ? 'flex' : 'none';
  });
  $('fcRunBtn')?.addEventListener('click', runForecast);
  $('fcDetectBtn')?.addEventListener('click', autoDetectRates);

  window.exportForecastCSV = () => {
    if (!fcData?.length) { alert('Run a forecast first.'); return; }
    const rows = [['Year','Ticket Revenue','Cargo Revenue','Total Revenue','Expenses','Net Adj','Op Profit','Est Tax','Net Profit','YoY Rev %']];
    fcData.forEach(r => rows.push([r.year,Math.round(r.ticketRev),Math.round(r.cargoRev),Math.round(r.rev),Math.round(r.exp),Math.round(r.adj),Math.round(r.op),Math.round(r.tax),Math.round(r.net),r.yoy!=null?r.yoy.toFixed(1)+'%':'—']));
    const csv = rows.map(r => r.join(',')).join('\n');
    const a = document.createElement('a');
    a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
    a.download = `pawa-forecast-${new Date().getFullYear()}.csv`;
    a.click();
  };

  // Auto-detect when forecast section becomes visible
  let fcDetected = false;
  const origShowSection = window.showSection || (()=>{});
  document.querySelectorAll('.fin-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.section === 'forecast' && !fcDetected) {
        fcDetected = true;
        autoDetectRates();
      }
    });
  });

  // ── Print ──────────────────────────────────────────────────────────────────
  window.printReport=()=>{ document.title=`Pawa Finance — ${currentRange?.label||''}`; window.print(); };

  // ── CSV export ─────────────────────────────────────────────────────────────
  window.exportCSV=(type='all')=>{
    // Payroll export doesn't need a loaded report
    if(type==='payroll'){
      const list=JSON.parse(localStorage.getItem('pawa_payroll')||'[]');
      if(!list.length){alert('No employees in payroll register.');return;}
      const rows=[['PAYROLL REGISTER'],['Employee','Type','Department','Gross (TZS)','PAYE (TZS)','SDL 4% (TZS)','Net Pay (TZS)','Employer Cost (TZS)']];
      list.forEach(e=>{const t=calcPAYE(e.gross);rows.push([e.name,e.type,e.dept,t.gross,t.paye,t.sdl,t.net,t.employerCost]);});
      const csv=rows.map(r=>r.map(c=>`"${String(c??'').replace(/"/g,'""')}"`).join(',')).join('\n');
      const a=document.createElement('a');a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
      a.download='pawa-payroll.csv';a.click();return;
    }
    if(!allData){ alert('Load a report first.'); return; }
    const fin=calcFinancials(allData);
    const rows=[];
    if(type==='all'||type==='income'){
      rows.push(['INCOME STATEMENT',currentRange?.label||'']);
      rows.push(['Item','Amount (TZS)']);
      rows.push(['Ticket Revenue (confirmed)',fin.ticketRev]);
      rows.push(['Pending Revenue',fin.pendingRev]);
      rows.push(['Cargo Revenue',fin.cargoRev]);
      rows.push(['Gross Revenue',fin.totalRev]);
      rows.push(['VAT 18%',-fin.vatAmt]);
      rows.push(['Net Revenue (ex-VAT)',fin.netRev]);
      rows.push(['Total Expenses',-fin.totalExp]);
      rows.push(['Operating Profit',fin.opProfit]);
      rows.push(['SDL 4%',-fin.sdlAmt]);
      rows.push(['Net Profit (est.)',fin.netProfit]);
      rows.push([]);
      rows.push(['BOOKING FUNNEL']);
      rows.push(['Total',fin.total,'Confirmed',fin.confirmed,'Pending',fin.pending,'Expired/Cancelled',fin.expired,'Conversion Rate',pct(fin.confirmed,fin.total||1)]);
      rows.push([]);
    }
    if(type==='all'){
      rows.push(['BOOKINGS']);
      rows.push(['Ticket Code','Date','Bus','Route','Passenger','Seat','Fare (TZS)','Status']);
      allData.bookings.forEach(b=>rows.push([b.ticket_code,b.travel_date,b.bus_name,`${b.origin}→${b.destination}`,b.passenger_name,b.seat_number,b.fare_tzs||0,b.status]));
      rows.push([]);
      rows.push(['SHIPMENTS']);
      rows.push(['Tracking Code','Date','Bus','Route','Sender','Receiver','Weight(kg)','Freight(TZS)','Status']);
      allData.shipments.forEach(s=>rows.push([s.tracking_code,s.created_at?.slice(0,10),s.bus_name,s.bus_route,s.sender_name,s.receiver_name,s.product_weight_kg,Math.round(freightCalc(s)),s.status]));
      rows.push([]);
      rows.push(['EXPENSES']);
      rows.push(['Date','Bus Company','Category','Description','Amount (TZS)','Receipt','By']);
      allData.expenses.forEach(e=>rows.push([e.period_date,busMap[e.bus_company_id]||'Org',e.category,e.description,e.amount_tzs,e.receipt_ref||'',e.recorded_by]));
    }
    const csv=rows.map(r=>r.map(c=>`"${String(c??'').replace(/"/g,'""')}"`).join(',')).join('\n');
    const a=document.createElement('a');
    a.href='data:text/csv;charset=utf-8,'+encodeURIComponent(csv);
    a.download=`pawa-finance-${currentRange?.from||'report'}.csv`;
    a.click();
  };

  // ── boot ──────────────────────────────────────────────────────────────────
  renderPayroll();
  initBudgetInputs();
  initInvoiceSection();
  window.Auth.onAuthChange(gate);
  await gate();
};
