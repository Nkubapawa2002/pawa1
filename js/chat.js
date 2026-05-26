// Tab switching between AI chat and Support contacts
window.switchChatTab = (tab) => {
  document.querySelectorAll(".chat-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".chat-panel").forEach(p => p.classList.remove("active"));
  document.getElementById(tab === "ai" ? "tabAi" : "tabSupport").classList.add("active");
  document.getElementById(tab === "ai" ? "panelAi" : "panelSupport").classList.add("active");
};

// Render support contacts list
window.renderSupportContacts = () => {
  const list = document.getElementById("supportContactsList");
  if (!list) return;
  const contacts = window.APP_CONFIG.SUPPORT_CONTACTS || [];
  if (!contacts.length) {
    list.innerHTML = `<div class="message-empty">${window.t("voice_no_booking")}</div>`;
    return;
  }
  list.innerHTML = contacts.map(c => {
    const roleLabel = window.t(c.role) || c.role;
    const phoneEncoded = encodeURIComponent(c.phone);
    return `
    <div class="support-contact-card">
      <div class="support-contact-icon">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
        </svg>
      </div>
      <div class="support-contact-info">
        <span class="role-label">${roleLabel}</span>
        <div class="contact-name">${c.name}</div>
        <div class="contact-phone">${c.phone}</div>
      </div>
      <div class="support-contact-actions">
        <a href="tel:${phoneEncoded}" class="btn btn-green btn-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12 19.79 19.79 0 0 1 1.63 3.35 2 2 0 0 1 3.6 1.13h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.73a16 16 0 0 0 6 6l.96-.96a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 21.73 16z"/>
          </svg>
          ${window.t("support_call")}
        </a>
        <a href="https://wa.me/${c.whatsapp}" target="_blank" rel="noopener" class="btn btn-whatsapp btn-sm">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51a12.8 12.8 0 0 0-.57-.01c-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/>
          </svg>
          ${window.t("support_whatsapp")}
        </a>
      </div>
    </div>`;
  }).join("");
};

window.initChatPage = async () => {
  const messagesEl = document.getElementById("chatMessages");
  const form = document.getElementById("chatForm");
  const input = document.getElementById("chatInput");
  const suggestions = document.getElementById("suggestions");
  const sendBtn = form.querySelector("button");

  let agents = [], buses = [], regions = [], shipments = [];
  try {
    [agents, buses, regions, shipments] = await Promise.all([
      window.DataStore.getAgents(),
      window.DataStore.getBuses(),
      window.DataStore.getRegions(),
      window.DataStore.getShipments()
    ]);
  } catch (e) {
    addMessage("system", "Could not load data: " + e.message);
  }

  const lang = window.getLang();

  // Conversation history shared with the agent-chat Edge Function.
  const conversation = [];

  function addMessage(role, text) {
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    div.innerHTML = `<div class="msg-bubble">${formatMessage(text)}</div>`;
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  const formatMessage = (text) =>
    text
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br/>");

  addMessage("assistant", window.t("chat_greeting"));

  // Agent-chat lives server-side now; no per-browser key needed.
  // We just need a configured tenant + the SUPABASE_URL.
  const cfg = window.APP_CONFIG || {};
  const agentUrl = (cfg.SUPABASE_URL || "").replace(/\/$/, "") + "/functions/v1/agent-chat";
  const haveAgent = !!cfg.SUPABASE_URL;

  const SUGGESTIONS = lang === "sw"
    ? ["Nataka kutuma mzigo Dar kwenda Mwanza", "Mawakala wa Arusha", "Fuatilia TZ-DAR-ARU-20260429-002", "Mabasi yanayokwenda Mbeya"]
    : ["Send a parcel from Dar to Mwanza", "Agents in Arusha", "Track TZ-DAR-ARU-20260429-002", "Buses to Mbeya"];

  SUGGESTIONS.forEach(s => {
    const chip = document.createElement("div");
    chip.className = "suggestion-chip";
    chip.textContent = s;
    chip.addEventListener("click", () => { input.value = s; form.requestSubmit(); });
    suggestions.appendChild(chip);
  });

  // Calls the per-tenant agent-chat Edge Function. The Function loads
  // the tenant's encrypted Anthropic key, builds a tenant-flavoured
  // system prompt, and runs Claude with the 24 tool webhooks.
  const callAI = async (userText) => {
    if (!haveAgent) return demoReply(userText);

    const tenant_slug = (window.tenantSlug && window.tenantSlug()) || "bus-tz-pawa";
    conversation.push({ role: "user", content: userText });

    try {
      const res = await fetch(agentUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "apikey": cfg.SUPABASE_ANON_KEY,
          "Authorization": "Bearer " + cfg.SUPABASE_ANON_KEY
        },
        body: JSON.stringify({
          tenant_slug,
          messages: conversation,
          conversation_id: window.__chatConvId || (window.__chatConvId = "web-" + Math.random().toString(36).slice(2,10))
        })
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`agent-chat ${res.status}: ${t.slice(0, 240)}`);
      }
      const data = await res.json();
      // The Edge Function returns the updated message history; replace ours
      // so subsequent turns include the assistant + tool_result blocks.
      if (Array.isArray(data.messages)) {
        conversation.length = 0;
        data.messages.forEach(m => conversation.push(m));
      }
      return data.reply || "(no reply)";
    } catch (e) {
      console.error(e);
      return `Error contacting agent: ${e.message}\n\n${demoReply(userText)}`;
    }
  };

  const demoReply = (text) => {
    const q = text.toLowerCase();

    const codeMatch = text.match(/TZ-[A-Z]{3}-[A-Z]{3}-\d{8}-\d{3}/i);
    if (codeMatch) {
      const s = shipments.find(x => x.tracking_code.toLowerCase() === codeMatch[0].toLowerCase());
      if (s) {
        const cov = Math.round((s.product.value_tzs || 0) * 0.8);
        return `**${s.tracking_code}**\n**Status:** ${s.status}\n**Route:** ${s.bus.route}\n**Bus:** ${s.bus.name}\n**Sender:** ${s.sender.name} (${s.sender.phone})\n**Receiver:** ${s.receiver.name} (${s.receiver.phone})\n**Value:** ${window.formatTZS(s.product.value_tzs)} | **Insured:** ${window.formatTZS(cov)}\n**Origin Agent:** ${s.agent_origin.name} - ${s.agent_origin.phone}\n**Dest Agent:** ${s.agent_destination.name} - ${s.agent_destination.phone}`;
      }
      return "No shipment found with that code.";
    }

    const region = regions.find(r => q.includes(r.toLowerCase()));
    if ((q.includes("agent") || q.includes("wakala") || q.includes("mawakala")) && region) {
      const found = window.DataStore.findAgentsByRegion(agents, region);
      if (found.length === 0) return `No agents listed in ${region} yet.`;
      return `**Agents in ${region}:**\n` + found.map(a => `- ${a.name} (${a.terminal}) - ${a.phone}`).join("\n");
    }

    if (q.includes("send") || q.includes("tuma") || q.includes("from") || q.includes("kutoka")) {
      const found = regions.filter(r => q.includes(r.toLowerCase()));
      if (found.length >= 2) {
        const [from, to] = found;
        const matchingBuses = window.DataStore.findBusesForRoute(buses, from, to);
        if (matchingBuses.length === 0) return `No bus found for ${from} → ${to}.`;
        return `**Buses for ${from} → ${to}:**\n` + matchingBuses.map(b => {
          const r = b.routes.find(x => x.from === from && x.to === to);
          return `- ${b.name} (${r.departure}, ~${r.duration_hours}h) - ${b.contact}`;
        }).join("\n") + "\n\nClick **Send Parcel** to register.";
      }
      return "Tell me the origin and destination — e.g. 'Send from Dar to Mwanza'.";
    }

    if ((q.includes("bus") || q.includes("basi")) && region) {
      const matching = buses.filter(b => (b.routes || []).some(r => r.to === region || r.from === region));
      if (matching.length === 0) return `No buses found serving ${region}.`;
      return `**Buses serving ${region}:**\n` + matching.map(b => `- ${b.name} - ${b.contact}`).join("\n");
    }

    return "I can help with: finding a bus, finding an agent, tracking a parcel, registering a shipment, or explaining insurance. What would you like?";
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    addMessage("user", text);
    input.value = "";
    sendBtn.disabled = true;
    sendBtn.textContent = "...";
    suggestions.style.display = "none";

    const reply = await callAI(text);
    addMessage("assistant", reply);
    sendBtn.disabled = false;
    sendBtn.textContent = window.t("chat_send");
  });
};
