
// Shared canvas-based seat layout editor used by admin.html and
// dashboard.html. Mount it by calling:
//   window.renderSeatCanvasEditor(containerEl, busRow, supabaseClient, { onSaved })
//
// The container element gets its innerHTML replaced. busRow must include
// id / name / seats_total / seat_names / seat_layout. On save, the buses
// row is updated and (optionally) opts.onSaved(updatedBus) is invoked.

(function () {
  if (window.renderSeatCanvasEditor) return;   // already loaded

  window.renderSeatCanvasEditor = function (wrap, bus, sb, opts) {
    opts = opts || {};
    const $ = (id) => document.getElementById(id);

            // ─── State (only persisted on Save) ───────────────────────────────
      // Free-positioning canvas. Each item lives at absolute (x, y) inside
      // the canvas. Seat numbers are NOT stored — they're computed when
      // needed by sorting seats top-to-bottom, left-to-right.
      //
      // Item shape:
      //   { id, type: 'seat'|'aisle'|'door', x, y, w, h, name? }
      //
      // Migrate from older shapes:
      //   (a) saved seat_layout.items  → use as-is
      //   (b) saved seat_layout.grid   → convert grid cells to absolute coords
      //   (c) no saved layout          → synthesize a 2+aisle+2 default from
      //                                  seats_total + seat_names
      const SEAT_W = 80, SEAT_H = 80;
      const AISLE_W = 40, AISLE_H = 80;
      const DOOR_W  = 80, DOOR_H  = 50;
      const SNAP    = 8;       // grid snap step in px
      const PAD     = 32;      // canvas inner padding

      // Roomy default canvas so the editor has plenty of empty space around
      // the seats for dragging items and rearranging without feeling cramped.
      const DEFAULT_W = 960;
      const DEFAULT_H = 1800;
      let canvasW = DEFAULT_W;
      let canvasH = DEFAULT_H;
      let items   = [];        // {id,type,x,y,w,h,name?}
      let drag    = null;      // {id, dx, dy, fromPalette, type?, ghost?}
      let activeItem = null;   // currently selected (for inline editor)

      const uid = () => "i" + Math.random().toString(36).slice(2, 9);

      function loadInitial() {
        const sl = bus.seat_layout;
        if (sl && Array.isArray(sl.items)) {
          canvasW = sl.canvas?.w || DEFAULT_W;
          canvasH = sl.canvas?.h || DEFAULT_H;
          items = sl.items.map(it => ({ ...it, id: it.id || uid() }));
          return;
        }
        if (sl && sl.grid) {
          // Convert grid layout (rows × cols) to absolute coords. Use the
          // roomy default canvas so there's space around the imported items.
          const cols = sl.cols, rows = sl.rows;
          const cellW = SEAT_W + 8, cellH = SEAT_H + 8;
          canvasW = Math.max(DEFAULT_W, PAD * 2 + cols * cellW + 240);
          canvasH = Math.max(DEFAULT_H, PAD * 2 + rows * cellH + 200);
          items = [];
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              const cell = sl.grid[r][c];
              if (!cell) continue;
              const x = PAD + c * cellW;
              const y = PAD + r * cellH;
              if (cell.type === 'seat')  items.push({ id: uid(), type: 'seat',  x, y, w: SEAT_W, h: SEAT_H, name: cell.name });
              if (cell.type === 'aisle') items.push({ id: uid(), type: 'aisle', x, y, w: SEAT_W, h: SEAT_H });
              if (cell.type === 'door')  items.push({ id: uid(), type: 'door',  x, y, w: SEAT_W, h: DOOR_H });
            }
          }
          return;
        }
        // Default: synthesize 2 + aisle + 2 from seats_total.
        // Canvas always at least DEFAULT_W × DEFAULT_H — bigger if the seat
        // count would otherwise overflow — so there's plenty of empty space
        // around the layout for drag-editing.
        const total = bus.seats_total || 50;
        const names = bus.seat_names || {};
        const rows = Math.ceil(total / 4);
        const cellW = SEAT_W + 8, cellH = SEAT_H + 8;
        canvasW = Math.max(DEFAULT_W, PAD * 2 + 4 * cellW + AISLE_W + 8 + 240);
        canvasH = Math.max(DEFAULT_H, PAD * 2 + rows * cellH + 200);
        items = [];
        let n = 1;
        for (let r = 0; r < rows; r++) {
          const y = PAD + r * cellH;
          if (n <= total) items.push({ id: uid(), type: 'seat', x: PAD,                        y, w: SEAT_W, h: SEAT_H, name: names[n] }); n++;
          if (n <= total) items.push({ id: uid(), type: 'seat', x: PAD + cellW,                y, w: SEAT_W, h: SEAT_H, name: names[n] }); n++;
          if (n - 1 <= total) items.push({ id: uid(), type: 'aisle', x: PAD + 2 * cellW,       y, w: AISLE_W, h: AISLE_H });
          if (n <= total) items.push({ id: uid(), type: 'seat', x: PAD + 2 * cellW + AISLE_W + 8, y, w: SEAT_W, h: SEAT_H, name: names[n] }); n++;
          if (n <= total) items.push({ id: uid(), type: 'seat', x: PAD + 3 * cellW + AISLE_W + 8, y, w: SEAT_W, h: SEAT_H, name: names[n] }); n++;
        }
      }
      loadInitial();

      // ── Inject styles ─────────────────────────────────────────────────
      if (!document.getElementById("seat-editor-styles")) {
        const s = document.createElement("style");
        s.id = "seat-editor-styles";
        s.textContent = `
          .seWrap { display:flex; flex-direction:column; gap:14px; }
          .seBar { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
          .seBar input[type=number] {
            width:70px; padding:6px 8px; border:1px solid #cbd5e1;
            border-radius:7px; font-size:0.88rem;
          }
          .seBar label { font-size:0.78rem; font-weight:700; color:#475569; }
          .seBar .seInfo { font-size:0.85rem; color:#0a6f4d; font-weight:700; margin-left:auto; }

          .seBoard { display:flex; gap:14px; flex-wrap:wrap; align-items:flex-start; }
          .sePalette {
            display:flex; flex-direction:column; gap:10px;
            width:90px; flex-shrink:0;
            background:#fff; border:1px solid #e5e7eb; border-radius:12px;
            padding:10px 8px;
            position:sticky; top:10px;
          }
          .sePalette-title {
            font-size:0.65rem; font-weight:800; color:#94a3b8;
            text-transform:uppercase; letter-spacing:1px; text-align:center;
          }
          .sePaletteItem {
            display:flex; flex-direction:column; align-items:center; gap:3px;
            padding:8px 4px; border-radius:8px; cursor:grab;
            background:#f8fafc; border:2px dashed #cbd5e1;
            font-size:0.7rem; font-weight:700; color:#475569;
            user-select:none; touch-action:none;
          }
          .sePaletteItem:hover { background:#f0fdf4; border-color:#86efac; color:#065f46; }
          .sePaletteItem .ico { font-size:1.4rem; }

          .seCanvasWrap {
            flex:1 1 auto; min-width:0; display:flex; justify-content:center;
          }
          .seCanvas {
            background: linear-gradient(180deg,#f0fdf4,#f8fafc);
            border:2px solid #16a34a; border-radius:32px 32px 22px 22px;
            position:relative; overflow:hidden;
            box-shadow: 0 4px 14px rgba(22,163,74,.15);
            background-image:
              linear-gradient(rgba(22,163,74,.06) 1px, transparent 1px),
              linear-gradient(90deg, rgba(22,163,74,.06) 1px, transparent 1px);
            background-size: 8px 8px;
            touch-action:none;
          }
          .seCanvas::before {
            content:'🚍 Driver — Front'; position:absolute; top:6px; left:0; right:0;
            text-align:center; font-size:0.7rem; font-weight:700; color:#065f46;
            background:#fff; border-bottom:2px dashed #86efac; padding:4px;
            pointer-events:none; z-index:0;
          }
          .seCanvas::after {
            content:'Rear ↓'; position:absolute; bottom:0; left:0; right:0;
            text-align:center; font-size:0.7rem; font-weight:700; color:#475569;
            background:rgba(255,255,255,.9); border-top:2px dashed #86efac;
            padding:4px; pointer-events:none;
          }

          .seItem {
            position:absolute; box-sizing:border-box;
            border-radius:9px;
            display:flex; flex-direction:column; align-items:center; justify-content:center;
            cursor:grab; user-select:none; touch-action:none;
            transition: box-shadow .12s, transform .08s;
            z-index:1;
          }
          .seItem:active { cursor:grabbing; }
          .seItem.dragging { opacity:.5; z-index:50; }
          .seItem.active { box-shadow:0 0 0 3px #d97706, 0 4px 12px rgba(217,119,6,.3); z-index:10; }

          .seItem.seat { background:#fff; border:2px solid #16a34a; padding:3px 4px 2px; }
          .seItem.seat .seNum {
            font-size:0.58rem; font-weight:800; color:#15803d;
            background:#dcfce7; border-radius:4px; padding:1px 5px;
            align-self:flex-start;
          }
          .seItem.seat .seName {
            margin-top:2px; width:100%; box-sizing:border-box;
            border:none; outline:none; background:transparent;
            font-size:0.82rem; font-weight:700; color:#065f46;
            text-align:center; padding:1px;
          }
          .seItem.seat .seName::placeholder { color:#cbd5e1; }
          .seItem.aisle {
            background: repeating-linear-gradient(45deg,#fde68a 0 5px, transparent 5px 10px);
            border:1.5px dashed #d97706;
            color:#92400e; font-size:0.85rem; font-weight:800;
          }
          .seItem.door {
            background:#dbeafe; border:2px solid #0284c7;
            color:#0c4a6e; font-size:0.65rem; font-weight:800;
          }
          .seItem.door::before { content:'🚪'; font-size:1.1rem; }

          .seGhost {
            position:fixed; pointer-events:none; z-index:9999;
            opacity:.85; transform:translate(-50%,-50%);
          }

          .sePop {
            position:absolute; z-index:100;
            background:#fff; border:1px solid #e5e7eb; border-radius:10px;
            padding:8px 10px; box-shadow:0 6px 20px rgba(0,0,0,.15);
            display:flex; gap:6px; align-items:center; flex-wrap:wrap;
            font-size:0.78rem;
          }
          .sePop button { padding:4px 10px; font-size:0.75rem; }
          .seHint {
            font-size:0.78rem; color:#475569;
            background:#fff; border:1px dashed #cbd5e1; border-radius:8px;
            padding:8px 12px; margin-bottom:4px;
          }
        `;
        document.head.appendChild(s);
      }

      // ── Mount UI ──────────────────────────────────────────────────────
      wrap.hidden = false;
      wrap.innerHTML = `
        <div class="seWrap" style="background:#f4f8f4;border:1px solid #c8ddc8;border-radius:14px;padding:16px;">
          <div class="seBar">
            <strong style="font-size:0.95rem;color:#065f46">🚍 ${bus.name}</strong>
            <span class="seInfo">Seats: <span id="seCount_${bus.id}">—</span></span>
          </div>

          <div class="seHint">
            🖱️ <strong>Drag from the palette</strong> onto the canvas to drop a seat /
            aisle / door. <strong>Drag any item</strong> on the canvas to move it
            anywhere. <strong>Tap an item</strong> to rename or delete it.
            Items snap to an 8 px grid. Seat numbers (#1, #2…) are computed
            from each seat's position automatically.
          </div>

          <div class="seBar">
            <label>Canvas W</label>
            <input type="number" min="200" max="1600" value="${canvasW}" id="seW_${bus.id}" />
            <label>Canvas H</label>
            <input type="number" min="200" max="4000" value="${canvasH}" id="seH_${bus.id}" />
            <button type="button" class="btn btn-outline btn-sm" id="seResize_${bus.id}">Resize canvas</button>
          </div>

          <div class="seBoard">
            <div class="sePalette" id="sePalette_${bus.id}">
              <div class="sePalette-title">Palette</div>
              <div class="sePaletteItem" data-add="seat"><span class="ico">💺</span>Seat</div>
              <div class="sePaletteItem" data-add="aisle"><span class="ico">||</span>Aisle</div>
              <div class="sePaletteItem" data-add="door"><span class="ico">🚪</span>Door</div>
            </div>

            <div class="seCanvasWrap">
              <div class="seCanvas" id="seCanvas_${bus.id}"
                   style="width:${canvasW}px;height:${canvasH}px"></div>
            </div>
          </div>

          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
            <button type="button" class="btn btn-primary" id="seSave_${bus.id}">💾 Save seat structure</button>
            <button type="button" class="btn btn-outline btn-sm" id="seClearNames_${bus.id}">Clear all names</button>
            <button type="button" class="btn btn-outline btn-sm" id="seClearAll_${bus.id}">Empty bus</button>
            <span id="seStatus_${bus.id}" class="banner" hidden style="display:inline-block;padding:6px 12px;"></span>
          </div>
        </div>`;

      const canvas = $(`seCanvas_${bus.id}`);

      // ── Render items + seat numbers ───────────────────────────────────
      function numberMap() {
        // Sort seats by (y, x) and assign sequential numbers.
        const seats = items.filter(it => it.type === 'seat').slice()
          .sort((a, b) => (a.y - b.y) || (a.x - b.x));
        const m = new Map();
        seats.forEach((s, i) => m.set(s.id, i + 1));
        return m;
      }
      function draw() {
        const nums = numberMap();
        // Diff-render: simplest approach is full re-render of items.
        canvas.querySelectorAll(".seItem").forEach(el => el.remove());
        for (const it of items) {
          const el = document.createElement("div");
          el.className = `seItem ${it.type}`;
          el.dataset.id = it.id;
          el.style.left   = it.x + "px";
          el.style.top    = it.y + "px";
          el.style.width  = it.w + "px";
          el.style.height = it.h + "px";
          if (it.type === 'seat') {
            const n = nums.get(it.id);
            const nm = (it.name || '').replace(/"/g, '&quot;');
            el.innerHTML = `<span class="seNum">#${n}</span>
              <input type="text" class="seName" data-id="${it.id}"
                     value="${nm}" placeholder="Seat ${n}" />`;
          } else if (it.type === 'aisle') {
            el.textContent = '||';
          } else if (it.type === 'door') {
            el.textContent = 'DOOR';
          }
          canvas.appendChild(el);
        }
        $(`seCount_${bus.id}`).textContent = items.filter(i => i.type === 'seat').length;
        wireItems();
      }

      function wireItems() {
        canvas.querySelectorAll(".seName").forEach(inp => {
          inp.addEventListener("input", () => {
            const it = items.find(x => x.id === inp.dataset.id);
            if (!it) return;
            const v = inp.value.trim();
            if (v) it.name = v; else delete it.name;
          });
          // Block drag when interacting with the input.
          ["pointerdown","mousedown","touchstart","click"].forEach(ev =>
            inp.addEventListener(ev, e => e.stopPropagation(), { passive: true })
          );
        });
        canvas.querySelectorAll(".seItem").forEach(el => {
          el.addEventListener("pointerdown", onItemPointerDown);
          el.addEventListener("click", e => {
            if (e.target.closest(".seName")) return;
            // Don't fire selection if a drag actually happened.
            if (el.dataset.didDrag === "1") { el.dataset.didDrag = ""; return; }
            openItemPopover(el);
          });
        });
      }

      function defaultSize(type) {
        if (type === 'seat')  return { w: SEAT_W,  h: SEAT_H };
        if (type === 'aisle') return { w: AISLE_W, h: AISLE_H };
        if (type === 'door')  return { w: DOOR_W,  h: DOOR_H };
        return { w: 60, h: 60 };
      }

      // ── Palette: drag from palette card onto the canvas ──────────────
      // Why this is structured this way: on mobile (Pointer Events), the
      // pointerdown target gets *implicit* pointer capture, which means
      // subsequent pointermove/pointerup events are routed to that source
      // element — they don't always reach a `window` listener reliably,
      // especially on iOS Safari. So we attach the move/up listeners
      // directly to the captured element and also explicitly capture the
      // pointer to be safe.
      let paletteGhost = null;
      $(`sePalette_${bus.id}`).querySelectorAll(".sePaletteItem").forEach(p => {
        p.addEventListener("pointerdown", e => {
          // Don't preventDefault on a touch start before deciding it's a
          // drag — some browsers cancel the whole pointer sequence. Just
          // mark drag state and bind listeners.
          const type = p.dataset.add;
          drag = { fromPalette: true, type };
          try { p.setPointerCapture(e.pointerId); } catch {}

          // Ghost element follows the finger
          const sz = defaultSize(type);
          paletteGhost = document.createElement("div");
          paletteGhost.className = "seGhost";
          paletteGhost.style.width  = sz.w + "px";
          paletteGhost.style.height = sz.h + "px";
          paletteGhost.style.left   = e.clientX + "px";
          paletteGhost.style.top    = e.clientY + "px";
          paletteGhost.style.background = type === 'seat' ? '#fff'
            : type === 'aisle' ? 'repeating-linear-gradient(45deg,#fde68a 0 5px,transparent 5px 10px)'
            : '#dbeafe';
          paletteGhost.style.border = type === 'seat' ? '2px solid #16a34a'
            : type === 'aisle' ? '1.5px dashed #d97706'
            : '2px solid #0284c7';
          paletteGhost.style.borderRadius = '9px';
          paletteGhost.style.display = 'flex';
          paletteGhost.style.alignItems = 'center';
          paletteGhost.style.justifyContent = 'center';
          paletteGhost.style.fontSize = '0.85rem';
          paletteGhost.style.fontWeight = '800';
          paletteGhost.style.color = type === 'aisle' ? '#92400e'
            : type === 'door' ? '#0c4a6e' : '#065f46';
          paletteGhost.textContent = type === 'seat' ? '💺'
            : type === 'aisle' ? '||' : '🚪';
          document.body.appendChild(paletteGhost);

          function onMove(ev) {
            if (!paletteGhost) return;
            ev.preventDefault();
            paletteGhost.style.left = ev.clientX + "px";
            paletteGhost.style.top  = ev.clientY + "px";
          }
          function onUp(ev) {
            p.removeEventListener("pointermove",   onMove);
            p.removeEventListener("pointerup",     onUp);
            p.removeEventListener("pointercancel", onUp);
            try { p.releasePointerCapture(ev.pointerId); } catch {}

            if (paletteGhost) {
              const cRect = canvas.getBoundingClientRect();
              if (ev.clientX >= cRect.left && ev.clientX <= cRect.right &&
                  ev.clientY >= cRect.top  && ev.clientY <= cRect.bottom) {
                const sz2 = defaultSize(type);
                let nx = Math.round((ev.clientX - cRect.left - sz2.w / 2) / SNAP) * SNAP;
                let ny = Math.round((ev.clientY - cRect.top  - sz2.h / 2) / SNAP) * SNAP;
                nx = Math.max(0, Math.min(canvasW - sz2.w, nx));
                ny = Math.max(0, Math.min(canvasH - sz2.h, ny));
                items.push({ id: uid(), type, x: nx, y: ny, w: sz2.w, h: sz2.h });
                draw();
              }
              paletteGhost.remove();
              paletteGhost = null;
            }
            drag = null;
          }

          p.addEventListener("pointermove",   onMove);
          p.addEventListener("pointerup",     onUp);
          p.addEventListener("pointercancel", onUp);
        });
      });

      // ── Item drag (move/swap existing items on the canvas) ────────────
      function onItemPointerDown(e) {
        if (e.target.closest(".seName")) return;
        const el = e.currentTarget;
        const id = el.dataset.id;
        const it = items.find(x => x.id === id);
        if (!it) return;
        const rect = el.getBoundingClientRect();
        const startClientX = e.clientX, startClientY = e.clientY;
        const dx = e.clientX - rect.left, dy = e.clientY - rect.top;
        let moved = false;
        drag = { fromPalette: false, id };
        el.classList.add("dragging");
        try { el.setPointerCapture(e.pointerId); } catch {}

        function onMove(ev) {
          if (!moved) {
            const md = Math.hypot(ev.clientX - startClientX, ev.clientY - startClientY);
            if (md < 4) return;
            moved = true;
          }
          ev.preventDefault();
          const cRect = canvas.getBoundingClientRect();
          let nx = ev.clientX - cRect.left - dx;
          let ny = ev.clientY - cRect.top  - dy;
          nx = Math.round(nx / SNAP) * SNAP;
          ny = Math.round(ny / SNAP) * SNAP;
          nx = Math.max(0, Math.min(canvasW - it.w, nx));
          ny = Math.max(0, Math.min(canvasH - it.h, ny));
          it.x = nx; it.y = ny;
          el.style.left = nx + "px";
          el.style.top  = ny + "px";
        }
        function onUp(ev) {
          el.removeEventListener("pointermove",   onMove);
          el.removeEventListener("pointerup",     onUp);
          el.removeEventListener("pointercancel", onUp);
          try { el.releasePointerCapture(ev.pointerId); } catch {}
          el.classList.remove("dragging");
          if (moved) el.dataset.didDrag = "1";
          drag = null;
          if (moved) draw();    // re-number seats based on new positions
        }
        el.addEventListener("pointermove",   onMove);
        el.addEventListener("pointerup",     onUp);
        el.addEventListener("pointercancel", onUp);
      }

      // ── Item popover (rename + delete) ────────────────────────────────
      function openItemPopover(el) {
        closePopover();
        const id = el.dataset.id;
        const it = items.find(x => x.id === id);
        if (!it) return;
        el.classList.add("active");
        activeItem = id;
        const pop = document.createElement("div");
        pop.className = "sePop";
        pop.id = `sePop_${bus.id}`;
        pop.style.left = (it.x + it.w + 8) + "px";
        pop.style.top  = it.y + "px";
        if (it.type === 'seat') {
          pop.innerHTML = `
            <input type="text" placeholder="Seat name" value="${(it.name || '').replace(/"/g,'&quot;')}"
                   style="padding:4px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:0.82rem;width:120px" />
            <button class="btn btn-primary btn-sm" data-act="save">Set</button>
            <button class="btn btn-danger  btn-sm" data-act="del">Delete</button>`;
        } else {
          pop.innerHTML = `
            <span style="font-weight:700;color:#475569">${it.type.toUpperCase()}</span>
            <button class="btn btn-danger btn-sm" data-act="del">Delete</button>`;
        }
        canvas.appendChild(pop);
        const inp = pop.querySelector("input");
        inp?.focus();
        inp?.addEventListener("keydown", e => { if (e.key === 'Enter') pop.querySelector('[data-act=save]').click(); });
        pop.addEventListener("click", e => {
          const act = e.target.closest("[data-act]")?.dataset.act;
          if (act === "save") {
            const v = inp.value.trim();
            if (v) it.name = v; else delete it.name;
            closePopover(); draw();
          } else if (act === "del") {
            const i = items.findIndex(x => x.id === id);
            if (i >= 0) items.splice(i, 1);
            closePopover(); draw();
          }
        });
        // Click outside closes.
        setTimeout(() => document.addEventListener("pointerdown", outsideHandler, { capture: true }), 0);
      }
      function outsideHandler(e) {
        if (e.target.closest(".sePop") || e.target.closest(".seItem")) return;
        closePopover();
      }
      function closePopover() {
        document.getElementById(`sePop_${bus.id}`)?.remove();
        canvas.querySelectorAll(".seItem.active").forEach(el => el.classList.remove("active"));
        activeItem = null;
        document.removeEventListener("pointerdown", outsideHandler, { capture: true });
      }

      // ── Top bar buttons ──────────────────────────────────────────────
      $(`seResize_${bus.id}`).addEventListener("click", () => {
        const w = Math.max(200, Math.min(1600, parseInt($(`seW_${bus.id}`).value) || canvasW));
        const h = Math.max(200, Math.min(4000, parseInt($(`seH_${bus.id}`).value) || canvasH));
        canvasW = w; canvasH = h;
        canvas.style.width  = w + "px";
        canvas.style.height = h + "px";
        // Pull any out-of-bounds items back in.
        for (const it of items) {
          it.x = Math.max(0, Math.min(w - it.w, it.x));
          it.y = Math.max(0, Math.min(h - it.h, it.y));
        }
        draw();
      });

      $(`seClearNames_${bus.id}`).addEventListener("click", () => {
        if (!confirm("Clear all seat names? Layout stays.")) return;
        for (const it of items) if (it.type === 'seat') delete it.name;
        draw();
      });

      $(`seClearAll_${bus.id}`).addEventListener("click", () => {
        if (!confirm("Empty the entire bus and start with a blank canvas?")) return;
        items = [];
        draw();
      });

      // ── Save ──────────────────────────────────────────────────────────
      // Two paths:
      //   - Platform admin (email in APP_CONFIG.ADMIN_EMAILS) → write the
      //     change straight to the buses row.
      //   - Anyone else (tenant owner/admin) → insert into
      //     bus_layout_pending; a platform admin must approve before the
      //     change becomes visible to riders. The DB-side trigger
      //     guard_bus_layout_update enforces this even if the UI is bypassed.
      $(`seSave_${bus.id}`).addEventListener("click", async () => {
        const nums = numberMap();
        const seat_names = {};
        for (const it of items) {
          if (it.type !== 'seat') continue;
          const n = nums.get(it.id);
          if (it.name && it.name.trim() && it.name.trim() !== String(n)) {
            seat_names[n] = it.name.trim();
          }
        }
        const seats_total = items.filter(i => i.type === 'seat').length;
        const seat_layout = {
          version: 2,
          canvas: { w: canvasW, h: canvasH },
          items
        };
        const statusEl = $(`seStatus_${bus.id}`);
        statusEl.hidden = false; statusEl.className = "banner"; statusEl.textContent = "Saving…";

        const email = window.Auth ? await window.Auth.currentEmail() : null;
        const isPlatformAdmin = !!(window.Auth && window.Auth.isAllowedEmail(email));

        if (isPlatformAdmin) {
          const { error } = await sb.from("buses")
            .update({ seats_total, seat_names, seat_layout })
            .eq("id", bus.id);
          if (error) {
            statusEl.className = "banner error"; statusEl.textContent = error.message;
            return;
          }
          bus.seats_total = seats_total;
          bus.seat_names  = seat_names;
          bus.seat_layout = seat_layout;
          statusEl.className = "banner success";
          statusEl.textContent = `Saved ✓ — ${seats_total} seat${seats_total !== 1 ? "s" : ""} (admin write-through)`;
          setTimeout(() => { statusEl.hidden = true; }, 2500);
          if (opts.onSaved) opts.onSaved(bus);
          return;
        }

        // Tenant path → submit for admin review.
        const { data: sessionData } = await sb.auth.getSession();
        const userId = sessionData?.session?.user?.id || null;
        const { error } = await sb.from("bus_layout_pending").insert({
          bus_id:            bus.id,
          tenant_id:         bus.tenant_id,
          proposed_by:       userId,
          proposed_by_email: email,
          seats_total,
          seat_names,
          seat_layout
        });
        if (error) {
          statusEl.className = "banner error";
          statusEl.textContent = "Could not submit: " + error.message;
          return;
        }
        statusEl.className = "banner success";
        statusEl.textContent = `Submitted for admin review — ${seats_total} seat${seats_total !== 1 ? "s" : ""}. The bus layout won't change until an admin approves.`;
        if (opts.onSubmitted) opts.onSubmitted(bus);
      });

      draw();
    
  };
})();
